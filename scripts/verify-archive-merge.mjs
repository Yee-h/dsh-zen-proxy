/**
 * 归档前置校验：delta 的 MODIFIED 需求头必须与主规格逐字匹配（空白不敏感），
 * 且 ADDED 需求不得与主规格既有需求重名（否则归档合并会出错）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/。
// 注意：该 delta 已于 2026-10-08 归档，因此指向 archive/ 下的路径（保留本脚本是为了
// 让「归档时校验过什么」这件事仍可复现，而不是留一个指向不存在目录的命令）。
const REPO = join(import.meta.dirname, '..');
const DELTA = 'openspec/changes/archive/2026-10-08-add-reasoning-effort-control';
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const headers = (file) =>
  readFileSync(join(REPO, file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('### Requirement:'))
    .map((l) => norm(l.slice('### Requirement:'.length)));

const pairs = [
  ['zen-free-provider', '能力元数据按可溯源来源，无来源即省略'],
  ['zen-free-upstream-wire', null],
];

// 本脚本写于归档**之前**，当时 ADDED 与主规格重名即为错误。
// 该 delta 已于 2026-10-08 归档，因此现在「重名 = true」正是**归档成功**的预期结果
// （ADDED 需求已被合并进主规格）。下面按归档后语义报告，避免把正确状态读成冲突。
const POST_ARCHIVE = true;

for (const [cap, modifiedName] of pairs) {
  const main = headers(`openspec/specs/${cap}/spec.md`);
  const delta = headers(`${DELTA}/specs/${cap}/spec.md`);
  console.log(`\n=== ${cap} ===`);
  console.log(`主规格需求数 = ${main.length}；delta 需求数 = ${delta.length}`);
  if (modifiedName !== null) {
    const ok = main.includes(norm(modifiedName));
    console.log(`MODIFIED 头 "${modifiedName}" 存在于主规格 = ${ok}`);
  }
  const added = delta.filter((h) => modifiedName === null || h !== norm(modifiedName));
  for (const a of added) {
    const present = main.includes(a);
    const verdict = POST_ARCHIVE
      ? `已并入主规格 = ${present}（归档后应为 true）`
      : `与主规格重名 = ${present}（归档前应为 false）`;
    console.log(`ADDED "${a}" ${verdict}`);
  }
}
