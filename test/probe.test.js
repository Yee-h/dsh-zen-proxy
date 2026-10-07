/**
 * `src/probe.js`：单模型探测与判定（判定必须解析数据帧，而不是只看状态码）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROBE_STATE, isNormalIncrement, probeModel, probeRequestFor, verdictFor } from '../src/probe.js';
import { chatFrame, fakeFetch, jsonResponse, sseResponse } from './fake-upstream.js';

const OK_FRAMES = [chatFrame({ content: '' }), chatFrame({ content: 'pong' })];

describe('verdictFor', () => {
  it('地区受限 → region；插件级身份失败 → unknown；瞬时 → transient；终局模型失败 → unavailable', () => {
    assert.equal(verdictFor({ region: true, code: 'AUTH', scope: 'model', disposition: 'terminal' }), PROBE_STATE.region);
    assert.equal(verdictFor({ region: false, code: 'AUTH', scope: 'plugin', disposition: 'terminal' }), PROBE_STATE.unknown);
    assert.equal(verdictFor({ region: false, code: 'SERVER', scope: 'model', disposition: 'transient' }), PROBE_STATE.transient);
    assert.equal(verdictFor({ region: false, code: 'UNKNOWN', scope: 'model', disposition: 'terminal' }), PROBE_STATE.unavailable);
  });
});

describe('isNormalIncrement', () => {
  it('chat 族看 choices[].delta，responses 族看事件名', () => {
    assert.equal(isNormalIncrement('chat', JSON.parse(chatFrame({ content: '' }))), true);
    assert.equal(isNormalIncrement('chat', { choices: [] }), false);
    assert.equal(isNormalIncrement('responses', { type: 'response.output_text.delta' }), true);
    assert.equal(isNormalIncrement('responses', { type: 'response.created' }), false);
  });
});

describe('probeRequestFor', () => {
  it('chat 族发到 chat 端点并把四连工具与 tool_choice:none 一起带上', () => {
    const { wire, path, body } = probeRequestFor('fledge-alpha-free');
    assert.equal(wire, 'chat');
    assert.equal(path, '/chat/completions');
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ['bash', 'glob', 'grep', 'read']);
    assert.equal(body.tool_choice, 'none');
    assert.equal(body.max_tokens, 16);
  });

  it('responses 族发到 responses 端点并使用扁平工具形状', () => {
    const { wire, path, body } = probeRequestFor('muse-spark-1.3-contributor-free');
    assert.equal(wire, 'responses');
    assert.equal(path, '/responses');
    assert.equal(body.store, false);
    assert.deepEqual(body.tools.map((tool) => tool.name).sort(), ['bash', 'glob', 'grep', 'read']);
    assert.equal(body.tools[0].function, undefined);
    assert.equal(body.max_output_tokens, 16);
  });
});

describe('probeModel', () => {
  it('200 + 正常增量 → available，且请求带齐六个身份头', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse(OK_FRAMES));
    const result = await probeModel({ modelId: 'fledge-alpha-free', fetchImpl: fetch });
    assert.equal(result.state, PROBE_STATE.available);
    assert.ok(result.firstIncrementMs >= 0);

    const headers = calls[0].init.headers;
    for (const name of ['user-agent', 'authorization', 'x-opencode-client', 'x-opencode-project', 'x-opencode-session', 'x-opencode-request']) {
      assert.ok(typeof headers[name] === 'string' && headers[name] !== '', `缺少 ${name}`);
    }
    assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(headers['x-opencode-request'], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(calls[0].url, /^https:\/\/opencode\.ai\/zen\/v1\/chat\/completions$/);
    assert.equal(JSON.parse(calls[0].init.body).model, 'fledge-alpha-free');
  });

  it('200 + 顶层 error 对象 → 不可用（不是 available）', async () => {
    const { fetch } = fakeFetch(() => sseResponse([
      JSON.stringify({ error: { type: 'server_error', message: 'boom' } }),
    ]));
    const result = await probeModel({ modelId: 'fledge-alpha-free', fetchImpl: fetch });
    assert.equal(result.state, PROBE_STATE.transient);
    assert.equal(result.failure.code, 'SERVER');
  });

  it('403 + RegionError → 地区受限', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(
      { type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country.' } },
      { status: 403 },
    ));
    const result = await probeModel({ modelId: 'muse-spark-1.3-contributor-free', fetchImpl: fetch });
    assert.equal(result.state, PROBE_STATE.region);
    assert.equal(result.failure.region, true);
  });

  it('403 + FreeTierError 与 426 → 插件级诊断（unknown）', async () => {
    const forbidden = fakeFetch(() => jsonResponse(
      { type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } },
      { status: 403 },
    ));
    const first = await probeModel({ modelId: 'fledge-alpha-free', fetchImpl: forbidden.fetch });
    assert.equal(first.state, PROBE_STATE.unknown);
    assert.equal(first.failure.scope, 'plugin');

    const upgrade = fakeFetch(() => jsonResponse(
      { type: 'error', error: { type: 'UpgradeRequired', message: 'OpenCode 1.18.0 or newer is required to use the free tier' } },
      { status: 426 },
    ));
    const second = await probeModel({ modelId: 'fledge-alpha-free', fetchImpl: upgrade.fetch });
    assert.equal(second.state, PROBE_STATE.unknown);
    assert.equal(second.failure.scope, 'plugin');
  });

  it('503 与网络失败 → transient', async () => {
    const unavailable = fakeFetch(() => jsonResponse(
      { error: { type: 'server_error', message: 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.' } },
      { status: 503 },
    ));
    const first = await probeModel({ modelId: 'exo-free', fetchImpl: unavailable.fetch });
    assert.equal(first.state, PROBE_STATE.transient);

    const broken = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const second = await probeModel({ modelId: 'exo-free', fetchImpl: broken.fetch });
    assert.equal(second.state, PROBE_STATE.transient);
    assert.equal(second.failure.code, 'TRANSPORT');
  });

  it('401 ModelError（上游指名模型不可路由）→ unavailable', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(
      { type: 'error', error: { type: 'ModelError', message: 'Model no-such-model-free is not supported' } },
      { status: 401 },
    ));
    const result = await probeModel({ modelId: 'no-such-model-free', fetchImpl: fetch });
    assert.equal(result.state, PROBE_STATE.unavailable);
  });

  it('2xx 但整段流没有任何增量 → 不当成可用', async () => {
    const { fetch } = fakeFetch(() => sseResponse([JSON.stringify({ object: 'chat.completion.chunk', choices: [] })]));
    const result = await probeModel({ modelId: 'fledge-alpha-free', fetchImpl: fetch });
    assert.notEqual(result.state, PROBE_STATE.available);
  });

  it('探测会话与用户对话隔离，且请求 id 绑定轮次与模型', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse(OK_FRAMES));
    await probeModel({ modelId: 'fledge-alpha-free', round: 'round-1', fetchImpl: fetch });
    await probeModel({ modelId: 'exo-free', round: 'round-1', fetchImpl: fetch });
    await probeModel({ modelId: 'exo-free', round: 'round-2', fetchImpl: fetch });
    const [first, second, third] = calls.map((call) => call.init.headers);
    assert.equal(first['x-opencode-session'], second['x-opencode-session']);
    assert.notEqual(first['x-opencode-request'], second['x-opencode-request']);
    assert.notEqual(second['x-opencode-request'], third['x-opencode-request']);
  });

  it('探测不抛异常', async () => {
    const { fetch } = fakeFetch(() => { throw new Error('意外'); });
    await assert.doesNotReject(() => probeModel({ modelId: 'x-free', fetchImpl: fetch }));
  });
});
