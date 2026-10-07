/**
 * 上游模型清单的解析、免费过滤、协议族判定与能力元数据。
 *
 * 实测 `GET https://opencode.ai/zen/v1/models`（200，`application/json`，7232 字节）：
 *
 * ```json
 * {"object":"list","data":[{"id":"claude-fable-5","object":"model","created":1791377709,"owned_by":"opencode"}]}
 * ```
 *
 * 清单里**只有** 4 个字段：`id`、`object`（恒为 `"model"`）、`created`、`owned_by`
 * （恒为 `"opencode"`）。没有表示「免费」的字段，没有表示「协议族」的字段，
 * 也没有上下文窗口或输出上限。详情端点也不存在：`/zen/v1/models/<id>` 返回 404
 * （HTML），`?include=capabilities` 返回同一份 7232 字节清单。因此：
 *
 * - 免费判定 = id 以 `-free` 结尾（spec 的「目录只公布免费且可用的模型」定义）；
 * - 协议族判定 = 按 id 决定端点（design D11）；
 * - 上下文窗口 = 只在有可溯源来源时才给（见 {@link CONTEXT_WINDOW_SOURCE}）。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/catalog.js
 */

/** 唯一允许写死的网络地址：上游 base URL。 */
export const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

export const MODELS_PATH = '/models';
export const CHAT_COMPLETIONS_PATH = '/chat/completions';
export const RESPONSES_PATH = '/responses';

/** 免费车道的 id 后缀。 */
export const FREE_SUFFIX = '-free';

/** 能力表里没有可溯源窗口的模型的诊断码。 */
export const CATALOG_METADATA_UNKNOWN = 'CATALOG_METADATA_UNKNOWN';

/**
 * 上下文窗口的**唯一**来源说明。来源数据取自 Zen 的已发布目录，
 * 运行时**不**请求该地址（design 的「插件自包含」目标）。
 *
 * 来源 URL：https://models.dev/api.json（`opencode` provider 的 `limit.context`）
 * 取值日期：2026-10-07
 *
 * 逐条溯源（模型 id → limit.context）：
 *   exo-free 1048576
 *   fledge-alpha-free 1048576
 *   ling-3.0-flash-fin-free 262144
 *   ling-3.1-flash-free 262144
 *   longcat-2.5-preview-free 1000000
 *   mimo-v2.6-flash-free 200000
 *   muse-spark-1.2-contributor-free 1048576
 *   muse-spark-1.3-contributor-free 1048576
 *   nemotron-3.5-lightning-free 262144
 *   nemotron-3-ultra-free 1000000
 *   space-bunny-free 1048576
 *
 * 不在本表中的 id 一律省略 `context` 字段，并且**不**用保守下限或家族猜测填充
 * （Zen 清单里的 `jev-1.13-free` 就是这种情形：上游在列，models.dev 的 opencode
 * provider 里没有它）。目录是否呈现只由「免费 + 可用」决定，与元数据完整度无关。
 *
 * @type {Readonly<Record<string, number>>}
 */
export const CONTEXT_WINDOW_SOURCE = Object.freeze({
  'exo-free': 1048576,
  'fledge-alpha-free': 1048576,
  'ling-3.0-flash-fin-free': 262144,
  'ling-3.1-flash-free': 262144,
  'longcat-2.5-preview-free': 1000000,
  'mimo-v2.6-flash-free': 200000,
  'muse-spark-1.2-contributor-free': 1048576,
  'muse-spark-1.3-contributor-free': 1048576,
  'nemotron-3.5-lightning-free': 262144,
  'nemotron-3-ultra-free': 1000000,
  'space-bunny-free': 1048576,
});

/**
 * responses 协议族的 id 模式。
 *
 * 上游清单不披露协议族（实测每项只有 `id`/`object`/`created`/`owned_by`），因此只能按 id
 * 判定（design D11 授权）。本模式的依据是**间接**的，且在本机出口（CN）无法证真：
 *
 * - 这两个 id 发到 `/responses` 得到 403 `RegionError`；
 * - 但它们发到 `/chat/completions` **同样**返回 403 `RegionError`——地区闸门先于路由判定，
 *   所以这条**不能**证明「该端点接受这个 id」；
 * - chat 族模型发到 `/responses` 得到 `500 server_error`，既可能是该端点不接受这个 id，
 *   也可能是无关的上游故障；
 * - 社区同类实现收敛到**逐字相同**的模式：`dsh-our-free-model` 的 `isMuseSpark`
 *   （`upstream.js:104-108`）用 `/^muse[-_]?spark(?:$|[-_:.\s])/i`，与本模块
 *   `RESPONSES_ID_PATTERN`（同文件下方常量）逐字相同，并经 `isResponsesModel`
 *   → `endpointFor` 驱动端点选择（`upstream.js:110-123`）。两个独立实现从同一上游行为
 *   收敛出同一正则，是这条间接判据最实的支撑。
 *
 * 猜错的代价有限：只影响这一个 id 走哪个端点，不影响其它模型；而在本机这些 id 恒被地区闸门
 * 拦住，真实链路无从区分。详见 evidence.md 的「协议族的判据（间接；本机无法证真）」。
 */
const RESPONSES_ID_PATTERN = /^muse[-_]?spark(?:$|[-_:.\s])/i;

/**
 * 解析清单响应体为 id 列表（去重、保持上游顺序）。
 * @param {unknown} payload
 * @returns {string[]}
 */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

/**
 * 免费车道判定：id 以 `-free` 结尾。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isFreeModel(modelId) {
  return typeof modelId === 'string' && modelId.endsWith(FREE_SUFFIX) && modelId.length > FREE_SUFFIX.length;
}

/**
 * 从清单响应体里取出候选免费模型 id。
 * @param {unknown} payload
 * @returns {string[]}
 */
export function freeCandidates(payload) {
  return parseListing(payload).filter(isFreeModel);
}

/**
 * 去掉 id 上的模型级后缀，得到用于模式匹配的基名。
 * @param {unknown} modelId
 * @returns {string}
 */
export function baseModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const withoutSuffix = raw.replace(/\([^()]*\)\s*$/, '').trim();
  return withoutSuffix.includes('/') ? withoutSuffix.split('/').pop() : withoutSuffix;
}

/**
 * 该模型是否由 responses 协议族提供。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isResponsesModel(modelId) {
  return RESPONSES_ID_PATTERN.test(baseModelId(modelId));
}

/**
 * 该模型走哪个协议族。
 * @param {unknown} modelId
 * @returns {'chat' | 'responses'}
 */
export function wireFor(modelId) {
  return isResponsesModel(modelId) ? 'responses' : 'chat';
}

/**
 * 协议族对应的上游路径。
 * @param {'chat' | 'responses'} wire
 * @returns {string}
 */
export function pathForWire(wire) {
  return wire === 'responses' ? RESPONSES_PATH : CHAT_COMPLETIONS_PATH;
}

/**
 * 模型的上游端点路径。
 * @param {unknown} modelId
 * @returns {string}
 */
export function pathForModel(modelId) {
  return pathForWire(wireFor(modelId));
}

/**
 * 可溯源的上下文窗口；没有来源时返回 `undefined`（调用方须省略该字段）。
 * @param {unknown} modelId
 * @returns {number | undefined}
 */
export function contextWindowFor(modelId) {
  const base = baseModelId(modelId);
  const value = CONTEXT_WINDOW_SOURCE[base];
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 该模型是否有可溯源的能力元数据。
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function hasTraceableCapabilities(modelId) {
  return contextWindowFor(modelId) !== undefined;
}

/**
 * 把上游 id 渲染成可供模型选择器展示的名字。
 * @param {unknown} modelId
 * @returns {string}
 */
export function displayNameFor(modelId) {
  const base = baseModelId(modelId);
  if (base === '') return String(modelId ?? '');
  return base
    // 只把 `-` 与 `_` 当词分隔符：`.` 是版本号的一部分（`3.5` 不能被拆成 `3 5`）。
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}
