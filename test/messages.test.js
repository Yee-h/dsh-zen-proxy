/**
 * `src/messages.js`：harness 消息 → 两种 wire 请求体。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChatRequest,
  buildRequestFor,
  buildResponsesRequest,
  chatMessages,
  responsesInput,
  textOf,
} from '../src/messages.js';

const userMessage = { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } };
const systemMessage = { id: 'm0', role: 'system', content: [{ type: 'text', text: '你是助手' }], source: { kind: 'system-prompt' } };
const assistantMessage = {
  id: 'm2',
  role: 'assistant',
  content: [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '我来调用工具' },
    { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"cmd":"ls"}' },
  ],
  source: { kind: 'model', provider: 'opencode-free', model: 'fledge-alpha-free' },
};
const toolMessage = {
  id: 'm3',
  role: 'tool',
  toolCallId: 'call_1',
  content: [{ type: 'text', text: 'file-a\nfile-b' }],
  isError: false,
  source: { kind: 'tool', callId: 'call_1' },
};

describe('textOf', () => {
  it('拼接文本块并忽略非文本块', () => {
    assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }]), 'ac');
    assert.equal(textOf('plain'), 'plain');
    assert.equal(textOf(undefined), '');
  });
});

describe('chat 协议族请求体', () => {
  it('映射四种角色；推理块不回传；工具参数保持原始 JSON 字符串', () => {
    const messages = chatMessages([systemMessage, userMessage, assistantMessage, toolMessage]);
    assert.deepEqual(messages[0], { role: 'system', content: '你是助手' });
    assert.deepEqual(messages[1], { role: 'user', content: '你好' });
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].content, '我来调用工具');
    assert.equal(messages[2].tool_calls[0].id, 'call_1');
    assert.equal(messages[2].tool_calls[0].function.name, 'pwsh');
    assert.equal(messages[2].tool_calls[0].function.arguments, '{"cmd":"ls"}');
    assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'file-a\nfile-b' });
  });

  it('总是流式 + 带工具数组', () => {
    const body = buildChatRequest({ model: 'fledge-alpha-free', messages: [userMessage], tools: [] });
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, []);
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
  });

  it('调用方没有给出输出上限时不发送 max_tokens', () => {
    const body = buildChatRequest({ model: 'x-free', messages: [userMessage], tools: [] });
    assert.equal('max_tokens' in body, false);
    assert.equal('max_output_tokens' in body, false);
  });

  it('调用方给出正整数上限才发送', () => {
    assert.equal(buildChatRequest({ model: 'x-free', messages: [], tools: [], maxTokens: 4096 }).max_tokens, 4096);
    assert.equal('max_tokens' in buildChatRequest({ model: 'x-free', messages: [], tools: [], maxTokens: 0 }), false);
    assert.equal('max_tokens' in buildChatRequest({ model: 'x-free', messages: [], tools: [], maxTokens: 1.5 }), false);
  });

  it('采样参数只在给出时出现；stop 只属于 chat 族', () => {
    const body = buildChatRequest({ model: 'x-free', messages: [], tools: [], temperature: 0.3, stop: ['x'] });
    assert.equal(body.temperature, 0.3);
    assert.deepEqual(body.stop, ['x']);
    assert.equal('temperature' in buildChatRequest({ model: 'x-free', messages: [], tools: [] }), false);
  });
});

describe('responses 协议族请求体', () => {
  it('映射成扁平 input item 列表', () => {
    const input = responsesInput([systemMessage, userMessage, assistantMessage, toolMessage]);
    assert.deepEqual(input[0], { type: 'message', role: 'system', content: [{ type: 'input_text', text: '你是助手' }] });
    assert.deepEqual(input[1], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] });
    assert.deepEqual(input[2], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来调用工具' }] });
    assert.deepEqual(input[3], { type: 'function_call', call_id: 'call_1', name: 'pwsh', arguments: '{"cmd":"ls"}' });
    assert.deepEqual(input[4], { type: 'function_call_output', call_id: 'call_1', output: 'file-a\nfile-b' });
  });

  it('流式 + store:false，且不带 stop', () => {
    const body = buildResponsesRequest({ model: 'muse-spark-1.3-contributor-free', messages: [userMessage], tools: [], stop: ['x'] });
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal('stop' in body, false);
    assert.equal('max_output_tokens' in body, false);
    assert.equal(body.max_output_tokens, undefined);
  });

  it('输出上限用 max_output_tokens 表达', () => {
    assert.equal(
      buildResponsesRequest({ model: 'x-free', messages: [], tools: [], maxTokens: 512 }).max_output_tokens,
      512,
    );
  });
});

describe('buildRequestFor', () => {
  it('按协议族分派', () => {
    const options = { model: 'x-free', messages: [userMessage], tools: [] };
    assert.ok(Array.isArray(buildRequestFor('chat', options).messages));
    assert.ok(Array.isArray(buildRequestFor('responses', options).input));
    assert.equal('messages' in buildRequestFor('responses', options), false);
  });

  it('空 assistant 消息被跳过', () => {
    const empty = { id: 'm', role: 'assistant', content: [{ type: 'reasoning', text: '只有推理' }] };
    assert.deepEqual(chatMessages([empty]), []);
    assert.deepEqual(responsesInput([empty]), []);
  });
});
