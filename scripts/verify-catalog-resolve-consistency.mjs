/**
 * 宿主链路一致性：宿主对 listModels 返回的**每个** id 都会再调 resolveModelInfo 取菜单
 * （见 evidence.md (3) 的 buildModelCatalog）。因此必须验证：目录里出现的每个 id
 * 都能解析出合法菜单，且不会因缺元数据而抛错。
 */
import { createAdapter, ROUTES, ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js';
import { MODEL_STATE } from '../src/state.js';

const state = () => ({
  version: 1,
  updatedAt: 0,
  models: Object.fromEntries(
    [
      'exo-free', 'fledge-alpha-free', 'ling-3.0-flash-fin-free', 'ling-3.1-flash-free',
      'longcat-2.5-preview-free', 'mimo-v2.6-flash-free',
      'muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free',
      'nemotron-3.5-lightning-free', 'nemotron-3-ultra-free', 'space-bunny-free',
      'jev-1.13-free',
    ].map((id) => [id, { state: MODEL_STATE.available, transientStreak: 0 }]),
  ),
});

const adapter = createAdapter({ state });
let listed = 0;
let problems = 0;

for (const provider of ROUTES) {
  const models = await adapter.listModels(provider);
  console.log(`\n=== ${provider}（${models.length} 个）===`);
  for (const m of models) {
    listed += 1;
    const keys = Object.keys(m).sort().join(',');
    const keysOk = keys === 'id,inputModalities,name,provider';
    const hasReasoning = 'reasoning' in m;
    const resolved = await adapter.resolveModel(provider, m.id);
    const eff = resolved.reasoning?.efforts ?? [];
    const idsOk = JSON.stringify(eff.map((e) => e.id)) === JSON.stringify(['light', 'balanced', 'deep']);
    const namesOk = eff.every((e) => typeof e.name === 'string' && e.name.length > 0);
    const defOk = resolved.reasoning?.defaultEffort === 'balanced';
    const ok = keysOk && !hasReasoning && idsOk && namesOk && defOk;
    if (!ok) problems += 1;
    console.log(
      `${ok ? 'ok  ' : 'BAD '} ${m.id.padEnd(32)} 目录键=${keysOk ? 'ok' : keys} 目录无reasoning=${!hasReasoning}`
      + ` 菜单=${idsOk ? 'ok' : 'BAD'} 默认=${defOk ? 'ok' : 'BAD'} | ${eff.map((e) => e.name).join(' / ')}`,
    );
  }
}

// 未列出的 id 也必须能解析（核心路由接受任意 id）
const brandNew = await adapter.resolveModel(ROUTE_MAIN, 'brand-new-free');
const brandOk = JSON.stringify(brandNew.reasoning.efforts.map((e) => e.id)) === JSON.stringify(['light', 'balanced', 'deep']);
console.log(`\n未列出的 id 也能解析出菜单 = ${brandOk}`);
if (!brandOk) problems += 1;

console.log(`\n受检目录条目 = ${listed}；问题数 = ${problems}`);
process.exitCode = problems === 0 ? 0 : 1;
