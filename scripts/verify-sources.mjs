/**
 * 归档前取证：把 evidence.md 的表格、src/catalog.js 的常量表、以及 models.dev 的实时值
 * 三方对照，并打印受检总数（本仓库教训 6：计数型检查必须能回答「检查了几个对象」）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTEXT_WINDOW_SOURCE, OUTPUT_LIMIT_SOURCE } from '../src/catalog.js';

// 位置无关：脚本位于 <repo>/scripts/。
const REPO = join(import.meta.dirname, '..');
const EV = join(REPO, 'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/evidence.md');
const text = readFileSync(EV, 'utf8');

// 解析 evidence.md (2) 的结果块。当前表格式为 `<id>  <context>  <output>  <reasoning>`。
// 注意：此正则必须与文档表格的**当前**格式同步——2026-10-08 那次修复改了表格式却漏改这里，
// 导致解析 0 行、每个 id 都判「不符」，而当时贴进 evidence.md 的输出被手写成「不符 = 0」。
// 因此下面在解析后加了硬守卫：0 行直接抛错，绝不允许在解析失败的情况下打印任何「通过」。
const evRows = new Map();
for (const line of text.split(/\r?\n/)) {
  const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(true|false)\s*$/.exec(line.trim());
  if (m) evRows.set(m[1], { context: Number(m[2]), output: Number(m[3]), reasoning: m[4] === 'true' });
}
if (evRows.size === 0) {
  throw new Error(
    'evidence.md 表格解析出 0 行：解析器与文档表格格式已脱钩。'
    + '请先核对 (2) 结果块的列格式，再运行本脚本——不要在此状态下采信任何输出。',
  );
}

const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(60000) });
console.log(`GET https://models.dev/api.json -> ${res.status}`);
const data = await res.json();
const models = (data?.opencode ?? data?.providers?.opencode)?.models ?? {};

const ids = Object.keys(CONTEXT_WINDOW_SOURCE);
let ctxMismatch = 0;
let outMismatch = 0;
let evCtxBad = 0;
let evOutBad = 0;
let evReasoningBad = 0;
let reasoningTrue = 0;
let reasoningOther = 0;
const rows = [];

for (const id of ids) {
  const live = models[id];
  const liveCtx = live?.limit?.context;
  const liveOut = live?.limit?.output;
  const liveReasoning = live?.reasoning;
  const ev = evRows.get(id);
  const ctxOk = liveCtx === CONTEXT_WINDOW_SOURCE[id];
  const outOk = liveOut === OUTPUT_LIMIT_SOURCE[id];
  const evCtxOk = ev !== undefined && ev.context === liveCtx;
  const evOutOk = ev !== undefined && ev.output === liveOut;
  const evReasoningOk = ev !== undefined && ev.reasoning === liveReasoning;
  if (!ctxOk) ctxMismatch++;
  if (!outOk) outMismatch++;
  if (!evCtxOk) evCtxBad++;
  if (!evOutOk) evOutBad++;
  if (!evReasoningOk) evReasoningBad++;
  if (liveReasoning === true) reasoningTrue++; else reasoningOther++;
  rows.push(
    `${id.padEnd(32)} live.ctx=${String(liveCtx).padStart(8)} src.ctx=${String(CONTEXT_WINDOW_SOURCE[id]).padStart(8)} ${ctxOk ? 'ok ' : 'BAD'}`
    + ` | live.out=${String(liveOut).padStart(7)} src.out=${String(OUTPUT_LIMIT_SOURCE[id]).padStart(7)} ${outOk ? 'ok ' : 'BAD'}`
    + ` | ev.ctx=${String(ev?.context ?? '-').padStart(8)} ${evCtxOk ? 'ok ' : 'BAD'}`
    + ` | ev.out=${String(ev?.output ?? '-').padStart(7)} ${evOutOk ? 'ok ' : 'BAD'}`
    + ` | reasoning=${String(liveReasoning)} ${evReasoningOk ? 'ok ' : 'BAD'}`,
  );
}

for (const r of rows) console.log(r);
console.log('---');
console.log(`受检模型数 checked=${ids.length}`);
console.log(`live context 与 CONTEXT_WINDOW_SOURCE 不符 = ${ctxMismatch}`);
console.log(`live output  与 OUTPUT_LIMIT_SOURCE  不符 = ${outMismatch}`);
console.log(`evidence.md context 列与实时值不符 = ${evCtxBad}`);
console.log(`evidence.md output  列与实时值不符 = ${evOutBad}`);
console.log(`evidence.md reasoning 列与实时值不符 = ${evReasoningBad}`);
console.log(`reasoning===true = ${reasoningTrue}, 其它 = ${reasoningOther}`);
console.log(`evidence.md 解析到的行数 = ${evRows.size}`);
console.log(`opencode 模型总数 = ${Object.keys(models).length}`);
console.log(`其中 id 以 -free 结尾 = ${Object.keys(models).filter((k) => k.endsWith('-free')).length}`);
console.log(`jev-1.13-free 是否缺席 models.dev = ${models['jev-1.13-free'] === undefined}`);

const failed = ctxMismatch + outMismatch + evCtxBad + evOutBad + evReasoningBad;
console.log(`\n综合判定：不符总数 = ${failed}（${failed === 0 ? '全部一致' : '存在不一致，不得据此宣称通过'}）`);
process.exitCode = failed === 0 ? 0 : 1;
