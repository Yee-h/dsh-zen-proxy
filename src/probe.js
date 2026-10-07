/**
 * 单模型可用性探测与判定。
 *
 * 判定顺序（design D7）：HTTP 非 2xx → 按错误信封的 `type` 与状态码分类；
 * HTTP 2xx → **必须**读数据帧，出现错误对象即判失败，出现正常增量才判可用。
 * 只看状态码会把「200 + 流内 `{"error":…}`」误判为可用（这是仓库旧实现遇到过的坑，
 * 本机也实测到过）。
 *
 * 探测流量的身份与任何用户对话隔离：会话取独立种子，请求 id 绑定「轮次 + 模型」。
 * 探测请求显式带一个很小的输出上限（16），因为它是本模块自己发起的请求，
 * 而不是「调用方未指定上限」的情形。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/probe.js
 */

import { pathForModel, wireFor } from './catalog.js';
import { mapUsage, parsePayload } from './chunks.js';
import { classifyThrownError, classifyUpstreamFailure, readErrorEnvelope } from './failure.js';
import { FAILURE_DISPOSITION, FAILURE_SCOPE } from './failure.js';
import { PROBE_TIMEOUT_MS, requestUpstream } from './http.js';
import { buildIdentityHeaders, probeRequest, probeSession, resolveClientVersion } from './identity.js';
import { buildRequestFor } from './messages.js';
import { applyToolQuartet } from './tools.js';

/**
 * 探测判定结果。前四个是 design D8 的模型状态；`transient` 表示「本次失败是瞬时故障」，
 * 由 `src/state.js` 按宽限规则折算成保留前值或 `unavailable`。
 */
export const PROBE_STATE = Object.freeze({
  available: 'available',
  region: 'region',
  unavailable: 'unavailable',
  unknown: 'unknown',
  transient: 'transient',
});

/** 探测请求的输出上限：只要首帧，不需要长回答。 */
export const PROBE_MAX_TOKENS = 16;

/** 最多读取多少帧就下结论，避免慢模型把一轮探测拖长。 */
export const PROBE_MAX_FRAMES = 24;

/** 该协议族的「正常增量」事件名。 */
const RESPONSES_CONTENT_TYPES = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.output_item.added',
  'response.function_call_arguments.delta',
]);

/**
 * 把一次失败分类折算成探测判定。
 * @param {object} classification {@link classifyUpstreamFailure} 的结果
 * @returns {string} {@link PROBE_STATE} 之一
 */
export function verdictFor(classification) {
  if (classification.region === true) return PROBE_STATE.region;
  if (classification.scope === FAILURE_SCOPE.plugin) return PROBE_STATE.unknown;
  if (classification.disposition === FAILURE_DISPOSITION.transient) return PROBE_STATE.transient;
  return PROBE_STATE.unavailable;
}

/**
 * 构造一次探测请求（协议族、路径与请求体）。
 * @param {string} modelId
 * @returns {{wire: 'chat'|'responses', path: string, body: object}}
 */
export function probeRequestFor(modelId) {
  const wire = wireFor(modelId);
  // 调用方（本模块）没有声明任何工具，因此补上闸门要求的四连、并把 tool_choice
  // 置为 none，避免模型去调用自禁用占位工具。
  const { tools, toolChoice } = applyToolQuartet([], { style: wire, toolChoice: true });
  return {
    wire,
    path: pathForModel(modelId),
    body: buildRequestFor(wire, {
      model: modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools,
      toolChoice,
      maxTokens: PROBE_MAX_TOKENS,
    }),
  };
}

/**
 * 判断一个已解析的数据帧是否表示「正常的流式增量」。
 * @param {'chat'|'responses'} wire
 * @param {unknown} json
 * @returns {boolean}
 */
export function isNormalIncrement(wire, json) {
  if (typeof json !== 'object' || json === null) return false;
  if (wire === 'responses') {
    return typeof json.type === 'string' && RESPONSES_CONTENT_TYPES.has(json.type);
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  return typeof choice === 'object' && choice !== null && typeof choice.delta === 'object' && choice.delta !== null;
}

/**
 * 探测单个模型。
 *
 * 本函数不抛异常：一切都折算成判定结果，由调度与状态机决定如何处置。
 * @param {{modelId: string, round?: string, version?: string, signal?: AbortSignal,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} input
 * @returns {Promise<{state: string, failure?: object, latencyMs: number, firstIncrementMs?: number,
 *                    usage?: object, detail?: string}>}
 */
export async function probeModel({
  modelId,
  round = 'round',
  version = resolveClientVersion().version,
  signal,
  fetchImpl,
  timeoutMs = PROBE_TIMEOUT_MS,
}) {
  const started = Date.now();
  const session = probeSession();
  const requestId = probeRequest(round, modelId);
  const { wire, path, body } = probeRequestFor(modelId);
  const headers = buildIdentityHeaders({ version, session, requestId, stream: true });

  try {
    const { payloads } = await requestUpstream({
      path,
      headers,
      body,
      signal,
      fetchImpl,
      timeoutMs,
      requestId,
    });

    let frames = 0;
    let sawIncrement = false;
    let firstIncrementMs;
    let usage;
    for await (const payload of payloads ?? []) {
      const json = parsePayload(payload);
      if (json === undefined) continue;
      frames += 1;

      const envelope = readErrorEnvelope(json);
      if (envelope !== undefined) {
        const classification = classifyUpstreamFailure({
          status: 200,
          type: envelope.type,
          message: envelope.message,
          requestId,
        });
        return {
          state: verdictFor(classification),
          failure: classification,
          detail: classification.message,
          latencyMs: Date.now() - started,
        };
      }

      const frameUsage = mapUsage(json.usage ?? json.response?.usage);
      if (frameUsage !== undefined) usage = frameUsage;

      if (isNormalIncrement(wire, json)) {
        if (!sawIncrement) firstIncrementMs = Date.now() - started;
        sawIncrement = true;
        // 拿到正常增量即可下结论：探测只证明「这个模型此刻会开口」。
        break;
      }
      if (frames >= PROBE_MAX_FRAMES) break;
    }

    if (sawIncrement) {
      return {
        state: PROBE_STATE.available,
        latencyMs: Date.now() - started,
        firstIncrementMs,
        ...usage === undefined ? {} : { usage },
      };
    }

    // 2xx 但整段流没有任何正常增量：按上游故障处理（可能是被截断的空流）。
    const classification = classifyUpstreamFailure({
      status: 200,
      type: 'server_error',
      message: 'upstream returned 2xx without any content increment',
      requestId,
    });
    return {
      state: verdictFor(classification),
      failure: classification,
      detail: classification.message,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const classification = error?.classification ?? classifyThrownError(error, requestId);
    return {
      state: verdictFor(classification),
      failure: classification,
      detail: classification.message,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * 用有界并发探测一批模型（免费车道的配额按会话计，宽扇出会把自己限流）。
 * @param {string[]} modelIds
 * @param {{round?: string, version?: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *          timeoutMs?: number, concurrency?: number}} options
 * @param {(modelId: string, result: object) => void} [onResult]
 * @returns {Promise<Record<string, object>>}
 */
export async function probeModels(modelIds, options = {}, onResult = () => {}) {
  const { concurrency = 2, ...probeOptions } = options;
  const results = {};
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, modelIds.length)) },
    async () => {
      while (cursor < modelIds.length) {
        const modelId = modelIds[cursor];
        cursor += 1;
        const result = await probeModel({ modelId, ...probeOptions });
        results[modelId] = result;
        onResult(modelId, result);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
