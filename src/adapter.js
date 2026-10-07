/**
 * Zen 免费车道的 llm 适配器：两条 provider 路由 + 目录 + 一次对话的分发。
 *
 * 两条路由表达「分组」，而不是在模型条目上打标记——`listModels` 与
 * `normalizeModelInfo` 都没有「不可用」字段（已查证宿主契约），GUI 按 provider 分组，
 * 因此分组只能由路由表达（design D2）：
 *
 * - `opencode-free`：最近一次探测判定为 `available` 的免费模型；
 * - `opencode-free-region`：判定为 `region`（地区受限）的免费模型。
 *
 * 本模块**结构性地**实现宿主的 `LlmAdapter` 六个可覆写点
 * （`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` /
 * `resolveModel` / `prepareCall`），但刻意**不** `import '@deepseek-ai/dsh-llm'`：
 * 该包由宿主在运行时注入，在插件仓库内不可解析，而本模块必须能被单元测试直接加载。
 * `src/register.js` 在宿主侧把本对象挂到真实 `LlmAdapter.prototype` 上，使其成为子类。
 *
 * @module src/adapter.js
 */

import { ABORTED_CODE } from './chunks.js';
import {
  contextWindowFor,
  displayNameFor,
  pathForModel,
  wireFor,
} from './catalog.js';
import { requestUpstream } from './http.js';
import { buildIdentityHeaders, requestForTurn, resolveClientVersion, sessionForConversation } from './identity.js';
import { buildRequestFor } from './messages.js';
import { translateChatStream } from './chat.js';
import { translateResponsesStream } from './responses.js';
import { MODEL_STATE, modelsWithVerdict } from './state.js';
import { applyToolQuartet } from './tools.js';

/** 主路由：判定为可用的免费模型。 */
export const ROUTE_MAIN = 'opencode-free';

/** 地区路由：判定为地区受限的免费模型，以独立分组呈现。 */
export const ROUTE_REGION = 'opencode-free-region';

/** 两条路由的展示名。 */
export const ROUTE_LABELS = Object.freeze({
  [ROUTE_MAIN]: 'OpenCode Zen 免费模型',
  [ROUTE_REGION]: 'OpenCode Zen 免费模型（地区受限）',
});

/** 注册顺序即 GUI 中的出现顺序。 */
export const ROUTES = Object.freeze([ROUTE_MAIN, ROUTE_REGION]);

/** 每个路由公布哪些判定状态。 */
export const ROUTE_VERDICTS = Object.freeze({
  [ROUTE_MAIN]: MODEL_STATE.available,
  [ROUTE_REGION]: MODEL_STATE.region,
});

/** 目录里每个模型都声明纯文本输入：宿主据此把图片块投影成占位符，适配器无需处理图片。 */
const INPUT_MODALITIES = Object.freeze(['text']);

/**
 * 派生出一次对话的会话身份。
 *
 * 免费配额按 session 计，因此会话必须按对话稳定派生，绝不能逐请求随机。
 * @param {object} options 宿主的 `GenerateOptions`
 * @returns {{session: string, requestId: string}}
 */
export function conversationIdentity(options) {
  const session = sessionForConversation(options?.sessionId);
  // 「单轮」的标识取请求里最后一条消息的 id：它在同一轮内稳定，跨轮必然变化。
  const last = Array.isArray(options?.messages) ? options.messages.at(-1) : undefined;
  const turn = typeof last?.id === 'string' && last.id !== ''
    ? last.id
    : `turn:${Array.isArray(options?.messages) ? options.messages.length : 0}`;
  return { session, requestId: requestForTurn(session, turn) };
}

/**
 * 创建一个适配器实例。
 * @param {{state: () => object, clientVersion?: string, fetchImpl?: typeof fetch,
 *          timeoutMs?: number}} deps
 *   `state` 返回最近一次的判定状态（由 `src/state.js` 维护）
 * @returns {object} 六点齐全的适配器
 */
export function createAdapter({ state, clientVersion, fetchImpl, timeoutMs }) {
  const version = clientVersion ?? resolveClientVersion().version;

  function modelEntry(provider, modelId) {
    const contextWindow = contextWindowFor(modelId);
    return {
      provider,
      id: modelId,
      name: displayNameFor(modelId),
      inputModalities: [...INPUT_MODALITIES],
      // 只在有可溯源来源时给出上下文窗口；无来源就省略（见 src/catalog.js）。
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      // 不声明 defaultMaxTokens：宿主会把它物化成请求的输出上限，而 spec 要求
      // 适配器不在调用方未指定输出上限时自行发送 max_tokens / max_output_tokens。
    };
  }

  return {
    /**
     * 路由的展示元数据。宿主校验 `id` 必须等于注册的路由、`name` 必须非空。
     * @param {string} provider
     * @returns {{id: string, name: string}}
     */
    providerInfo(provider) {
      return { id: provider, name: ROUTE_LABELS[provider] ?? provider };
    },

    /** 使用宿主默认的重试策略。 */
    providerRetryPolicy() {
      return undefined;
    },

    /** 不按视觉 token 计价：目录里所有模型都是纯文本输入。 */
    imageRequestPricing() {
      return undefined;
    },

    /**
     * 公布一个路由的目录。条目只受「免费 + 判定」驱动，与能力元数据完整度无关。
     * @param {string} provider
     * @returns {object[]}
     */
    listModels(provider) {
      const verdict = ROUTE_VERDICTS[provider];
      if (verdict === undefined) return [];
      return modelsWithVerdict(state(), verdict).map((modelId) => ({
        provider,
        id: modelId,
        name: displayNameFor(modelId),
        inputModalities: [...INPUT_MODALITIES],
      }));
    },

    /**
     * 精确模型信息。核心路由接受未列出的 id，所以任何 id 都必须能解析出合法结果。
     * @param {string} provider
     * @param {string} model
     * @returns {object}
     */
    resolveModel(provider, model) {
      const entry = modelEntry(provider, model);
      return {
        provider: entry.provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.inputModalities,
        ...entry.context === undefined ? {} : { context: entry.context },
      };
    },

    /**
     * 绑定精确模型信息与一次流式分发。
     * @param {string} provider
     * @param {string} model
     * @returns {Promise<{model: object, stream: (options: object) => AsyncGenerator<object>}>}
     */
    async prepareCall(provider, model) {
      const resolved = this.resolveModel(provider, model);
      return {
        model: resolved,
        stream: (options) => streamTurn(options, { version, fetchImpl, timeoutMs }),
      };
    },
  };
}

/**
 * 一次对话的流式分发：构造请求、发往对应协议族、把响应流翻译成宿主分片。
 *
 * 失败以「抛出带 `code` 与 `failure` 自有属性的 Error」交付；宿主会把它转成终止失败
 * 分片。取消则本流自己产出一个 `{kind:'aborted'}` 的终止 `finish`。
 * @param {object} options 宿主的 `GenerateOptions`
 * @param {{version: string, fetchImpl?: typeof fetch, timeoutMs?: number}} context
 * @returns {AsyncGenerator<object>}
 */
async function* streamTurn(options, { version, fetchImpl, timeoutMs }) {
  const modelId = String(options?.model ?? '');
  const signal = options?.signal;
  if (signal?.aborted === true) {
    yield {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: Object.freeze({ message: 'the request was aborted by the caller', code: ABORTED_CODE }),
      },
    };
    return;
  }

  const wire = wireFor(modelId);
  const { session, requestId } = conversationIdentity(options);
  const { tools, rename, toolChoice } = applyToolQuartet(options?.tools, { style: wire, toolChoice: true });
  const body = buildRequestFor(wire, {
    model: modelId,
    messages: options?.messages,
    tools,
    toolChoice,
    // 调用方（或宿主按适配器声明）给了输出上限才发送；本适配器不声明默认上限。
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    stop: options?.stop,
  });
  const headers = buildIdentityHeaders({ version, session, requestId, stream: true });

  const { payloads } = await requestUpstream({
    path: pathForModel(modelId),
    headers,
    body,
    signal,
    fetchImpl,
    timeoutMs,
    requestId,
  });

  const translate = wire === 'responses' ? translateResponsesStream : translateChatStream;
  yield* translate(payloads ?? [], { requestId, rename, signal });
}
