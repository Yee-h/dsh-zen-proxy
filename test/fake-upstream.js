/**
 * 测试用的假上游：把一串 `data:` 载荷包成真实的 SSE `Response`，
 * 并把 `fetch` 换成可捕获请求的桩。本文件不是测试用例（不匹配 `test/*.test.js`）。
 */

const encoder = new TextEncoder();

/**
 * 造一个 SSE 响应。
 * @param {string[]} payloads 每帧的 `data:` 载荷（JSON 文本）
 * @param {{status?: number, headers?: Record<string,string>, eol?: string}} [options]
 * @returns {Response}
 */
export function sseResponse(payloads, { status = 200, headers = {}, eol = '\n\n' } = {}) {
  const chunks = payloads.map((payload) => `data: ${payload}${eol}`);
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

/**
 * 造一个 JSON 响应。
 * @param {unknown} body
 * @param {{status?: number, headers?: Record<string,string>}} [options]
 * @returns {Response}
 */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * 造一个可捕获请求的 fetch 桩。
 * @param {(url: string, init: object) => Response | Promise<Response>} handler
 * @returns {{fetch: typeof fetch, calls: Array<{url: string, init: object}>}}
 */
export function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fetchImpl, calls };
}

/**
 * 一个形状合法的 chat 增量帧。
 * @param {{content?: string, reasoning?: string, toolCalls?: object[], finishReason?: string|null, usage?: object}} [delta]
 * @returns {string}
 */
export function chatFrame({ content, reasoning, toolCalls, finishReason = null, usage } = {}) {
  const delta = {};
  if (content !== undefined) delta.content = content;
  if (reasoning !== undefined) delta.reasoning_content = reasoning;
  if (toolCalls !== undefined) delta.tool_calls = toolCalls;
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'fledge-alpha-free',
    choices: [{ index: 0, finish_reason: finishReason, delta }],
    ...usage === undefined ? {} : { usage },
  });
}

/** 只带 `finish_reason` 的收尾帧。 */
export function chatFinishFrame(reason) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'fledge-alpha-free',
    choices: [{ index: 0, finish_reason: reason, delta: {} }],
  });
}

/**
 * 把异步可迭代对象收成数组。
 * @param {AsyncIterable<unknown>} iterable
 * @returns {Promise<unknown[]>}
 */
export async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** 一个记录调用的假 logger。 */
export function fakeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message) => lines.info.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
    error: (message) => lines.error.push(String(message)),
  };
}
