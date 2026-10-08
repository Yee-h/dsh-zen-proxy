/**
 * `src/catalog.js`：清单解析、免费过滤、协议族判定与可溯源能力元数据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATALOG_METADATA_UNKNOWN,
  CONTEXT_WINDOW_SOURCE,
  OUTPUT_LIMIT_SOURCE,
  CHAT_COMPLETIONS_PATH,
  RESPONSES_PATH,
  UPSTREAM_BASE_URL,
  contextWindowFor,
  displayNameFor,
  freeCandidates,
  hasTraceableCapabilities,
  isFreeModel,
  isResponsesModel,
  outputLimitFor,
  parseListing,
  pathForModel,
  pathForWire,
  wireFor,
} from '../src/catalog.js';

/** 真实清单的形状（实测：只有 id / object / created / owned_by）。 */
const LISTING = {
  object: 'list',
  data: [
    { id: 'claude-fable-5', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'fledge-alpha-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'exo-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'muse-spark-1.3-contributor-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
    { id: 'jev-1.13-free', object: 'model', created: 1791377709, owned_by: 'opencode' },
  ],
};

describe('parseListing', () => {
  it('从 {data:[{id}]} 里取出 id 并去重', () => {
    assert.deepEqual(parseListing(LISTING), [
      'claude-fable-5',
      'fledge-alpha-free',
      'exo-free',
      'muse-spark-1.3-contributor-free',
      'jev-1.13-free',
    ]);
    assert.deepEqual(parseListing({ data: [{ id: 'a' }, { id: 'a' }] }), ['a']);
    assert.deepEqual(parseListing({ data: ['b', { id: '' }, 3] }), ['b']);
    assert.deepEqual(parseListing(undefined), []);
  });
});

describe('免费过滤', () => {
  it('只保留 -free 结尾的 id', () => {
    assert.deepEqual(freeCandidates(LISTING), [
      'fledge-alpha-free',
      'exo-free',
      'muse-spark-1.3-contributor-free',
      'jev-1.13-free',
    ]);
    assert.equal(isFreeModel('claude-fable-5'), false);
    assert.equal(isFreeModel('free'), false);
    assert.equal(isFreeModel('-free'), false);
    assert.equal(isFreeModel('mimo-v2.6-flash-free'), true);
  });
});

describe('协议族判定', () => {
  it('muse-spark 系走 responses，其余走 chat', () => {
    assert.equal(wireFor('muse-spark-1.3-contributor-free'), 'responses');
    assert.equal(wireFor('muse-spark-1.2-contributor-free'), 'responses');
    assert.equal(wireFor('muse_spark-1.4-free'), 'responses');
    assert.equal(wireFor('fledge-alpha-free'), 'chat');
    assert.equal(wireFor('nemotron-3-ultra-free'), 'chat');
    assert.equal(wireFor('openrouter/muse-spark-x'), 'responses');
    assert.equal(isResponsesModel('fledge-alpha-free'), false);
  });

  it('端点路径按协议族选择，其余地址只有上游 base URL', () => {
    assert.equal(pathForWire('chat'), CHAT_COMPLETIONS_PATH);
    assert.equal(pathForWire('responses'), RESPONSES_PATH);
    assert.equal(pathForModel('muse-spark-1.3-contributor-free'), RESPONSES_PATH);
    assert.equal(pathForModel('fledge-alpha-free'), CHAT_COMPLETIONS_PATH);
    assert.equal(UPSTREAM_BASE_URL, 'https://opencode.ai/zen/v1');
  });
});

describe('可溯源能力元数据', () => {
  it('有来源的模型给出正的窗口值', () => {
    assert.equal(contextWindowFor('fledge-alpha-free'), 1048576);
    assert.equal(contextWindowFor('nemotron-3.5-lightning-free'), 262144);
    assert.equal(contextWindowFor('space-bunny-free'), 1048576);
    assert.equal(hasTraceableCapabilities('exo-free'), true);
    for (const [id, value] of Object.entries(CONTEXT_WINDOW_SOURCE)) {
      assert.ok(Number.isSafeInteger(value) && value > 0, `${id} 的窗口值必须为正整数`);
    }
    // 计数型断言：空表/键名改坏时上面的循环会「零次通过」，因此必须锁定受检条数。
    assert.equal(Object.keys(CONTEXT_WINDOW_SOURCE).length, 11, '受检窗口条目数');
  });

  it('没有来源的模型返回 undefined（调用方须省略 context）', () => {
    assert.equal(contextWindowFor('jev-1.13-free'), undefined);
    assert.equal(contextWindowFor('some-future-model-free'), undefined);
    assert.equal(hasTraceableCapabilities('jev-1.13-free'), false);
  });

  it('有输出上限来源的模型给出正的上限值', () => {
    assert.equal(outputLimitFor('mimo-v2.6-flash-free'), 32000);
    assert.equal(outputLimitFor('space-bunny-free'), 524288);
    assert.equal(outputLimitFor('nemotron-3.5-lightning-free'), 262144);
    for (const [id, value] of Object.entries(OUTPUT_LIMIT_SOURCE)) {
      assert.ok(Number.isSafeInteger(value) && value > 0, id + ' 的输出上限必须为正整数');
    }
    // 计数型断言 + 与窗口表同键：两表取自同一次 models.dev 抓取、覆盖同一批 11 个免费 id，
    // 因此键集合必须相同（jev-1.13-free 双双缺席）。空表或键名漂移都会在此失败。
    assert.equal(Object.keys(OUTPUT_LIMIT_SOURCE).length, 11, '受检输出上限条目数');
    assert.deepEqual(
      Object.keys(OUTPUT_LIMIT_SOURCE).sort(),
      Object.keys(CONTEXT_WINDOW_SOURCE).sort(),
      '两张溯源表必须覆盖同一批模型 id',
    );
  });

  it('没有输出上限来源的模型返回 undefined', () => {
    assert.equal(outputLimitFor('jev-1.13-free'), undefined);
    assert.equal(outputLimitFor('some-future-model-free'), undefined);
    assert.equal(Object.hasOwn(OUTPUT_LIMIT_SOURCE, 'jev-1.13-free'), false);
  });

  it('诊断码是稳定字符串', () => {
    assert.equal(CATALOG_METADATA_UNKNOWN, 'CATALOG_METADATA_UNKNOWN');
  });
});

describe('displayNameFor', () => {
  it('把上游 id 渲染成可展示的名字', () => {
    assert.equal(displayNameFor('fledge-alpha-free'), 'Fledge Alpha Free');
    assert.equal(displayNameFor('nemotron-3.5-lightning-free'), 'Nemotron 3.5 Lightning Free');
    assert.equal(displayNameFor('jev-1.13-free'), 'Jev 1.13 Free');
    assert.notEqual(displayNameFor('exo-free'), '');
  });
});
