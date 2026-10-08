/**
 * 逐模型核对：档位菜单里的数字 == 该档将发出的预算（覆盖全部 11 个可溯源模型）。
 * 动机：既有单测只覆盖 3-4 个模型；本脚本用真实溯源表跑全量，确认没有某个模型
 * 因容量小于档位基准（如 ling 系列 32768 < 8192×2=16384? 不，32768>16384）
 * 或容量极小而出现「名称与预算不一致」或「deep 档反而小于 balanced 档」。
 */
import { budgetFor, effortsFor, ALWAYS_THINKING_FACTOR } from '../src/effort.js';
import { OUTPUT_LIMIT_SOURCE, outputLimitFor } from '../src/catalog.js';

const ids = Object.keys(OUTPUT_LIMIT_SOURCE);
console.log(`受检模型数 = ${ids.length}\n`);
console.log('模型'.padEnd(32) + '容量'.padStart(9) + '  light'.padStart(8) + '  balanced'.padStart(10) + '  deep'.padStart(9) + '  菜单');
console.log('-'.repeat(105));

let problems = 0;
for (const id of ids) {
  const model = { outputLimit: outputLimitFor(id) };
  const cap = outputLimitFor(id);
  const light = budgetFor('light', model, undefined);
  const balanced = budgetFor('balanced', model, undefined);
  const deep = budgetFor('deep', model, undefined);
  const menu = effortsFor(model).map((e) => e.name).join(' | ');

  // 逐档核对：名称里的 K 数 == 预算/1024 四舍五入
  const names = effortsFor(model);
  const kilosOk = names.every((e, i) => {
    const budget = [light, balanced, deep][i];
    return e.name.includes(Math.round(budget / 1024) + ' K');
  });
  // 单调性：light <= balanced <= deep（档位越高天花板不应更低）
  const monotone = light <= balanced && balanced <= deep;
  if (!kilosOk || !monotone) problems += 1;

  console.log(
    id.padEnd(32)
    + String(cap).padStart(9)
    + String(light).padStart(8)
    + String(balanced).padStart(10)
    + String(deep).padStart(9)
    + '  ' + (kilosOk ? 'k-ok' : 'K-BAD') + (monotone ? ' mono-ok' : ' MONO-BAD'),
  );
}

console.log('-'.repeat(105));
console.log(`\n名称与预算不一致 或 档位非单调 的模型数 = ${problems}`);
console.log(`倍率 = ${ALWAYS_THINKING_FACTOR}；light/balanced 理论值 = ${2048 * ALWAYS_THINKING_FACTOR}/${8192 * ALWAYS_THINKING_FACTOR}`);
console.log('\n菜单样例（mimo-v2.6-flash-free）:', effortsFor({ outputLimit: outputLimitFor('mimo-v2.6-flash-free') }).map((e) => e.name).join(' | '));
console.log('菜单样例（ling-3.0-flash-fin-free 容量 32768）:', effortsFor({ outputLimit: outputLimitFor('ling-3.0-flash-fin-free') }).map((e) => e.name).join(' | '));
process.exitCode = problems === 0 ? 0 : 1;
