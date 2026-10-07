/**
 * responses 协议族：`POST /zen/v1/responses` 的 SSE 事件流 → `StreamChunk`。
 *
 * 该族只有 `muse-spark*` 系模型走（见 `src/catalog.js` 的协议族判定）。事件形状
 * （OpenAI Responses 的 SSE，`data:` 载荷带 `type` 字段）：
 *
 * ```text
 * response.created
 * response.output_item.added              item.type === 'function_call'（工具调用开场）
 * response.output_text.delta              delta（正文增量）
 * response.reasoning_summary_text.delta   delta（推理摘要增量）
 * response.function_call_arguments.delta  delta（工具参数增量，原始 JSON 片段）
 * response.completed                      response.usage
 * response.incomplete                     输出被上限截断
 * response.failed                         错误对象
 * ```
 *
 * 本机出口国家被该族拒绝（实测两个 muse-spark 模型均返回 `403 RegionError`），
 * 因此真实链路只能证伪、不能证真；实现由注入式桩事件流覆盖
 * （见 `test/responses.test.js`）。这一点已在 README 的「已知限制」中记录。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/responses.js
 */

import { driveWireStream, mapUsage, parsePayload } from './chunks.js';
import { classifyUpstreamFailure, createUpstreamError, readErrorEnvelope } from './failure.js';
import { restoreToolName } from './tools.js';

/** 正文增量事件。 */
const TEXT_DELTA_TYPES = new Set(['response.output_text.delta']);
/** 推理增量事件（不同版本的上游用了不同的事件名）。 */
const REASONING_DELTA_TYPES = new Set([
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
]);
/** 工具参数增量事件。 */
const ARGUMENTS_DELTA_TYPES = new Set(['response.function_call_arguments.delta']);
/** 工具调用开场事件。 */
const ITEM_ADDED_TYPES = new Set(['response.output_item.added']);

/**
 * 创建一个 responses 帧解码器。
 * @param {{requestId?: string, rename?: Map<string, string>}} [options]
 * @returns {(payload: string, tracker: object, state: object) => object[] | undefined}
 */
export function createResponsesDecoder({ requestId, rename } = {}) {
  /** 工具调用 item 的 `id` → 块键，使参数增量能找回自己的块。 */
  const keyByItemId = new Map();
  let implicitToolIndex = 0;

  function keyForItem(itemId, fallbackName) {
    if (typeof itemId === 'string' && itemId !== '') {
      const known = keyByItemId.get(itemId);
      if (known !== undefined) return known;
      const key = `tool:${itemId}`;
      keyByItemId.set(itemId, key);
      return key;
    }
    implicitToolIndex += 1;
    return `tool:${fallbackName ?? ''}:${implicitToolIndex}`;
  }

  return (payload, tracker, state) => {
    const json = parsePayload(payload);
    if (json === undefined) return undefined;

    const envelope = readErrorEnvelope(json);
    if (envelope !== undefined) {
      throw createUpstreamError(classifyUpstreamFailure({
        status: 200,
        type: envelope.type,
        message: envelope.message,
        requestId,
      }));
    }

    const type = typeof json.type === 'string' ? json.type : '';
    // 该族把失败也发成 `type: 'error'` 的事件。
    if (type === 'error' || type === 'response.failed') {
      const failure = json.error ?? json.response?.error ?? {};
      throw createUpstreamError(classifyUpstreamFailure({
        status: 200,
        type: typeof failure.type === 'string' ? failure.type : '',
        message: typeof failure.message === 'string' ? failure.message : 'response.failed',
        requestId,
      }));
    }

    if (type === 'response.incomplete') {
      state.truncated = true;
      return undefined;
    }

    if (type === 'response.completed' || type === 'response.done') {
      const mapped = mapUsage(json.response?.usage ?? json.usage);
      if (mapped !== undefined) state.usage = mapped;
      state.done = true;
      return undefined;
    }

    if (TEXT_DELTA_TYPES.has(type)) {
      const text = typeof json.delta === 'string' ? json.delta : '';
      return text === '' ? undefined : tracker.textDelta('text', text);
    }
    if (REASONING_DELTA_TYPES.has(type)) {
      const text = typeof json.delta === 'string' ? json.delta : '';
      return text === '' ? undefined : tracker.reasoningDelta('reasoning', text);
    }
    if (ITEM_ADDED_TYPES.has(type)) {
      const item = json.item;
      if (item?.type !== 'function_call') return undefined;
      return tracker.toolCallDelta(keyForItem(item.id ?? item.call_id, item.name), {
        id: item.call_id ?? item.id,
        name: restoreToolName(item.name, rename),
        // 开场事件的 arguments 通常是空串；残留的初始化片段也要串进去。
        argumentsDelta: typeof item.arguments === 'string' ? item.arguments : '',
      });
    }
    if (ARGUMENTS_DELTA_TYPES.has(type)) {
      const text = typeof json.delta === 'string' ? json.delta : '';
      if (text === '') return undefined;
      return tracker.toolCallDelta(keyForItem(json.item_id, json.name), {
        name: restoreToolName(json.name, rename),
        argumentsDelta: text,
      });
    }
    if (type === 'response.function_call_arguments.done') {
      return undefined;
    }
    return undefined;
  };
}

/**
 * 把一个 responses 协议族的事件流翻译为符合宿主协议的 `StreamChunk` 流。
 * @param {AsyncIterable<string>} payloads
 * @param {{requestId?: string, rename?: Map<string, string>, signal?: AbortSignal}} [options]
 * @returns {AsyncGenerator<object>}
 */
export function translateResponsesStream(payloads, options = {}) {
  return driveWireStream(payloads, {
    signal: options.signal,
    decode: createResponsesDecoder(options),
  });
}
