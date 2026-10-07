# Spec Delta

## Purpose

向 dsh 暴露 OpenCode Zen 免费模型的 provider 路由与模型目录，使用户无需手工配置即可在模型选择器中直接使用可用免费模型，并让地区受限的免费模型以独立分组呈现。

## ADDED Requirements

### Requirement: 免费模型 provider 注册
插件 SHALL 以 `opencode-free` 与 `opencode-free-region` 两个 provider id 向 `ctx.llm` 注册适配器路由，并在插件卸载时随 fiber 一并释放。

#### Scenario: 挂载后路由可枚举
- **WHEN** 插件在 desktop profile 中挂载完成
- **THEN** `ctx.llm.listProviders()` 的结果包含 id 为 `opencode-free` 与 `opencode-free-region` 的条目，且两条目的 name 均非空

#### Scenario: 卸载后路由消失
- **WHEN** 插件被卸载
- **THEN** `ctx.llm.listProviders()` 不再包含上述两个 id

### Requirement: 目录只公布免费且可用的模型
`opencode-free` 路由的目录 SHALL 只包含模型 id 以 `-free` 结尾、且最近一次探测判定为可用的模型；付费模型、判定不可用的模型与地区受限模型 SHALL NOT 出现在该目录中。

#### Scenario: 付费模型被过滤
- **WHEN** 上游模型清单同时包含以 `-free` 结尾与不以 `-free` 结尾的 id
- **THEN** `opencode-free` 路由的目录只包含以 `-free` 结尾的 id

#### Scenario: 判定不可用的模型被过滤
- **WHEN** 某个免费模型的最近一次探测失败
- **THEN** 该模型不出现在 `opencode-free` 路由的目录中

#### Scenario: 尚未完成首次探测
- **WHEN** 插件刚挂载且本地没有任何历史探测结果
- **THEN** `opencode-free` 路由的目录不包含任何模型，且不抛出错误

### Requirement: 地区受限模型独立分组
地区受限的免费模型 SHALL 只出现在 `opencode-free-region` 路由的目录中。

#### Scenario: 地区受限模型归入地区分组
- **WHEN** 某个免费模型的探测结果为地区受限
- **THEN** 该模型出现在 `opencode-free-region` 路由的目录中，且不出现在 `opencode-free` 路由的目录中

### Requirement: 目录条目自洽
适配器公布的每个模型条目 SHALL 携带与其所属路由一致的 `provider`、非空的 `id` 与非空的 `name`，且同一路由内 `id` MUST NOT 重复。

#### Scenario: 目录通过宿主校验
- **WHEN** `ctx.llm.listModels('opencode-free')` 被调用
- **THEN** 调用成功返回，不抛出 `INVALID_CATALOG`

### Requirement: 能力元数据按可溯源来源，无来源即省略
上游 `GET /zen/v1/models` 实测只返回 `{id, object, created, owned_by}`（无免费标记、无协议族、无上下文窗口、无输出上限），且无可用详情端点（`/zen/v1/models/<id>` 返回 404，能力查询参数返回同一份清单）。适配器 SHALL NOT 编造能力数值：`context.contextWindow` 与 `defaultMaxTokens` SHALL 均为可选，仅当存在可溯源来源（已发布的 Zen 目录数据，并在代码注释与 `evidence.md` 记录来源 URL、取值日期、模型 id）时才提供；无可溯源来源的模型 SHALL 省略 `context` 字段，SHALL NOT 以保守下限或家族猜测填充。模型是否公布 SHALL 只取决于「免费 + 可用」两项判定，SHALL NOT 因元数据缺失而收缩目录。适配器 SHALL NOT 在调用方未指定输出上限时自行发送 `max_tokens` 或 `max_output_tokens`。

#### Scenario: 模型信息解析不因元数据缺失而失败
- **WHEN** `ctx.llm.resolveModelInfo('opencode-free', <某个已公布模型 id>)` 被调用
- **THEN** 返回结果包含该模型 id，且不抛出 `INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT` 或 `INVALID_MODEL_MAX_TOKENS`

#### Scenario: 有来源时提供窗口
- **WHEN** 解析的模型在能力表中存在可溯源窗口值
- **THEN** 返回结果的 `context.contextWindow` 等于该溯源值且为正整数

#### Scenario: 无来源时省略而非填充
- **WHEN** 解析的模型没有可溯源窗口值
- **THEN** 返回结果不含 `context.contextWindow` 也不含 `defaultMaxTokens`，且该模型仍出现在该路由的 `listModels` 结果中

### Requirement: 插件配置面
插件 SHALL 通过 `registerConfigurableProviders` 声明其两个路由，并 SHALL 提供一个可编辑的探测周期配置项，默认值为 10 分钟。

#### Scenario: 配置条目可枚举
- **WHEN** `ctx.llm.listConfigurableProviders()` 被调用
- **THEN** 返回结果包含 provider 为 `opencode-free` 与 `opencode-free-region` 的两个条目，其 displayName 与 settingsNs 均非空

#### Scenario: 探测周期可改
- **WHEN** 用户把探测周期配置改为非默认值
- **THEN** 后续探测按新周期调度，无需重启进程

### Requirement: 不写死用户目录路径
插件 SHALL 通过宿主环境信息解析自身状态目录，并 MUST NOT 在源码中写死任何用户目录绝对路径；唯一允许写死的网络地址是上游 base URL。

#### Scenario: 换用户账户后仍可定位状态目录
- **WHEN** 插件在另一个用户账户下被加载
- **THEN** 插件不读取上一个用户的绝对路径，状态写入由宿主环境解析出的目录

#### Scenario: 源码不含绝对路径
- **WHEN** 审查插件源码
- **THEN** 除上游 base URL 外，不出现任何以盘符或 `/home/`、`/Users/` 开头的用户目录字面量
