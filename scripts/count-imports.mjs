/**
 * 查清 src/ 里 import/require 说明符的真实数量：旧单正则（不去重）vs 新四正则（去重）。
 * 目的：确认 39 与 40 的差异来源，避免为了让测试通过而随意调阈值。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/，src/ 在它上一级。
const root = join(import.meta.dirname, '..', 'src') + sep;

const OLD = [/(?:^|[\s;{(])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/gm];
const NEW = [
  /(?:^|[\s;{(])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/gm,
  /(?:^|[\s;{(])import\s*['"]([^'"]+)['"]/gm,
  /import\s*\(\s*(?:['"]([^'"]+)['"]|`([^`$]+)`)\s*\)/gm,
  /(?:^|[^\w$.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

let oldTotal = 0;
let newTotal = 0;
const perFile = [];

for (const name of readdirSync(root).sort()) {
  const text = readFileSync(root + name, 'utf8');

  const oldHits = [];
  for (const m of text.matchAll(OLD[0])) oldHits.push(m[1] ?? m[2]);

  const newHits = [];
  for (const p of NEW) for (const m of text.matchAll(p)) {
    const s = m[1] ?? m[2];
    if (s !== undefined) newHits.push(s);
  }
  const uniq = [...new Set(newHits)];

  oldTotal += oldHits.length;
  newTotal += uniq.length;
  const dupes = newHits.length - uniq.length;
  perFile.push(`${name.padEnd(16)} old=${String(oldHits.length).padStart(2)} new_raw=${String(newHits.length).padStart(2)} new_uniq=${String(uniq.length).padStart(2)} dupes=${dupes}`);
}

for (const l of perFile) console.log(l);
console.log('---');
console.log(`OLD 单正则（不去重）合计 = ${oldTotal}`);
console.log(`NEW 四正则去重后合计 = ${newTotal}`);
