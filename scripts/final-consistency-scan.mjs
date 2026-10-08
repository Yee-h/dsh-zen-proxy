/**
 * 最终一致性总扫描：把「同一事实在多处出现」的关键数值/断言逐处列出，
 * 便于人工确认没有「只改一处」的残留（本仓教训 1/2/9）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/。
const ROOT = join(import.meta.dirname, '..') + sep;
const SKIP = /node_modules|[\\/]\.git[\\/]|package-lock/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|md|json|ya?ml)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log(`受检文件数 = ${files.length}`);

const probes = [
  ['档位预算 4096', /4096/g],
  ['档位预算 16384', /16384/g],
  ['下界 512', /MIN_BUDGET|不小于 512|512\b/g],
  ['回退 32768', /32768/g],
  ['思考占比 33%-43%', /33%-43%/g],
  ['82%', /82%/g],
  ['测试计数 177', /177/g],
  ['测试计数 176', /176/g],
  ['-free 结尾 35', /35 个/g],
];

for (const [label, re] of probes) {
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const n = (text.match(re) ?? []).length;
    if (n > 0) hits.push(`${f.replace(ROOT, '')}(${n})`);
  }
  console.log(`\n[${label}] 出现在 ${hits.length} 个文件：`);
  console.log('  ' + (hits.join(', ') || '(无)'));
}
