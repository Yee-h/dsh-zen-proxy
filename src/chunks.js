/**
 * StreamChunk 的构造与块索引追踪，以及上游用量 → 宿主用量的映射。
 *
 * 两个协议族（chat / responses）的解析器共用这里的块追踪与收尾逻辑，因此
 * 「`usage` 先于 `finish`」「终止 `finish` 之后不再产出任何分片」「每个流恰好一个
 * `finish`」这些不变式只有一份实现，不会在两个协议之间漂移。
 *
 * 分片协议（`@deepseek-ai/dsh-llm` 的 `StreamChunk`）：
 *
 * ```text
 * {type:'block-start', index, blockType:'text'|'reasoning'|'tool-call'}
 * {type:'text-delta', index, text}
 * {type:'reasoning-delta', index, text}
 * {type:'tool-call-delta', index, id, name?, argumentsDelta}
 * {type:'block-end', index, block}
 * {type:'usage', usage}
 * {type:'finish', reason}
 * ```
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/chunks.js
 */

/**
 * 取消时终止分片的失败码。宿主 `adapter-failure` 明确按该码把失败归入
 * `{kind:'aborted'}`，因此不是自造新码。
 */
export const ABORTED_CODE = 'ABORTED';

/**
 * 上游用量 → 宿主的 disjoint TokenUsage。
 *
 * 宿主的口径是「`inputTokens` 只算未命中的输入」：OpenAI 的 `prompt_tokens` 是含缓存
 * 命中的总量，因此必须减去 `cached_tokens`。缺省的可选字段要先补零再参与运算，
 * 否则会算出 `NaN`（宿主的持久日志拒绝非有限数字）。
 * @param {unknown} raw 上游的 `usage` 对象
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number,
 *            cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number} | undefined}
 */
export function mapUsage(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const prompt = finite(raw.prompt_tokens ?? raw.input_tokens);
  const completion = finite(raw.completion_tokens ?? raw.output_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const cached = finite(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens) ?? 0;
  const cacheWrite = finite(raw.prompt_tokens_details?.cache_write_tokens);
  const reasoning = finite(
    raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens,
  );
  const usage = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
    totalTokens: (prompt ?? 0) + (completion ?? 0),
  };
  if (cached > 0) usage.cacheReadTokens = cached;
  if (cacheWrite !== undefined && cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 追踪流式内容块，按首次出现顺序分配块索引，并产出 `block-start` / `*-delta` / `block-end`。
 * @returns {object} 块追踪器
 */
function createBlockTracker() {
  /** @type {Array<{key: string, index: number, kind: string, text: string, id?: string, name?: string}>} */
  const order = [];
  const byKey = new Map();
  let nextIndex = 0;

  function ensure(key, kind) {
    let state = byKey.get(key);
    if (state !== undefined) return state;
    state = { key, index: nextIndex, kind, text: '' };
    nextIndex += 1;
    byKey.set(key, state);
    order.push(state);
    return state;
  }

  function start(key, kind) {
    const state = byKey.get(key);
    if (state !== undefined) return undefined;
    const created = ensure(key, kind);
    return { type: 'block-start', index: created.index, blockType: kind };
  }

  return {
    /**
     * 追加文本增量。
     * @param {string} key 块键（同一逻辑块必须复用）
     * @param {string} text
     * @returns {object[]} 需要产出的分片（至多一个 `block-start` 加一个 `text-delta`）
     */
    textDelta(key, text) {
      const chunks = [];
      const started = start(key, 'text');
      if (started !== undefined) chunks.push(started);
      const state = ensure(key, 'text');
      state.text += text;
      chunks.push({ type: 'text-delta', index: state.index, text });
      return chunks;
    },
    /**
     * 追加推理增量。
     * @param {string} key
     * @param {string} text
     * @returns {object[]}
     */
    reasoningDelta(key, text) {
      const chunks = [];
      const started = start(key, 'reasoning');
      if (started !== undefined) chunks.push(started);
      const state = ensure(key, 'reasoning');
      state.text += text;
      chunks.push({ type: 'reasoning-delta', index: state.index, text });
      return chunks;
    },
    /**
     * 追加工具调用增量。`argumentsDelta` 保持上游原始片段，不做 JSON 往返。
     * @param {string} key 每个上游工具调用下标一个键
     * @param {{id?: string, name?: string, argumentsDelta: string}} input
     * @returns {object[]}
     */
    toolCallDelta(key, { id, name, argumentsDelta }) {
      const chunks = [];
      if (!byKey.has(key)) {
        const created = ensure(key, 'tool-call');
        chunks.push({ type: 'block-start', index: created.index, blockType: 'tool-call' });
      }
      const state = ensure(key, 'tool-call');
      if (typeof id === 'string' && id !== '') state.id = id;
      if (typeof name === 'string' && name !== '') state.name = name;
      state.text += argumentsDelta;
      // 空参数片段不产出 delta：开场事件（responses 族的 output_item.added）就是
      // 这种形状，它只负责开块与登记名字/身份，把空增量发下去对下游没有信息。
      if (argumentsDelta !== '') {
        chunks.push({
          type: 'tool-call-delta',
          index: state.index,
          id: state.id ?? `call-${state.index}`,
          // 空名字要省略：宿主把 `name: ''` 视为无名字的工具调用并把整个分片降级。
          ...state.name === undefined ? {} : { name: state.name },
          argumentsDelta,
        });
      }
      return chunks;
    },
    /**
     * 关闭所有已开启的块，产出 `block-end`（block 是完整内容块）。
     * @returns {object[]}
     */
    closeAll() {
      return order.map((state) => ({
        type: 'block-end',
        index: state.index,
        block: state.kind === 'tool-call'
          ? {
            type: 'tool-call',
            id: state.id ?? `call-${state.index}`,
            name: state.name ?? '',
            // 工具参数以原始 JSON 字符串交付，绝不重新序列化。
            arguments: state.text,
          }
          : { type: state.kind, text: state.text },
      }));
    },
    /** 已开启的块数量（诊断用）。 */
    get size() {
      return order.length;
    },
  };
}

/**
 * 驱动一遍上游数据帧流，并在末尾补齐协议要求的收尾分片。
 *
 * @param {AsyncIterable<string>} payloads 逐帧的 `data:` 载荷（JSON 文本）
 * @param {{signal?: AbortSignal, decode: (payload: string, tracker: object, state: object) => object[] | undefined}} options
 *   `decode` 负责把一个载荷映射为分片；它同时可以写 `state.usage`、`state.truncated`、`state.done`
 * @returns {AsyncGenerator<object>} 分片流
 */
export async function* driveWireStream(payloads, { signal, decode }) {
  const tracker = createBlockTracker();
  /** @type {{usage?: object, truncated: boolean, done: boolean}} */
  const state = { truncated: false, done: false };
  let aborted = false;

  try {
    for await (const payload of payloads) {
      if (state.done) break;
      const chunks = decode(payload, tracker, state);
      if (chunks === undefined) continue;
      for (const chunk of chunks) yield chunk;
    }
  } catch (error) {
    // 调用方取消时不再向外抛：本流仍须以恰好一个终止 finish 收尾，且形态为取消。
    if (signal?.aborted === true) aborted = true;
    else throw error;
  }

  // 取消时上游已断，不再补 block-end（宿主用 interruptedBlocks() 处理未闭合的块）。
  if (!aborted) {
    for (const chunk of tracker.closeAll()) yield chunk;
  }
  if (state.usage !== undefined) yield { type: 'usage', usage: state.usage };
  yield {
    type: 'finish',
    reason: aborted
      ? {
        kind: 'aborted',
        failure: Object.freeze({ message: 'the request was aborted by the caller', code: ABORTED_CODE }),
      }
      : { kind: state.truncated ? 'max-tokens' : 'stop' },
  };
}

/**
 * 读取一帧载荷的 JSON。无法解析的帧（心跳、注释行）返回 `undefined`。
 * @param {string} payload
 * @returns {unknown}
 */
export function parsePayload(payload) {
  if (typeof payload !== 'string') return undefined;
  const trimmed = payload.trim();
  if (trimmed === '' || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
