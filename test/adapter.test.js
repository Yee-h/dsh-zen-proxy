/**
 * `src/adapter.js`：目录、精确模型信息、以及一次完整对话的分片行为。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTES,
  ROUTE_MAIN,
  ROUTE_REGION,
  conversationIdentity,
  createAdapter,
} from '../src/adapter.js';
import { MODEL_STATE, emptyState } from '../src/state.js';
import { chatFinishFrame, chatFrame, collect, fakeFetch, sseResponse } from './fake-upstream.js';

/** 网关接受但不执行的强度字段（实测见 `evidence.md` (1)）：适配器一律不在请求体里发送。 */
const EFFORT_FIELDS = ['reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget'];

/**
 * 宿主 `LlmRuntime.normalizeModelInfo` 接受的字段与取值规则（按权威契约逐条抄录成断言）。
 * 这里不 import 宿主包（插件仓库内不可解析），而是把关卡条件写成本地校验器，
 * 让「字段集合不越出宿主接受的集合」成为可执行的断言。
 * @param {string} provider
 * @param {string} model
 * @param {object} resolved
 */
function assertHostAcceptsResolvedModel(provider, model, resolved) {
  assert.equal(typeof resolved.provider, 'string');
  assert.equal(resolved.provider, provider, 'provider 必须等于该路由');
  assert.equal(typeof resolved.id, 'string');
  assert.equal(resolved.id, model, 'id 必须严格等于请求的模型');
  assert.equal(typeof resolved.name, 'string');
  assert.ok(resolved.name.length > 0, 'name 非空');
  if (resolved.description !== undefined) assert.equal(typeof resolved.description, 'string');
  if (resolved.inputModalities !== undefined) {
    assert.ok(Array.isArray(resolved.inputModalities));
  }
  if (resolved.context !== undefined) {
    assert.ok(Number.isInteger(resolved.context.contextWindow), 'contextWindow 必须是整数');
    assert.ok(resolved.context.contextWindow > 0, 'contextWindow 必须为正');
  }
  if (resolved.defaultMaxTokens !== undefined) {
    assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0);
  }
  if (resolved.systemPromptUpdate !== undefined) assert.equal(resolved.systemPromptUpdate, 'in-history');
  if (resolved.toolUpdate !== undefined) {
    assert.ok(['in-history', 'addition-only'].includes(resolved.toolUpdate));
  }
  if (resolved.reasoning !== undefined) {
    assert.ok(Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0);
    const ids = new Set();
    for (const effort of resolved.reasoning.efforts) {
      assert.ok(typeof effort.id === 'string' && effort.id.length > 0);
      assert.ok(typeof effort.name === 'string' && effort.name.length > 0);
      assert.equal(ids.has(effort.id), false, 'reasoning effort id 不得重复');
      ids.add(effort.id);
    }
    if (resolved.reasoning.defaultEffort !== undefined) {
      assert.ok(ids.has(resolved.reasoning.defaultEffort), 'defaultEffort 必须存在于 efforts');
    }
  }
}

/**
 * 宿主 `LlmRuntime.listModels` 的 `INVALID_CATALOG` 条件。
 * @param {string} provider
 * @param {object[]} models
 */
function assertHostAcceptsCatalog(provider, models) {
  const seen = new Set();
  for (const model of models) {
    assert.equal(model.provider, provider);
    assert.ok(typeof model.id === 'string' && model.id.length > 0);
    assert.ok(typeof model.name === 'string' && model.name.length > 0);
    if (model.description !== undefined) assert.equal(typeof model.description, 'string');
    assert.equal(seen.has(model.id), false, 'id 不得重复');
    seen.add(model.id);
  }
}

/** 造一个固定的判定状态。 */
const stateOf = (models) => () => ({
  version: 1,
  updatedAt: 0,
  models: Object.fromEntries(Object.entries(models).map(([id, state]) => [id, { state, transientStreak: 0 }])),
});

const mixedState = stateOf({
  'fledge-alpha-free': MODEL_STATE.available,
  'nemotron-3.5-lightning-free': MODEL_STATE.available,
  'muse-spark-1.3-contributor-free': MODEL_STATE.region,
  'muse-spark-1.2-contributor-free': MODEL_STATE.region,
  'exo-free': MODEL_STATE.unavailable,
  'jev-1.13-free': MODEL_STATE.unknown,
});

describe('providerInfo', () => {
  it('两条路由都有非空 name，且 id 等于路由', () => {
    const adapter = createAdapter({ state: emptyState });
    for (const provider of ROUTES) {
      const info = adapter.providerInfo(provider);
      assert.equal(info.id, provider);
      assert.equal(typeof info.name, 'string');
      assert.ok(info.name.length > 0);
    }
  });
});

describe('listModels', () => {
  it('主路由只返回判定为可用的模型，且条目自洽', async () => {
    const adapter = createAdapter({ state: mixedState });
    const models = await adapter.listModels(ROUTE_MAIN);
    assert.deepEqual(models.map((model) => model.id), ['fledge-alpha-free', 'nemotron-3.5-lightning-free']);
    const ids = new Set();
    for (const model of models) {
      assert.equal(model.provider, ROUTE_MAIN, 'provider 必须与该路由一致');
      assert.equal(typeof model.id, 'string');
      assert.ok(model.id.length > 0);
      assert.equal(typeof model.name, 'string');
      assert.ok(model.name.length > 0);
      assert.deepEqual(model.inputModalities, ['text']);
      assert.equal(ids.has(model.id), false, 'id 不得重复');
      ids.add(model.id);
    }
  });

  it('地区路由只返回判定为地区受限的模型', async () => {
    const adapter = createAdapter({ state: mixedState });
    const models = await adapter.listModels(ROUTE_REGION);
    assert.deepEqual(models.map((model) => model.id), ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free']);
    for (const model of models) assert.equal(model.provider, ROUTE_REGION);
  });

  it('未知与不可用的模型两条路由都不出现', async () => {
    const adapter = createAdapter({ state: mixedState });
    for (const provider of ROUTES) {
      const ids = (await adapter.listModels(provider)).map((model) => model.id);
      assert.equal(ids.includes('exo-free'), false);
      assert.equal(ids.includes('jev-1.13-free'), false);
    }
  });

  it('没有历史判定时目录为空且不抛错', async () => {
    const adapter = createAdapter({ state: emptyState });
    for (const provider of ROUTES) assert.deepEqual(await adapter.listModels(provider), []);
  });

  it('未知路由返回空目录', async () => {
    const adapter = createAdapter({ state: mixedState });
    assert.deepEqual(await adapter.listModels('nope'), []);
  });
});

describe('宿主校验规则', () => {
  it('两个路由的目录都通过 INVALID_CATALOG 的条件', async () => {
    const adapter = createAdapter({ state: mixedState });
    for (const provider of ROUTES) {
      assertHostAcceptsCatalog(provider, await adapter.listModels(provider));
    }
  });

  it('每个已公布模型的精确信息都通过 INVALID_MODEL_* 的条件', async () => {
    const adapter = createAdapter({ state: mixedState });
    for (const provider of ROUTES) {
      for (const model of await adapter.listModels(provider)) {
        assertHostAcceptsResolvedModel(provider, model.id, await adapter.resolveModel(provider, model.id));
      }
    }
    // 未列出的 id 同样必须能通过校验。
    assertHostAcceptsResolvedModel(ROUTE_MAIN, 'brand-new-free', await adapter.resolveModel(ROUTE_MAIN, 'brand-new-free'));
  });
});

describe('思考强度菜单', () => {
  it('精确模型信息声明三档，默认档在菜单内', async () => {
    const adapter = createAdapter({ state: mixedState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'fledge-alpha-free');
    assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['light', 'balanced', 'deep']);
    assert.equal(resolved.reasoning.defaultEffort, 'balanced');
    for (const effort of resolved.reasoning.efforts) {
      assert.ok(effort.name.includes('K'), '档位名称要能看出预算');
    }
  });

  it('无溯源输出上限的模型也给出菜单（容量回退）', async () => {
    const adapter = createAdapter({ state: mixedState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'jev-1.13-free');
    assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['light', 'balanced', 'deep']);
    assert.equal(resolved.context, undefined);
  });

  it('目录条目不携带 reasoning：宿主在该路径只保留四个字段', async () => {
    const adapter = createAdapter({ state: mixedState });
    for (const provider of ROUTES) {
      for (const model of await adapter.listModels(provider)) {
        assert.deepEqual(Object.keys(model).sort(), ['id', 'inputModalities', 'name', 'provider']);
      }
    }
  });
});

describe('resolveModel', () => {
  it('id 严格等于请求的模型，且字段集合不越出宿主接受的集合', async () => {
    const adapter = createAdapter({ state: mixedState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'fledge-alpha-free');
    assert.equal(resolved.provider, ROUTE_MAIN);
    assert.equal(resolved.id, 'fledge-alpha-free');
    assert.equal(typeof resolved.name, 'string');
    assert.ok(resolved.name.length > 0);
    assert.deepEqual(Object.keys(resolved).sort(), ['context', 'id', 'inputModalities', 'name', 'provider', 'reasoning']);
    assert.deepEqual(resolved.inputModalities, ['text']);
    assert.equal(resolved.systemPromptUpdate, undefined);
    assert.equal(resolved.toolUpdate, undefined);
    assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['light', 'balanced', 'deep']);
  });

  it('有可溯源来源的模型给出该 contextWindow', async () => {
    const adapter = createAdapter({ state: mixedState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'fledge-alpha-free');
    assert.deepEqual(resolved.context, { contextWindow: 1048576 });
    const nemotron = await adapter.resolveModel(ROUTE_MAIN, 'nemotron-3.5-lightning-free');
    assert.deepEqual(nemotron.context, { contextWindow: 262144 });
  });

  it('无来源的模型省略 context 与 defaultMaxTokens，但仍能解析', async () => {
    const adapter = createAdapter({ state: mixedState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'jev-1.13-free');
    assert.equal(resolved.id, 'jev-1.13-free');
    assert.equal('context' in resolved, false);
    assert.equal('defaultMaxTokens' in resolved, false);
  });

  it('未列出的 id 也能解析（核心路由不依赖目录成员资格）', async () => {
    const adapter = createAdapter({ state: emptyState });
    const resolved = await adapter.resolveModel(ROUTE_MAIN, 'brand-new-free');
    assert.equal(resolved.id, 'brand-new-free');
    assert.equal(resolved.provider, ROUTE_MAIN);
  });
});

describe('conversationIdentity', () => {
  it('同一对话稳定，不同对话不同，且与探测会话无关', async () => {
    const adapter = createAdapter({ state: emptyState });
    void adapter;
    const options = { sessionId: 'session-a', messages: [{ id: 'msg-1' }] };
    const first = conversationIdentity(options);
    assert.deepEqual(conversationIdentity(options), first);
    assert.equal(conversationIdentity({ sessionId: 'session-a', messages: [{ id: 'msg-1' }] }).session, first.session);
    assert.notEqual(conversationIdentity({ sessionId: 'session-b', messages: [{ id: 'msg-1' }] }).session, first.session);
    assert.notEqual(conversationIdentity({ sessionId: 'session-a', messages: [{ id: 'msg-2' }] }).requestId, first.requestId);
    assert.match(first.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});

describe('prepareCall / stream', () => {
  const options = {
    provider: ROUTE_MAIN,
    model: 'fledge-alpha-free',
    sessionId: 'session-a',
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }] },
    ],
    tools: [{ name: 'pwsh', description: 'shell', parameters: { type: 'object', properties: {} } }],
  };

  it('发出的请求带齐身份头、四连工具、tool_choice 与原始对话', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    await collect(prepared.stream(options));

    assert.match(calls[0].url, /\/zen\/v1\/chat\/completions$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'fledge-alpha-free');
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ['bash', 'glob', 'grep', 'read']);
    assert.equal(body.max_tokens, 16384, '未指定档位时按默认（均衡）档发出预算');
    for (const field of EFFORT_FIELDS) assert.equal(field in body, false, `不应发送 ${field}`);
    const headers = calls[0].init.headers;
    assert.match(headers['user-agent'], /^opencode\/1\.18\./);
    assert.equal(headers.authorization, 'Bearer public');
  });

  it('调用方指定的上限收窄档位预算', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    await collect(prepared.stream({ ...options, maxTokens: 2048 }));
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 2048);
  });

  it('调用方指定的上限不把档位预算抬高', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    await collect(prepared.stream({ ...options, maxTokens: 4000000 }));
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 16384, '档位预算不被调用方的更大上限抬高');
  });

  it('非法调用方上限不把请求体预算压到 0', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
      const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
      const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
      await collect(prepared.stream({ ...options, maxTokens: bad }));
      assert.equal(JSON.parse(calls[0].init.body).max_tokens, 16384, String(bad));
    }
  });

  it('无溯源输出上限的模型在 deep 档发出回退容量 32768', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'jev-1.13-free');
    await collect(prepared.stream({ ...options, model: 'jev-1.13-free', reasoningEffort: 'deep' }));
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 32768);
  });

  it('档位改变 chat 请求体的预算', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([chatFrame({ content: 'hi' }), chatFinishFrame('stop')]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    await collect(prepared.stream({ ...options, reasoningEffort: 'light' }));
    await collect(prepared.stream({ ...options, reasoningEffort: 'deep' }));
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 4096);
    assert.equal(JSON.parse(calls[1].init.body).max_tokens, 131072);
  });

  it('responses 族把预算写在 max_output_tokens', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
      JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_REGION, 'muse-spark-1.3-contributor-free');
    await collect(prepared.stream({
      ...options,
      provider: ROUTE_REGION,
      model: 'muse-spark-1.3-contributor-free',
      reasoningEffort: 'light',
    }));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.max_output_tokens, 4096);
    assert.equal('max_tokens' in body, false);
    for (const field of EFFORT_FIELDS) assert.equal(field in body, false, `不应发送 ${field}`);
  });

  it('工具调用名回写成调用方拼写', async () => {
    const { fetch } = fakeFetch(() => sseResponse([
      chatFrame({ toolCalls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] }),
      chatFinishFrame('tool_calls'),
    ]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    const chunks = await collect(prepared.stream(options));
    const block = chunks.find((chunk) => chunk.type === 'block-end').block;
    assert.equal(block.name, 'pwsh');
  });

  it('responses 族模型发往 /responses', async () => {
    const { fetch, calls } = fakeFetch(() => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
      JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_REGION, 'muse-spark-1.3-contributor-free');
    const chunks = await collect(prepared.stream({ ...options, provider: ROUTE_REGION, model: 'muse-spark-1.3-contributor-free' }));
    assert.match(calls[0].url, /\/zen\/v1\/responses$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.store, false);
    assert.equal(body.tools[0].function, undefined);
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  });

  it('上游失败以抛出带 code/failure 的错误交付（宿主会转成终止失败分片）', async () => {
    const { fetch } = fakeFetch(() => sseResponse([
      JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'not available in your country' } }),
    ]));
    const adapter = createAdapter({ state: mixedState, fetchImpl: fetch });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const chunk of prepared.stream(options)) seen.push(chunk);
      },
      (error) => {
        assert.equal(error.code, 'AUTH');
        assert.equal(error.failure.code, 'AUTH');
        return true;
      },
    );
    assert.equal(seen.some((chunk) => chunk.type === 'text-delta'), false);
  });

  it('已经取消的信号直接产出 aborted 终止分片', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createAdapter({ state: mixedState });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    const chunks = await collect(prepared.stream({ ...options, signal: controller.signal }));
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish']);
    assert.equal(chunks[0].reason.kind, 'aborted');
  });

  it('prepareCall 返回的 model 与 resolveModel 同形', async () => {
    const adapter = createAdapter({ state: mixedState });
    const prepared = await adapter.prepareCall(ROUTE_MAIN, 'fledge-alpha-free');
    assert.deepEqual(prepared.model, await adapter.resolveModel(ROUTE_MAIN, 'fledge-alpha-free'));
  });
});

describe('重试策略与图片计价', () => {
  it('都使用宿主默认（undefined）', () => {
    const adapter = createAdapter({ state: emptyState });
    assert.equal(adapter.providerRetryPolicy(ROUTE_MAIN), undefined);
    assert.equal(adapter.imageRequestPricing(ROUTE_MAIN, 'fledge-alpha-free'), undefined);
  });
});
