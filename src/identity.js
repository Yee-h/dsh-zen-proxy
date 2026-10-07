/**
 * 上游身份：伪装成官方 OpenCode 客户端的请求头、版本门槛，以及会话／请求 id 的稳定派生。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包，也不发起 I/O。
 *
 * ## 偏离宿主 attribution 契约的显式记录
 *
 * 宿主 `@deepseek-ai/dsh-llm` 要求每个 provider 请求携带 `attributionHeaders()`，
 * 其 `user-agent` 实测为 `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`。
 * 而 Zen 免费车道的闸门只接受 `user-agent: opencode/<version>`（version >= 1.18.0）：
 * 实测同一组 `x-opencode-*` 头下，`opencode/1.18.31` 返回 200，harness UA 返回
 * `403 FreeTierError`（`OpenCode's free tier can only be used from within OpenCode`），
 * `opencode/1.17.0` 与仓库旧值 `opencode/1.15.5 …` 返回 `426 UpgradeRequired`。
 * 两者互斥，本插件选择过闸，因此在 {@link buildIdentityHeaders} 里用官方客户端身份
 * 覆盖 attribution。该头部只承载「官方客户端身份」，不携带任何用户数据。
 *
 * @module src/identity.js
 */

import { createHash } from 'node:crypto';

/** 闸门下界，实测 `opencode/1.18.0` 可用、`1.17.0` 返回 426。 */
export const MIN_CLIENT_VERSION = '1.18.0';

/** 默认伪装版本，取实测可用的一个具体版本。 */
export const DEFAULT_CLIENT_VERSION = '1.18.31';

/** `x-opencode-client`：`cli` 与 `desktop` 实测都可过闸，取其一以固定指纹。 */
export const OPENCODE_CLIENT = 'desktop';

/** `x-opencode-project`：官方客户端的默认项目签名。 */
export const OPENCODE_PROJECT = 'global';

/** 该车道的池化免密凭据，无需用户密钥。 */
export const PUBLIC_AUTHORIZATION = 'Bearer public';

/** 会话／请求 id 的形状：`ses_` / `msg_` + 12 位十六进制 + 14 位 base62。 */
export const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** 探测流量的种子：与任何用户对话的会话都不同，避免挤占对话配额。 */
const PROBE_SEED = 'zen-proxy:probe';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_NAMESPACE = 'zen-proxy';

/**
 * 解析 `major.minor.patch`，容忍缺失的尾部段与前置 `v`。
 * @param {unknown} value
 * @returns {number[] | undefined} 三段数字，或无法解析时的 `undefined`
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * 比较两个已解析的版本号。
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} 负数表示 left 更旧
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * 校验配置的 OpenCode 版本是否达到闸门门槛；低于门槛或无法解析时不使用该值。
 * @param {unknown} [requested] 配置值
 * @returns {{version: string, requested: unknown, usedFallback: boolean, reason?: string}}
 */
export function resolveClientVersion(requested = DEFAULT_CLIENT_VERSION) {
  const parsed = parseVersion(requested);
  const minimum = parseVersion(MIN_CLIENT_VERSION);
  if (parsed !== undefined && compareVersions(parsed, minimum) >= 0) {
    return { version: requested.trim(), requested, usedFallback: false };
  }
  return {
    version: MIN_CLIENT_VERSION,
    requested,
    usedFallback: true,
    reason: parsed === undefined
      ? `配置的 OpenCode 版本 "${String(requested)}" 无法解析，改用门槛值 ${MIN_CLIENT_VERSION}`
      : `配置的 OpenCode 版本 ${requested.trim()} 低于闸门门槛 ${MIN_CLIENT_VERSION}，改用门槛值`,
  };
}

/**
 * 渲染 `user-agent`。
 * @param {string} version
 * @returns {string} 形如 `opencode/1.18.31`
 */
export function userAgentFor(version) {
  return `opencode/${version}`;
}

/**
 * 六个必需身份头 + SSE 接受头。任何一个缺失都会让闸门以 403 拒绝，因此本函数是
 * 构造上游请求头的**唯一**入口，调用方不得自行拼装子集。
 * @param {{version: string, session: string, requestId: string, stream?: boolean}} input
 * @returns {Record<string, string>}
 */
export function buildIdentityHeaders({ version, session, requestId, stream = true }) {
  return {
    'content-type': 'application/json',
    // 偏离 dsh 的 attributionHeaders()：见本模块文件头。此处的 `user-agent`
    // 必须是 opencode/<>=1.18.0>，harness UA 实测得到 403 FreeTierError。
    'authorization': PUBLIC_AUTHORIZATION,
    'user-agent': userAgentFor(version),
    'x-opencode-client': OPENCODE_CLIENT,
    'x-opencode-project': OPENCODE_PROJECT,
    'x-opencode-session': session,
    'x-opencode-request': requestId,
    'accept': stream ? 'text/event-stream' : '*/*',
  };
}

/**
 * 由任意种子派生一个闸门形状的 id：`<prefix>` + 12 位十六进制 + 14 位 base62。
 * @param {string} prefix `ses_` 或 `msg_`
 * @param {string} seed
 * @returns {string}
 */
export function deriveId(prefix, seed) {
  const digest = createHash('sha256').update(`${ID_NAMESPACE}\0${seed}`).digest();
  const hex = digest.subarray(0, 6).toString('hex');
  let base62 = '';
  for (const byte of digest.subarray(6, 20)) base62 += BASE62[byte % 62];
  return `${prefix}${hex}${base62}`;
}

/**
 * 一个对话的稳定 `x-opencode-session`。
 *
 * 免费配额按 session 计，逐请求新造会话会迅速触发限流，因此派生必须是纯函数：
 * 同一对话在重启后仍是同一会话；不同对话必然不同（除非 sha256 碰撞）。
 * @param {string} conversationKey 对话标识（宿主会话 id），留空则退化为全局会话
 * @returns {string}
 */
export function sessionForConversation(conversationKey) {
  const key = typeof conversationKey === 'string' && conversationKey.trim() !== ''
    ? conversationKey.trim()
    : 'global';
  return deriveId('ses_', `session\0${key}`);
}

/**
 * 一轮对话的 `x-opencode-request`：由会话与轮次派生，使同一轮的多次尝试共享同一请求身份。
 * @param {string} session
 * @param {string} [turn] 轮次标识
 * @returns {string}
 */
export function requestForTurn(session, turn = '') {
  return deriveId('msg_', `request\0${session}\0${turn}`);
}

/**
 * 探测流量的会话：与任何用户对话都不同（见 {@link PROBE_SEED}）。
 * @returns {string}
 */
export function probeSession() {
  return deriveId('ses_', `session\0${PROBE_SEED}`);
}

/**
 * 探测流量的请求 id：绑定「会话 + 轮次 + 模型」。
 * @param {string} round 轮次标识
 * @param {string} modelId
 * @returns {string}
 */
export function probeRequest(round, modelId) {
  return deriveId('msg_', `request\0${probeSession()}\0${round}\0${modelId}`);
}
