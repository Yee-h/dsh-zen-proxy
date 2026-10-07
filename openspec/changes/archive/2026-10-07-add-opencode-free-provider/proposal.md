# Proposal

## Why

现有 `dsh-zen-proxy` 以本地 HTTP 代理形态工作，其两个前提均已失效：

1. **UA 门槛漂移**。插件写死的 `user-agent` 是 `opencode/1.15.5 …`，而 Zen 网关当前要求 `opencode/1.18.0` 或更高。实测该 UA 返回 `426 UpgradeRequired`（`OpenCode 1.18.0 or newer is required to use the free tier`），即插件当前**完全不能用**。
2. **desktop 缺少配置入口**。代理形态要求用户手工把 provider 的 `baseURL` 指向本地端口，而 desktop profile 没有 `settings.yaml`，该路径在桌面端无法落地。

同时，代理形态天然无法满足"仅显示可用免费模型"：模型选择器只能看到用户手写的模型名，可用性信息无处承载。改造为原生 llm-provider 后，目录由插件直接公布，可用性可驱动目录内容。

## What Changes

- **BREAKING** 移除内置 HTTP 代理面：不再监听 `127.0.0.1:4097`，移除 `/v1/chat/completions` 与 `GET /v1/models` 转发。
- **BREAKING** 移除 `host` / `port` / `upstreamHost` / `upstreamBasePath` / `userAgent` / `clientHeader` / `projectHeader` 配置项。
- **BREAKING** 移除"手工把 provider `baseURL` 指向代理"的安装路径；改为在 desktop profile 直接安装插件。
- 改造为原生 dsh llm-provider 插件，暴露两个 provider 路由：`opencode-free`（可用免费模型）与 `opencode-free-region`（地区受限免费模型）。
- 模型目录只公布探测通过的**免费**模型（模型 id 以 `-free` 结尾）；付费模型与不可用模型不进入目录。
- 上游伪装身份对齐为 `user-agent: opencode/<version>` 且 `version >= 1.18.0`；对每个对话维持稳定的 `x-opencode-session`。
- 每 10 分钟探测一次可用性，探测结果驱动目录内容；探测判定同时检查 HTTP 状态与 SSE 帧内的错误对象。
- 支持两种上游协议族：`/zen/v1/chat/completions` 与 `/zen/v1/responses`。
- 地区受限模型单独分组，显示为不可用。
- 文档与注释改为中文，并显式记录对 dsh 强制 attribution 契约的偏离。

## Capabilities

### New Capabilities
- `zen-free-provider`: 在 dsh 模型选择器中暴露 Zen 免费模型的 provider 路由、模型目录与分组，含配置面与激活语义。
- `zen-free-availability`: 免费模型的可用性探测、失败分类、周期刷新、结果持久化与目录过滤规则。
- `zen-free-upstream-wire`: 向上游发送的客户端身份伪装、会话身份稳定性、工具指纹补齐，以及按模型分派协议族的请求编码与流式解析。

### Modified Capabilities
<!-- 这是本仓库的首个变更，openspec/specs/ 为空，无既有能力的需求被修改。 -->

## Impact

- **代码**：`index.js` 从 HTTP 代理重写为 cordis llm-provider 插件；新增 `src/` 模块（上游身份与请求塑形、SSE 两种协议族的解析、探测调度、目录构建、状态持久化）。
- **包元数据**：`package.json` 的 `name` 保持 `dsh-zen-proxy`；依赖从 `@deepseek-ai/schemastery` 单依赖改为声明宿主注入的 peer 依赖，并新增 `dsh.bundle.patch` 以向 profile 注入 loader 条目。
- **依赖边界**：不依赖 `dsh-our-free-model` 或任何第三方用户插件；唯一写死的地址是上游 `https://opencode.ai/zen/v1`；不出现任何用户目录绝对路径。
- **兼容性**：仅支持 desktop profile；web profile 的安装与运行路径随代理面一并移除。
- **已记录偏离**：`@deepseek-ai/dsh-llm` 要求每个 provider 请求携带 `attributionHeaders()`（`user-agent: deepseek-harness/<version>`），而该车道要求 `user-agent: opencode/<>=1.18.0>`。二者互斥，实测发送 harness UA 返回 `403 FreeTierError`。本变更选择过闸，偏离写入 README 与代码注释。
- **已知限制**：地区受限模型（`muse-spark-1.2-contributor-free`、`muse-spark-1.3-contributor-free`）在受限地区无法证真，只能证伪。
