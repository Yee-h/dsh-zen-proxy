/**
 * 判定状态机与持久化。
 *
 * 每个候选模型持有 `available` / `region` / `unavailable` / `unknown` 之一，另有一个
 * 「连续瞬时故障计数」。规则（design D8 + spec 的「瞬时故障宽限」）：
 *
 * - `available` / `region` / `unavailable` 直接改写，并把计数清零；
 * - 瞬时故障（限流、上游 5xx、网络失败）在**连续 3 次以内保留前值**，第 3 次才转
 *   `unavailable`。免费车道本身不稳（本机实测过上游 503），若一次抖动就清空目录，
 *   模型选择器会持续抖动；同理，地区判定不会被一次 429 覆盖；
 * - 插件级失败（身份／版本被拒）与具体模型无关：整条车道降级，全部模型转 `unknown`。
 *
 * 持久化用「先写临时文件再原子改名」，文件缺失或不可解析时按无历史处理且不抛错。
 * 状态目录从宿主环境解析（`DSH_HOME` → 宿主配置根），**不写死**任何用户目录路径。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/state.js
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

import { PROBE_STATE } from './probe.js';

/** 状态文件结构版本；形状或含义变化时递增。 */
export const STATE_VERSION = 1;

/** 状态目录名（相对宿主配置根）。 */
export const DATA_DIR_NAME = 'zen-proxy';

/** 状态文件名。 */
export const STATE_FILE_NAME = 'availability.json';

/** 连续多少次瞬时故障后把模型移出目录。 */
export const TRANSIENT_GRACE = 3;

/** 模型状态取值。 */
export const MODEL_STATE = Object.freeze({
  available: 'available',
  region: 'region',
  unavailable: 'unavailable',
  unknown: 'unknown',
});

/** 诊断码。 */
export const DIAGNOSTIC = Object.freeze({
  identityRejected: 'IDENTITY_REJECTED',
  modelUnknown: 'MODEL_VERDICT_UNKNOWN',
  graceExpired: 'TRANSIENT_GRACE_EXPIRED',
});

const MODEL_STATES = new Set(Object.values(MODEL_STATE));

/**
 * 解析状态目录：`DSH_HOME` → 宿主配置根（`<home>/.dsh`），再拼上 {@link DATA_DIR_NAME}。
 * @param {{env?: Record<string, string | undefined>, home?: string}} [input]
 * @returns {string}
 */
export function resolveStateDir({ env = {}, home } = {}) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const base = home !== undefined && home !== '' ? home : os.homedir();
  const root = fromEnv !== '' ? fromEnv : join(base, '.dsh');
  return join(root, DATA_DIR_NAME);
}

/**
 * 状态文件的完整路径。
 * @param {{env?: Record<string, string | undefined>, home?: string, stateDir?: string}} [input]
 * @returns {string}
 */
export function resolveStateFile(input = {}) {
  const dir = input.stateDir !== undefined && input.stateDir !== ''
    ? input.stateDir
    : resolveStateDir(input);
  return join(dir, STATE_FILE_NAME);
}

/**
 * 空状态（无历史判定）。
 * @returns {{version: number, updatedAt: number, models: Record<string, object>}}
 */
export function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, models: {} };
}

/**
 * 校验并规范化一个从磁盘读到的状态对象。
 * @param {unknown} value
 * @returns {object | undefined} 形状不合法时返回 `undefined`
 */
function normalizeState(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  if (value.version !== STATE_VERSION) return undefined;
  const models = value.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return undefined;
  const normalized = {};
  for (const [id, entry] of Object.entries(models)) {
    if (typeof id !== 'string' || id === '') continue;
    if (typeof entry !== 'object' || entry === null) continue;
    if (!MODEL_STATES.has(entry.state)) continue;
    normalized[id] = {
      state: entry.state,
      transientStreak: Number.isSafeInteger(entry.transientStreak) && entry.transientStreak > 0
        ? entry.transientStreak
        : 0,
      ...Number.isFinite(entry.checkedAt) ? { checkedAt: entry.checkedAt } : {},
      ...typeof entry.detail === 'string' && entry.detail !== '' ? { detail: entry.detail } : {},
    };
  }
  return {
    version: STATE_VERSION,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    models: normalized,
  };
}

/**
 * 读取状态文件；缺失、被截断或含非法 JSON 时按无历史处理。
 * @param {string} filePath
 * @returns {object} 状态对象，永不抛错
 */
export function loadState(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    return normalizeState(JSON.parse(text)) ?? emptyState();
  } catch {
    return emptyState();
  }
}

/**
 * 原子保存状态：先写临时文件再改名，避免读到半份文件。
 * @param {string} filePath
 * @param {object} state
 * @returns {boolean} 写入成功为 `true`
 */
export function saveState(filePath, state) {
  const temporary = `${filePath}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    renameSync(temporary, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一整套判定（含模型列表与每模型结果）折算成新状态。
 *
 * @param {object} previous 之前的状态
 * @param {{models?: string[], results?: Record<string, {state: string, detail?: string}>,
 *          now?: number, pluginFailure?: object | null}} round
 *   `results` 的键是模型 id；缺少结果的候选模型保留原判定
 * @returns {{state: object, diagnostics: object[]}}
 */
export function reduceRound(previous, { models = [], results = {}, now = Date.now(), pluginFailure = null } = {}) {
  const diagnostics = [];
  const next = {};
  const order = [];
  const seen = new Set();
  for (const id of models) {
    if (!seen.has(id)) { seen.add(id); order.push(id); }
  }
  for (const id of Object.keys(previous?.models ?? {})) {
    if (!seen.has(id)) { seen.add(id); order.push(id); }
  }

  if (pluginFailure !== null && pluginFailure !== undefined) {
    diagnostics.push({
      code: DIAGNOSTIC.identityRejected,
      message: `上游以身份或版本原因拒绝了整条车道：${pluginFailure.message}`,
      upstreamType: pluginFailure.upstreamType ?? '',
      status: pluginFailure.status,
    });
    for (const id of order) {
      next[id] = { state: MODEL_STATE.unknown, transientStreak: 0, checkedAt: now };
    }
    return { state: { version: STATE_VERSION, updatedAt: now, models: next }, diagnostics };
  }

  for (const id of order) {
    const prior = previous?.models?.[id];
    const result = results[id];
    if (result === undefined) {
      // 本轮没有探测结果（例如模型刚出现）：保留原值或维持 unknown。
      next[id] = prior ?? { state: MODEL_STATE.unknown, transientStreak: 0 };
      continue;
    }

    const streak = prior?.transientStreak ?? 0;
    if (result.state === PROBE_STATE.transient) {
      const nextStreak = streak + 1;
      if (prior !== undefined && nextStreak < TRANSIENT_GRACE) {
        next[id] = { ...prior, transientStreak: nextStreak, checkedAt: now };
        continue;
      }
      if (nextStreak === TRANSIENT_GRACE) {
        diagnostics.push({
          code: DIAGNOSTIC.graceExpired,
          message: `模型 ${id} 连续 ${TRANSIENT_GRACE} 次瞬时故障，移出目录`,
          modelId: id,
        });
      }
      next[id] = {
        state: MODEL_STATE.unavailable,
        transientStreak: nextStreak,
        checkedAt: now,
        ...result.detail === undefined ? {} : { detail: result.detail },
      };
      continue;
    }

    const mapped = mapVerdict(result.state);
    if (mapped === MODEL_STATE.unknown) {
      diagnostics.push({
        code: DIAGNOSTIC.modelUnknown,
        message: `模型 ${id} 的探测结果无法归类：${result.detail ?? '未知原因'}`,
        modelId: id,
      });
    }
    next[id] = {
      state: mapped,
      transientStreak: 0,
      checkedAt: now,
      ...result.detail === undefined ? {} : { detail: result.detail },
    };
  }

  return { state: { version: STATE_VERSION, updatedAt: now, models: next }, diagnostics };
}

/** 探测判定 → 模型状态。 */
function mapVerdict(state) {
  switch (state) {
    case PROBE_STATE.available: return MODEL_STATE.available;
    case PROBE_STATE.region: return MODEL_STATE.region;
    case PROBE_STATE.unavailable: return MODEL_STATE.unavailable;
    default: return MODEL_STATE.unknown;
  }
}

/**
 * 取某个状态下的全部模型 id（保持状态里的插入顺序）。
 * @param {object} state
 * @param {string} verdict {@link MODEL_STATE} 之一
 * @returns {string[]}
 */
export function modelsWithVerdict(state, verdict) {
  const models = state?.models ?? {};
  return Object.keys(models).filter((id) => models[id]?.state === verdict);
}

/**
 * 某个模型当前的状态（未知模型返回 `unknown`）。
 * @param {object} state
 * @param {string} modelId
 * @returns {string}
 */
export function verdictOf(state, modelId) {
  return state?.models?.[modelId]?.state ?? MODEL_STATE.unknown;
}
