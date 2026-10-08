/**
 * 思考强度档位与输出预算的折算。
 *
 * 上游没有「思考强度」这个概念：本车道的网关接受 `reasoning_effort`、
 * `thinking.budget_tokens`、`enable_thinking`、`thinking_budget` 之后全部忽略它们，
 * 唯一被执行的强度旋钮是**输出预算上限**（实测见变更 `add-reasoning-effort-control`
 * 的 `evidence.md` (1)；此前归档的 `add-opencode-free-provider` 只测过「上游接受不带
 * 上限的请求」，没有强度字段的对照）。
 * 宿主又要求适配器在精确模型信息里给出 `reasoning.efforts` 才会渲染档位菜单，
 * 否则用户只能看到模型、无法调节强度。两边的差集由本模块填：把档位翻译成请求体
 * 的 `max_tokens` / `max_output_tokens`。
 *
 * 数字的来源：
 *
 * - 档位基准为 2048 与 8192 输出上限，再乘 {@link ALWAYS_THINKING_FACTOR}：
 *   输出上限同时限制思考与正文，倍率 2 对应「思考占比不超过 50%」这一边界
 *   （正文 = 2 × 基准 × (1 − 占比) ≥ 基准 ⟺ 占比 ≤ 50%），即档位名里的数字是正文的下界。
 *   参考实现曾在 `mimo-v2.6-flash-free` 上测得约 82% 的输出 token 是思考（92 次调用，
 *   见本变更的 `evidence.md` (2b)），本机复核同一模型为 33%-43%；82% 与该系数**不相容**
 *   （该占比下正文只剩约 737 token），本机未复现该占比，故不按它标定。本机 `light` 档实测
 *   正文 3117 token（预算 4096、思考 979），落在边界内。
 * - 模型容量取 `models.dev` 的 `limit.output`（溯源表在 `src/catalog.js`）；
 *   无溯源时回退到 {@link FALLBACK_OUTPUT_LIMIT}。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/effort.js
 */

/** 输出上限同时限制思考与正文，因此档位基准要按此倍率放大。 */
export const ALWAYS_THINKING_FACTOR = 2;

/** 预算下界：再小的上限都会把回复压没，宁可超出档位基准也不低于此值。 */
export const MIN_BUDGET = 512;

/** 模型没有可溯源输出上限时的容量回退值。 */
export const FALLBACK_OUTPUT_LIMIT = 32768;

/** 默认档位 id，宿主在调用方未指定档位时使用。 */
export const DEFAULT_EFFORT = 'balanced';

/**
 * 档位表。`ceiling` 是基准上限，`undefined` 表示「取模型自身容量」。
 * @type {ReadonlyArray<{id: string, name: string, ceiling: number | undefined, hint: string}>}
 */
export const LEVELS = Object.freeze([
  Object.freeze({ id: 'light', name: '精简', ceiling: 2048, hint: '最短思考，最快给出答案' }),
  Object.freeze({ id: 'balanced', name: '均衡', ceiling: 8192, hint: '思考与正文各占一半' }),
  Object.freeze({ id: 'deep', name: '深度', ceiling: undefined, hint: '尽量思考，正文可能先被截断' }),
]);

const DEFAULT_LEVEL = LEVELS.find((entry) => entry.id === DEFAULT_EFFORT);

/**
 * 把宿主给出的档位 id 解析成档位表条目；未知档位回退到默认档。
 * @param {unknown} level
 * @returns {{id: string, name: string, ceiling: number | undefined, hint: string}}
 */
export function resolveEffort(level) {
  if (typeof level === 'string') {
    const found = LEVELS.find((entry) => entry.id === level);
    if (found !== undefined) return found;
  }
  return DEFAULT_LEVEL;
}

/**
 * 把可能缺失、可能是垃圾的上限值收敛成可用于取小的数。
 * `0`、负数、`NaN` 与 `Infinity` 一律视为「没有该上限」，而不是 0——
 * 把 `Number('') || 0` 一类结果直接拿去取小会让每一轮都撞到 {@link MIN_BUDGET}。
 * @param {unknown} value
 * @returns {number}
 */
function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/**
 * 模型的输出容量上限；没有可溯源值时用 {@link FALLBACK_OUTPUT_LIMIT}。
 * @param {{outputLimit?: number} | undefined} model
 * @returns {number}
 */
function capacityOf(model) {
  const limit = model?.outputLimit;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : FALLBACK_OUTPUT_LIMIT;
}

/**
 * 折算一次请求的输出预算上限。
 * @param {unknown} level 宿主给出的档位 id
 * @param {{outputLimit?: number} | undefined} model 可溯源输出容量
 * @param {unknown} requested 调用方显式给出的输出上限
 * @returns {number} 不小于 {@link MIN_BUDGET} 的整数
 */
export function budgetFor(level, model, requested) {
  const capacity = Math.min(capacityOf(model), usableTokens(requested));
  const { ceiling } = resolveEffort(level);
  const wanted = ceiling === undefined ? capacity : Math.min(ceiling * ALWAYS_THINKING_FACTOR, capacity);
  return Math.max(MIN_BUDGET, Math.trunc(wanted));
}

/**
 * 渲染档位名称里的预算数字。与 {@link budgetFor} 取同一份预算值，因此菜单上的数字
 * 就是该档**在调用方未指定上限时**将发出的数字（调用方给出更小上限时实际值被收窄）。
 * @param {number} budget
 * @returns {string}
 */
function kilos(budget) {
  return Math.round(budget / 1024) + ' K';
}

/**
 * 交给宿主的思考强度菜单。
 *
 * 名称里直接写这一档的输出上限：宿主把 `name` 渲染成菜单项（且只渲染 `name`，不渲染
 * `description`），用户在选择前就能看到该档会发出多大的预算，而不是只有一个抽象的「高 / 低」。
 *
 * 不接收调用方的输出上限：菜单在**声明期**生成，此时还不知道本次调用的上限；调用方一旦
 * 给出更小上限，实际发出的值会被收窄（见 `budgetFor`）。因此菜单数字是该档的**上界**。
 * @param {{outputLimit?: number} | undefined} model
 * @returns {ReadonlyArray<{id: string, name: string, description: string}>}
 */
export function effortsFor(model) {
  return LEVELS.map((entry) => ({
    id: entry.id,
    name: entry.name + ' · ' + kilos(budgetFor(entry.id, model)),
    description: '输出上限同时约束思考与正文：' + entry.hint,
  }));
}
