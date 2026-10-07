# dsh-zen-proxy

一个 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 插件：
把 **OpenCode Zen 的免费模型车道**接成 dsh 的**原生 llm-provider**。

装上即可在桌面端的模型选择器里直接使用 Zen 的免费模型，**不需要监听端口、不需要写
`settings.yaml`、不需要 API Key**。插件以官方 OpenCode 客户端的网络身份向上游发请求，
每 10 分钟探测一次可用性，并且**只把「判定为可用」的免费模型放进目录**。

> **这次改造是破坏性变更。** 旧版本是一个本地 HTTP 代理（监听 `127.0.0.1:4097`，要求用户
> 把 provider 的 `baseURL` 指向它）。代理面、`host`/`port`/`upstream*`/`userAgent` 等配置项
> 已全部移除，也删掉了 `index.js` 里的 `http`/`https` 服务器代码。

---

## 这是什么

dsh 的模型选择器只从适配器的 `listModels` 取模型，而 `listModels` 与
`normalizeModelInfo` 都**没有「不可用」字段**（已核对宿主 `@deepseek-ai/dsh-llm` 的权威
契约）。因此「哪些免费模型现在真的能用」这件事，只能由**路由分组**来表达。插件注册两条路由：

| 路由 id | 分组语义 | 目录内容 |
|---|---|---|
| `opencode-free` | 免费模型（主分组） | 最近一次探测判定为**可用**的免费模型 |
| `opencode-free-region` | 免费模型（地区受限） | 最近一次探测判定为**地区受限**的免费模型 |

两条路由的展示名分别是 `OpenCode Zen 免费模型` 与 `OpenCode Zen 免费模型（地区受限）`。

「免费」的判据是模型 id 以 `-free` 结尾（上游清单里**没有**表示免费的字段，实测清单每项只有
`id` / `object` / `created` / `owned_by`）。付费模型、判定不可用的模型、以及尚未判定完成的
模型都**不会**出现在任何一条路由里。

---

## 安装

### 1. 把本包加进 desktop profile 的依赖

在 `$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 里加入本包（本地 checkout
或 git 地址都可以）：

```jsonc
{
  "dependencies": {
    "dsh-zen-proxy": "git+https://github.com/Yee-h/dsh-zen-proxy.git"
    // 或在本地 checkout 时： "dsh-zen-proxy": "file:C:/path/to/dsh-zen-proxy"
  }
}
```

### 2. 安装

```powershell
cd $env:DSH_HOME\profiles\desktop
npm install
```

`@deepseek-ai/*`（cordis、dsh-llm、schemastery）由宿主在运行时注入，**不**会（也不应）出现在
profile 的 `node_modules` 里，因此它们只作为本包的 `peerDependencies` 声明。

### 3. 重启宿主

重启 dsh。本包通过自身的 `dsh.bundle.patch`（`cordis.patch.yml`）向 profile 注入 loader 条目：

```yaml
- insert:
    - id: zen-proxy
      name: 'dsh-zen-proxy'
      config: {}
```

本插件**没有浏览器半身**，因此 `package.json` 里刻意不声明 `dsh.client`。

### 4. 不需要任何其它配置

不再需要把某个 provider 的 `baseURL` 指向本地端口，也不再需要 `settings.yaml`。
凭据是池化的 `Bearer public`，无需用户密钥。

---

## 配置

插件有两个配置项（探测周期，以及受门槛约束的伪装版本号）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `probeIntervalMinutes` | `10` | 探测周期（分钟）。运行中修改后，**下一轮**起生效，无需重启进程。 |
| `opencodeVersion` | `1.18.31` | 伪装用的 OpenCode 版本。低于闸门门槛 `1.18.0` 的值不会被使用，插件会记录一条诊断并回退到门槛值。 |

---

## 探测、宽限与退避语义

- **挂载后立即探测一轮**，且不阻塞挂载（首轮异步发起，目录在首轮返回后填充）。
- 之后**每 10 分钟**（或配置的周期）重复一轮：先取上游清单 → 按 `-free` 过滤 → 逐个探测。
- **可用性判定必须解析数据帧**：HTTP 200 **不等于**可用。实测网关会在 2xx 的流里塞进
  错误对象（`data: {"error":{"type":"server_error",…}}`），只看状态码会把不可用的模型
  误判为可用。判定顺序是：非 2xx 按错误信封的 `type` 与状态码分类；2xx 则读数据帧，
  出现错误对象即判失败，出现正常增量才判可用。
- **瞬时故障宽限**：限流、上游 5xx、网络失败属于瞬时故障。一个模型在**连续 3 次以内**的
  瞬时故障中**保留此前的判定**（因此一次抖动不会把它从目录里抹掉），第 3 次才转为
  不可用并移出目录。地区归属不会被一次 429 覆盖（地区受限的模型在限流那一轮仍留在地区分组）。
- **全轮限流退避**：如果一整轮里所有模型都被判为限流，下一次探测的间隔按指数延长
  （退避间隔恒不小于配置周期），直到某一轮出现至少一个可用模型后回到配置周期。上限 1 小时。
- **身份/版本被拒是插件级失败**：`403 FreeTierError` 或 `426 UpgradeRequired` 与具体模型
  无关，此时整条车道降级——所有模型转 `unknown`、两条路由都清空，并记录一条插件级诊断。
  其它情况下，清单拉取失败只会让**本轮作废**，既有目录保持不动。
- **结果持久化**：最近一次判定写入宿主环境解析出的状态目录
  （`$DSH_HOME/zen-proxy/availability.json`，未设置 `DSH_HOME` 时为宿主配置根下的同名路径），
  采用「先写临时文件再原子改名」。文件缺失或无法解析时按无历史处理，挂载不受影响。
  因此**重启后目录在首轮探测完成前就反映上次已知状态**。
- **探测流量与对话配额隔离**：探测使用独立种子派生的 `x-opencode-session`，与任何用户对话的
  会话都不同；用户对话的会话按对话标识经 sha256 **稳定派生**，同一对话重启后仍是同一会话
  （免费配额按 session 计，逐请求新造会话会把配额打满）。

> 实测提醒：一轮探测会短时间内打出十来个请求，**整条车道随后出现瞬时限流是正常的**
> （实测遇到过：探测刚结束，紧接着的对话请求得到 `429 RATE_LIMIT`，等一分钟再试即恢复）。
> 这正是上面「瞬时故障宽限」和「退避」存在的原因。

---

## 地区受限模型

`muse-spark-1.2-contributor-free` 与 `muse-spark-1.3-contributor-free` 在本机出口
（实测国家 `CN`）恒为：

```json
{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}
```

HTTP 状态码 403，无论走 `/chat/completions` 还是 `/responses`、无论是否携带工具都一样。
它们只会出现在 `opencode-free-region` 分组里，`opencode-free` 里不会出现。

> 注意一个实测到的先后关系：当免费车道正处于**限流**状态时，这两个模型返回的是
> `429 FreeUsageLimitError` 而不是 `RegionError`——**限流发生在地区判定之前**。因此
> 「地区受限」只能在车道不处于限流时观察到；插件靠上面说的「瞬时故障宽限」保留此前
> 的地区归属，不会被一次 429 抹掉。

---

## 上游协议

- 清单：`GET https://opencode.ai/zen/v1/models`（唯一允许写死的网络地址就是上游 base URL）。
- chat 协议族：`POST https://opencode.ai/zen/v1/chat/completions`。
- responses 协议族：`POST https://opencode.ai/zen/v1/responses`。

协议族按模型 id 判定：`muse-spark*` 走 responses，其余走 chat。**这个判据是间接的，且在本机
无法证真**：上游清单不披露协议族，而这两个 id 走哪条端点都返回 `RegionError`（地区闸门先于
路由判定），因此真实链路无从区分；依据、反证与残留不确定性见
`openspec/changes/archive/2026-10-07-add-opencode-free-provider/evidence.md` 的「协议族的判据（间接；本机无法证真）」。

每个上游请求都带齐六个身份头。其中 `user-agent`（`opencode/` 且不低于 `1.18.0`）与
`x-opencode-*` 是实测的闸门必需项（去掉 `user-agent` 或去掉全部 `x-opencode-*` → `403
FreeTierError`）；`authorization: Bearer public` 是该车道的池化免密凭据，插件始终携带，
但实测单独去掉它仍返回 `200`（见 evidence (2) 的 F 行）：

```text
user-agent: opencode/<version>        # version >= 1.18.0
authorization: Bearer public
x-opencode-client: desktop
x-opencode-project: global
x-opencode-session: ses_<12 hex><14 base62>
x-opencode-request: msg_<12 hex><14 base62>
```

请求体另外要满足两条闸门要求：**流式**（`stream: true`）与**声明工具数组**。工具数组里
小写的 `bash`、`glob`、`grep`、`read` 四个名字必须齐备，缺失的槽位会优先把能真正代答的
调用方工具改名填入（Windows 上宿主的 `pwsh` 填入 `bash` 槽），其余才补一个自禁用占位工具；
响应侧再把被改写的工具名映射回调用方的原始拼写。

---

## 偏离 dsh attribution 契约的说明

宿主 `@deepseek-ai/dsh-llm` 要求**每个** provider HTTP 请求携带 `attributionHeaders()`，
其实测值为：

```text
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
```

而 Zen 免费车道的闸门只接受 `user-agent: opencode/<version>`（且版本不低于 1.18.0）。
两者互斥，**实测对照**（其余五个身份头齐备，同一份请求体）：

| 发送的 `user-agent` | 结果 |
|---|---|
| `opencode/1.18.31` | `200` ✅ |
| `deepseek-harness/<version> (+…)` | `403 FreeTierError`：`OpenCode's free tier can only be used from within OpenCode` |
| `opencode/1.17.0` / 更旧 | `426 UpgradeRequired`：`OpenCode 1.18.0 or newer is required to use the free tier` |

本插件选择**过闸**，因此在这一处覆盖 attribution：`user-agent` 是官方客户端身份，
**不携带任何用户数据**，也不是遥测通道。该偏离在源码中对应位置有注释
（`src/identity.js` 的模块头与 `buildIdentityHeaders`），此处是面向用户的同一说明。

---

## 已知限制

1. **地区受限模型无法在本机证真**。`muse-spark-1.2/1.3-contributor-free` 在本机出口恒为
   `403 RegionError`（车道处于限流时会先返回 `429`），因此只能验证「归类正确」，无法验证
   「在允许的地区可用」。
2. **responses 协议族无法在本机走通真实链路**。该族只有这两个 muse-spark 模型，全部被地区
   闸门挡住。它的请求编码与事件解析由注入式桩流覆盖（`test/responses.test.js`），
   真实连通性是未验证项。
3. **免费配额仍然存在**。身份伪装只是让请求看起来来自官方客户端，不能创造配额；配额按会话
   池化，用满后会返回 `429 FreeUsageLimitError`（映射为 `RATE_LIMIT`），退避或等窗口恢复。
4. **首版不支持图片输入**。目录里每个模型都声明 `inputModalities: ['text']`，宿主会把图片
   投影成文本占位符，适配器永远不需要处理图片块。
5. **能力元数据只有上下文窗口，且只有部分模型有**。上游清单不提供任何能力字段，
   `contextWindow` 只在有可溯源来源时给出（来源与取值日期见
   `openspec/changes/archive/2026-10-07-add-opencode-free-provider/evidence.md`），无来源的模型省略该字段但
   **仍会出现在目录中**。刻意不声明 `defaultMaxTokens`：调用方未指定输出上限时，适配器不发
   `max_tokens` / `max_output_tokens`（实测上游接受不带上限的请求）。

---

## 开发

```powershell
npm install          # 只装 devDependency：@deepseek-ai/schemastery
npm test             # node:test，覆盖全部纯逻辑模块与适配器行为
```

模块边界：

| 文件 | 职责 |
|---|---|
| `index.js` | 薄入口：`name` / `inject` / `Config` / `apply` |
| `src/identity.js` | 身份头与版本门槛、会话/请求 id 派生（**含上面那处偏离的注释**） |
| `src/http.js` | 上游请求封装、SSE 解码、错误分类接线 |
| `src/catalog.js` | 清单解析、免费过滤、协议族判定、可溯源能力元数据 |
| `src/probe.js` | 单模型探测与判定 |
| `src/state.js` | 判定状态机与持久化 |
| `src/schedule.js` | 周期调度与退避 |
| `src/messages.js` | harness 消息 → 两种 wire 请求体 |
| `src/tools.js` | 工具四连补齐与名称回写 |
| `src/chunks.js` | `StreamChunk` 构造、块索引追踪、用量换算 |
| `src/chat.js` | chat 族 SSE → `StreamChunk` |
| `src/responses.js` | responses 族 SSE → `StreamChunk` |
| `src/failure.js` | 失败分类与失败对象构造 |
| `src/adapter.js` | 适配器（六点：`providerInfo`/`providerRetryPolicy`/`imageRequestPricing`/`listModels`/`resolveModel`/`prepareCall`） |
| `src/register.js` | 宿主接线（唯一接触 `@deepseek-ai/*` 的地方） |

除 `src/register.js` 外没有任何模块 import 宿主包，因此全部纯逻辑都能在仓库内直接单测。

## License

MIT
