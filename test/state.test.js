/**
 * `src/state.js`：判定状态机与持久化。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { PROBE_STATE } from '../src/probe.js';
import {
  DATA_DIR_NAME,
  DIAGNOSTIC,
  MODEL_STATE,
  STATE_FILE_NAME,
  STATE_VERSION,
  TRANSIENT_GRACE,
  emptyState,
  loadState,
  modelsWithVerdict,
  reduceRound,
  resolveStateDir,
  resolveStateFile,
  saveState,
  verdictOf,
} from '../src/state.js';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'zen-proxy-test-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 造一个「上一轮已判定 available」的状态。 */
const available = (id) => ({ version: 1, updatedAt: 0, models: { [id]: { state: 'available', transientStreak: 0 } } });

describe('reduceRound', () => {
  it('一次 503 之后模型仍留在主路由目录', () => {
    const { state } = reduceRound(available('exo-free'), {
      models: ['exo-free'],
      results: { 'exo-free': { state: PROBE_STATE.transient, detail: '503' } },
      now: 1,
    });
    assert.equal(verdictOf(state, 'exo-free'), MODEL_STATE.available);
  });

  it('连续三次瞬时故障后移出目录', () => {
    assert.equal(TRANSIENT_GRACE, 3);
    let state = available('exo-free');
    const transient = { 'exo-free': { state: PROBE_STATE.transient, detail: '503' } };
    for (let strike = 1; strike < TRANSIENT_GRACE; strike += 1) {
      state = reduceRound(state, { models: ['exo-free'], results: transient, now: strike }).state;
      assert.equal(verdictOf(state, 'exo-free'), MODEL_STATE.available, `第 ${strike} 次仍保留`);
    }
    const last = reduceRound(state, { models: ['exo-free'], results: transient, now: TRANSIENT_GRACE });
    assert.equal(verdictOf(last.state, 'exo-free'), MODEL_STATE.unavailable);
    assert.ok(last.diagnostics.some((entry) => entry.code === DIAGNOSTIC.graceExpired));
  });

  it('成功的探测把瞬时故障计数清零', () => {
    let state = available('exo-free');
    state = reduceRound(state, { models: ['exo-free'], results: { 'exo-free': { state: PROBE_STATE.transient } }, now: 1 }).state;
    state = reduceRound(state, { models: ['exo-free'], results: { 'exo-free': { state: PROBE_STATE.available } }, now: 2 }).state;
    assert.equal(state.models['exo-free'].transientStreak, 0);
    state = reduceRound(state, { models: ['exo-free'], results: { 'exo-free': { state: PROBE_STATE.transient } }, now: 3 }).state;
    assert.equal(verdictOf(state, 'exo-free'), MODEL_STATE.available);
  });

  it('429 不改变地区归属', () => {
    const region = { version: 1, updatedAt: 0, models: { 'muse-spark-1.3-contributor-free': { state: 'region', transientStreak: 0 } } };
    const { state } = reduceRound(region, {
      models: ['muse-spark-1.3-contributor-free'],
      results: { 'muse-spark-1.3-contributor-free': { state: PROBE_STATE.transient, detail: '429' } },
      now: 1,
    });
    assert.equal(verdictOf(state, 'muse-spark-1.3-contributor-free'), MODEL_STATE.region);
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.region), ['muse-spark-1.3-contributor-free']);
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.available), []);
  });

  it('地区判定只出现在地区路由', () => {
    const { state } = reduceRound(emptyState(), {
      models: ['a-free', 'b-free'],
      results: {
        'a-free': { state: PROBE_STATE.available },
        'b-free': { state: PROBE_STATE.region, detail: 'RegionError' },
      },
      now: 1,
    });
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.available), ['a-free']);
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.region), ['b-free']);
  });

  it('全局失败把全部模型转 unknown', () => {
    const { state, diagnostics } = reduceRound(emptyState(), {
      models: ['a-free', 'b-free'],
      results: { 'a-free': { state: PROBE_STATE.available }, 'b-free': { state: PROBE_STATE.region } },
      pluginFailure: { message: 'OpenCode 1.18.0 or newer is required to use the free tier', upstreamType: 'UpgradeRequired', status: 426 },
      now: 1,
    });
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.available), []);
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.region), []);
    assert.equal(verdictOf(state, 'a-free'), MODEL_STATE.unknown);
    assert.equal(verdictOf(state, 'b-free'), MODEL_STATE.unknown);
    assert.ok(diagnostics.some((entry) => entry.code === DIAGNOSTIC.identityRejected));
  });

  it('不可用与未知都不进入任何路由', () => {
    const { state } = reduceRound(emptyState(), {
      models: ['a-free', 'b-free'],
      results: {
        'a-free': { state: PROBE_STATE.unavailable, detail: 'ModelError' },
        'b-free': { state: PROBE_STATE.unknown, detail: '401' },
      },
      now: 1,
    });
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.available), []);
    assert.deepEqual(modelsWithVerdict(state, MODEL_STATE.region), []);
  });

  it('本轮没有结果的模型保留原判定', () => {
    const { state } = reduceRound(available('keep-free'), { models: ['new-free'], results: {}, now: 1 });
    assert.equal(verdictOf(state, 'keep-free'), MODEL_STATE.available);
    assert.equal(verdictOf(state, 'new-free'), MODEL_STATE.unknown);
  });
});

describe('持久化', () => {
  it('写入后重新加载可读回', () => {
    const file = join(tempDir(), STATE_FILE_NAME);
    const next = reduceRound(emptyState(), {
      models: ['exo-free'],
      results: { 'exo-free': { state: PROBE_STATE.available } },
      now: 42,
    }).state;
    assert.equal(saveState(file, next), true);
    assert.deepEqual(loadState(file), next);
  });

  it('文件缺失、被截断或含非法 JSON 时按无历史处理且不抛错', () => {
    const dir = tempDir();
    assert.deepEqual(loadState(join(dir, 'missing.json')), emptyState());

    const truncated = join(dir, 'truncated.json');
    writeFileSync(truncated, '{"version":1,"models":{"a-f', 'utf8');
    assert.deepEqual(loadState(truncated), emptyState());

    const wrongShape = join(dir, 'shape.json');
    writeFileSync(wrongShape, JSON.stringify({ version: 99, models: 'nope' }), 'utf8');
    assert.deepEqual(loadState(wrongShape), emptyState());
  });

  it('忽略状态里形状非法的条目', () => {
    const file = join(tempDir(), STATE_FILE_NAME);
    writeFileSync(file, JSON.stringify({
      version: 1,
      updatedAt: 7,
      models: {
        'good-free': { state: 'available', transientStreak: 0 },
        'bad-free': { state: 'nonsense' },
        'worse-free': 3,
      },
    }), 'utf8');
    const state = loadState(file);
    assert.deepEqual(Object.keys(state.models), ['good-free']);
    assert.equal(state.updatedAt, 7);
    assert.equal(state.version, STATE_VERSION);
  });

  it('写入路径来自环境解析而非字面量', () => {
    const fromEnv = resolveStateDir({ env: { DSH_HOME: join(os.tmpdir(), 'dsh-home') }, home: join(os.tmpdir(), 'ignored') });
    assert.equal(fromEnv, join(os.tmpdir(), 'dsh-home', DATA_DIR_NAME));
    const fromHome = resolveStateDir({ env: {}, home: join(os.tmpdir(), 'someone') });
    assert.equal(fromHome, join(os.tmpdir(), 'someone', '.dsh', DATA_DIR_NAME));
    assert.equal(resolveStateFile({ env: { DSH_HOME: join(os.tmpdir(), 'dsh-home') } }), join(fromEnv, STATE_FILE_NAME));
    assert.equal(resolveStateFile({ stateDir: join(os.tmpdir(), 'explicit') }), join(os.tmpdir(), 'explicit', STATE_FILE_NAME));
  });
});
