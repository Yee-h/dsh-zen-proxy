# Spec Delta

## Purpose

以官方 OpenCode 客户端的网络身份向上游发起请求，并让上游的两种流式协议族与 dsh 的消息／分片词汇之间保持一次准确的翻译，使免费车道对调用方表现为一个普通的 dsh provider。

## ADDED Requirements

### Requirement: 客户端身份伪装
插件 SHALL 在每个上游请求上携带 `user-agent`、`authorization`、`x-opencode-client`、`x-opencode-project`、`x-opencode-session` 与 `x-opencode-request` 六个头，其中 `authorization` 的值 SHALL 为 `Bearer public`。

#### Scenario: 身份头齐备
- **WHEN** 插件向上游发起一次对话请求
- **THEN** 该请求同时包含上述六个头，且 `user-agent` 形如 `opencode/<version>`

#### Scenario: 缺少身份头会被拒
- **WHEN** 审查插件的上游请求构造
- **THEN** 不存在任何省略上述任一头部的代码路径

### Requirement: 客户端版本门槛
插件 SHALL 保证 `user-agent` 中的 OpenCode 版本不低于 `1.18.0`；当配置值低于该门槛时，插件 MUST NOT 用该值发请求。

#### Scenario: 低于门槛被拒绝或回退
- **WHEN** 配置的 OpenCode 版本为 `1.17.0`
- **THEN** 插件不以该版本发起请求，而是记录诊断并使用不低于门槛的版本

#### Scenario: 门槛下界可用
- **WHEN** 插件以 `opencode/1.18.0` 发起请求
- **THEN** 该请求不被上游以版本过旧为由拒绝

### Requirement: 会话身份稳定性
插件 SHALL 为一个对话（或一次目录探测）派生稳定的 `x-opencode-session`，使同一对话的多次请求共享同一会话身份；该值 MUST NOT 逐请求随机生成。

#### Scenario: 同一对话会话恒定
- **WHEN** 同一对话连续发起两次请求
- **THEN** 两次请求的 `x-opencode-session` 相同

#### Scenario: 不同对话会话不同
- **WHEN** 两个不同对话各发起一次请求
- **THEN** 两者的 `x-opencode-session` 不相同

### Requirement: 工具指纹补齐
当调用方声明的工具未覆盖上游闸门要求的小写工具名集合（`bash`、`glob`、`grep`、`read`）时，插件 SHALL 在请求体中补齐缺失的名字，并 SHALL 在响应侧把被改写的工具名映射回调用方的原始拼写。

#### Scenario: 补齐缺失工具名
- **WHEN** 调用方只声明了 `glob` 与 `read`
- **THEN** 发往上游的请求体声明了 `bash`、`glob`、`grep`、`read` 四个名字

#### Scenario: 工具调用名回写
- **WHEN** 上游返回的工具调用使用了一个被改写过的工具名
- **THEN** 交付给宿主的工具调用使用调用方的原始拼写

#### Scenario: 大小写变体不重复声明
- **WHEN** 调用方声明的工具名与要求名仅大小写不同
- **THEN** 上游请求体中该要求名只出现一次

### Requirement: 闸门要求的请求形状
插件 SHALL 以流式方式发起对话请求，且 SHALL 在请求体中声明工具数组。

#### Scenario: 流式加工具
- **WHEN** 插件向任一协议族端点发起对话请求
- **THEN** 请求体要求流式返回且包含工具数组

### Requirement: 协议族分派
插件 SHALL 按目标模型选择上游协议族：以 responses 协议族提供的模型发往 `/zen/v1/responses`，其余模型发往 `/zen/v1/chat/completions`，并 SHALL 为该族使用对应的请求编码与流式解析。

#### Scenario: responses 族模型
- **WHEN** 目标模型由上游以 responses 协议族提供
- **THEN** 请求发往 `/zen/v1/responses` 并按该族解析响应流

#### Scenario: chat 族模型
- **WHEN** 目标模型由 chat 协议族提供
- **THEN** 请求发往 `/zen/v1/chat/completions` 并按该族解析响应流

### Requirement: 分片协议合规
交付给宿主的流 SHALL 以恰好一个终止 `finish` 分片结束；当上游返回用量信息时，`usage` 分片 SHALL 先于 `finish` 分片；终止 `finish` 之后 MUST NOT 再有任何分片。

#### Scenario: 正常结束
- **WHEN** 上游流正常结束
- **THEN** 该流以恰好一个终止 `finish` 分片结束

#### Scenario: usage 顺序
- **WHEN** 上游提供了用量信息
- **THEN** `usage` 分片出现在 `finish` 分片之前

#### Scenario: 取消
- **WHEN** 调用方取消该流
- **THEN** 该流以一个终止 `finish` 分片结束，且其形态为取消

### Requirement: 上游失败映射
插件 SHALL 把上游失败映射为 dsh 的提供方中立失败码：限流映射为 `RATE_LIMIT`，地区受限与其他身份类拒绝 SHALL 以携带原因的失败结束该流，且 MUST NOT 伪造成功内容。

#### Scenario: 限流映射
- **WHEN** 上游返回 429
- **THEN** 该流以 `RATE_LIMIT` 失败码终止

#### Scenario: 地区受限不伪装成功
- **WHEN** 上游返回 `RegionError`
- **THEN** 该流以失败终止，且不产生任何助手内容分片

### Requirement: 偏离宿主 attribution 契约的显式记录
由于上游闸门要求 `user-agent` 为 `opencode/<version>`，插件 SHALL 在这一偏离发生处的源码注释与 README 中说明它偏离了 dsh 的 `attributionHeaders()` 要求及其原因。

#### Scenario: 偏离处有注释
- **WHEN** 审查设置上游身份头的源码
- **THEN** 该处存在说明偏离与原因的注释

#### Scenario: README 记录偏离
- **WHEN** 阅读仓库 README
- **THEN** README 说明该插件不发送 dsh 的 attribution `user-agent` 及其原因
