/**
 * `src/http.js`：SSE 解码、非 2xx 失败分类与清单拉取。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UPSTREAM_BASE_URL } from '../src/catalog.js';
import { decodeSse, fetchModelListing, payloadsOfFrame, requestUpstream } from '../src/http.js';
import { collect, fakeFetch, jsonResponse, sseResponse } from './fake-upstream.js';

/** 把一段文本拆成任意大小的块，模拟网络分片。 */
function chunked(text, size) {
  const bytes = new TextEncoder().encode(text);
  const parts = [];
  for (let index = 0; index < bytes.length; index += size) parts.push(bytes.subarray(index, index + size));
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

describe('payloadsOfFrame', () => {
  it('多行 data 按换行拼接，注释与其它字段被忽略', () => {
    assert.deepEqual(payloadsOfFrame('data: {"a":1}'), ['{"a":1}']);
    assert.deepEqual(payloadsOfFrame('data: line1\ndata: line2'), ['line1\nline2']);
    assert.deepEqual(payloadsOfFrame('event: message\ndata: x\nid: 3'), ['x']);
    assert.deepEqual(payloadsOfFrame(': heartbeat'), []);
    assert.deepEqual(payloadsOfFrame(''), []);
  });

  it('去掉 data 后紧跟的一个空格，保留其余空白', () => {
    assert.deepEqual(payloadsOfFrame('data:  two-spaces'), [' two-spaces']);
  });
});

describe('decodeSse', () => {
  it('跨网络分片切帧，且同时容忍 LF 与 CRLF', async () => {
    const text = `data: a\r\n\r\ndata: b\n\n: ping\ndata: c\n\n`;
    const payloads = await collect(decodeSse(chunked(text, 3)));
    assert.deepEqual(payloads, ['a', 'b', 'c']);
  });

  it('流末尾没有空行的帧也要取出', async () => {
    const payloads = await collect(decodeSse(chunked('data: tail', 4)));
    assert.deepEqual(payloads, ['tail']);
  });

  it('空 body 直接结束', async () => {
    assert.deepEqual(await collect(decodeSse(null)), []);
  });
});

describe('requestUpstream', () => {
  it('非 2xx 抛出带 code/failure 的分类失败，并带上 retry-after', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(
      { error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } },
      { status: 429, headers: { 'retry-after': '3' } },
    ));
    await assert.rejects(
      () => requestUpstream({ path: '/chat/completions', headers: {}, body: {}, fetchImpl: fetch }),
      (error) => {
        assert.equal(error.code, 'RATE_LIMIT');
        assert.equal(error.failure.providerRetryAfterMs, 3000);
        assert.equal(error.failure.status, 429);
        return true;
      },
    );
    assert.equal(calls[0].url, `${UPSTREAM_BASE_URL}/chat/completions`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{}');
  });

  it('非 JSON 的错误体也能分类', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }));
    await assert.rejects(
      () => requestUpstream({ path: '/chat/completions', headers: {}, fetchImpl: fetch }),
      (error) => {
        assert.equal(error.code, 'SERVER');
        return true;
      },
    );
  });

  it('2xx 返回 SSE 载荷流', async () => {
    const { fetch } = fakeFetch(() => sseResponse(['{"ok":1}', '{"ok":2}']));
    const { status, payloads } = await requestUpstream({ path: '/chat/completions', headers: {}, fetchImpl: fetch });
    assert.equal(status, 200);
    assert.deepEqual(await collect(payloads), ['{"ok":1}', '{"ok":2}']);
  });

  it('网络异常分类为 TRANSPORT', async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(
      () => requestUpstream({ path: '/chat/completions', headers: {}, fetchImpl: fetch }),
      (error) => {
        assert.equal(error.code, 'TRANSPORT');
        return true;
      },
    );
  });
});

describe('fetchModelListing', () => {
  it('用 GET 拉清单，且身份头照样齐备', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ object: 'list', data: [{ id: 'a-free', object: 'model' }] }));
    const listing = await fetchModelListing({ headers: { 'user-agent': 'opencode/1.18.31' }, fetchImpl: fetch });
    assert.deepEqual(listing.data.map((entry) => entry.id), ['a-free']);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].url, `${UPSTREAM_BASE_URL}/models`);
    assert.equal(calls[0].init.headers['user-agent'], 'opencode/1.18.31');
  });

  it('清单拉取失败会抛分类失败', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(
      { error: { type: 'UpgradeRequired', message: 'OpenCode 1.18.0 or newer is required to use the free tier' } },
      { status: 426 },
    ));
    await assert.rejects(
      () => fetchModelListing({ headers: {}, fetchImpl: fetch }),
      (error) => {
        assert.equal(error.code, 'AUTH');
        assert.equal(error.failure.status, 426);
        return true;
      },
    );
  });
});
