# Spec Delta

## MODIFIED Requirements

### Requirement: 能力元数据按可溯源来源，无来源即省略

上游 `GET /zen/v1/models` 实测只返回 `{id, object, created, owned_by}`（无免费标记、无协议族、无上下文窗口、无输出上限），且无可用详情端点（`/zen/v1/models/<id>` 返回 404，能力查询参数返回同一份清单）。适配器 SHALL NOT 编造能力数值：`context.contextWindow` 与 `defaultMaxTokens` SHALL 均为可选，仅当存在可溯源来源（已发布的 Zen 目录数据，并在代码注释与 `evidence.md` 记录来源 URL、取值日期、模型 id）时才提供；无可溯源来源的模型 SHALL 省略 `context` 字段，SHALL NOT 以保守下限或家族猜测填充。模型是否公布 SHALL 只取决于「免费 + 可用」两项判定，SHALL NOT 因元数据缺失而收缩目录。适配器 SHALL NOT 在精确模型信息中声明 `defaultMaxTokens`；请求体中的输出预算由 `zen-free-upstream-wire` 的「思考预算」需求约束。

#### Scenario: 模型信息解析不因元数据缺失而失败

- **WHEN** `ctx.llm.resolveModelInfo('opencode-free', <某个已公布模型 id>)` 被调用
- **THEN** 返回结果包含该模型 id，且不抛出 `INVALID_MODEL_INFO`、`INVALID_MODEL_CONTEXT` 或 `INVALID_MODEL_MAX_TOKENS`

#### Scenario: 有来源时提供窗口

- **WHEN** 解析的模型在能力表中存在可溯源窗口值
- **THEN** 返回结果的 `context.contextWindow` 等于该溯源值且为正整数

#### Scenario: 无来源时省略而非填充

- **WHEN** 解析的模型没有可溯源窗口值
- **THEN** 返回结果不含 `context.contextWindow` 也不含 `defaultMaxTokens`，且该模型仍出现在该路由的 `listModels` 结果中

## ADDED Requirements

### Requirement: 思考强度菜单

适配器的精确模型信息 SHALL 声明 `reasoning`，其中 `efforts` 为按展示顺序排列的非空档位数组（每项含非空 `id` 与非空 `name`），`defaultEffort` SHALL 落在该数组内，否则宿主会抛 `INVALID_MODEL_REASONING`。档位 id SHALL 为 `light`、`balanced`、`deep`，默认档位 SHALL 为 `balanced`。适配器 SHALL NOT 依据逐模型的能力标记（例如「能否关闭思考」）决定菜单是否提供或预算取值——该属性在本机没有可溯源来源。档位名称 SHALL 携带**调用方未指定输出上限时**该档将要发出的预算数字；调用方指定更小上限时实际发出的值被收窄，故菜单数字是该档上界而非恒等值。目录（`listModels`）的条目 SHALL NOT 携带 `reasoning`：宿主在该路径只保留 `{provider, id, name, description?, inputModalities?}` 五个字段，多余的键被静默丢弃而不报错，带上去没有作用。

#### Scenario: 精确模型信息通过宿主校验

- **WHEN** `ctx.llm.resolveModelInfo('opencode-free', <某个已公布模型 id>)` 被调用
- **THEN** 返回结果含非空的 `reasoning.efforts` 与位于其中的 `reasoning.defaultEffort`，且不抛出 `INVALID_MODEL_REASONING`

#### Scenario: 宿主接受任一档位

- **WHEN** 调用方以 `light`、`balanced` 或 `deep` 之一请求该模型
- **THEN** 宿主不抛出 `UNSUPPORTED_REASONING_EFFORT`

#### Scenario: 档位名称里的数字与将发出的预算一致

- **WHEN** 读取精确模型信息中某一档位名称里的预算数字，且调用方未指定输出上限
- **THEN** 该数字等于以同档位计算出的请求体预算除以 1024 后四舍五入的结果，即界面呈现的数字与线上发出的数字由同一次计算得出

#### Scenario: 目录条目保持宿主接受的形状

- **WHEN** 请求任一路由的 `listModels`
- **THEN** 每个条目的键集合恰好为 `{provider, id, name, inputModalities}`，不含 `reasoning`
