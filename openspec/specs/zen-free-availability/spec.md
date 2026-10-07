# zen-free-availability Specification

## Purpose
判定 OpenCode Zen 免费模型中哪些真正可用，并让这一判定周期性地驱动模型目录，同时避免探测流量挤占用户对话的配额。

## Requirements

### Requirement: 周期探测
插件 SHALL 以配置的探测周期（默认 10 分钟）对所有候选免费模型发起一次可用性探测，并 SHALL 在插件卸载时停止后续探测。

#### Scenario: 按周期重复探测
- **WHEN** 插件已挂载且探测周期为 10 分钟
- **THEN** 每 10 分钟各候选模型被探测一次，且最近一次结果被记录

#### Scenario: 卸载后不再探测
- **WHEN** 插件被卸载
- **THEN** 不再发起新的探测请求

#### Scenario: 探测不阻塞挂载
- **WHEN** 插件挂载且首次探测尚未返回
- **THEN** 挂载立即完成，模型目录在探测返回后被更新

### Requirement: 可用性判定
插件 SHALL 仅当探测响应状态为 2xx 且响应流中不包含错误对象时判定该模型可用。

#### Scenario: 判定为可用
- **WHEN** 探测返回 2xx 且首个数据帧是正常的流式增量
- **THEN** 该模型被判定为可用

#### Scenario: 2xx 但流内报错
- **WHEN** 探测返回 200，但数据帧包含顶层 `error` 对象
- **THEN** 该模型 MUST NOT 被判定为可用

#### Scenario: 非 2xx 状态
- **WHEN** 探测返回任何非 2xx 状态
- **THEN** 该次探测 MUST NOT 产生可用的判定

### Requirement: 失败分类
插件 SHALL 把探测失败归类为地区受限、身份或版本被拒、限流、上游故障与网络失败中的一种，并 SHALL 依据错误对象的 `type` 与状态码分类，而非依据自然语言文本。

#### Scenario: 地区受限
- **WHEN** 探测返回 403 且错误对象的 type 为 `RegionError`
- **THEN** 该模型被归类为地区受限

#### Scenario: 身份或版本被拒
- **WHEN** 探测返回 403 且错误对象的 type 为 `FreeTierError`，或返回 426
- **THEN** 失败被归类为身份或版本被拒，并 SHALL 记录为一条插件级诊断

#### Scenario: 限流
- **WHEN** 探测返回 429
- **THEN** 该模型被归类为限流，且不改变其地区归属

### Requirement: 结果持久化
插件 SHALL 把最近一次探测结果持久化到自身状态目录，并在启动时先加载该结果，使目录在首次探测完成前即可反映上次已知状态。

#### Scenario: 跨重启保留结果
- **WHEN** 插件重启且本地存在上次探测结果
- **THEN** 目录在首次探测完成前即反映上次结果

#### Scenario: 状态文件损坏
- **WHEN** 本地状态文件缺失或无法解析
- **THEN** 插件按无历史结果处理且不中断挂载

### Requirement: 探测流量与对话配额隔离
插件 SHALL 为探测流量使用与该次探测绑定、且与任何用户对话不同的 `x-opencode-session`，使用户对话的会话配额不被探测挤占。

#### Scenario: 探测与对话并发
- **WHEN** 一次用户对话与一轮探测并发进行
- **THEN** 两者发出的 `x-opencode-session` 不相等

### Requirement: 探测退避
当连续多轮探测全部被判为限流时，插件 SHALL 延长下一次探测的间隔，且该间隔 MUST NOT 小于配置周期。

#### Scenario: 全部限流后退避
- **WHEN** 连续两轮及以上探测全部被判为限流
- **THEN** 下一次探测的间隔大于配置周期

#### Scenario: 恢复后退避解除
- **WHEN** 一轮探测中出现至少一个可用模型
- **THEN** 探测间隔恢复为配置周期

### Requirement: 瞬时故障宽限
当探测失败被归类为限流、上游故障或网络失败时，插件 SHALL 在有限次数的连续失败内保留该模型此前的判定，且 MUST NOT 因单次瞬时故障改变其分组归属。

#### Scenario: 单次瞬时故障不改变分组
- **WHEN** 一个此前判定为可用的模型在一次探测中返回 503
- **THEN** 该模型仍出现在 `opencode-free` 路由的目录中

#### Scenario: 连续瞬时故障后判定为不可用
- **WHEN** 同一模型连续三次探测均为瞬时故障
- **THEN** 该模型不再出现在 `opencode-free` 路由的目录中

#### Scenario: 地区判定不被瞬时故障覆盖
- **WHEN** 一个地区受限模型在一次探测中返回 429
- **THEN** 该模型仍归入 `opencode-free-region` 分组
