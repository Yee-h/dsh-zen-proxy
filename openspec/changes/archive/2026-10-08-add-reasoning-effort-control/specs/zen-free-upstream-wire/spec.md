# Spec Delta

## ADDED Requirements

### Requirement: 思考预算作为唯一可执行的控制

本车道的网关接受 `reasoning_effort` 一类字段后不执行它们，唯一被执行的强度旋钮是输出预算。因此适配器 SHALL 把宿主解析出的档位折算为请求体的输出上限：chat 协议族写入 `max_tokens`，responses 协议族写入 `max_output_tokens`。档位预算 SHALL 取 2048、8192、模型输出容量三档，其中前两档各按 2 倍给出、容量档取该模型的输出容量（输出上限同时限制思考与正文）；容量项 SHALL 取自标注了来源 URL 与取值日期的溯源表，无溯源时回退到 32768。调用方显式给出的输出上限 SHALL 与档位预算取较小者：档位 SHALL NOT 突破它，它也 SHALL NOT 抬高预算。折算结果 SHALL 为不小于 512 的整数；非正数、`NaN` 与 `Infinity` SHALL 被视为「没有该上限」而不是 0。适配器 SHALL NOT 在请求体中发送 `reasoning_effort`、`thinking`、`enable_thinking` 或 `thinking_budget`。

#### Scenario: 带预算的 chat 请求

- **WHEN** 调用方未指定输出上限、档位为 `balanced`，目标模型由 chat 协议族提供
- **THEN** 请求体含 `max_tokens`，其值等于该模型 `balanced` 档的预算

#### Scenario: 带预算的 responses 请求

- **WHEN** 调用方未指定输出上限，目标模型由 responses 协议族提供
- **THEN** 请求体含 `max_output_tokens`，其值等于该档预算，且不含 `max_tokens`

#### Scenario: 调用方上限收窄档位预算

- **WHEN** 调用方指定的输出上限低于该档预算
- **THEN** 请求体的输出预算等于调用方给定值（在不小于下界的前提下）

#### Scenario: 调用方上限不抬高档位预算

- **WHEN** 调用方指定的输出上限高于该档预算
- **THEN** 请求体的输出预算仍等于该档预算，而不是调用方给定值

#### Scenario: 非法上限不把预算压到 0

- **WHEN** 配置或调用方给出的上限为 `0`、负数、`NaN` 或 `Infinity`
- **THEN** 该值被视为没有上限，请求体的输出预算等于档位预算且不小于 512

#### Scenario: 不发送 effort 字段

- **WHEN** 任一协议族的请求被构造
- **THEN** 请求体中不含 `reasoning_effort`、`thinking`、`enable_thinking` 或 `thinking_budget`
