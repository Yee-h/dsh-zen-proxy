/**
 * 上游失败的分类与失败对象构造。
 *
 * 分类只依据网关错误信封里的 `type` 与 HTTP 状态码，**不解析自然语言文本**作为主依据。
 * 实测到的信封形状（全部来自真实上游）：
 *
 * ```text
 * 403 {"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}
 * 403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}
 * 426 {"type":"error","error":{"type":"UpgradeRequired","message":"OpenCode 1.18.0 or newer is required to use the free tier"}}
 * 401 {"type":"error","error":{"type":"ModelError","message":"Model no-such-model-free is not supported"}}
 * 503 {"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}}
 * 500 {"type":"error","error":{"type":"error","message":"Internal server error"}}
 * ```
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。失败对象也不从宿主
 * 包里构造——`@deepseek-ai/dsh-llm` 在本仓库不可解析。宿主 `normalizeLlmFailure` 会在
 * 「Error 同时带自有数据属性 `code` 与 `failure`，且 `failure.code === error.code`」时
 * 原样采用我们给出的 `failure`，因此这里按该约定构造并抛出即可。
 *
 * @module src/failure.js
 */

/** 宿主已文档化的提供方中立失败码。不自造新码。 */
export const FAILURE_CODE = Object.freeze({
  /** 401/403，含地区受限与身份／版本被拒 */
  auth: 'AUTH',
  /** 429 且未指名额度耗尽 */
  rateLimit: 'RATE_LIMIT',
  /** 额度耗尽类错误 */
  quota: 'QUOTA',
  /** 5xx 与信封 type 为 `server_error` 的上游故障 */
  server: 'SERVER',
  /** 网络失败 */
  transport: 'TRANSPORT',
  /** 超时与取消 */
  timeout: 'TIMEOUT',
  /** 其余 */
  unknown: 'UNKNOWN',
});

/** 失败影响的范围：单个模型，还是整条插件车道。 */
export const FAILURE_SCOPE = Object.freeze({ model: 'model', plugin: 'plugin' });

/** 失败的时间性质：瞬时故障有宽限，终局故障立即改写判定。 */
export const FAILURE_DISPOSITION = Object.freeze({ transient: 'transient', terminal: 'terminal' });

/** 地区受限：模型存在，但当前出口国家被排除。 */
const REGION_TYPES = new Set(['RegionError']);

/** 身份或版本被拒：整条车道的问题，与具体模型无关。 */
const IDENTITY_TYPES = new Set(['FreeTierError', 'UpgradeRequired', 'SubscriptionError']);

/** 网关明确指名该模型不可路由。 */
const MODEL_TYPES = new Set(['ModelError']);

/** 上游自身故障。 */
const SERVER_TYPES = new Set(['server_error', 'ServerError', 'api_error', 'overloaded_error']);

/** 限流与额度类。 */
const RATE_TYPES = new Set(['FreeUsageLimitError', 'RateLimitError', 'rate_limit', 'insufficient_quota']);

/**
 * 「额度耗尽」而非普通限流的判据，照抄宿主 `isQuotaExceededError` 文档化的语义：
 * 只有明确的 quota / balance / credit / budget / usage-limit 措辞才算额度耗尽。
 * 例：`FreeUsageLimitError` 的 `"Rate limit exceeded. Please try again later."` 不匹配
 * （"Rate limit" 不是 "usage limit"），因而是 RATE_LIMIT。
 */
const QUOTA_PATTERNS = Object.freeze([
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
]);

/**
 * 读取网关错误信封里的 `type` 与 `message`。
 * 兼容两种实测形状：`{error:{type,message}}` 与 `{type:'error', error:{…}}`。
 * @param {unknown} payload 已解析的响应体或 SSE 数据帧
 * @returns {{type: string, message: string} | undefined} 未携带错误信封时为 `undefined`
 */
export function readErrorEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const inner = payload.error;
  if (typeof inner === 'object' && inner !== null) {
    return {
      type: typeof inner.type === 'string' ? inner.type : '',
      message: typeof inner.message === 'string' ? inner.message : '',
    };
  }
  if (payload.type === 'error' && typeof payload.message === 'string') {
    return { type: 'error', message: payload.message };
  }
  return undefined;
}

/**
 * 判定一个错误信封是否在指名「额度耗尽」而非普通限流。
 * @param {string} type
 * @param {string} message
 * @returns {boolean}
 */
function isQuotaExhaustion(type, message) {
  const detail = `${type} ${message}`;
  return QUOTA_PATTERNS.some((pattern) => pattern.test(detail));
}

/**
 * 把一个上游失败分类为宿主失败码 + 影响范围 + 时间性质。
 * @param {{status?: number, type?: string, message?: string, retryAfterMs?: number, requestId?: string}} input
 * @returns {{code: string, scope: string, disposition: string, region: boolean, message: string,
 *            status?: number, providerRetryAfterMs?: number, requestId?: string, upstreamType: string}}
 */
export function classifyUpstreamFailure({ status, type = '', message = '', retryAfterMs, requestId } = {}) {
  const text = message !== '' ? message : `upstream request failed${status === undefined ? '' : ` (HTTP ${status})`}`;
  const base = {
    message: text,
    upstreamType: type,
    ...typeof requestId === 'string' && requestId !== '' ? { requestId } : {},
  };

  if (REGION_TYPES.has(type)) {
    return {
      ...base,
      code: FAILURE_CODE.auth,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.terminal,
      region: true,
      ...statusField(status),
    };
  }
  if (IDENTITY_TYPES.has(type)) {
    return {
      ...base,
      code: FAILURE_CODE.auth,
      scope: FAILURE_SCOPE.plugin,
      disposition: FAILURE_DISPOSITION.terminal,
      region: false,
      ...statusField(status),
    };
  }
  if (MODEL_TYPES.has(type)) {
    return {
      ...base,
      code: FAILURE_CODE.unknown,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.terminal,
      region: false,
      ...statusField(status),
    };
  }
  if (SERVER_TYPES.has(type)) {
    return {
      ...base,
      code: FAILURE_CODE.server,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.transient,
      region: false,
      ...statusField(status),
    };
  }
  if (RATE_TYPES.has(type)) {
    return {
      ...base,
      code: isQuotaExhaustion(type, text) ? FAILURE_CODE.quota : FAILURE_CODE.rateLimit,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.transient,
      region: false,
      ...statusField(status),
      ...retryAfterField(retryAfterMs),
    };
  }

  // 未被识别的 type：退回状态码。
  if (status === 429) {
    return {
      ...base,
      code: isQuotaExhaustion(type, text) ? FAILURE_CODE.quota : FAILURE_CODE.rateLimit,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.transient,
      region: false,
      status,
      ...retryAfterField(retryAfterMs),
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      ...base,
      code: FAILURE_CODE.server,
      scope: FAILURE_SCOPE.model,
      disposition: FAILURE_DISPOSITION.transient,
      region: false,
      status,
    };
  }
  if (status === 401 || status === 403 || status === 426) {
    return {
      ...base,
      code: FAILURE_CODE.auth,
      scope: FAILURE_SCOPE.plugin,
      disposition: FAILURE_DISPOSITION.terminal,
      region: false,
      status,
    };
  }
  return {
    ...base,
    code: FAILURE_CODE.unknown,
    scope: FAILURE_SCOPE.model,
    disposition: FAILURE_DISPOSITION.terminal,
    region: false,
    ...statusField(status),
  };
}

function statusField(status) {
  return typeof status === 'number' ? { status } : {};
}

function retryAfterField(retryAfterMs) {
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? { providerRetryAfterMs: retryAfterMs }
    : {};
}

/**
 * 把 fetch/读取层的异常分类为传输或超时失败。
 * @param {unknown} error
 * @param {string} [requestId]
 * @returns {object} 与 {@link classifyUpstreamFailure} 同形的分类结果
 */
export function classifyThrownError(error, requestId) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const aborted = name === 'AbortError' || name === 'TimeoutError';
  const cause = typeof error?.cause?.code === 'string' ? ` (${error.cause.code})` : '';
  return {
    code: aborted ? FAILURE_CODE.timeout : FAILURE_CODE.transport,
    scope: FAILURE_SCOPE.model,
    disposition: FAILURE_DISPOSITION.transient,
    region: false,
    message: `${aborted ? 'upstream request timed out' : 'upstream transport failed'}: ${
      typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
    }${cause}`,
    upstreamType: '',
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * 构造一个可被宿主 `normalizeLlmFailure` 原样采用的失败对象。
 *
 * 两个属性都必须是**自有数据属性**（普通赋值即可），且 `failure.code === error.code`；
 * 否则宿主会退回到自己的 `UNKNOWN` 分类并丢掉这里的原因。
 * @param {object} classification {@link classifyUpstreamFailure} 或 {@link classifyThrownError} 的结果
 * @returns {Error & {code: string, failure: object}}
 */
export function createUpstreamError(classification) {
  const message = typeof classification.message === 'string' && classification.message !== ''
    ? classification.message
    : 'upstream request failed';
  const error = new Error(message);
  error.name = 'ZenUpstreamError';
  error.code = classification.code;
  error.failure = Object.freeze({
    message,
    code: classification.code,
    ...typeof classification.status === 'number' && Number.isInteger(classification.status)
      && classification.status >= 100 && classification.status <= 599
      ? { status: classification.status }
      : {},
    ...typeof classification.providerRetryAfterMs === 'number'
      && Number.isFinite(classification.providerRetryAfterMs) && classification.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: classification.providerRetryAfterMs }
      : {},
    ...typeof classification.requestId === 'string' && classification.requestId !== ''
      ? { requestId: classification.requestId }
      : {},
  });
  // 便于调用方（探测、日志）读到分类细节，同样只挂自有数据属性。
  error.classification = classification;
  return error;
}

/**
 * 从 HTTP 响应头读取 `retry-after`，转成毫秒。
 * @param {string | null} value
 * @returns {number | undefined}
 */
export function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? delta : undefined;
}
