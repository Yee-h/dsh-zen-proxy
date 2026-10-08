/**
 * N1 的终极验收（第二版，修 D2 的盲区）：把归档后的 evidence.md 里那段
 * 「三方对照的脚本实际输出汇总段」与 `node scripts/verify-sources.mjs` 的真实 stdout 比对。
 *
 * 第一版只从 `受检模型数` 起比对，因此**结构上无法发现「前置删行」**——而文档当时还写着
 * 「逐字粘贴，未做任何修饰」，等于给了一个比对工具覆盖不到的绝对断言（审查 D2）。
 * 本版做两件事：
 *   1. 把文档块作为**完整 stdout 的连续后缀**来校验（顺序、内容都要对得上）；
 *   2. 读出文档里声明的「省略了 stdout 开头的 N 行」，与实际省略行数比对——声明与实际必须相符。
 * 这样「偷偷删行」会同时打破第 1 或第 2 条，无法再蒙混。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/，被调用的 verify-sources.mjs 是它的同目录邻居。
const SCRIPTS = import.meta.dirname;
const REPO = join(SCRIPTS, '..');
const EV = join(REPO, 'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/evidence.md');

const raw = execFileSync(process.execPath, [join(SCRIPTS, 'verify-sources.mjs')], {
  encoding: 'utf8',
});
if (!raw.includes('受检模型数')) throw new Error('脚本输出里找不到「受检模型数」，汇总格式变了');

const rawLines = raw.replace(/\r/g, '').split('\n');
// 去掉末尾空行，得到有效 stdout 行
while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();

const text = readFileSync(EV, 'utf8');
const blocks = [...text.matchAll(/```text\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
const docBlock = blocks.find((b) => b.includes('受检模型数'));
if (docBlock === undefined) throw new Error('evidence.md 里找不到含「受检模型数」的 text 代码块');

const docLines = docBlock.replace(/\r/g, '').split('\n');
while (docLines.length > 0 && docLines[docLines.length - 1].trim() === '') docLines.pop();

console.log(`完整 stdout 有效行数 = ${rawLines.length}`);
console.log(`文档粘贴行数         = ${docLines.length}`);

// --- 检查 1：文档块必须是完整 stdout 的连续后缀 ---
const omitted = rawLines.length - docLines.length;
let suffixOk = omitted >= 0;
if (suffixOk) {
  for (let i = 0; i < docLines.length; i += 1) {
    if (rawLines[omitted + i] !== docLines[i]) { suffixOk = false; break; }
  }
}
console.log(`\n[检查 1] 文档块是 stdout 的连续后缀 = ${suffixOk}（实际省略开头 ${omitted} 行）`);

// --- 检查 2：文档声明的省略行数必须等于实际 ---
const declaredMatch = /省略了 stdout 开头的\s*(\d+)\s*行/.exec(text)
  ?? /省略了 stdout 开头的\s*(\d+)\s*行/.exec(text);
const declared = declaredMatch === null ? null : Number(declaredMatch[1]);
console.log(`[检查 2] 文档声明的省略行数 = ${declared}；实际 = ${omitted}`
  + ` => ${declared === omitted ? 'ok 相符' : 'DIFF 不符'}`);

// --- 检查 3：声明了「完整 stdout 共 N 行」时，N 必须等于实际 ---
const totalMatch = /完整 stdout 共\s*(\d+)\s*行/.exec(text);
const declaredTotal = totalMatch === null ? null : Number(totalMatch[1]);
console.log(`[检查 3] 文档声明的 stdout 总行数 = ${declaredTotal}；实际 = ${rawLines.length}`
  + ` => ${declaredTotal === rawLines.length ? 'ok 相符' : 'DIFF 不符'}`);

const failures = [suffixOk, declared === omitted, declaredTotal === rawLines.length]
  .filter((x) => x !== true).length;
console.log(`\n失败检查数 = ${failures}`);
if (failures === 0) console.log('文档与脚本真实输出一致，且省略行数的声明与实际相符。');
process.exitCode = failures === 0 ? 0 : 1;
