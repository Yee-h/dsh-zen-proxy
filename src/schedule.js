/**
 * 周期探测的调度与退避。
 *
 * 语义（design D10 + spec 的「周期探测」「探测退避」）：
 * - 挂载后**立即**探测一轮，且不阻塞挂载（首轮是异步发起的）；
 * - 之后按配置周期重复；周期在每次重新武装时**重新读取**，因此运行中改配置无需重启；
 * - 一轮结束后才排下一轮，因此不会出现两轮重叠；
 * - 卸载后不再发起任何探测；
 * - 若一整轮里所有模型都被判为限流，则指数退避（有上限），直到某一轮出现至少一个
 *   非限流结果后回到配置周期。退避间隔恒不小于配置周期。
 *
 * 计时器与时钟都可注入，便于用假时钟做确定性测试。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/schedule.js
 */

/** 退避上限：一小时。 */
export const DEFAULT_MAX_INTERVAL_MS = 60 * 60 * 1000;

/** 默认探测周期：10 分钟。 */
export const DEFAULT_PROBE_INTERVAL_MINUTES = 10;

/**
 * 计算退避后的下一轮间隔。
 * @param {{intervalMs: number, throttledRounds: number, maxIntervalMs?: number}} input
 * @returns {number} 不少于 `intervalMs`、不大于 `maxIntervalMs` 的毫秒数
 */
export function backoffDelay({ intervalMs, throttledRounds, maxIntervalMs = DEFAULT_MAX_INTERVAL_MS }) {
  if (!Number.isFinite(throttledRounds) || throttledRounds <= 0) return intervalMs;
  const exponent = Math.min(throttledRounds, 20);
  const grown = intervalMs * 2 ** exponent;
  return Math.max(intervalMs, Math.min(Number.isFinite(grown) ? grown : maxIntervalMs, maxIntervalMs));
}

/**
 * 创建一个周期调度器。
 * @param {{intervalMs: number | (() => number), run: () => Promise<{throttled?: boolean}|void>,
 *          maxIntervalMs?: number, schedule?: (fn: () => void, ms: number) => unknown,
 *          cancel?: (handle: unknown) => void, onError?: (error: unknown) => void}} input
 * @returns {{start: () => void, stop: () => void, runOnce: () => Promise<object|undefined>,
 *            readonly nextDelayMs: number, readonly throttledRounds: number}}
 */
export function createScheduler({
  intervalMs,
  run,
  maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  onError = () => {},
}) {
  const configuredInterval = () => (typeof intervalMs === 'function' ? intervalMs() : intervalMs);
  let handle;
  let stopped = false;
  let throttledRounds = 0;
  let nextDelayMs = configuredInterval();

  function arm() {
    if (stopped) return;
    handle = schedule(() => { void round(); }, nextDelayMs);
    handle?.unref?.();
  }

  async function round() {
    handle = undefined;
    if (stopped) return undefined;
    let outcome;
    try {
      outcome = await run();
    } catch (error) {
      onError(error);
      outcome = undefined;
    }
    // 一轮可能在等待期间被卸载：此时不得再武装下一轮。
    if (stopped) return outcome;
    throttledRounds = outcome?.throttled === true ? throttledRounds + 1 : 0;
    const base = configuredInterval();
    nextDelayMs = throttledRounds === 0
      ? base
      : backoffDelay({ intervalMs: base, throttledRounds, maxIntervalMs });
    arm();
    return outcome;
  }

  return {
    /** 立即发起首轮（不阻塞调用方），并在其结束后进入周期。 */
    start() {
      if (stopped) return;
      void round();
    },
    /** 停止后续探测。正在飞行中的那一轮会在收尾时发现已停止。 */
    stop() {
      stopped = true;
      if (handle !== undefined) cancel(handle);
      handle = undefined;
    },
    /** 直接跑一轮（测试与「立即刷新」使用）。 */
    runOnce() {
      return round();
    },
    get nextDelayMs() {
      return nextDelayMs;
    },
    get throttledRounds() {
      return throttledRounds;
    },
  };
}
