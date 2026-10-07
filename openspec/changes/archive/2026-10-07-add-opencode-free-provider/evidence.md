# 证据

本文件记录开发期对上游与宿主的**实测**结果。所有命令都是本机直连
`https://opencode.ai` 的一次性脚本（`node --input-type=module -e`，不落在仓库里），
日期 2026-10-07。

---

## (1) `GET https://opencode.ai/zen/v1/models` 的 JSON 字段结构

命令（摘录）：

```js
const res = await fetch("https://opencode.ai/zen/v1/models", { headers: {} });
const json = await res.json();
console.log(Object.keys(json), json.data.length, Object.keys(json.data[0]));
```

结果：

```text
status 200 application/json
len 7232
top-level keys: [ 'object', 'data' ]
data len 86
FIRST: {
 "id": "claude-fable-5",
 "object": "model",
 "created": 1791377709,
 "owned_by": "opencode"
}
free count 12
union of item keys: id, object, created, owned_by
```

免费 id（12 个，按 id 后缀 `-free` 判定）：

```text
jev-1.13-free exo-free muse-spark-1.3-contributor-free muse-spark-1.2-contributor-free
mimo-v2.6-flash-free space-bunny-free longcat-2.5-preview-free ling-3.0-flash-fin-free
nemotron-3-ultra-free nemotron-3.5-lightning-free fledge-alpha-free ling-3.1-flash-free
```

**结论（决定了三处实现）**：

1. 清单每项**只有** `id` / `object`（恒为 `"model"`）/ `created` / `owned_by`（恒为 `"opencode"`）。
2. **没有表示「免费」的字段** → 免费判定只能按 id 后缀 `-free`（spec 的定义）。
3. **没有表示「协议族」的字段** → 协议族只能按 id 判定（design D11 授权）；实测判据见下。
4. **没有上下文窗口、也没有输出上限字段** → 能力元数据必须另找可溯源来源（见 (5)）。
5. 详情端点不存在：`GET /zen/v1/models/fledge-alpha-free` → **404**（`text/html`，5663 字节，
   是站点 404 页）；`GET /zen/v1/models?include=capabilities` → **200**，返回的是
   **同一份 7232 字节**的清单；`GET /zen/v1/model/fledge-alpha-free` → 404。

### 协议族的判据（间接；本机无法证真）

| 请求 | 结果 |
| --- | --- |
| `muse-spark-1.3-contributor-free` → `/zen/v1/responses` | `403` `{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}` |
| `muse-spark-1.2-contributor-free` → `/zen/v1/responses` | `403` 同上 `RegionError` |
| `muse-spark-1.3-contributor-free` → `/zen/v1/chat/completions` | `403` 同上 `RegionError` |
| `fledge-alpha-free`（chat 族）→ `/zen/v1/responses` | `500` `{"type":"error","error":{"type":"error","message":"Internal server error"}}` |

**这张表支撑不了「id 前缀可作判据」这个结论，原推理已被推翻，记录在此以免误导**：

- 第 1、2 行（发到 `/responses` 得到 `RegionError`）**不能**证明「该端点接受这个 id」——
  因为第 3 行显示同一 id 发到 `/chat/completions` **同样**返回 `RegionError`，即
  **地区闸门先于路由判定**，两条端点在这里不可区分。
- 第 4 行（chat 族 id 发到 `/responses` 得到 `500`）既可能是「该端点不接受这个 id」，
  也可能是无关的上游故障，**不构成反证**。

实现的判据因此**不是**从本表推出来的，而是采用与社区同类实现收敛出的 id 模式映射：
`dsh-our-free-model` 的 `isMuseSpark`（`upstream.js:104-108`）用
`/^muse[-_]?spark(?:$|[-_:.\s])/i`，与本实现的 `src/catalog.js` 里的 `RESPONSES_ID_PATTERN`
**逐字相同**，并经 `isResponsesModel` → `endpointFor`（`upstream.js:110-123`）驱动端点选择。
两个独立实现从同一上游行为收敛出同一正则，是本条判据最实的支撑；本表只算**弱佐证**。
在本机出口（CN）这两个 id 恒被地区闸门拦住，所以**该映射既无法证真也无法证伪**；
它猜错的代价仅限于「这一个 id 走哪个端点」，不影响其它模型。

---

## (2) 裸 `opencode/1.18.31` UA 是否足够

命令：六个身份头齐备（`authorization: Bearer public`、`x-opencode-client: desktop`、
`x-opencode-project: global`、`x-opencode-session: ses_…`、`x-opencode-request: msg_…`、
`accept: text/event-stream`）＋请求体带闸门要求的四连工具，`model: fledge-alpha-free`、`stream: true`。

| 标签 | `user-agent` | 结果 |
| --- | --- | --- |
| A | `opencode/1.18.31`（**裸**） | **200** ✅ `data: {"id":"chatcmpl-9af00b353caecca3","object":"chat.completion.chunk",…,"delta":{"role":"assistant","content":""}}` |
| B | `deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)` | `403` `{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}` |
| C | `opencode/1.17.0` | `426` `{"type":"error","error":{"type":"UpgradeRequired","message":"… OpenCode 1.18.0 or newer is required to use the free tier"}}` |
| D | `opencode/1.15.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`（仓库旧值） | `426` 同上 `UpgradeRequired` |
| E | `opencode/1.18.31` + **不带**工具数组 | `403` `FreeTierError` |
| F | `opencode/1.18.31` + **不带** `authorization` | **200** ✅ |
| G | 不带 `user-agent` | `403` `FreeTierError` |

**结论**：

- **裸 UA 足够**：`opencode/1.18.31` 不需要 `ai-sdk/… runtime/bun/…` 后缀即可过闸
  （A 返回 200）。因此实现的 `user-agent` 就是 `opencode/<version>`，不带任何额外 token。
- UA 的下界是 `1.18.0`：`1.17.0` 与仓库旧值都得到 426（C、D）。
- 工具数组是闸门的一部分：E 去掉工具数组后即使六个头齐备也得 403。
- `Authorization: Bearer public` 在本机实测并非必需（F 也能 200），但它是该车道的池化
  免密凭据，spec 要求携带，因此实现里始终发送 `Bearer public`。

### 补测：工具数组的形态

| 标签 | 请求体 | 结果 |
| --- | --- | --- |
| H | 四连工具 + `tool_choice: "none"` | **200** ✅ |
| I | 四连工具 + `tool_choice: "auto"` | **200** ✅ |

因此补出占位工具时把 `tool_choice` 置为 `none`（仅当调用方一个工具都没声明）是上游接受的。

---

## (3) `muse-spark` 两模型走 `responses` 的地区受限错误

请求体使用该族编码（`input` 数组 + 扁平工具）：

```json
{"model":"<id>","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],
 "stream":true,"store":false,"max_output_tokens":16,
 "tools":[{"type":"function","name":"bash","description":"…","parameters":{"type":"object","properties":{}}}, …]}
```

| 模型 | 端点 | 状态码 | 响应体 |
| --- | --- | --- | --- |
| `muse-spark-1.3-contributor-free` | `/zen/v1/responses` | `403` | `{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}` |
| `muse-spark-1.2-contributor-free` | `/zen/v1/responses` | `403` | 同上 |
| `muse-spark-1.3-contributor-free` | `/zen/v1/responses`（不带工具） | `403` | 同上 |
| `muse-spark-1.3-contributor-free` | `/zen/v1/chat/completions` | `403` | 同上 |

**结论**：地区受限的错误 `type` 稳定为 **`RegionError`**（HTTP 403），与是否携带工具、
走哪条端点无关。因此实现的地区判定按 `type === 'RegionError'` 分类，而不是按自然语言文本。
本机出口国家为 `CN`，该族**无法证真、只能证伪**（已写入 README 的已知限制）。

### 补测：车道被限流时，429 会**遮住**地区判定

在密集探测把免费车道打到限流之后，同样两个 muse-spark 模型不再返回 `RegionError`，
而是：

```json
HTTP 429 {"error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}
```

即**限流发生在地区判定之前**。这不是分类缺陷（分类按信封 type 给出 `RATE_LIMIT`，状态为
瞬时故障），但说明「地区受限」只能在车道不处于限流状态时观察到。实现因此依赖
「瞬时故障宽限」：一个此前判定为地区受限的模型在限流那一轮**保留地区归属**，
不会被一次 429 抹掉（见 `test/state.test.js` 的「429 不改变地区归属」）。

---

## (4) 调用方未指定输出上限时上游是否接受

命令：chat 族请求体**完全不带** `max_tokens`。

```text
[chat no-max_tokens] HTTP 200 :: data: {"id":"7b6c509c165448369be00f8372d5fad3","object":"chat.completion.chunk",
 "created":1791377943,"model":"fledge-alpha-free","choices":[{"index":0,"finish_reason":null,"logprobs":null,
 "delta":{"role":"assistant","content":"","reasoning_content":null}}]}
[chat with max_tokens=32] HTTP 200 :: 同上（对照）
[responses no-max_output_tokens] HTTP 403 :: RegionError（被地区闸门挡住，与本项无关）
```

**结论**：上游接受不带输出上限的流式请求，因此**不需要**为「调用方未指定上限」的情形
提供一个 `defaultMaxTokens`。实现据此：

- `resolveModel` **不**声明 `defaultMaxTokens`；
- 只有当 `GenerateOptions.maxTokens` 是正整数时才写 `max_tokens` / `max_output_tokens`。

---

## (5) 能力元数据的可溯源来源（不是上游清单）

上游清单没有上下文窗口（见 (1)）。宿主 spec 要求「仅当存在可溯源来源时才提供
`context.contextWindow`」，因此逐条从 Zen 的**已发布目录**取值：

- 来源 URL：`https://models.dev/api.json` 的 `opencode` provider 的 `limit.context`
- 取值日期：**2026-10-07**

| 模型 id | `limit.context` | `limit.output`（**未使用**，见下） |
| --- | --- | --- |
| `exo-free` | 1048576 | 131072 |
| `fledge-alpha-free` | 1048576 | 131072 |
| `ling-3.0-flash-fin-free` | 262144 | 32768 |
| `ling-3.1-flash-free` | 262144 | 32768 |
| `longcat-2.5-preview-free` | 1000000 | 131072 |
| `mimo-v2.6-flash-free` | 200000 | 32000 |
| `muse-spark-1.2-contributor-free` | 1048576 | 131072 |
| `muse-spark-1.3-contributor-free` | 1048576 | 131072 |
| `nemotron-3.5-lightning-free` | 262144 | 262144 |
| `nemotron-3-ultra-free` | 1000000 | 128000 |
| `space-bunny-free` | 1048576 | 524288 |
| `jev-1.13-free` | **不在该目录中** | — |

**结论**：

- `limit.context` 被内联为静态字面量（`src/catalog.js` 的 `CONTEXT_WINDOW_SOURCE`），
  运行时**不**请求 models.dev（design 的「插件自包含」目标）。
- `jev-1.13-free` 在上游清单里、但 models.dev 的 opencode provider 里没有它，因此它的
  `context` 被**省略**且记一条 `CATALOG_METADATA_UNKNOWN` 诊断；它**仍然**按「免费 + 可用」
  进入目录（目录不因元数据缺失而收缩）。
- `limit.output` **刻意未使用**：`defaultMaxTokens` 会被宿主物化成每个请求的输出上限，
  而 spec 明确要求「适配器 SHALL NOT 在调用方未指定输出上限时自行发送 `max_tokens` 或
  `max_output_tokens`」，(4) 又证明上游不需要这个上限。数值记录在此备查。

---

## (6) 真实端到端冒烟（chat 协议族）

临时脚本直接调用 `src/` 模块（不挂载宿主）：取清单 → 探测全部候选 → 用适配器对判定为
可用的模型发起一次真实流式对话。

第一轮（12 个候选全探测，并发 2）：

```text
免费候选 12 jev-1.13-free exo-free muse-spark-1.3-contributor-free muse-spark-1.2-contributor-free
mimo-v2.6-flash-free space-bunny-free longcat-2.5-preview-free ling-3.0-flash-fin-free
nemotron-3-ultra-free nemotron-3.5-lightning-free fledge-alpha-free ling-3.1-flash-free
探测 jev-1.13-free                    transient    Internal server error
探测 exo-free                         transient    Error from provider (Console): Upstream request failed: Endpoint is unavailable.
探测 muse-spark-1.3-contributor-free  region       This model is not available in your country.
探测 muse-spark-1.2-contributor-free  region       This model is not available in your country.
探测 mimo-v2.6-flash-free             available
探测 space-bunny-free                 available
探测 longcat-2.5-preview-free         available
探测 ling-3.0-flash-fin-free          transient    Error from provider (Console): Upstream request failed: Endpoint is unavailable.
探测 nemotron-3-ultra-free            available
探测 nemotron-3.5-lightning-free      available
探测 fledge-alpha-free                available
探测 ling-3.1-flash-free              transient    Rate limit exceeded. Please try again later.
主路由目录 ["mimo-v2.6-flash-free","space-bunny-free","longcat-2.5-preview-free",
             "nemotron-3-ultra-free","nemotron-3.5-lightning-free","fledge-alpha-free"]
地区路由目录 ["muse-spark-1.3-contributor-free","muse-spark-1.2-contributor-free"]
```

同一次运行里紧接着的对话请求得到 `RATE_LIMIT Rate limit exceeded. Please try again later.`——
即**整条车道的瞬时限流**（不是本插件的缺陷：探测刚打出 12 个请求）。等 45 秒后重试：

```text
首个文本增量 "1"
完整文本块 "1+1等于2。"
usage {"inputTokens":262,"outputTokens":244,"totalTokens":506}
分片序列 block-start | reasoning-delta ×N | block-start | text-delta ×6 | block-end | block-end
        | usage | finish:{"kind":"stop"}
```

**结论**：

- 目录快照与上游 `/models` 的 12 个 `-free` id 对照**无遗漏、无越界**：
  6 个可用进主路由、2 个地区受限进地区路由、4 个瞬时故障不进目录。
- 分片序列满足协议：`block-start` → 增量 → `block-end` → `usage` → **恰好一个** `finish`，
  且 `finish` 之后没有分片。
- 实测到的瞬时故障（429 / 503 / 400 `server_error` / 500）说明「瞬时故障宽限（连续 3 次）」
  与「全轮限流退避」是必要的：一次抖动就清空目录会让选择器持续抖动。

---

```text
探测 fledge-alpha-free=available muse-spark-1.3-contributor-free=transient
主路由 ["fledge-alpha-free"]
地区路由 []
providerInfo {"id":"opencode-free","name":"OpenCode Zen 免费模型"} {"id":"opencode-free-region","name":"OpenCode Zen 免费模型（地区受限）"}
resolveModel {"provider":"opencode-free","id":"fledge-alpha-free","name":"Fledge Alpha Free",
  "inputModalities":["text"],"context":{"contextWindow":1048576}}
文本 "好"
分片种类 block-start,reasoning-delta,text-delta,block-end,usage,finish:stop | finish 次数 1 | 末位 finish:stop
```

（此轮 muse-spark 得到 429 而非 RegionError，即上面的「限流遮住地区判定」；
在新实例没有历史判定的前提下，它既不入主路由也不入地区路由——这正是保守且正确的行为。）

## 未能验证的点

1. **地区受限模型无法在本机证真**：`muse-spark-1.2/1.3-contributor-free` 在本机出口
   （CN）恒为 403 `RegionError`，只能证明「归类正确」，不能证明「在允许的地区可用」。
2. **responses 协议族的真实链路无法连通**：该族只有这两个 muse-spark 模型，全部被地区闸门
   挡住，因此该族的请求编码与事件解析只有注入式桩流覆盖（`test/responses.test.js`），
   而且**「哪些 id 属于该族」这一映射本身在本机也无从证真或证伪**（见 (1) 的
   「协议族的判据」）。
3. **desktop profile 的实际挂载未验证**：没有改动仓库外的 profile（任务禁止），
   `cordis.patch.yml` 的形状与本机参考实现一致，但「选择器中出现两条路由」只能由宿主环境证实。
