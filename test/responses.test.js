/**
 * `src/responses.js`：responses 协议族事件流 → StreamChunk。
 *
 * 本机出口国家被该族拒绝（实测两个 muse-spark 模型均返回 403 RegionError），真实链路
 * 只能证伪，因此这里用注入式桩事件流覆盖映射。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { translateResponsesStream } from '../src/responses.js';
import { collect } from './fake-upstream.js';

async function* payloads(items) {
  for (const item of items) yield item;
}

const event = (value) => JSON.stringify(value);

describe('translateResponsesStream', () => {
  it('把 output_item.added / function_call_arguments.delta / output_text.delta / completed 映射成分片', async () => {
    const chunks = await collect(translateResponsesStream(payloads([
      event({ type: 'response.created' }),
      event({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' } }),
      event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"cmd"' }),
      event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"ls"}' }),
      event({ type: 'response.output_text.delta', delta: '开始做事' }),
      event({
        type: 'response.completed',
        response: { usage: { input_tokens: 20, output_tokens: 7 } },
      }),
    ])));

    assert.deepEqual(chunks.map((chunk) => chunk.type), [
      'block-start',
      'tool-call-delta',
      'tool-call-delta',
      'block-start',
      'text-delta',
      'block-end',
      'block-end',
      'usage',
      'finish',
    ]);
    const toolBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
    assert.deepEqual(toolBlock.block, { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' });
    const textBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text');
    assert.deepEqual(textBlock.block, { type: 'text', text: '开始做事' });
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  });

  it('推理增量走 reasoning-delta', async () => {
    const chunks = await collect(translateResponsesStream(payloads([
      event({ type: 'response.reasoning_summary_text.delta', delta: '想想' }),
      event({ type: 'response.output_text.delta', delta: '回答' }),
      event({ type: 'response.completed', response: {} }),
    ])));
    assert.ok(chunks.some((chunk) => chunk.type === 'reasoning-delta' && chunk.text === '想想'));
  });

  it('response.failed 映射为终止失败（抛出带 code/failure 的错误）', async () => {
    const stream = translateResponsesStream(payloads([
      event({ type: 'response.output_text.delta', delta: '部分' }),
      event({ type: 'response.failed', response: { error: { type: 'server_error', message: 'upstream exploded' } } }),
    ]));
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const chunk of stream) seen.push(chunk);
      },
      (error) => {
        assert.equal(error.code, 'SERVER');
        assert.equal(error.failure.message, 'upstream exploded');
        return true;
      },
    );
    assert.equal(seen.some((chunk) => chunk.type === 'finish'), false);
  });

  it('type:error 事件同样映射为失败', async () => {
    await assert.rejects(
      async () => {
        for await (const chunk of translateResponsesStream(payloads([
          event({ type: 'error', error: { type: 'RegionError', message: 'not available in your country' } }),
        ]))) void chunk;
      },
      (error) => {
        assert.equal(error.code, 'AUTH');
        return true;
      },
    );
  });

  it('response.incomplete 以 max-tokens 收尾', async () => {
    const chunks = await collect(translateResponsesStream(payloads([
      event({ type: 'response.output_text.delta', delta: 'x' }),
      event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }),
    ])));
    assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' });
  });

  it('工具调用名按映射回写', async () => {
    const rename = new Map([['bash', 'pwsh']]);
    const chunks = await collect(translateResponsesStream(payloads([
      event({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' } }),
      event({ type: 'response.completed', response: {} }),
    ]), { rename }));
    assert.equal(chunks.find((chunk) => chunk.type === 'tool-call-delta').name, 'pwsh');
  });

  it('忽略非函数调用的 output_item.added 与未知事件', async () => {
    const chunks = await collect(translateResponsesStream(payloads([
      event({ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } }),
      event({ type: 'response.unknown.event' }),
      event({ type: 'response.output_text.delta', delta: 'ok' }),
      event({ type: 'response.completed', response: {} }),
    ])));
    assert.equal(chunks.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 1);
  });

  it('取消时以恰好一个 aborted 终止分片收尾', async () => {
    const controller = new AbortController();
    async function* cancelling() {
      yield event({ type: 'response.output_text.delta', delta: 'a' });
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const chunks = await collect(translateResponsesStream(cancelling(), { signal: controller.signal }));
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
    assert.equal(chunks.at(-1).reason.kind, 'aborted');
  });
});
