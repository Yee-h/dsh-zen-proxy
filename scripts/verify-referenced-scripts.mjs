/**
 * 检查工件里引用为「验证命令」的 scripts/ 脚本是否都真实存在。
 * 动机：文档里写 `node scripts/xxx.mjs` 却不存在该文件，等于把不可复现的命令当成证据（教训 1 同族）。
 *
 * 位置无关：脚本位于 <repo>/scripts/，被引用的同类脚本也都在同一目录。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = import.meta.dirname;
const REPO = join(SCRIPTS, '..');

const files = [
  'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/evidence.md',
  'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/tasks.md',
  'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/design.md',
  'openspec/changes/archive/2026-10-08-add-reasoning-effort-control/proposal.md',
  'openspec/progress/log.md',
  'README.md',
];

const referenced = new Set();
for (const f of files) {
  const text = readFileSync(join(REPO, f), 'utf8');
  for (const m of text.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)) referenced.add(m[1]);
}

// 硬守卫（教训 15/18 同族）：解析出 0 条引用时不得静默「全部通过」。
// 若有人改了文档里的路径写法（例如又写回 `_probe/`），本脚本必须报错而不是打印 0 缺失。
if (referenced.size === 0) {
  throw new Error(
    '工件里解析出 0 条 scripts/*.mjs 引用：正则与文档写法已脱钩。'
    + '请先核对文档里的脚本引用格式，再运行本脚本——不要在此状态下采信任何输出。',
  );
}

const onDisk = new Set(readdirSync(SCRIPTS).filter((n) => n.endsWith('.mjs')));

console.log(`工件里引用的脚本 = ${referenced.size}`);
console.log(`scripts/ 实际存在的脚本 = ${onDisk.size}\n`);

let missing = 0;
for (const name of [...referenced].sort()) {
  const ok = existsSync(join(SCRIPTS, name));
  if (!ok) missing += 1;
  console.log(`${ok ? 'ok  ' : 'MISSING'} scripts/${name}`);
}

console.log(`\n引用但缺失的脚本 = ${missing}`);

// 反向：磁盘上有但没被任何工件引用（不算错，仅报告）
const unreferenced = [...onDisk].filter((n) => !referenced.has(n)).sort();
console.log(`\n存在但未被工件引用（仅供开发期使用，正常）：`);
for (const n of unreferenced) console.log(`  ${n}`);
process.exitCode = missing === 0 ? 0 : 1;
