/**
 * 变异测试（D3 的验收）：证明「对抗用例」现在能检测到**卫生用例**所依赖正则的退化。
 *
 * 做法：在 temp 副本里，把共享常量 SPECIFIER_PATTERNS 删掉若干条（模拟退化），
 * 然后跑 register.test.js，看对抗用例是否变红。修复前它会全绿（各持副本 → 自证）。
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';

// 位置无关：脚本位于 <repo>/scripts/。
const SRC = join(import.meta.dirname, '..');
const work = mkdtempSync(join(os.tmpdir(), 'zen-mut-'));
console.log(`临时工作区 = ${work}`);

// 复制仓库（排除 node_modules 以省时间，测试不需要宿主包）
cpSync(SRC, work, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
});
mkdirSync(join(work, 'node_modules', '@deepseek-ai'), { recursive: true });

const testFile = join(work, 'test', 'register.test.js');
const original = readFileSync(testFile, 'utf8');

function runTests() {
  try {
    const out = execFileSync(process.execPath, ['--test', 'test/register.test.js'], {
      cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function report(label, result) {
  const hygiene = /✖ src\/ 的模块只依赖 Node 内建与同目录模块/.test(result.out) ? 'FAIL(抓住)' : 'pass';
  const adversarial = /✖ 依赖检查的正则覆盖裸导入、模板字符串与 require/.test(result.out) ? 'FAIL(抓住)' : 'pass';
  console.log(`${label.padEnd(46)} 卫生用例=${hygiene}  对抗用例=${adversarial}`);
  return { hygiene, adversarial };
}

console.log('\n=== 基线（未变异）===');
report('原始代码', runTests());

// 变异 1：删掉 require 正则（第 4 条）
const mutRequire = original.replace(
  "  /(?:^|[^\\w$.])require\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/gm,\n",
  '',
);
if (mutRequire === original) throw new Error('变异 1 未生效：找不到 require 正则那一行');
writeFileSync(testFile, mutRequire);
console.log('\n=== 变异 1：删掉共享常量里的 require 正则 ===');
report('删 require 正则', runTests());

// 变异 2：删掉模板字符串支持（把动态 import 正则退化为只认引号）
const mutTemplate = mutRequire.replace(
  "/import\\s*\\(\\s*(?:['\"]([^'\"]+)['\"]|`([^`$]+)`)\\s*\\)/gm",
  "/import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)/gm",
);
if (mutTemplate === mutRequire) throw new Error('变异 2 未生效');
writeFileSync(testFile, mutTemplate);
console.log('\n=== 变异 2：动态 import 正则去掉模板字符串支持 ===');
report('去掉模板字符串', runTests());

// 变异 3：退化为「只有单引号静态」——即 round-3 的原始缺陷形态
const mutLegacy = mutTemplate.replace(
  /const SPECIFIER_PATTERNS = Object\.freeze\(\[[\s\S]*?\]\);/,
  "const SPECIFIER_PATTERNS = Object.freeze([/^import[\\s\\S]*?from\\s+'([^']+)'/gm]);",
);
if (mutLegacy === mutTemplate) throw new Error('变异 3 未生效');
writeFileSync(testFile, mutLegacy);
console.log('\n=== 变异 3：退化为 round-3 的「单引号 + 静态」单条正则 ===');
report('退化为旧单正则', runTests());

// 恢复
writeFileSync(testFile, original);
console.log('\n=== 恢复原文件 ===');
report('恢复后', runTests());

rmSync(work, { recursive: true, force: true });
console.log('\n临时工作区已清理');
