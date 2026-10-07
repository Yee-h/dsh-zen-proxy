/**
 * dsh-zen-proxy — 把 OpenCode Zen 的免费模型车道接成 dsh 的原生 llm-provider 插件。
 *
 * 插件以官方 OpenCode 客户端的网络身份向上游发请求（免费车道的闸门只认
 * `user-agent: opencode/<>=1.18.0>` 与一组 `x-opencode-*` 头），每 10 分钟探测一次
 * 可用性，并把目录只交给「最近一次判定为可用」的免费模型；地区受限的免费模型进入
 * 独立路由 `opencode-free-region`。
 *
 * 这里只做薄入口：`name` / `inject` / `Config` / `apply`。接线在 `src/register.js`，
 * 宿主无关的纯逻辑在 `src/` 的其余模块里。
 *
 * @module index.js
 */

import z from '@deepseek-ai/schemastery';

import { register } from './src/register.js';
import { DEFAULT_CLIENT_VERSION } from './src/identity.js';
import { DEFAULT_PROBE_INTERVAL_MINUTES } from './src/schedule.js';

/** 插件名。同时是 cordis.patch.yml 里 loader 条目的 `id`。 */
export const name = 'zen-proxy';

/**
 * 只硬依赖 `llm`：没有它插件无事可做；其余宿主facility 一律用可选读取，缺失时
 * 相应功能降级而不是让插件保持 PENDING。
 */
export const inject = ['llm'];

/** 配置面。 */
export const Config = z.object({
  /** 探测周期（分钟），默认 10。 */
  probeIntervalMinutes: z.number().default(DEFAULT_PROBE_INTERVAL_MINUTES),
  /**
   * 伪装用的 OpenCode 版本。只在下限之上生效：低于闸门门槛 `1.18.0` 的值不会被使用，
   * 插件会记录诊断并回退到门槛值（闸门对更旧的版本返回 `426 UpgradeRequired`）。
   */
  opencodeVersion: z.string().default(DEFAULT_CLIENT_VERSION),
});

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{probeIntervalMinutes: number, opencodeVersion: string}} config
 */
export function apply(ctx, config) {
  register(ctx, config, { pluginName: name });
}
