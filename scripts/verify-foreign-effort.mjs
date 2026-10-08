/**
 * 边缘情况：调用方带着**本车道没有**的档位 id（例如别的 provider 用的 `high`）请求本车道的模型。
 *
 * 宿主 resolveCallWithInfo 的规则是「不认识的档位直接抛 UNSUPPORTED_REASONING_EFFORT，
 * 不做 clamp/alias」。本变更的 design D15 也决定不 alias。因此这里要确认的是：
 *   (a) 本适配器**不会**因为收到陌生档位而崩掉或发出错误预算（它根本不会被调用到）；
 *   (b) 正常 UI 路径（客户端未指定档位）会落到本车道的 defaultEffort，不受影响。
 */
import { createAdapter, ROUTE_MAIN } from '../src/adapter.js';
import { MODEL_STATE } from '../src/state.js';

const state = () => ({
  version: 1, updatedAt: 0,
  models: { 'mimo-v2.6-flash-free': { state: MODEL_STATE.available, transientStreak: 0 } },
});

// 宿主规则（逐条抄自 dsh-llm/lib/index.js:2169-2194）
function resolveCallWithInfo(config, info) {
  const requested = config.reasoningEffort;
  if (info.reasoning === undefined) {
    if (requested !== undefined) return { error: 'UNSUPPORTED_REASONING_EFFORT' };
    return { config };
  }
  const effective = requested ?? info.reasoning.defaultEffort;
  if (effective !== undefined) {
    if (!info.reasoning.efforts.some((e) => e.id === effective)) return { error: 'UNSUPPORTED_REASONING_EFFORT' };
    if (requested !== effective) return { config: { ...config, reasoningEffort: effective } };
  }
  return { config };
}

const adapter = createAdapter({ state });
const info = await adapter.resolveModel(ROUTE_MAIN, 'mimo-v2.6-flash-free');

const cases = [
  ['未指定档位（正常 UI 路径）', undefined],
  ['light（本车道档位）', 'light'],
  ['balanced', 'balanced'],
  ['deep', 'deep'],
  ['high（别的 provider 的档位）', 'high'],
  ['low（别的 provider 的档位）', 'low'],
  ['medium', 'medium'],
  ['空串', ''],
];

console.log(`本车道菜单 = ${info.reasoning.efforts.map((e) => e.id).join(', ')}；defaultEffort = ${info.reasoning.defaultEffort}\n`);
for (const [label, effort] of cases) {
  const r = resolveCallWithInfo({ provider: ROUTE_MAIN, model: 'mimo-v2.6-flash-free', reasoningEffort: effort }, info);
  const outcome = r.error !== undefined
    ? `宿主拒绝：${r.error}（适配器不会被调用）`
    : `通过，实际档位 = ${r.config.reasoningEffort ?? '(未设置 → 适配器按默认档 balanced 折算)'}`;
  console.log(`${label.padEnd(28)} -> ${outcome}`);
}
