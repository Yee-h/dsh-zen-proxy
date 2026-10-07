/**
 * `src/chat.js`：chat 协议族 SSE → StreamChunk。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translateChatStream } from '../src/chat.js';
import { chatFinishFrame, chatFrame, collect } from './fake-upstream.js';

/** 把载荷数组包成异步可迭代对象。 */
async function* payloads(items) {
  for (const item of items) yield item;
}

describe('translateChatStream', () => {
  it('产出顺序为 block-start → 增量 → block-end → usage → finish，且 finish 唯一', async () => {
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({ reasoning: '想一下' }),
      chatFrame({ reasoning: '再想' }),
      chatFrame({ content: '你好' }),
      chatFrame({ content: '，世界' }),
      chatFrame({ finishReason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      '[DONE]',
    ])));

    assert.deepEqual(chunks.map((chunk) => chunk.type), [
      'block-start',
      'reasoning-delta',
      'reasoning-delta',
      'block-start',
      'text-delta',
      'text-delta',
      'block-end',
      'block-end',
      'usage',
      'finish',
    ]);
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });

    const [reasoningStart, textStart] = chunks.filter((chunk) => chunk.type === 'block-start');
    assert.equal(reasoningStart.blockType, 'reasoning');
    assert.equal(reasoningStart.index, 0);
    assert.equal(textStart.blockType, 'text');
    assert.equal(textStart.index, 1);

    const textBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text');
    assert.deepEqual(textBlock.block, { type: 'text', text: '你好，世界' });
    const reasoningBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning');
    assert.deepEqual(reasoningBlock.block, { type: 'reasoning', text: '想一下再想' });

    const usage = chunks.find((chunk) => chunk.type === 'usage');
    assert.deepEqual(usage.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  });

  it('usage 先于 finish，即使上游把 usage 放在很靠前的帧', async () => {
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({ content: 'a', usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      chatFinishFrame('stop'),
    ])));
    const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage');
    const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish');
    assert.ok(usageIndex >= 0 && finishIndex > usageIndex);
  });

  it('工具参数保持原始 JSON 字符串，且分片字段名是 argumentsDelta', async () => {
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({ toolCalls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"cmd"' } }] }),
      chatFrame({ toolCalls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
      chatFinishFrame('tool_calls'),
    ])));

    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].argumentsDelta, '{"cmd"');
    assert.equal(deltas[0].id, 'call_1');
    assert.equal(deltas[0].name, 'bash');
    assert.equal(deltas[1].argumentsDelta, ':"ls"}');
    assert.equal(deltas[1].id, 'call_1');

    const block = chunks.find((chunk) => chunk.type === 'block-end').block;
    assert.deepEqual(block, { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' });
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
  });

  it('finish_reason 为 length 时以 max-tokens 收尾', async () => {
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({ content: 'x' }),
      chatFinishFrame('length'),
    ])));
    assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' });
  });

  it('工具调用名按映射回写成调用方拼写', async () => {
    const rename = new Map([['bash', 'pwsh']]);
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({ toolCalls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{}' } }] }),
      chatFinishFrame('tool_calls'),
    ]), { rename }));
    assert.equal(chunks.find((chunk) => chunk.type === 'tool-call-delta').name, 'pwsh');
    assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.name, 'pwsh');
  });

  it('200 流里的错误对象抛出失败，且之前不产出任何助手内容分片', async () => {
    const stream = translateChatStream(payloads([
      JSON.stringify({ error: { type: 'server_error', message: 'boom' } }),
    ]));
    await assert.rejects(
      async () => {
        for await (const chunk of stream) assert.fail(`不应产出分片：${JSON.stringify(chunk)}`);
      },
      (error) => {
        assert.equal(error.code, 'SERVER');
        assert.equal(error.failure.code, 'SERVER');
        return true;
      },
    );
  });

  it('地区错误以携带原因的失败终止', async () => {
    const stream = translateChatStream(payloads([
      chatFrame({ content: '部分内容' }),
      JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'not available in your country' } }),
    ]));
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const chunk of stream) seen.push(chunk);
      },
      (error) => {
        assert.equal(error.code, 'AUTH');
        assert.match(error.failure.message, /country/);
        return true;
      },
    );
    assert.equal(seen.filter((chunk) => chunk.type === 'finish').length, 0);
  });

  it('取消时以恰好一个 aborted 终止分片收尾', async () => {
    const controller = new AbortController();
    async function* cancelling() {
      yield chatFrame({ content: 'a' });
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const chunks = await collect(translateChatStream(cancelling(), { signal: controller.signal }));
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
    assert.deepEqual(chunks.at(-1).reason.kind, 'aborted');
    assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED');
  });

  it('容忍空行、心跳与非法 JSON 帧', async () => {
    const chunks = await collect(translateChatStream(payloads([
      'not json',
      ':heartbeat',
      chatFrame({ content: 'ok' }),
      chatFinishFrame('stop'),
    ])));
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 1);
  });

  it('流在没有 finish_reason 时也以 stop 收尾', async () => {
    const chunks = await collect(translateChatStream(payloads([chatFrame({ content: 'x' })])));
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
  });

  it('缓存命中从 inputTokens 里扣除', async () => {
    const chunks = await collect(translateChatStream(payloads([
      chatFrame({
        content: 'x',
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
      }),
      chatFinishFrame('stop'),
    ])));
    const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
    assert.equal(usage.inputTokens, 60);
    assert.equal(usage.outputTokens, 5);
    assert.equal(usage.totalTokens, 105);
    assert.equal(usage.cacheReadTokens, 40);
  });
});
