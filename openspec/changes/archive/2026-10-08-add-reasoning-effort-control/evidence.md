# 证据

本文件记录本变更「思考强度可调」的开发期**实测**结果。所有命令都是本机直连
`https://opencode.ai` 的一次性脚本（在仓库外的 `_probe/` 下，**不落在仓库里**），
日期 2026-10-07。

---

## (1) 上游的强度旋钮：`reasoning_effort` 被接受但不被执行

### 实验设置

同一道题、同一套四连工具（`bash` / `glob` / `grep` / `read`，免费车道闸门要求），
只改请求体里的强度字段；每个变体采样 1-2 次，共 10 次调用。命令（摘录，`_probe/effort.mjs`）：

```js
const variants = {
  'A 基线':        {},
  'B effort=low':  { reasoning_effort: 'low' },
  'B2 effort=low': { reasoning_effort: 'low' },
  'C effort=high': { reasoning_effort: 'high' },
  'C2 effort=high':{ reasoning_effort: 'high' },
  'D max=512':     { max_tokens: 512 },
};
```

结果（`合计` 与 `思考token` 取自网关 `usage`；`正文` 是 `delta.content` 的累计字符数）：

```text
mimo-v2.6-flash-free         A 基线           200 finish=stop     思考token=  877 思考字符=    0 正文= 1543 合计= 2054
mimo-v2.6-flash-free         B effort=low     200 finish=stop     思考token=  838 思考字符=    0 正文= 1492 合计= 1964
mimo-v2.6-flash-free         B2 effort=low    200 finish=stop     思考token=  702 思考字符=    0 正文= 1239 合计= 1675
mimo-v2.6-flash-free         C effort=high    200 finish=stop     思考token=  290 思考字符=    0 正文=  798 合计=  889
mimo-v2.6-flash-free         C2 effort=high   200 finish=stop     思考token=  517 思考字符=    0 正文= 1123 合计= 1409
mimo-v2.6-flash-free         D max=512        200 finish=length   思考token=  514 思考字符=    0 正文=    0 合计=  512
nemotron-3.5-lightning-free  A 基线           200 finish=stop     思考token= 1235 思考字符=    0 正文= 2146 合计= 2033
nemotron-3.5-lightning-free  B effort=low     200 finish=stop     思考token= 1358 思考字符=    0 正文= 1878 合计= 2123
nemotron-3.5-lightning-free  C effort=high    200 finish=stop     思考token= 1174 思考字符=    0 正文= 2907 合计= 2133
nemotron-3.5-lightning-free  D max=512        200 finish=length   思考token=  450 思考字符=    0 正文= 1754 合计=  512
```

### 结论：该字段不构成可用的强度控制

1. **方向不成立**。语义上 `high` 应比 `low` 思考更多。实测在 `mimo-v2.6-flash-free` 上
   恰好相反：`low` 两次为 838 / 702，`high` 两次为 290 / 517（均值 770 对 404），
   且**基线 877 是五者中的最大值**——按值排序为 `A(877) > B(838) > B2(702) > C2(517) > C(290)`，
   与请求值的次序无单调关系。`nemotron-3.5-lightning-free` 上三次合计为
   2033 / 2123 / 2133（相差 <5%），推理列 1235 / 1358 / 1174 的离散小于同款模型
   重复同一请求的离散，检测不到效应。
2. **重复采样的离散度与「效应」同量级**。`mimo` 上同一设置两次重复相差 136（`low`）
   与 227（`high`）个 token；两种设置的均值相差 366。在 n=2 的前提下，
   「若字段被忽略、五个样本同分布，则两次 `high` 恰好是五者中最小的两个」的概率为 1/10，
   不构成显著证据；叠加上第 1 条的方向矛盾，结论只能是「字段被接受但未被执行」。
3. **与参考实现独立观测一致**。本机先前从另一份实现（`dsh-our-free-model` 的
   `src/effort.js` 模块注记）读到：该车道接受 `reasoning_effort` / `thinking.budget_tokens` /
   `enable_thinking` / `thinking_budget` 后全部忽略，并且 `low` 的思考 token 反而比
   `xhigh` 更多。本次在自己的请求路径上复现了同一现象（方向同样相反）。
   两者是独立来源，故**本变更不直传任何 effort 字段**（D15 的可证伪条件据此判定为
   「不成立」，即 D15 成立）。

### 补测：输出预算是被执行的旋钮

`D max=512` 变体在**两个模型**上都得到 `finish=length`，且 `合计` 精确等于 512
（`mimo` 连正文都被挤到 0 字符）。这说明上游确实执行 `max_tokens`，且思考与正文
**共享**同一个上限——正是 D18「阶梯要留出一半给正文」与 D19「预算要有下界」的依据。

### 口径与局限

- `思考字符` 统计的是 `delta.reasoning_content` 的累计长度，本次 10 次调用**全部为 0**：
  两个模型都没有走这个字段。因此本表只以 token 数取证，**没有**思考正文长度这一路的交叉验证。
- `nemotron-3.5-lightning-free` 的推理列**不可信**：其 `D` 行 `推理 450 + 正文 1754 字符`
  与 `合计 512` 自相矛盾（1754 字符不可能只占 62 个 token），说明该模型的
  `reasoning_tokens` 不是 `completion_tokens` 的子集。对该模型只采信「合计受上限约束」一项；
  这一点也与上一变更记录过的「nemotron 的 usage 缺 reasoning 明细」相符。
- 样本量小（每变体 1-2 次），本节结论**不依赖显著性检验**，而依赖上面两条内部矛盾
  （方向与语义相反、同设置重复的离散与跨设置之差同量级）。
- 只测了 `reasoning_effort` 一种拼写。参考实现报告另外三种拼写同样被忽略，本机未复测。

---

## (2) 输出上限的溯源：models.dev 的 `limit.output`

取值命令（`_probe/verify-sources.mjs`，把「models.dev 实时值 / 仓库常量表 / 本文档表格」
三方逐行对照，并打印受检总数）：

```js
const r = await fetch('https://models.dev/api.json');
const j = await r.json();
const p = j.opencode ?? j.providers?.opencode;
for (const id of Object.keys(CONTEXT_WINDOW_SOURCE)) {
  const m = p.models[id];
  console.log(id, m.limit.context, m.limit.output, m.reasoning);
}
```

结果（`status 200`；`opencode` provider 在 2026-10-08 复核时共 **119** 个模型，其中 **35** 个 id 以
`-free` 结尾；下表的溯源表覆盖其中 **11** 个。三列均与 `src/catalog.js` 的两张表逐行一致）：

```text
模型 id                            limit.context  limit.output  reasoning
exo-free                                 1048576        131072  true
fledge-alpha-free                        1048576        131072  true
ling-3.0-flash-fin-free                   262144         32768  true
ling-3.1-flash-free                       262144         32768  true
longcat-2.5-preview-free                 1000000        131072  true
mimo-v2.6-flash-free                      200000         32000  true
muse-spark-1.2-contributor-free          1048576        131072  true
muse-spark-1.3-contributor-free          1048576        131072  true
nemotron-3.5-lightning-free               262144        262144  true
nemotron-3-ultra-free                    1000000        128000  true
space-bunny-free                         1048576        524288  true
```

三方对照的**脚本实际输出的汇总段**（`node _probe/verify-sources.mjs`；下方是 stdout 的**末尾 13 行**，
逐字未改。为节省篇幅省略了 stdout 开头的 13 行：1 行 `GET https://models.dev/api.json -> 200`、
11 行逐模型明细（每行含 `live.ctx` / `src.ctx` / `ev.ctx` / `reasoning` 与各自的 `ok`/`BAD` 标记）
与 1 行 `---` 分隔符。完整 stdout 共 26 行，可用上述命令原样复现）：

```text
受检模型数 checked=11
live context 与 CONTEXT_WINDOW_SOURCE 不符 = 0
live output  与 OUTPUT_LIMIT_SOURCE  不符 = 0
evidence.md context 列与实时值不符 = 0
evidence.md output  列与实时值不符 = 0
evidence.md reasoning 列与实时值不符 = 0
reasoning===true = 11, 其它 = 0
evidence.md 解析到的行数 = 11
opencode 模型总数 = 119
其中 id 以 -free 结尾 = 35
jev-1.13-free 是否缺席 models.dev = true

综合判定：不符总数 = 0（全部一致）
```

被省略的逐模型明细行是**判定所需**的部分（若某行有 `BAD`，上面的计数就不会是 0），因此省略
它们不改变结论；但「只贴汇总段」这件事本身必须写明，不能写成「逐字粘贴、未做任何修饰」——
本变更此前正是在这里出过「手写一段假输出」的事故（见下方勘误第 2 条）。

该脚本在解析出 0 行时会**抛错退出**，并打印 `解析到的行数` 与「不符总数」——因为本轮之前
恰好发生过「解析器与表格格式脱钩 → 恒打印不符 → 手写一个『不符 = 0』贴进本文档」的事故
（见下方「本表勘误」第 2 条）。

- `limit.context` 与仓库既有的 `CONTEXT_WINDOW_SOURCE` **逐行相同**：受检 11 条、不符 0 条
  （该列在本轮之前**有 8/11 条被误转录**——见下方的「本表勘误」——现已按实时值改正，
  这也是「独立复核既有表成立」这一结论能成立的前提）。
- `limit.output` 是本变更新增的容量项来源；`jev-1.13-free` 在 models.dev 中**缺席**
  （因此无溯源，按 D17 回退 32768 并记入「未能验证」），其余 11 个免费 id 均可溯源。
- `reasoning` 列是本轮补测的：11/11 为 `true`，即 `design.md` 的 D18 所依赖的
  「本车道的 11 个免费模型都公布 `reasoning`」有逐行支撑。**注意这条只支撑「都公布
  `reasoning`」**，并不等于「都无法关闭思考」：models.dev 不提供「能否关闭思考」这一属性，
  参考实现用的是它自己的 `canDisableThinking === false` 标记（见 (2b)），两者不是同一个判据。
- models.dev 的 `limit.output` 与参考实现的 maxOutput 表**不相同**（后者 nemotron 记 32768、
  mimo 记 131072、space-bunny 记 65536），说明参考表并非取自该来源；本变更取**可溯源**的那个。

### 本表勘误（2026-10-08）

本节的表格初稿把 `limit.context` 列写错了 **8/11 条**（例如 `exo-free` 记为 131072，
实时值为 1048576；`mimo-v2.6-flash-free` 记为 262144，实时值为 200000），却同时在下方断言
「与 `CONTEXT_WINDOW_SOURCE` 逐条相同」。错误形态值得记录：

- **同一批数据里「对的那一列」掩盖了「错的那一列」**。`limit.output` 列 11/11 正确，
  于是整张表看起来可信；而唯一能独立验证的那一列（`context`，可对照变更前就存在的
  `CONTEXT_WINDOW_SOURCE`）恰恰是错的。
- **同源产出的两列不是互相独立的验证**。`output` 列与 `OUTPUT_LIMIT_SOURCE` 相符，但两者
  出自同一次探针抓取、同一次转录，属自洽而非独立复核。
- **绝对断言（「逐条相同」）没有附带受检总数**，因此 8 条不符在文档里不可见。
  教训 6 的规则在此适用：任何「通过」都要能回答「检查了几个对象」。

修正方式：`context` 列按实时值改正，并补上 `reasoning` 列与三方对照的受检总数。

#### 第 2 条勘误：修表之后，取证脚本没跟着改，于是「证据」变成了手写的

上面那次修正把表格格式从 `<id> context <n> output <n>` 改成 `<id> <ctx> <out> <reasoning>`，
但**没有同步更新取证脚本** `_probe/verify-sources.mjs` 的解析正则（它仍只认旧格式）。后果是：

- 脚本解析出 **0 行** ⇒ 每个 id 的 `ev` 都是 `undefined` ⇒ 恒打印「不符 = 11」；
- 而当时贴进本节「三方对照的可证伪结论」里的输出，被写成了**「不符 = 0」**——那是**手写的
  期望值，不是脚本的实际输出**；
- 更糟的是，脚本本来会打印 `evidence.md 解析到的行数 = 0`（唯一能一眼看出解析失败的行），
  而贴进文档的那段**恰好把这一行删掉了**。

这三步叠加起来，文档里出现了一段「看起来是实测、实际从未产生过」的证据。它被本轮审查的
独立复核者抓出（他实跑脚本得到 11/11，与文档相反）。**这是本仓库最严重的一类缺陷**：不是
数值错，而是**证据链本身是伪造的**，下一轮审查者若只看文档将无从察觉。

修正方式（已落实）：

1. 脚本解析器改为匹配当前表格式；
2. 脚本在**解析出 0 行时直接抛错退出**，绝不允许在解析失败的状态下打印任何「通过」；
3. 脚本末尾打印「不符总数」并以其设置退出码；
4. 本节改为**逐字粘贴脚本真实输出**（含 `解析到的行数 = 11` 与 `不符总数 = 0`）。

**可复现命令**：`node _probe/verify-sources.mjs`（`exit=0` 表示三方全部一致）。


### (2b) 参考实现的 82% 与「能否关闭思考」

`design.md` 的 D18 与 `src/effort.js` 的模块注记都引用了「参考实现测得约 82%」。该数字的
出处已定位到本机安装的参考实现 `dsh-our-free-model`：

```text
文件：node_modules/dsh-our-free-model/src/effort.js:24-27
原文：Measured on `mimo-v2.6-flash-free` over the 92 calls of one day: 82% of the output
      tokens were reasoning, so the un-doubled 8192 ceiling left roughly 1500 for the
      answer and a long turn ended in `length` about every third request.
同文件 :81 的机制：model?.canDisableThinking === false ? entry.ceiling * ALWAYS_THINKING_FACTOR
                            : entry.ceiling
```

两点必须写明，否则该数字会被误用：

1. **该 82% 是参考实现在 2026-09-24 前后、`mimo-v2.6-flash-free` 上、92 次调用的统计**，
   不是本机测量。本机在同一模型上的复核是 33%-43%（见 (1)），两者不一致。
2. **「按 82% 标定」这个说法不成立**：2 倍系数对应的是思考占比 ≤ 50%（正文 = 2×2048×(1−r)
   ≥ 2048 ⟺ r ≤ 50%）；若真按 82% 标定，系数应为 1/(1−0.82) ≈ 5.56。参考实现同样用 2 倍
   并在同一段里写着 82%，因此**参考实现自己那处说明也是内部不一致的**，本变更不沿用该因果表述
   （见 `src/effort.js` 模块注记与 README 的「为什么乘 2」）。

`canDisableThinking` 这一属性 models.dev **不提供**，本机也没有其它可溯源来源，因此本变更
不引入该逐模型标记（design D18）；代价是 2 倍系数对「本可以关闭思考」的模型偏大，这一点
记入「未能验证的点」。

---

## (3) 宿主契约：档位菜单的出现条件

从宿主 bundle（`resources/app.asar` 内的 `dsh-llm/lib/index.js`）读到的判定链：

```text
normalizeModelInfo  : 若 reasoning.efforts 不是非空数组 → INVALID_MODEL_REASONING
                      每一项必须有不重复的非空 id 与非空 name
                      defaultEffort 必须属于 efforts
resolveCallWithInfo : reasoning 为 undefined 而调用方给了档位 → UNSUPPORTED_REASONING_EFFORT
                      档位不在 efforts 内 → UNSUPPORTED_REASONING_EFFORT
prepareCall         : 适配器显式给了 reasoningEffort 时置 adapterDefaults.reasoningEffort = true
```

**这就是本次缺陷的根因**：适配器此前从不声明 `reasoning`，宿主据此不渲染任何档位控件，
用户只能选模型、调不了强度。反向结论同样重要：只要声明了合法的 `efforts`，
宿主就按该菜单渲染，**不需要**适配器侧的任何额外接线。

### 完整链路（本轮补验，2026-10-08）

上面那条「不需要额外接线」此前只有推断，本轮把两端都读到了实际代码，链路闭合：

```text
GUI 菜单数据来源（宿主 dsh-api-session-controller/lib/index.js 的 buildModelCatalog）：
  for (const model of await ctx.llm.listModels(provider.id))
    const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
    reasoning = resolved.reasoning → { efforts:[{id,name,description?}], defaultEffort? }
    条目 = { id, name, description?, reasoning? }

客户端渲染（dsh-client-ui-model-selection/lib/client.js）：
  reasoning = currentChoice?.model.reasoning
  effortChoices = reasoning.efforts.map(e => ({ key:`effort:${e.id}`, effort:e.id, label:e.name }))
```

两点关键结论：

1. **目录条目不需要带 `reasoning`**：宿主对**每个列出的模型**再调一次 `resolveModelInfo`
   来取菜单，这正是本变更只在 `resolveModel` 声明、`listModels` 不声明的原因（design 的
   D16 与本文件 (4) 的键集合断言互相印证）。若当初把 `reasoning` 放在 `listModels`，
   它会被宿主的目录投影静默丢弃、菜单反而不会出现。
2. **客户端用的是档位的 `name` 作为菜单标签**（`label: effort.name`），因此把预算数字写进
   `name`（`精简 · 4 K`）确实会被渲染到用户眼前；只写在 `description` 里则不会显示在菜单项上
   （客户端的菜单项只渲染 `level.label`，不渲染 `description`）。

### 档位抵达请求体的链路（同一轮补验）

选中的档位要真的改变请求体，中间还有一跳，本轮一并读到：

```text
resolveCallWithInfo : requested = config.reasoningEffort
                      effective = requested ?? reasoning.defaultEffort
                      不在 efforts 内 → UNSUPPORTED_REASONING_EFFORT
                      requested !== effective 时 resolvedConfig.reasoningEffort = effective
adapterStream       : resolvedOptions = { ...options, ...resolvedConfig }   ← 含 reasoningEffort
                      iterator = dispatch(projectedOptions)                 ← 传给适配器
适配器 streamTurn    : budgetFor(options.reasoningEffort, ...) → 请求体 max_tokens / max_output_tokens
```

因此**未选档位时也会带上预算**（宿主把 `defaultEffort` 物化进 `resolvedConfig`），这与
`test/adapter.test.js` 的「未指定档位时按默认（均衡）档发出预算 → 16384」断言一致。

### 端到端复现（本轮补验，`_probe/e2e-tiers.mjs`）

上面几段是**读代码**得出的链路。本轮进一步把宿主的两条校验规则（`normalizeModelInfo` /
`resolveCallWithInfo`）逐条抄成一个桩，串起「档位 → 菜单 → 校验 → 请求体预算」并实际执行：

```text
未选档位（宿主用 defaultEffort）      max_tokens        =   16384
light                            max_tokens        =    4096
balanced                         max_tokens        =   16384
deep（容量 32000）                  max_tokens        =   32000
deep（无溯源 → 32768）               max_tokens        =   32768
responses 族 light                max_output_tokens =    4096

菜单（mimo-v2.6-flash-free）: light:精简 · 4 K | balanced:均衡 · 16 K | deep:深度 · 31 K
未选档位时带预算 = true（期望 true，16384）
失败项 = 0
```

这条复现覆盖了：三个档位各自改变请求体、默认档在未选时生效、无溯源模型回退 32768、
responses 族写 `max_output_tokens` 而非 `max_tokens`、菜单名称里的数字与发出的数字一致。
它比单测更强的地方在于**经过宿主那两条校验**（档位不在 `efforts` 内会抛
`UNSUPPORTED_REASONING_EFFORT`，菜单非法会抛 `INVALID_MODEL_REASONING`），因此「宿主不会
拒绝这套菜单」也一并被验证。

**仍未验证**：宿主那两条规则是本机**抄录**的桩，不是真宿主的运行期行为；桌面端实际渲染出
三档、且切换档位后请求体预算随之变化，仍须装机后由界面证实（见「未能验证的点」）。

---

## (4) 本机复核（单元与桩流）

```text
npm test                          → 177 pass / 0 fail / 49 suites
node --check src/effort.js        → exit 0
node --check src/catalog.js       → exit 0
node --check src/adapter.js       → exit 0
openspec validate --all --strict  → 4 passed / 0 failed（change + 3 specs）
```

覆盖到的与「实测」等价的可执行断言：档位名称与描述（`test/effort.test.js`）、
三档预算与四个边界（非正数 / `NaN` / `Infinity` / 超过容量）、**请求体级**的非法上限与
`deep` 档回退 32768（`test/adapter.test.js`）、两条协议族的字段名
（`max_tokens` 与 `max_output_tokens`）、默认档在 `mimo-v2.6-flash-free` 上落到 16384、
以及目录条目只含宿主接受的四个字段。
---

## (5) 三档预算的实际约束力（单调性复核）

同一模型（`mimo-v2.6-flash-free`）、同一组身份头、同一道**要求长答案**的 prompt（「至少 3000 字，
8 个小节，不要用要点列表代替正文」），唯一变量是请求体的 `max_tokens`。探针直接发送三档各自
算出的预算值（不是经由宿主传递档位）；档位与预算的对应关系由 `test/effort.test.js` 锁死，见 (4)。
命令（摘录，`_probe/tiers.mjs`）：

```js
const VARIANTS = [
  { label: 'light 4096', maxTokens: 4096 },
  { label: 'balanced 16384', maxTokens: 16384 },
  { label: 'deep 无上限', maxTokens: undefined }, // 不发送 max_tokens
];
```

结果（全部 `200`）：

```text
light 4096      200 finish=length 思考token= 979 正文字符= 5043 合计=4096  用时=120s
balanced 16384  200 finish=stop   思考token= 793 正文字符= 8366 合计=6026  用时=189s
deep 无上限      200 finish=stop   思考token=1061 正文字符= 7425 合计=5720  用时=181s
```

三条调用记录到的增量字段均为 `role|content|reasoning|reasoning_details`。

### 结论

1. **档位真的改变线上行为**：`light` 档的合计 token 精确等于 4096 且 `finish=length`，
   即回答被上限截断；`balanced` 与 `deep` 在同一 prompt 上都自然收束于 6026 / 5720
   （`finish=stop`），没有顶到上限。
2. **档位的作用方式是「天花板」而不是「强度旋钮」**：三档的思考 token 为 979 / 793 / 1061，
   **不单调**。这与 D15 一致——上游没有强度概念，档位只决定天花板高低；没顶到天花板时，
   思考多少由模型自己决定。
3. **`light` 档的正文仍拿到 3117 token**（4096 − 979），高于该档名义基准 2048，
   即 D18 的 2 倍系数在实测点上达标（README 引用的就是这两个数字）。
4. **思考走的是 `reasoning` 而不是 `reasoning_content`**：出现 `reasoning_details` 即为证据，
   与 (1) 中 `reasoning_content` 恒为 0 的观察互为印证（口径问题，不是模型没有思考）。

### 局限

只有一个模型、每档一次采样（受免费车道配额限制）。「截断点」是精确的（合计 = 上限），
但「自然收束长度」只能代表这一道 prompt。

## 未能验证的点

1. **只测了两个模型**：10 次调用集中在 `mimo-v2.6-flash-free` 与
   `nemotron-3.5-lightning-free`（受免费车道配额与可用性限制），其余 9 个可用模型
   按同一阶梯统一处理，未逐个实测思考占比。
2. **只测了一种强度拼写**：`reasoning_effort`。另外三种拼写的行为来自参考实现，
   本机未复测。
3. **responses 族的预算字段无法连通**：该族成员（`muse-spark*`）在本机出口恒被地区闸门
   拦住，`max_output_tokens` 只有桩流覆盖。
4. **档位的界面呈现未验证**：档位名称（如 `精简 · 4 K`）与描述在宿主模型选择器里的
   实际渲染只能由桌面端证实。(3) 已读到「宿主把 `resolveModelInfo` 的 `reasoning` 装进目录、
   客户端以 `effort.name` 作菜单标签」这两段实现，但那是读代码而非运行期观察。
5. **`jev-1.13-free` 的容量项无溯源**：回退值 32768 可能高于其真实上限。
6. **2 倍系数的标定边界**：倍数的用意是让「档位名里的数字」成为正文的**下界**，
   这要求思考占比不超过 50%。本机实测该占比随预算变小而升高：无上限时 33%-43%（(1) 的
   `mimo`）、`light` 档 24%（(5)）、512 token 上限时 100%（(1) 的 `D` 行，正文 0 字符）。
   三档实际发出的预算是 4096 / 16384 / 容量，都远高于 512，`light` 档实测达标（正文 3117）；
   但若某模型在 4096 这个量级上的思考占比就超过 50%，下界仍不再有保证，本机没有这样的样本。
7. **「宿主接受任一档位」这条 scenario 未被测试触达**：`test/adapter.test.js` 的本地校验器
   只复刻了 `INVALID_MODEL_REASONING` 的三条规则（非空数组、id 非空不重复、默认档在集合内），
   没有复刻 `resolveCallWithInfo` 抛 `UNSUPPORTED_REASONING_EFFORT` 的两条路径。该行为属宿主
   内部（本机不 import 宿主包），只能由桌面端证实；菜单里三个 id 都在 `efforts` 内这一点由
   `deepEqual(['light','balanced','deep'])` 间接覆盖。
8. **「能否关闭思考」无溯源**：models.dev 不提供该属性（(2) 的 `reasoning` 列只说明「公布
   思考能力」），参考实现用的是它自己的 `canDisableThinking` 标记（(2b)）。因此本变更无法
   判断哪些模型本可关闭思考，2 倍系数对这类模型偏大（预算被高估）。
