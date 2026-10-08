/**
 * 实测：Zen 免费车道的思考强度到底由什么控制。
 *
 * 闸门条件（见 openspec/changes/archive/2026-10-07-add-opencode-free-provider/evidence.md
 * 第 (2) 节）：
 * 六个身份头 + `accept: text/event-stream` + `stream: true` + 请求体的工具数组里
 * 必须齐备小写 `bash`/`glob`/`grep`/`read`。缺工具数组即使六个头齐备也返回 403。
 *
 * 同一条 prompt、同一组头，只改 body 里的一个变量：
 * 若 `reasoning_effort` 真的生效，B 与 C 的思考量应显著不同；
 * 若只有 `max_tokens` 生效，则 B/C 应与基线无系统差异，而 D 的思考量应被压下来。
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://opencode.ai/zen/v1/chat/completions';
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

const PROMPT = '一个农夫要带狼、羊、白菜过河，船每次只能带农夫和一样东西，农夫不在时狼会吃羊、羊会吃白菜。请一步一步推理，最后给出最短步骤序列。';

const PLAN = [
  ['mimo-v2.6-flash-free', ['A 基线', 'B effort=low', 'B2 effort=low', 'C effort=high', 'C2 effort=high', 'D max=512']],
  ['nemotron-3.5-lightning-free', ['A 基线', 'B effort=low', 'C effort=high', 'D max=512']],
];

const VARIANTS = {
  'A 基线': {},
  'B effort=low': { reasoning_effort: 'low' },
  'B2 effort=low': { reasoning_effort: 'low' },
  'C effort=high': { reasoning_effort: 'high' },
  'C2 effort=high': { reasoning_effort: 'high' },
  'D max=512': { max_tokens: 512 },
};

async function once(model, label) {
  const body = {
    model,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    tool_choice: 'none',
    tools: GATE_TOOLS,
    ...VARIANTS[label],
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
    signal: AbortSignal.timeout(240000),
  });

  if (!res.ok) return { status: res.status, note: (await res.text()).replace(/\s+/g, ' ').slice(0, 110) };

  let buffer = '';
  let reasoningChars = 0;
  let contentChars = 0;
  let usage = null;
  let finish = '-';
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
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
        if (typeof delta.content === 'string') contentChars += delta.content.length;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  }
  const tokens = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    status: 200,
    finish,
    completion: usage?.completion_tokens ?? '?',
    reasoningTokens: tokens ?? '?',
    reasoningChars,
    contentChars,
    note: '',
  };
}

const rows = [];
for (const [model, labels] of PLAN) {
  for (const label of labels) {
    let result;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        result = await once(model, label);
      } catch (error) {
        result = { status: 0, note: `${error?.name}: ${error?.message}` };
      }
      if (result.status !== 429) break;
      await sleep(20000);
    }
    rows.push(
      `${model.padEnd(28)} ${label.padEnd(14)} ${String(result.status).padStart(3)}`
      + ` finish=${String(result.finish ?? '-').padEnd(8)}`
      + ` 思考token=${String(result.reasoningTokens ?? '-').padStart(5)}`
      + ` 思考字符=${String(result.reasoningChars ?? '-').padStart(5)}`
      + ` 正文=${String(result.contentChars ?? '-').padStart(5)}`
      + ` 合计=${String(result.completion ?? '-').padStart(5)} ${result.note ?? ''}`,
    );
    await sleep(3000);
  }
}

console.log(rows.join('\n'));
