/**
 * 实测：三档预算是否真的改变线上行为（单调性复核）。
 *
 * 变量只有一个：请求体里的 max_tokens（light=4096 / balanced=16384 / deep=不发送）。
 * prompt 故意要求长答案，否则 light 档的 4096 不会顶到上限，三档看起来会没有差别。
 *
 * 闸门条件同 effort.mjs：六个身份头 + accept: text/event-stream + stream: true
 * + 工具数组齐备小写 bash/glob/grep/read。
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://opencode.ai/zen/v1/chat/completions';
const MODEL = 'mimo-v2.6-flash-free';
const HEX = '0123456789abcdef';
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function idFor(prefix) {
  let out = prefix;
  for (let i = 0; i < 12; i += 1) out += HEX[Math.floor(Math.random() * 16)];
  for (let i = 0; i < 14; i += 1) out += B62[Math.floor(Math.random() * 62)];
  return out;
}

const GATE_TOOLS = ['bash', 'glob', 'grep', 'read'].map(name => ({
  type: 'function',
  function: {
    name,
    description: 'This tool is currently unavailable and must not be used.',
    parameters: { type: 'object', properties: {} },
  },
}));

const PROMPT = '请写一篇关于「分布式系统中的时钟」的技术长文，至少 3000 字，分成 8 个小节，每节至少 300 字。要求：不要省略，不要用要点列表或代码块代替正文，每个小节都要写成完整段落。最后再给出 5 条常见误解并逐条解释。';

const VARIANTS = [
  { label: 'light 4096', maxTokens: 4096, timeoutMs: 300000 },
  { label: 'balanced 16384', maxTokens: 16384, timeoutMs: 600000 },
  { label: 'deep 无上限', maxTokens: undefined, timeoutMs: 600000 },
];

function emit(row) {
  process.stdout.write('[' + new Date().toISOString().slice(11, 19) + '] ' + row + '\n');
}

async function once(variant) {
  const limited = variant.maxTokens === undefined ? {} : { max_tokens: variant.maxTokens };
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    tool_choice: 'none',
    tools: GATE_TOOLS,
    ...limited,
  };
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer public',
      'user-agent': 'opencode/1.18.31',
      'x-opencode-client': 'desktop',
      'x-opencode-project': 'global',
      'x-opencode-session': idFor('ses_'),
      'x-opencode-request': idFor('msg_'),
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(variant.timeoutMs),
  });

  if (!res.ok) return { status: res.status, note: (await res.text()).replace(/\s+/g, ' ').slice(0, 120) };

  let buffer = '';
  let contentChars = 0;
  let usage = null;
  let finish = '-';
  const keysSeen = new Set();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        for (const key of Object.keys(delta)) keysSeen.add(key);
        if (typeof delta.content === 'string') contentChars += delta.content.length;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  }
  return {
    status: 200,
    finish,
    completion: usage && usage.completion_tokens,
    reasoningTokens: usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens,
    contentChars,
    keys: [...keysSeen].join('|'),
    note: '',
  };
}

for (const variant of VARIANTS) {
  const started = Date.now();
  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      result = await once(variant);
    } catch (error) {
      result = { status: 0, note: (error && error.name) + ': ' + (error && error.message) };
    }
    if (result.status !== 429) break;
    await sleep(20000);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const pad = (value, width) => String(value === undefined || value === null ? '-' : value).padStart(width);
  const row = variant.label.padEnd(15)
    + pad(result.status, 4) + 's'
    + ' finish=' + String(result.finish || '-').padEnd(8)
    + ' 思考token=' + pad(result.reasoningTokens, 6)
    + ' 正文字符=' + pad(result.contentChars, 6)
    + ' 合计=' + pad(result.completion, 6)
    + ' 用时=' + pad(secs + 's', 6)
    + ' delta字段=' + (result.keys || '-')
    + ' ' + (result.note || '');
  emit(row);
  await sleep(3000);
}
emit('DONE');