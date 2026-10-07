/**
 * `src/register.js` 与入口 `index.js`：注册面、目录接线、卸载释放与源码卫生。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js';
import { register } from '../src/register.js';
import { chatFinishFrame, chatFrame, fakeFetch, fakeLogger, jsonResponse, sseResponse } from './fake-upstream.js';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'zen-proxy-register-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 一个够用的假 cordis 上下文。 */
function fakeContext({ settingsId = 'zen-proxy' } = {}) {
  const disposers = [];
  const adapterCalls = [];
  const directoryCalls = [];
  const logger = fakeLogger();
  return {
    logger,
    adapterCalls,
    directoryCalls,
    disposers,
    fiber: { entry: { options: { id: settingsId } } },
    llm: {
      registerAdapter(providers, adapter) {
        adapterCalls.push({ providers: [...providers], adapter });
        return { replace: () => {} };
      },
      registerConfigurableProviders(entries) {
        directoryCalls.push(entries);
        return { replace: () => {} };
      },
    },
    effect(callback, label) {
      const disposer = callback();
      disposers.push({ label, disposer });
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };
}

/** 上游桩：清单 + 逐模型的探测/对话响应。 */
function upstreamStub({ listing, framesByModel }) {
  return fakeFetch((url, init) => {
    if (url.endsWith('/models')) return jsonResponse({ object: 'list', data: listing.map((id) => ({ id, object: 'model' })) });
    const model = init.body === undefined ? '' : JSON.parse(init.body).model;
    const frames = framesByModel[model];
    if (frames === undefined) return jsonResponse({ error: { type: 'server_error', message: 'no stub' } }, { status: 500 });
    return sseResponse(frames);
  });
}

/** 一个永远失败的 fetch 桩：让 register 里自动发起的首轮探测不真的碰网络。 */
const noNetwork = () => fakeFetch(() => { throw new TypeError('offline test'); }).fetch;

const LISTING = [
  { id: 'claude-fable-5' },
  { id: 'fledge-alpha-free' },
  { id: 'nemotron-3.5-lightning-free' },
  { id: 'muse-spark-1.3-contributor-free' },
];

const REGION_FRAME = JSON.stringify({
  type: 'error',
  error: { type: 'RegionError', message: 'This model is not available in your country.' },
});

describe('注册面', () => {
  it('以两条路由注册适配器，并声明两个可配置 provider', () => {
    const ctx = fakeContext();
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: noNetwork(),
    });

    assert.equal(ctx.adapterCalls.length, 1);
    assert.deepEqual(ctx.adapterCalls[0].providers, [ROUTE_MAIN, ROUTE_REGION]);
    assert.equal(typeof ctx.adapterCalls[0].adapter.providerInfo, 'function');

    assert.equal(ctx.directoryCalls.length, 1);
    const entries = ctx.directoryCalls[0];
    assert.deepEqual(entries.map((entry) => entry.provider), [ROUTE_MAIN, ROUTE_REGION]);
    for (const entry of entries) {
      assert.ok(entry.displayName.length > 0, 'displayName 非空');
      assert.ok(entry.settingsNs.length > 0, 'settingsNs 非空');
      assert.deepEqual(entry.settingsPath, []);
    }
    assert.equal(entries[0].settingsNs, 'zen-proxy');
    assert.equal(handle.routes.length, 2);
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('settingsNs 取宿主 fiber 的插件 id', () => {
    const ctx = fakeContext({ settingsId: 'custom-id' });
    register(ctx, { probeIntervalMinutes: 10 }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: noNetwork() });
    assert.equal(ctx.directoryCalls[0][0].settingsNs, 'custom-id');
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('probeIntervalMinutes 默认为 10', () => {
    const ctx = fakeContext();
    const handle = register(ctx, {}, { stateFile: join(tempDir(), 'state.json'), fetchImpl: noNetwork() });
    assert.equal(handle.scheduler.nextDelayMs, 10 * 60_000);
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('运行中修改探测周期，下一轮起采用新值（无需重启进程）', async () => {
    const ctx = fakeContext();
    const config = { probeIntervalMinutes: 10 };
    const { fetch } = upstreamStub({
      listing: ['fledge-alpha-free'],
      framesByModel: { 'fledge-alpha-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')] },
    });
    const handle = register(ctx, config, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    assert.equal(handle.scheduler.nextDelayMs, 10 * 60_000);

    config.probeIntervalMinutes = 3;
    await handle.runRound();

    assert.equal(handle.scheduler.nextDelayMs, 3 * 60_000, '重新武装时读取新周期');
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('低于门槛的 OpenCode 版本被回退并记录诊断', () => {
    const ctx = fakeContext();
    const handle = register(ctx, { opencodeVersion: '1.17.0' }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: noNetwork(),
    });
    assert.ok(ctx.logger.lines.warn.some((line) => line.includes('1.17.0')));
    assert.ok(handle.adapter.providerInfo(ROUTE_MAIN).name.length > 0);
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('卸载时停止探测并释放路由', async () => {
    const ctx = fakeContext();
    const { fetch, calls } = upstreamStub({
      listing: LISTING.map((entry) => entry.id),
      framesByModel: { 'fledge-alpha-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')] },
    });
    register(ctx, { probeIntervalMinutes: 10 }, { stateFile: join(tempDir(), 'state.json'), fetchImpl: fetch });
    // 等首轮探测落定，再卸载。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = calls.length;
    for (const entry of ctx.disposers) entry.disposer();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, before, '卸载后不得再发起上游请求');
  });
});

describe('一轮探测驱动目录', () => {
  it('可用 → 主路由；地区受限 → 地区路由；付费模型被过滤', async () => {
    const ctx = fakeContext();
    const listing = [
      'claude-fable-5',
      'fledge-alpha-free',
      'nemotron-3.5-lightning-free',
      'muse-spark-1.3-contributor-free',
      'exo-free',
      'jev-1.13-free',
    ];
    const { fetch } = upstreamStub({
      listing,
      framesByModel: {
        'fledge-alpha-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')],
        'nemotron-3.5-lightning-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')],
        'muse-spark-1.3-contributor-free': [REGION_FRAME],
        'exo-free': [REGION_FRAME],
        'jev-1.13-free': [REGION_FRAME],
      },
    });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: fetch,
    });
    const outcome = await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();

    assert.deepEqual(outcome.candidates, ['fledge-alpha-free', 'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free', 'exo-free', 'jev-1.13-free']);
    const adapter = ctx.adapterCalls[0].adapter;
    assert.deepEqual((await adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['fledge-alpha-free', 'nemotron-3.5-lightning-free']);
    assert.deepEqual(
      (await adapter.listModels(ROUTE_REGION)).map((model) => model.id),
      ['muse-spark-1.3-contributor-free', 'exo-free', 'jev-1.13-free'],
    );
    for (const provider of [ROUTE_MAIN, ROUTE_REGION]) {
      assert.equal((await adapter.listModels(provider)).some((model) => model.id === 'claude-fable-5'), false, '付费模型不得出现');
    }
  });

  it('没有可溯源元数据的免费模型仍进入目录，并记录一条诊断', async () => {
    const ctx = fakeContext();
    const { fetch } = upstreamStub({
      listing: ['jev-1.13-free'],
      framesByModel: { 'jev-1.13-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')] },
    });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, {
      stateFile: join(tempDir(), 'state.json'),
      fetchImpl: fetch,
    });
    await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();

    const adapter = ctx.adapterCalls[0].adapter;
    const ids = (await adapter.listModels(ROUTE_MAIN)).map((model) => model.id);
    assert.deepEqual(ids, ['jev-1.13-free'], '目录不因元数据缺失而收缩');
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'jev-1.13-free');
    assert.equal('context' in resolved, false);
    assert.ok(ctx.logger.lines.warn.some((line) => line.includes('CATALOG_METADATA_UNKNOWN') && line.includes('jev-1.13-free')));
  });

  it('清单拉取失败时本轮作废，既有目录保持不动', async () => {
    const ctx = fakeContext();
    const stateFile = join(tempDir(), 'state.json');
    const good = upstreamStub({
      listing: ['fledge-alpha-free'],
      framesByModel: { 'fledge-alpha-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')] },
    });
    const first = register(ctx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: good.fetch });
    await first.runRound();
    assert.deepEqual((await ctx.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id), ['fledge-alpha-free']);
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();

    const secondCtx = fakeContext();
    const broken = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const second = register(secondCtx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: broken.fetch });
    await second.runRound();
    assert.deepEqual(
      (await secondCtx.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id),
      ['fledge-alpha-free'],
      '一次拉取失败不得清空目录',
    );
    secondCtx.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });

  it('全轮限流时退避，且持久化到传入的状态文件', async () => {
    const ctx = fakeContext();
    const stateFile = join(tempDir(), 'state.json');
    const limited = fakeFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ object: 'list', data: [{ id: 'fledge-alpha-free', object: 'model' }] });
      return jsonResponse({ error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }, { status: 429 });
    });
    const handle = register(ctx, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: limited.fetch });
    const outcome = await handle.runRound();
    ctx.disposers.find((entry) => entry.label.includes('probe')).disposer();

    assert.equal(outcome.throttled, true);
    assert.deepEqual((await ctx.adapterCalls[0].adapter.listModels(ROUTE_MAIN)), []);
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.models['fledge-alpha-free'].state, 'unavailable');
  });

  it('跨重启保留上次判定：新实例在首轮完成前即反映旧结果', async () => {
    const stateFile = join(tempDir(), 'state.json');
    const first = fakeContext();
    const stub = upstreamStub({
      listing: ['fledge-alpha-free'],
      framesByModel: { 'fledge-alpha-free': [chatFrame({ content: 'ok' }), chatFinishFrame('stop')] },
    });
    const a = register(first, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: stub.fetch });
    await a.runRound();
    first.disposers.find((entry) => entry.label.includes('probe')).disposer();

    const second = fakeContext();
    const broken = fakeFetch(() => { throw new TypeError('offline'); });
    register(second, { probeIntervalMinutes: 10 }, { stateFile, fetchImpl: broken.fetch });
    assert.deepEqual(
      (await second.adapterCalls[0].adapter.listModels(ROUTE_MAIN)).map((model) => model.id),
      ['fledge-alpha-free'],
    );
    second.disposers.find((entry) => entry.label.includes('probe')).disposer();
  });
});

describe('入口 index.js', () => {
  it('导出宿主约定的 name / inject / Config / apply', async () => {
    const entry = await import('../index.js');
    assert.equal(entry.name, 'zen-proxy');
    assert.deepEqual(entry.inject, ['llm']);
    assert.equal(typeof entry.apply, 'function');
    const parsed = entry.Config({});
    assert.equal(parsed.probeIntervalMinutes, 10);
    assert.equal(parsed.opencodeVersion, '1.18.31');
  });
});

describe('源码卫生', () => {
  it('除上游 base URL 外没有写死的用户目录绝对路径', () => {
    const root = new URL('../', import.meta.url);
    const files = [
      new URL('index.js', root),
      ...readdirSync(new URL('src/', root)).map((name) => new URL(`src/${name}`, root)),
    ];
    const pattern = /(['"`])(?:[A-Za-z]:[\\/]|\/home\/|\/Users\/|\/root\/)/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const hits = [...text.matchAll(pattern)].map((match) => match[0]);
      assert.deepEqual(hits, [], `${file.pathname} 含有写死的绝对路径：${hits.join(', ')}`);
    }
  });

  it('cordis.patch.yml 的条目 name 与 package.json 的 name 一致', () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8');
    assert.match(patch, new RegExp(`id:\\s*zen-proxy`));
    assert.ok(patch.includes(`name: '${manifest.name}'`), 'loader 条目的 name 必须等于包名');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.dsh.client, undefined, '本插件没有浏览器半身');
    assert.equal(manifest.scripts.test, 'node --test test/*.test.js');
    assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'] !== undefined, true);
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-llm'] !== undefined, true);
  });
});
