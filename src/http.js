/**
 * 上游 HTTP：请求封装、SSE 解码，以及把读取层异常接进失败分类。
 *
 * 四个实测事实决定了这里的形状：
 * 1. 上游 base URL 是**唯一**允许写死的地址（spec 的「不写死用户目录路径」）；
 * 2. SSE 帧以空行分隔，但上游同时可能出现 `\r\n\r\n` 与 `\n\n`，因此解码前统一换行；
 * 3. 「HTTP 200 不等于可用」——错误对象可能藏在 2xx 的流里，所以 2xx 的响应体必须
 *    逐帧交给协议解析器，而不是直接当成功；
 * 4. 流式响应不能被「总时限」掐断：超时只约束到响应头到达为止，之后由调用方的
 *    取消信号接管（否则长回答会被我们自己的计时器截断）。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。HTTP 实现通过
 * `fetchImpl` 注入，测试可以用桩替换。
 *
 * @module src/http.js
 */

import { MODELS_PATH, UPSTREAM_BASE_URL } from './catalog.js';
import { classifyThrownError, classifyUpstreamFailure, createUpstreamError, parseRetryAfter } from './failure.js';

/** 上游对话请求的默认响应头超时。 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** 探测请求的响应头超时，比对话短。 */
export const PROBE_TIMEOUT_MS = 45_000;

/**
 * 把一段 SSE 文本块转成若干 `data:` 载荷。
 * 多行 `data:` 按 SSE 规范用换行拼接；注释行与其他字段忽略。
 * @param {string} block
 * @returns {string[]}
 */
export function payloadsOfFrame(block) {
  const data = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    data.push(colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, ''));
  }
  return data.length === 0 ? [] : [data.join('\n')];
}

/**
 * 逐帧解码一个 SSE 响应体。
 * @param {ReadableStream<Uint8Array> | null | undefined} body
 * @param {{requestId?: string}} [options]
 * @returns {AsyncGenerator<string>}
 */
export async function* decodeSse(body, { requestId } = {}) {
  if (body === null || body === undefined) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const payload of payloadsOfFrame(block)) yield payload;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    if (buffer.trim() !== '') {
      for (const payload of payloadsOfFrame(buffer)) yield payload;
    }
  } catch (error) {
    // 读取层异常（取消、断流）在这里统一成失败分类；上层据取消信号决定是否改为
    // 「已取消」收尾。
    throw createUpstreamError(classifyThrownError(error, requestId));
  } finally {
    void reader.cancel?.().catch(() => {});
  }
}

/**
 * 组装调用方取消信号与响应头超时。
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal, clearTimeout: () => void, dispose: () => void}}
 */
function createRequestScope(signal, timeoutMs) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener('abort', relay, { once: true });
  let timer = setTimeout(() => controller.abort(new Error('upstream request timed out')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    clearTimeout: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', relay);
    },
  };
}

/**
 * 读出非 2xx 响应体的错误信封。
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readErrorPayload(response) {
  try {
    const text = await response.text();
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return { error: { type: '', message: text.slice(0, 500) } };
    }
  } catch {
    return undefined;
  }
}

/**
 * 向上游发起一次请求。
 *
 * 非 2xx 一律抛出带 `code` 与 `failure` 自有属性的失败；2xx 返回 SSE 载荷流，
 * 由调用方的协议解析器决定「成功」的含义。
 *
 * @param {{path: string, method?: 'GET'|'POST', headers: Record<string,string>, body?: object,
 *          signal?: AbortSignal, fetchImpl?: typeof fetch, timeoutMs?: number, requestId?: string,
 *          stream?: boolean}} input
 * @returns {Promise<{status: number, payloads?: AsyncGenerator<string>, json?: unknown}>}
 */
export async function requestUpstream({
  path,
  method = 'POST',
  headers,
  body,
  signal,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestId,
  stream = true,
}) {
  const scope = createRequestScope(signal, timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${UPSTREAM_BASE_URL}${path}`, {
      method,
      headers,
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: scope.signal,
    });
  } catch (error) {
    scope.dispose();
    throw createUpstreamError(classifyThrownError(error, requestId));
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    scope.dispose();
    const envelope = payload?.error ?? payload;
    throw createUpstreamError(classifyUpstreamFailure({
      status: response.status,
      type: typeof envelope?.type === 'string' ? envelope.type : '',
      message: typeof envelope?.message === 'string' ? envelope.message : '',
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after') ?? null),
      requestId,
    }));
  }

  if (!stream) {
    scope.clearTimeout();
    try {
      const json = await response.json().catch(() => undefined);
      return { status: response.status, json };
    } finally {
      scope.dispose();
    }
  }

  // 响应头已到：不再受响应头超时约束，交由调用方取消信号控制。
  scope.clearTimeout();
  const bodyStream = response.body;
  async function* payloads() {
    try {
      yield* decodeSse(bodyStream, { requestId });
    } finally {
      scope.dispose();
    }
  }
  return { status: response.status, payloads: payloads() };
}

/**
 * 拉取上游模型清单（`GET /zen/v1/models`）。
 *
 * 身份头同样齐备：spec 要求「每个上游请求」都携带六个头；实测该端点对头部不敏感，
 * 因此带上没有代价。
 * @param {{headers: Record<string,string>, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *          timeoutMs?: number, requestId?: string}} input
 * @returns {Promise<unknown>} 清单响应体
 */
export async function fetchModelListing({ headers, signal, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, requestId }) {
  const { json } = await requestUpstream({
    path: MODELS_PATH,
    method: 'GET',
    headers,
    signal,
    fetchImpl,
    timeoutMs,
    requestId,
    stream: false,
  });
  return json;
}
