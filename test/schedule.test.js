/**
 * `src/schedule.js`：周期调度、退避与卸载。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backoffDelay, createScheduler } from '../src/schedule.js';

/** 假时钟：手动推进时间，并记录每次武装的延迟。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    schedule: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return seq;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
    /** 把时间推进到下一件到期的事并触发它。 */
    async advance() {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) return false;
      now = next[1].at;
      pending.delete(next[0]);
      next[1].fn();
      return true;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

/** 等到调度器把这一轮跑完（run 是可以同步结算的异步函数）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('backoffDelay', () => {
  it('退避恒不小于配置周期且有上限', () => {
    assert.equal(backoffDelay({ intervalMs: 600_000, throttledRounds: 0 }), 600_000);
    assert.equal(backoffDelay({ intervalMs: 600_000, throttledRounds: 1 }), 1_200_000);
    assert.equal(backoffDelay({ intervalMs: 600_000, throttledRounds: 2 }), 2_400_000);
    assert.equal(backoffDelay({ intervalMs: 600_000, throttledRounds: 40, maxIntervalMs: 3_600_000 }), 3_600_000);
  });
});

describe('createScheduler', () => {
  it('挂载后立即探测一轮，然后按配置周期重复', async () => {
    const clock = fakeClock();
    let rounds = 0;
    const scheduler = createScheduler({
      intervalMs: 600_000,
      run: async () => { rounds += 1; },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    scheduler.start();
    await settle();
    assert.equal(rounds, 1, '挂载后立即探测一轮');
    assert.equal(scheduler.nextDelayMs, 600_000);

    await clock.advance();
    await settle();
    assert.equal(rounds, 2);
    await clock.advance();
    await settle();
    assert.equal(rounds, 3);
  });

  it('卸载后不再探测，且飞行中的那一轮不会重新武装', async () => {
    const clock = fakeClock();
    let rounds = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const scheduler = createScheduler({
      intervalMs: 600_000,
      run: async () => { rounds += 1; await gate; },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    scheduler.start();
    await settle();
    assert.equal(rounds, 1);

    scheduler.stop();
    release();
    await settle();
    assert.equal(clock.pendingCount, 0, '卸载后不得再武装下一轮');
    await clock.advance();
    await settle();
    assert.equal(rounds, 1);
  });

  it('全轮限流时下一次间隔大于配置周期；恢复后回到配置周期', async () => {
    const clock = fakeClock();
    let throttled = true;
    const scheduler = createScheduler({
      intervalMs: 600_000,
      run: async () => ({ throttled }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    scheduler.start();
    await settle();
    assert.ok(scheduler.nextDelayMs > 600_000, `期望退避，实际 ${scheduler.nextDelayMs}`);

    await clock.advance();
    await settle();
    assert.ok(scheduler.nextDelayMs > 600_000, '连续限流继续退避');

    throttled = false;
    await clock.advance();
    await settle();
    assert.equal(scheduler.nextDelayMs, 600_000, '恢复后回到配置周期');
  });

  it('周期在每次重新武装时重新读取，改配置无需重启', async () => {
    const clock = fakeClock();
    let intervalMs = 600_000;
    const scheduler = createScheduler({
      intervalMs: () => intervalMs,
      run: async () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    scheduler.start();
    await settle();
    intervalMs = 60_000;
    await clock.advance();
    await settle();
    assert.equal(scheduler.nextDelayMs, 60_000);
  });

  it('一轮抛错时记录错误并继续调度', async () => {
    const clock = fakeClock();
    const seen = [];
    let rounds = 0;
    const scheduler = createScheduler({
      intervalMs: 600_000,
      run: async () => { rounds += 1; throw new Error('boom'); },
      schedule: clock.schedule,
      cancel: clock.cancel,
      onError: (error) => seen.push(error.message),
    });
    scheduler.start();
    await settle();
    assert.deepEqual(seen, ['boom']);
    assert.equal(scheduler.nextDelayMs, 600_000, '异常轮次不触发退避');
    await clock.advance();
    await settle();
    assert.equal(rounds, 2);
  });
});
