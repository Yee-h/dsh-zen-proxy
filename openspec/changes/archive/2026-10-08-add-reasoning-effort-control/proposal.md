# Proposal

## Why

用户报告：模型可以在模型选择器中选中并正常对话，但**思考强度不可调**。核因是适配器既不声明思考菜单，也不发送任何输出预算：

1. **没有菜单**。`src/adapter.js` 的 `modelEntry()` 只给出 `provider` / `id` / `name` / `inputModalities` / `context`，从不给出 `reasoning`。宿主 `normalizeModelInfo` 见到 `reasoning === undefined` 即认为该模型不支持思考档位：`resolveCallWithInfo` 在收到任何档位请求时抛 `UNSUPPORTED_REASONING_EFFORT`，模型选择器也不呈现强度入口。
2. **没有可执行的旋钮**。本车道的网关接受 `reasoning_effort` 一类字段后**忽略**它们（参考实现 2026-09-24 实测：每种拼写 3 次采样，`low` 产生的思考 token 比 `xhigh` 更多；未知字段偶尔以 503 露出）。该车道唯一被执行的旋钮是**输出预算**（chat 族的 `max_tokens`、responses 族的 `max_output_tokens`）：实测 64 token 的上限把思考从约 397 token 压到约 63。
3. **当前实现刻意不发送预算**。`zen-free-provider` 的「能力元数据」需求写着「适配器 SHALL NOT 在调用方未指定输出上限时自行发送 `max_tokens` 或 `max_output_tokens`」。该条写在「输出预算是否被执行」尚未测定的时期，与第 2 点的事实互斥。

因此「可调思考强度」在这条车道上**等价于**「可调的、被执行的输出预算」——这正是本变更要改的东西。

## What Changes

- 新增 `src/effort.js`：思考档位阶梯（`light` / `balanced` / `deep`）与「档位 → 请求体预算」的纯函数，含下界守卫。
- `src/catalog.js` 新增输出上限的溯源表（与既有上下文窗口表同源、同取值日期）与取值函数。
- `src/adapter.js` 的精确模型信息声明 `reasoning: { efforts, defaultEffort }`，使宿主按档位调用成为可能。
- `src/adapter.js` 的请求分发把宿主解析出的档位换成输出预算写入请求体；调用方显式给出的输出上限作为该预算的上限（取较小者），档位不突破它、它也不抬高档位。
- **MODIFIED** `zen-free-provider` 的「能力元数据按可溯源来源，无来源即省略」：删除与事实互斥的「不得自行发送输出预算」一句，改由新需求约束。
- **ADDED** `zen-free-provider` 的「思考强度菜单」需求。
- **ADDED** `zen-free-upstream-wire` 的「思考预算作为唯一可执行的控制」需求。
- README 记录三档语义、预算的溯源来源，以及「档位说明里的数字就是将要发出的数字」。

## Capabilities

### New Capabilities

<!-- 无新增能力：本次只扩展既有能力中的两个。 -->

### Modified Capabilities

- `zen-free-provider`: 精确模型信息新增 `reasoning` 菜单；「能力元数据」需求中与输出预算互斥的一句被替换。
- `zen-free-upstream-wire`: 请求编码新增「档位 → 输出预算」的取值规则。

## Impact

- **代码**：新增 `src/effort.js`；改动 `src/catalog.js`、`src/adapter.js`；新增 `test/effort.test.js`，扩展适配器与请求形状的既有测试。
- **行为变化**：对话请求从此**总是**携带输出预算（未指定时为默认档 `balanced`），此前不携带。思考模型单轮答复的上限因此从「模型容量」变为「档位预算」。
- **规格冲突处置**：本变更选择修改规格并在 design 中留下依据，而不是保留一个使该功能无法实现的条目。
- **不改变**：两条路由、可用性判定、身份伪装、工具四连补齐、协议族分派、配置面（不新增旋钮）。
- **已知限制**：`jev-1.13-free` 不在 models.dev 的 opencode provider 中（无输出上限溯源），其容量项回退到默认值；该 id 实测长期处于瞬时不可用组，通常不出现在目录里。
