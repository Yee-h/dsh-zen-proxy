/**
 * 版本一致性核验：package.json / package-lock.json 的三处版本字段必须一致
 * （本仓教训：升版本要同步三处，只改一处会让发布清单与实物不符）。
 *
 * 位置无关：脚本位于 <repo>/scripts/。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const pkgText = readFileSync(join(REPO, 'package.json'), 'utf8');
const lockText = readFileSync(join(REPO, 'package-lock.json'), 'utf8');
const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);

const rootPkg = lock.packages[''];

const versionsAgree = pkg.version === lock.version && lock.version === rootPkg.version;
const namesAgree = pkg.name === lock.name && lock.name === rootPkg.name;

console.log(`package.json                      version = ${pkg.version}`);
console.log(`package-lock.json                 version = ${lock.version}`);
console.log(`package-lock.json packages[""]    version = ${rootPkg.version}`);
console.log(`三处版本一致 = ${versionsAgree}`);
console.log(`三处包名一致 = ${namesAgree}（${pkg.name}）`);
console.log(`package.json peer dsh-llm 范围 = ${pkg.peerDependencies['@deepseek-ai/dsh-llm']}`);

// 自身版本字符串在 lock 里应至少出现一次（根条目），并列出出现次数供人工核对。
const selfInLock = [...lockText.matchAll(new RegExp(`"version":\\s*"${pkg.version.replace(/\./g, '\\.')}"`, 'g'))].length;
console.log(`\nlock 里 "version": "${pkg.version}" 出现次数 = ${selfInLock}（至少 1：根条目 packages[""]）`);

// 顶层 version 字段之外，不应再有其它「等于自身版本」的裸串出现在 package.json 里。
const selfInPkg = [...pkgText.matchAll(new RegExp(pkg.version.replace(/\./g, '\\.'), 'g'))].length;
console.log(`package.json 里 ${pkg.version} 出现次数 = ${selfInPkg}（应仅 1：顶层 version 字段）`);

const failures = [versionsAgree, namesAgree, selfInPkg === 1].filter((x) => x !== true).length;
console.log(`\n失败检查数 = ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
