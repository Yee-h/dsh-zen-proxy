/**
 * 端到端复核（不落仓库）：模拟宿主的调用链，验证
 *   档位 -> 精确模型信息菜单 -> resolveCallWithInfo 校验 -> 请求体预算
 * 全部打通，并逐档打印请求体里真正会发出去的 max_tokens。
 *
 * 宿主侧的判定规则逐条抄自 app.asar 内的 dsh-llm/lib/index.js（normalizeModelInfo /
 * resolveCallWithInfo），因此这里能在没有真宿主的情况下复现同一条链路。
 */
import { createAdapter, ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js';
import { MODEL_STATE } from '../src/state.js';

const state = () => ({
  version: 1,
  updatedAt: 0,
  models: {
    'mimo-v2.6-flash-free': { state: MODEL_STATE.available, transientStreak: 0 },
    'jev-1.13-free': { state: MODEL_STATE.available, transientStreak: 0 },
    'muse-spark-1.3-contributor-free': { state: MODEL_STATE.region, transientStreak: 0 },
  },
});

// --- 宿主规则（逐条抄录）---
function normalizeModelInfo(provider, model, resolved) {
  const info = { provider, id: model, name: resolved.name };
  if (resolved.reasoning !== undefined) {
    if (resolved.reasoning.efforts.length === 0) throw new Error('INVALID_MODEL_REASONING');
    const seen = new Set();
    for (const e of resolved.reasoning.efforts) {
      if (typeof e.id !== 'string' || e.id.length === 0) throw new Error('INVALID_MODEL_REASONING');
      if (typeof e.name !== 'string' || e.name.length === 0) throw new Error('INVALID_MODEL_REASONING');
      if (seen.has(e.id)) throw new Error('INVALID_MODEL_REASONING');
      seen.add(e.id);
    }
    if (resolved.reasoning.defaultEffort !== undefined && !seen.has(resolved.reasoning.defaultEffort)) {
      throw new Error('INVALID_MODEL_REASONING');
    }
    info.reasoning = { efforts: resolved.reasoning.efforts, defaultEffort: resolved.reasoning.defaultEffort };
  }
  return info;
}
function resolveCallWithInfo(config, info) {
  const requested = config.reasoningEffort;
  if (info.reasoning === undefined) {
    if (requested !== undefined) throw new Error('UNSUPPORTED_REASONING_EFFORT');
    return config;
  }
  const effective = requested ?? info.reasoning.defaultEffort;
  if (effective !== undefined) {
    if (!info.reasoning.efforts.some((e) => e.id === effective)) throw new Error('UNSUPPORTED_REASONING_EFFORT');
    if (requested !== effective) return { ...config, reasoningEffort: effective };
  }
  return config;
}

// --- 抓取请求体 ---
function capturingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

async function run(provider, model, effort) {
  const calls = [];
  const adapter = createAdapter({ state, fetchImpl: capturingFetch(calls) });
  const resolved = await adapter.resolveModel(provider, model);
  const info = normalizeModelInfo(provider, model, resolved);
  const config = resolveCallWithInfo({ provider, model, reasoningEffort: effort }, info);
  const prepared = await adapter.prepareCall(provider, model);
  // 宿主把 resolvedConfig 合并进 options 后交给适配器（见 adapterStream）
  for await (const _ of prepared.stream({ provider, model, messages: [], ...config })) void _;
  const body = calls[0].body;
  const wire = 'max_tokens' in body ? 'max_tokens' : 'max_output_tokens';
  return { menu: info.reasoning.efforts.map((e) => `${e.id}:${e.name}`), wire, budget: body[wire] };
}

const cases = [
  [ROUTE_MAIN, 'mimo-v2.6-flash-free', undefined, '未选档位（宿主用 defaultEffort）'],
  [ROUTE_MAIN, 'mimo-v2.6-flash-free', 'light', 'light'],
  [ROUTE_MAIN, 'mimo-v2.6-flash-free', 'balanced', 'balanced'],
  [ROUTE_MAIN, 'mimo-v2.6-flash-free', 'deep', 'deep（容量 32000）'],
  [ROUTE_MAIN, 'jev-1.13-free', 'deep', 'deep（无溯源 → 32768）'],
  [ROUTE_REGION, 'muse-spark-1.3-contributor-free', 'light', 'responses 族 light'],
];

let failures = 0;
for (const [provider, model, effort, label] of cases) {
  const r = await run(provider, model, effort);
  console.log(`${label.padEnd(34)} ${r.wire.padEnd(17)} = ${String(r.budget).padStart(7)}`);
  if (r.budget === undefined) failures += 1;
}
const menu = (await run(ROUTE_MAIN, 'mimo-v2.6-flash-free', 'light')).menu;
console.log('\n菜单（mimo-v2.6-flash-free）:', menu.join(' | '));

// 反向断言：未选档位也必须带预算（宿主物化 defaultEffort）
const noEffort = await run(ROUTE_MAIN, 'mimo-v2.6-flash-free', undefined);
console.log(`未选档位时带预算 = ${noEffort.budget === 16384}（期望 true，16384）`);
if (noEffort.budget !== 16384) failures += 1;
console.log(`\n失败项 = ${failures}`);
