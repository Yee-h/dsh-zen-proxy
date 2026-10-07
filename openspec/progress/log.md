# 进度日志

> 手动维护。启动时读，完成时写。用户纠正后立即记录教训。

## 2026-10-07 — dsh-zen-proxy 适配 DeepSeek Harness Desktop

### 交付

- `dsh-zen-proxy` 从「HTTP 反向代理（监听 4097）」重写为**原生 llm-provider cordis 插件**，直接注册进宿主的模型选择器；provider 名为 `opencode-free`（可用免费模型）与 `opencode-free-region`（地区受限，单独分组显示为不可用）。
- OpenSpec 变更 `add-opencode-free-provider` 已走完 propose → apply → verify → archive；三条能力已同步为 SSOT：`openspec/specs/zen-free-provider/spec.md`、`zen-free-availability/spec.md`、`zen-free-upstream-wire/spec.md`（`openspec validate --all --strict` 3/3 通过）。
- 完成证据：`npm test` 152/152（44 suites）；`node --check` 全绿；产物（index.js、src/*.js、cordis.patch.yml）内除上游 base URL 外无写死绝对路径；无 TODO/占位符。

### 教训

#### 1. 不要把弱证据写成「实测」

`evidence.md` 初稿的「协议族判据」表把「muse id 发到 `/responses` 得到 `RegionError`」当作「该端点接受这个 id」的实测判据。但同一 id 发到 `/chat/completions` **同样**返回 `RegionError` ⇒ **地区闸门先于路由判定**，两条端点在此不可区分，原推理不成立。连带查出 README/design 声称「六个身份头缺任一即被 403」，而证据表 F 行显示去掉 `authorization` 仍返回 `200`。

- 规则：证据表里每一行**能**支撑什么、**不能**支撑什么，必须在同一段落写明；「端点 A 返回 RegionError」推不出「端点 A 接受该 id」。
- 文档里的绝对断言（「必需」「缺任一即…」）必须能在证据表里找到逐行支撑，否则改写为限定表述并标注不确定性。

#### 2. 同一事实写在多处，只改一处等于没改

同一错误断言同时存在于 `README.md` 与 `design.md`；陈旧行号（`src/catalog.js:94` → 实际已移到 `:97`，因为自己的改动插入了 3 行）同时出现在源码注释与 `evidence.md`。修完必须 grep 回查全部副本。

#### 3. 文档承诺必须接线到代码

README 承诺「运行中修改探测周期，下一轮起生效，无需重启进程」，但 `register.js` 把 interval 算成常量后以 `() => intervalMs` 暴露；`schedule.js` 虽在每次重排时重读 getter，getter 本身返回冻结常量 ⇒ 承诺从未兑现。既有测试只覆盖了 scheduler 的活 getter，所以全绿也没暴露。

- 规则：配置项的可变更性要有**跨模块**测试（本仓在 `test/register.test.js` 补「运行中修改探测周期」用例，改前必然失败）。
- 默认值/配置面写进 README 就要有对应注册代码路径：design D13 声称「配置面只引入一个旋钮」，与代码里的 `opencodeVersion` 冲突；因 D4 本就预设该版本值可配，最终**改规格**而非删功能。

#### 4. 归档的两个连带动作（本次踩到）

- **归档前先勾选 tasks.md**：本次归档时是 `0/27`，归档输出直接打印 `Warning: 27 incomplete task(s) found. Continuing due to --yes flag.`。事后补齐为 26 项已勾选，仅保留 `5.4`（真实设备安装确认）未勾选。
- **归档会移动目录**：`openspec/changes/<id>/` → `openspec/changes/archive/<date>-<id>/`，仓库里指向旧路径的引用会立刻失效（本次 `README.md:150` 与 `:211` 两处）。

#### 5. codemode 里嵌 PowerShell 的引号陷阱

在 codemode 的 JS 模板字符串里写 PowerShell 的 `"${f} -> $LASTEXITCODE"`，`${}` 会被 JS **先**插值，报 `ReferenceError: f is not defined`。含 `$var` 的 PowerShell 片段应改用 JS 单引号字符串拼接。

### 残留风险

- **desktop profile 实际挂载未验证**（任务 5.4）：需用户把本包加入 profile 依赖并重启宿主后，确认模型选择器出现 `opencode-free` / `opencode-free-region`。
- **地区车道与 responses 协议族在本机出口（CN）无法证真**，只能证伪（`*muse-spark*` 恒被地区闸门拦住）。
- 宿主契约断言基于本地复刻的桩，与 `_recon` 抽取结果一致，但宿主升级后可能漂移。
