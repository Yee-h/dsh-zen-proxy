# Tasks

## 1. 包结构与安装面

- [x] 1.1 重写 `package.json`：保持 `name` 为 `dsh-zen-proxy`、`type: module`；把 `@deepseek-ai/*`（cordis、dsh-llm、schemastery）改为 peer 依赖；新增 `dsh.bundle.patch` 指向本仓库的 `cordis.patch.yml`；删除代理时代的描述与关键词。验证：`node -e "JSON.parse(require('fs').readFileSync('package.json'))"` 通过，且 `npm pack --dry-run` 列出的文件与 `files` 字段一致。
- [x] 1.2 新增 `cordis.patch.yml`，向 profile 注入 loader 条目 `- id: zen-proxy, name: dsh-zen-proxy`。验证：用 YAML 解析该文件成功，且条目 `name` 与 `package.json` 的 `name` 完全一致。
- [x] 1.3 在 README 写入 desktop profile 的安装步骤（把本包加入 profile 依赖 → 安装 → 重启宿主），并说明不再需要 `settings.yaml` 配置。验证：按 README 步骤在 desktop profile 中执行后，profile 的依赖树中出现 `dsh-zen-proxy`。

## 2. 上游身份与请求塑形

- [x] 2.1 先写身份头构造的失败测试：断言请求头同时包含 `user-agent`、`authorization: Bearer public`、`x-opencode-client`、`x-opencode-project`、`x-opencode-session`、`x-opencode-request`；再实现构造器使测试通过。验证：单元测试全绿。
- [x] 2.2 先写版本门槛测试：`1.18.0` 被接受并用作 UA、`1.17.0` 不被用作 UA（记录诊断并回退到门槛值）；再实现门槛校验。验证：两个用例分别断言发出的 UA 版本。
- [x] 2.3 先写会话与请求 id 测试：同一对话两次派生结果相等、不同对话不相等、结果匹配 `ses_` + 12 位十六进制 + 14 位 base62 的形状；再实现派生函数。验证：测试全绿，含形状正则断言。
- [x] 2.4 先写工具四连补齐测试：仅声明 `glob`/`read` 时请求体出现四个要求名；仅大小写不同时不重复声明；`pwsh` 被填入 `bash` 槽且响应侧工具调用名还原为 `pwsh`；再实现补齐与回写。验证：测试覆盖四条场景且全绿。
- [x] 2.5 先写 chat 协议族解析测试：用注入的桩 SSE 流断言文本增量、推理增量、工具调用增量、`usage`、终止 `finish` 的产出顺序，且工具参数保持原始 JSON 字符串；再实现该族编码与解析。验证：测试断言分片序列且 `finish` 唯一。
- [x] 2.6 先写 responses 协议族解析测试：用注入的桩事件流断言 `response.output_text.delta`、`response.output_item.added`、`response.function_call_arguments.delta`、`response.completed`、`response.failed` 的映射；再实现该族编码与解析。验证：测试全绿，含 `failed` 映射为终止失败的分片。
- [x] 2.7 先写失败映射测试：上游 429 产出 `RATE_LIMIT` 失败码、`RegionError` 产出携带原因的失败且不产出任何助手内容分片；再实现映射。验证：测试全绿。
- [x] 2.8 在设置上游身份头的源码处写明偏离 `attributionHeaders()` 的原因，并在 README 增加对应说明章节。验证：源码注释与 README 章节均存在，且说明与"实测 harness UA 返回 403"一致。

## 3. 可用性探测与状态

- [x] 3.1 先写候选过滤测试：上游模型清单同时含 `-free` 与非 `-free` id 时，候选只保留 `-free`；再实现候选获取。验证：测试全绿。
- [x] 3.2 先写判定测试：`200` + 正常增量 → 可用；`200` + 顶层 `error` 对象 → 不可用；`403` + `RegionError` → 地区受限；`403` + `FreeTierError` 与 `426` → 全局诊断；再实现判定。验证：五个用例全绿。
- [x] 3.3 先写状态机测试：单个模型一次 `503` 后仍留在主路由目录；连续三次瞬时故障后移出；`429` 不改变地区归属；全局失败后全部转 `unknown`；再实现状态机。验证：测试全绿。
- [x] 3.4 先写持久化测试：结果写入后重新加载可读回；状态文件被截断或含非法 JSON 时不抛错且按无历史处理；再实现持久化（先写临时文件再原子改名）。验证：测试全绿，且断言写入路径来自环境解析而非字面量。
- [x] 3.5 先写调度测试：用假时钟断言挂载后立即探测一轮、按配置周期重复、卸载后不再探测、全轮限流时下一次间隔大于配置周期；再实现调度与退避。验证：测试全绿。
- [x] 3.6 在 README 记录探测周期、瞬时故障宽限与退避语义。验证：README 描述与 3.3／3.5 的测试断言一致。

## 4. provider 注册与目录

- [x] 4.1 先写适配器目录测试：`listModels('opencode-free')` 返回条目的 `provider` 与该路由一致、`id` 非空不重复、`name` 非空；`listModels('opencode-free-region')` 只返回地区模型；再实现适配器的 `providerInfo`／`listModels`／`resolveModel`。验证：测试全绿，且断言不触发 `INVALID_CATALOG` 的校验条件。
- [x] 4.2 先写注册测试：用假 ctx 断言以 `['opencode-free','opencode-free-region']` 调用 `registerAdapter`、以两个条目调用 `registerConfigurableProviders`、`probeIntervalMinutes` 默认为 10；再实现注册与配置面。验证：测试全绿，含卸载时释放的断言。
- [x] 4.3 先写目录接线测试：状态为可用 → 出现在主路由；状态为地区受限 → 只出现在地区路由；状态为未知或不可用 → 两条路由都不出现；再实现接线。验证：测试全绿。
- [x] 4.4 先写元数据测试：有溯源来源的模型解析出该 `contextWindow`；无来源的模型不返回 `contextWindow` / `defaultMaxTokens` 但仍在 `listModels` 结果中；字段集合不越出宿主接受的集合（含 `systemPromptUpdate` 只允许 `in-history`）；请求未指定输出上限时不发送 `max_tokens` / `max_output_tokens`；再实现元数据。验证：测试全绿，覆盖 `normalizeModelInfo` 的校验规则。
- [x] 4.5 在 README 写清两条路由的用途、地区分组的显示名 `opencode-free-region` 与不可用语义。验证：README 中可检索到两个路由 id 及其说明。

## 5. 集成验证

- [x] 5.1 对真实上游做 chat 协议族端到端冒烟：取一个已判定可用的免费模型发起一次流式对话，记录状态码与首个内容增量作为证据。验证：证据文件包含状态码与增量片段。
- [x] 5.2 对真实上游做 `responses` 协议族的证伪冒烟：对地区受限模型发起一次请求，确认归类为地区受限而非网络或协议错误。验证：证据文件包含 `RegionError` 归类结果。
- [x] 5.3 触发一轮完整探测，导出目录快照，确认主路由只含免费且判定可用的模型、地区路由只含地区受限模型。验证：快照与上游 `/models` 的 12 个 `-free` id 对照无遗漏与越界。
- [ ] 5.4 在 desktop profile 中安装并确认 `opencode-free` 与 `opencode-free-region` 出现在模型选择器，且选中一个可用模型能完成一次真实对话。验证：记录选择器呈现与一次成功对话的证据。
- [x] 5.5 审查源码，确认除上游 base URL 外不存在用户目录绝对路径字面量。验证：对源码执行绝对路径模式检索，结果仅命中上游 URL。

## Workflow follow-up

- 代码质量审查通过后执行 `/opsx-archive`，把三个能力的 delta 同步进 `openspec/specs/`。
- 归档后确认 `openspec/specs/` 下出现 `zen-free-provider`、`zen-free-availability`、`zen-free-upstream-wire` 三个主规格。
- 向远端推送前单独征询；不默认推送 `main`。
