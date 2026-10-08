/**
 * 开发时一次性取值：从 models.dev 取 opencode provider 的 limit.context / limit.output，
 * 用于核对仓库里已有的上下文窗口表，并为思考预算的容量项取溯源数据。
 * 运行时**不**请求该地址（插件自包含）。
 */
const FREE_IDS = [
  'exo-free',
  'fledge-alpha-free',
  'jev-1.13-free',
  'ling-3.0-flash-fin-free',
  'ling-3.1-flash-free',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'space-bunny-free',
];

const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(60000) });
console.log(`GET https://models.dev/api.json -> ${res.status} ${res.headers.get('last-modified') ?? ''}`);
const data = await res.json();
const opencode = data?.opencode ?? data?.providers?.opencode;
const models = opencode?.models ?? {};
console.log(`opencode provider models: ${Object.keys(models).length}`);

for (const id of FREE_IDS) {
  const row = models[id];
  if (row === undefined) {
    console.log(`${id.padEnd(34)} ABSENT`);
    continue;
  }
  console.log(
    `${id.padEnd(34)} context=${String(row.limit?.context ?? '-').padStart(8)}`
    + ` output=${String(row.limit?.output ?? '-').padStart(7)}`
    + ` reasoning=${String(row.reasoning ?? '-').padStart(5)}`
    + ` temp=${String(row.temperature ?? '-')}`
    + ` name=${row.name ?? '-'}`,
  );
}
