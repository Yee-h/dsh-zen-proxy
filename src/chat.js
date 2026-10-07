/**
 * chat 协议族：`POST /zen/v1/chat/completions` 的 SSE 响应流 → `StreamChunk`。
 *
 * 实测帧形状（`data:` 载荷，节选自真实响应）：
 *
 * ```json
 * {"id":"7b6c509c165448369be00f8372d5fad3","object":"chat.completion.chunk","created":1791377943,
 *  "model":"fledge-alpha-free","choices":[{"index":0,"finish_reason":null,"logprobs":null,
 *  "delta":{"role":"assistant","content":"","reasoning_content":null}}]}
 * ```
 *
 * 两种需要特别处理的实测事实：
 * 1. **HTTP 200 不等于可用**：网关会在 2xx 流里塞入错误帧
 *    （`data: {"error":{"type":"server_error",…}}`），因此每一帧都要先查错误信封；
 * 2. **`usage` 可能出现在很靠前的帧**（实测首个帧就带 `usage`），所以用量要缓存到流末
 *    再产出，以满足「`usage` 先于 `finish`」。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/chat.js
 */

import { driveWireStream, mapUsage, parsePayload } from './chunks.js';
import { classifyUpstreamFailure, createUpstreamError, readErrorEnvelope } from './failure.js';
import { restoreToolName } from './tools.js';

/** 上游 `finish_reason` → 是否按「输出被上限截断」收尾。 */
const TRUNCATED_REASONS = new Set(['length']);

/**
 * 创建一个 chat 帧解码器。
 * @param {{requestId?: string, rename?: Map<string, string>}} [options]
 *   `rename` 是闸门补齐时产生的「发送拼写 → 调用方拼写」映射
 * @returns {(payload: string, tracker: object, state: object) => object[] | undefined}
 */
export function createChatDecoder({ requestId, rename } = {}) {
  return (payload, tracker, state) => {
    const json = parsePayload(payload);
    if (json === undefined) return undefined;

    // 2xx 流里也可能出现错误对象：必须抛失败，不能当成内容。
    const envelope = readErrorEnvelope(json);
    if (envelope !== undefined) {
      throw createUpstreamError(classifyUpstreamFailure({
        status: 200,
        type: envelope.type,
        message: envelope.message,
        requestId,
      }));
    }

    if (json.usage !== undefined) {
      const mapped = mapUsage(json.usage);
      if (mapped !== undefined) state.usage = mapped;
    }

    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (choice === undefined || typeof choice !== 'object' || choice === null) return undefined;
    if (TRUNCATED_REASONS.has(choice.finish_reason)) state.truncated = true;

    const delta = choice.delta;
    if (typeof delta !== 'object' || delta === null) return undefined;

    const chunks = [];
    if (typeof delta.content === 'string' && delta.content !== '') {
      chunks.push(...tracker.textDelta('text', delta.content));
    }
    const reasoning = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning !== '') chunks.push(...tracker.reasoningDelta('reasoning', reasoning));

    for (const [position, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
      const key = `tool:${call?.index ?? position}`;
      chunks.push(...tracker.toolCallDelta(key, {
        id: call?.id,
        name: restoreToolName(call?.function?.name, rename),
        // 工具参数以上游原始 JSON 片段拼接，绝不重新序列化。
        argumentsDelta: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
      }));
    }
    return chunks;
  };
}

/**
 * 把一个 chat 协议族的 `data:` 载荷流翻译为符合宿主协议的 `StreamChunk` 流。
 * @param {AsyncIterable<string>} payloads
 * @param {{requestId?: string, rename?: Map<string, string>, signal?: AbortSignal}} [options]
 * @returns {AsyncGenerator<object>}
 */
export function translateChatStream(payloads, options = {}) {
  return driveWireStream(payloads, {
    signal: options.signal,
    decode: createChatDecoder(options),
  });
}
