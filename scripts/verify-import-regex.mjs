/**
 * 反证：新的 register.test.js 正则必须能命中 src/ 里唯一引用宿主包的那句动态 import，
 * 而旧正则（仅「单引号 + 静态」）必须漏掉它。否则新用例是假绿。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/。
const root = join(import.meta.dirname, '..') + sep;
const NEW = /(?:^|[\s;{(])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/gm;
const OLD = /^import[\s\S]*?from\s+'([^']+)'/gm;

let newChecked = 0;
const newForeign = [];
let oldChecked = 0;
const oldForeign = [];

for (const name of readdirSync(root + 'src/')) {
  const text = readFileSync(root + 'src/' + name, 'utf8');
  for (const m of text.matchAll(NEW)) {
    newChecked += 1;
    const s = m[1] ?? m[2];
    if (!s.startsWith('./') && !s.startsWith('node:')) newForeign.push(`${name} -> ${s}`);
  }
  for (const m of text.matchAll(OLD)) {
    oldChecked += 1;
    if (!m[1].startsWith('./') && !m[1].startsWith('node:')) oldForeign.push(`${name} -> ${m[1]}`);
  }
}

console.log(`新正则 checked=${newChecked}  非内建/非相对=${JSON.stringify(newForeign)}`);
console.log(`旧正则 checked=${oldChecked}  非内建/非相对=${JSON.stringify(oldForeign)}`);
console.log(`新正则是否抓到宿主包 = ${newForeign.length > 0}`);
console.log(`旧正则是否抓到宿主包 = ${oldForeign.length > 0}`);
