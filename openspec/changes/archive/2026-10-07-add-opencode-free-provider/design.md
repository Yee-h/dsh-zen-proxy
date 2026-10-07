# Design

## Context

现状与本次实测到的上游事实（全部为本机直连 `https://opencode.ai` 的观测结果）：

- 仓库当前是单文件 HTTP 代理插件，写死 `user-agent: opencode/1.15.5 …`，并要求用户在 `settings.yaml` 把 provider 的 `baseURL` 指向 `127.0.0.1:4097`。
- 插件始终发送六个头：`user-agent`、`authorization`、`x-opencode-client`、`x-opencode-project`、`x-opencode-session`、`x-opencode-request`。实测对照（其中 `authorization` 并非闸门必需项）：
  - `user-agent: opencode/1.18.31` + 其余五个 → **200**
  - `user-agent: opencode/1.18.0` + 其余五个 → **200**（门槛下界）
  - `user-agent: opencode/1.17.0` → **426 UpgradeRequired**（`OpenCode 1.18.0 or newer is required to use the free tier`）
  - `user-agent: opencode/1.15.5 …`（仓库现值） → **426**
  - `user-agent: deepseek-harness/<version> (+url)` → **403 FreeTierError**
  - 去掉 `user-agent`，或去掉全部 `x-opencode-*` → **403 FreeTierError**
  - 去掉 `authorization` → **200**（该头是车道凭据，不是闸门必需项）
  - `x-opencode-client` 取 `cli` 或 `desktop` 均可通过
- `authorization: Bearer public` 是该车道的池化免密凭据，无需用户密钥。
- `GET /zen/v1/models` 与请求头无关：裸请求与完整指纹返回同一份 86 个 id，其中 12 个以 `-free` 结尾。
- 免费模型中的 `muse-spark-1.2-contributor-free` 与 `muse-spark-1.3-contributor-free` 返回 **403 `RegionError`**（`/chat/completions` 与 `/responses` 两条路径均如此），且它们是仅有的走 `/zen/v1/responses` 协议族的模型。
- **HTTP 200 不等于可用**：实测出现过 `200` 且响应体为 `data: {"error":{"type":"server_error",…}}` 的情形。
- 免费配额按 session 计；逐请求新造 session 会迅速触发限流。

宿主侧的权威约束（读自 `app.asar` 内 `@deepseek-ai/dsh-llm` 0.2.0-rc.2 的 README 与 lib）：

- 文档明言："GUI 的模型选择与提交要求模型出现在目录中；供 GUI 使用的适配器必须实现 `listModels`，公布其可用模型。基类实现返回空列表，因此不向 GUI 提供模型。"
- `listModels` 的返回项仅接受 `{provider, id, name, description?, inputModalities?}`；`normalizeModelInfo` 仅接受 `description` / `inputModalities` / `context.contextWindow` / `defaultMaxTokens` / `systemPromptUpdate` / `toolUpdate` / `reasoning`。**没有任何"不可用/禁用"字段。**
- `registerAdapter(providers, adapter)` 全量校验、全有或全无，重复路由抛 `DUPLICATE_ADAPTER`。
- 每个流恰好以一个终止 `finish` 分片结束；`usage` 先于 `finish`；工具参数保持原始 JSON 字符串。
- `LlmAdapter` 提供 `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` 六个可覆写点。
- 文档要求"每个 provider HTTP 请求必须包含 `attributionHeaders()`"。

安装面（读自 desktop profile）：

- profile 的插件来自 `profiles/<name>/package.json` 的依赖，加上插件自身 `dsh.bundle.patch` 注入的 loader 条目（如 `- id: our-free-model, name: dsh-our-free-model`）。
- `@deepseek-ai/*` 全部由宿主在运行时注入，并不存在于 profile 的 `node_modules` 中，因此只能作为 peer 依赖声明。

## Goals / Non-Goals

**Goals:**

- 让 Zen 免费模型直接出现在 desktop 的模型选择器中，无需监听端口、无需手工配置 provider。
- 目录只呈现可用免费模型；地区受限模型归入独立分组。
- 可用性每 10 分钟自动刷新，且刷新失败不破坏既有可用列表。
- 插件自包含：不依赖 `dsh-our-free-model` 或任何第三方用户插件。

**Non-Goals:**

- 不为付费模型提供通道，不做通用计费模型透传。
- 不改造为通用 OpenAI 兼容 provider，不接入 Zen 之外的上游。
- 不保留 web profile 的安装与运行路径。
- 不做登录、余额查询、额度充值相关能力。
- 首版不支持图片输入模态（免费车道与闸门无关的额外能力，无需求驱动）。

## Decisions

### D1 形态：原生 llm-provider，删除代理面

理由：desktop 没有 `settings.yaml`，代理形态的配置入口不存在；GUI 仅从目录取模型，而目录只能由适配器的 `listModels` 提供；可用性过滤必须由目录承载。

备选与放弃原因：保留 HTTP 代理（澄清阶段已被否决）；代理与插件双形态并存（已被否决，且要维护两套入口）。

### D2 用第二条 provider 路由表达"不可用"，而不是模型上的标记

理由：`listModels` 与 `normalizeModelInfo` 均无禁用字段（已查证权威契约），模型条目无法自述"不可用"；GUI 按 provider 分组，因此分组只能由路由表达。

备选与放弃原因：单路由内用 name 前缀或 description 提示（GUI 不认该语义，模型仍可被选中并提交）。

### D3 使用 `ctx.llm.registerAdapter` 低层注册，不经 pi-ai 桥

理由：必须精确控制 `user-agent`。pi-ai 桥会把 dsh 的 attribution UA 写进 provider 请求，实测该 UA 得到 403。

备选与放弃原因：通过 `dsh-llm-pi-ai` 注册自定义 provider（头部不可控）；复用 `dsh-llm-deepseek` 的注册助手（其语义绑定 DeepSeek 协议）。

### D4 请求身份集中在一个模块，并显式校验版本门槛

`user-agent` 的下限常量取 `1.18.0`（实测下界）；配置值低于门槛时不以该值发请求，改为记录诊断并使用门槛值。`x-opencode-client` 固定取 `desktop`（实测 `cli` 亦可，取其一以固定指纹）。

### D5 会话身份按对话派生并保持稳定

形状 `ses_` + 12 位十六进制 + 14 位 base62，由对话标识经 sha256 派生，使重启后同一对话仍是同一会话。探测流量使用独立种子，与任何用户对话的会话不同。请求 id 为 `msg_` + 同为 12+14 的形状，按"会话 + 单轮"派生，使同一轮的多次尝试共享。

理由：配额按 session 计；逐请求随机（仓库现状）会把配额打满，这正是旧实现遇到 `429 FreeUsageLimitError` 的机制。

### D6 工具四连补齐与名称回写

向请求体保证小写 `bash`、`glob`、`grep`、`read` 四个名字齐备：调用方已声明的直接沿用；缺失的槽位优先把能够代答的真实工具改名填入（Windows 上调用方的 `pwsh` 填入 `bash` 槽），其余才补一个自禁用占位工具。大小写变体不重复声明。响应侧按"发送拼写 → 调用方拼写"的映射还原工具调用名。

理由：闸门校验的是声明的小写名集合，而占位工具可能被模型调用并产生无效工具调用；改名填入既满足闸门又让调用可执行。

### D7 可用性判定必须解析 SSE 帧

判定顺序：HTTP 非 2xx → 依错误对象的 `type` 分类；HTTP 2xx → 读取首个数据帧，出现顶层 `error` 对象即判失败，出现正常增量才判可用。

理由：实测存在 200 + SSE 错误对象的情形，仅看状态码会误判为可用。

### D8 判定状态机与瞬时故障宽限

每个模型持有 `available` / `region` / `unavailable` / `unknown` 之一。目录只收 `available`，地区分组只收 `region`。瞬时故障（限流、上游 5xx、网络失败）在连续 3 次以内保留前值，超过则转 `unavailable`。全局身份类失败（`FreeTierError`、426）不针对单个模型，而是给出插件级诊断并将全部模型转 `unknown`。

理由：免费车道本身不稳定（实测已遇上游过载 503），若单次抖动就清空目录，模型选择器会持续抖动。

### D9 状态持久化到环境解析出的目录

解析顺序：`DSH_HOME` 环境变量 → 宿主默认配置根（`<home>/.dsh`）；文件名固定，写入采用先写临时文件再原子改名；文件缺失或不可解析时按无历史处理且不中断挂载。

理由：满足"不写死用户目录路径"的硬约束，同时让重启后目录立即可用。

### D10 探测调度

挂载后立即探测一轮，之后按配置周期重复；卸载时停止。单轮内串行或小并发，避免触发限流。若一轮内全部模型被判为限流，则指数退避（有上限），直到某一轮出现至少一个可用模型后回到配置周期。

### D11 协议族分派

按模型 id 决定端点与解析器：`responses` 族发往 `/zen/v1/responses` 并使用该族的请求编码（`input` 数组、扁平工具形状）与事件解析（`response.output_text.delta`、`response.output_item.added`、`response.function_call_arguments.delta`、`response.completed`、`response.failed`）；其余发往 `/zen/v1/chat/completions` 并解析 `chat.completion.chunk`。

### D12 显式记录 attribution 偏离

在设置上游身份头的源码处写注释，并在 README 说明：本插件不发送 dsh 的 attribution `user-agent`，原因是该车道的闸门只接受 `opencode/<>=1.18.0>`，实测发送 harness UA 得到 `403 FreeTierError`。该头部不携带任何用户数据。

### D13 配置面只引入两个旋钮

暴露 `probeIntervalMinutes`（默认 10）与 `opencodeVersion`（默认 `1.18.31`，受 D4 的 `1.18.0` 门槛约束，低于门槛回退并记诊断）。不引入 host/port/upstream 等旧旋钮，也不引入模型白名单。`opencodeVersion` 之所以例外：伪装版本是整套机制唯一的单点失效面，而闸门地板已实测变动过（旧的 `1.17.0` 现得 426），保留一个受门槛约束的逃生口比等新版本发布更省事，且它不改变任何默认行为。

### D14 能力元数据按可溯源来源，无来源即省略

上游 `/zen/v1/models` 实测只返回 `{id, object, created, owned_by}`：没有免费字段（只能按 `-free` 后缀判定）、没有协议族字段（按 `muse-spark*` id 模式判定端点，即 D11）、**没有上下文窗口与输出上限**，且不存在可用详情端点（`/zen/v1/models/<id>` 返回 404，能力查询参数返回同一份清单）。因此「每个公布模型都必须有正的 `contextWindow`」在数据上不可满足。备选与取舍：

- 每轮探测时拉取 `models.dev/api.json`（其中含 Zen 的 `limit.context` / `limit.output`）→ 否。为一个可选字段引入 5.3MB 上游请求与额外失败面，削弱自包含目标。
- 家族模式匹配 + 未知家族给保守下限（如 32768 / 8192）→ 否。宿主把 `contextWindow` 当真值使用，编造的下限会导致过早压缩、吃掉模型真实的长上下文能力，收益为负。
- 只公布能力已知的模型 → 否。目录由「免费 + 可用」两项决定；一个真能用的免费模型因缺元数据而静默缺席，比少一个窗口徽章糟得多。

采用：`context.contextWindow` 与 `defaultMaxTokens` 均为**可选**。仅在开发期从已发布的 Zen 目录数据取得可溯源数值时填 `context.contextWindow`，并在代码注释与 `evidence.md` 记录来源 URL、取值日期与模型 id；该表内联为静态字面量，运行时**不**访问第三方上游。无来源则省略 `context` 字段（宿主按「未知」处理），并产出一条带模型 id 的诊断。请求未指定输出上限时**不**自行发送 `max_tokens` / `max_output_tokens`（该行为由 evidence 项实测确认）。

## Risks / Trade-offs

- [上游闸门随时可能再变（本次已从旧的 429 语义变为 403/426 语义）] → 身份与版本门槛集中在单一模块；失败以插件级诊断呈现；探测失败只降级目录，不中断挂载。
- [免费车道不稳定，上游过载会返回 200 + SSE 错误] → 瞬时故障宽限与退避；目录不因单次抖动清空。
- [偏离宿主 attribution 契约可能引起合规关注] → 在源码与 README 显式记录并说明成因；该头部不携带用户数据。
- [地区受限模型在本机只能证伪，不能证真] → README 标注为已知限制；测试只断言归类正确，不断言可调用。
- [`responses` 协议族在受限地区无法真实连通] → 以解析器单测加注入式桩流覆盖；真实调用列为已知限制。
- [免费模型清单会增删] → 候选每轮从上游 `/models` 现取并按 `-free` 后缀过滤，不写死模型名单。
- [静态能力表会随上游漂移（窗口上调后本插件仍按旧值上报）] → 表内记录取值日期与来源，宁可省略也不猜；对不上能力表的模型按「未知」处理而不是回退到更小值。
- [两条路由的展示名与分组依赖 GUI 按 provider 分组这一前提] → 该前提来自 `listModels` 条目携带 `provider` 字段这一事实；若实测 GUI 不分组，则回退方案是把地区模型并入主路由并从目录中移除（需回到规格讨论）。
