/**
 * `src/failure.js`：上游失败分类与失败对象构造。
 *
 * 用例里的响应体全部来自真实上游实测（见 evidence.md）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FAILURE_CODE,
  FAILURE_DISPOSITION,
  FAILURE_SCOPE,
  classifyThrownError,
  classifyUpstreamFailure,
  createUpstreamError,
  parseRetryAfter,
  readErrorEnvelope,
} from '../src/failure.js';

describe('classifyUpstreamFailure', () => {
  it('普通 429 是 RATE_LIMIT（瞬时、模型范围）', () => {
    const failure = classifyUpstreamFailure({
      status: 429,
      type: 'RateLimitError',
      message: 'Rate limit exceeded. Please try again later.',
    });
    assert.equal(failure.code, FAILURE_CODE.rateLimit);
    assert.equal(failure.scope, FAILURE_SCOPE.model);
    assert.equal(failure.disposition, FAILURE_DISPOSITION.transient);
    assert.equal(failure.region, false);
  });

  it('额度耗尽措辞是 QUOTA（宿主 isQuotaExceededError 的语义）', () => {
    assert.equal(
      classifyUpstreamFailure({ status: 429, type: '', message: 'You exceeded your current quota' }).code,
      FAILURE_CODE.quota,
    );
    assert.equal(
      classifyUpstreamFailure({ status: 402, type: 'insufficient_quota', message: '' }).code,
      FAILURE_CODE.quota,
    );
  });

  it('403 RegionError 是 AUTH + 地区受限', () => {
    const failure = classifyUpstreamFailure({
      status: 403,
      type: 'RegionError',
      message: 'This model is not available in your country.',
    });
    assert.equal(failure.code, FAILURE_CODE.auth);
    assert.equal(failure.region, true);
    assert.equal(failure.scope, FAILURE_SCOPE.model);
    assert.equal(failure.disposition, FAILURE_DISPOSITION.terminal);
  });

  it('403 FreeTierError 与 426 UpgradeRequired 是插件级身份拒绝', () => {
    for (const [status, type, message] of [
      [403, 'FreeTierError', "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"],
      [426, 'UpgradeRequired', 'Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier'],
    ]) {
      const failure = classifyUpstreamFailure({ status, type, message });
      assert.equal(failure.code, FAILURE_CODE.auth, `${type} 应为 AUTH`);
      assert.equal(failure.scope, FAILURE_SCOPE.plugin, `${type} 应为插件级`);
      assert.equal(failure.region, false);
    }
  });

  it('401 ModelError 是模型级终局失败', () => {
    const failure = classifyUpstreamFailure({
      status: 401,
      type: 'ModelError',
      message: 'Model no-such-model-free is not supported',
    });
    assert.equal(failure.code, FAILURE_CODE.unknown);
    assert.equal(failure.scope, FAILURE_SCOPE.model);
    assert.equal(failure.disposition, FAILURE_DISPOSITION.terminal);
  });

  it('server_error 信封按上游故障处理，即使状态码是 400', () => {
    for (const status of [400, 503]) {
      const failure = classifyUpstreamFailure({
        status,
        type: 'server_error',
        message: 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.',
      });
      assert.equal(failure.code, FAILURE_CODE.server);
      assert.equal(failure.disposition, FAILURE_DISPOSITION.transient);
      assert.equal(failure.status, status);
    }
  });

  it('未识别的信封 type 退回状态码：500 → SERVER', () => {
    const failure = classifyUpstreamFailure({ status: 500, type: 'error', message: 'Internal server error' });
    assert.equal(failure.code, FAILURE_CODE.server);
    assert.equal(failure.disposition, FAILURE_DISPOSITION.transient);
  });

  it('401/403/426 无识别 type 时按身份类处理', () => {
    assert.equal(classifyUpstreamFailure({ status: 403, type: '', message: '' }).code, FAILURE_CODE.auth);
    assert.equal(classifyUpstreamFailure({ status: 426, type: '', message: '' }).code, FAILURE_CODE.auth);
  });

  it('保留 retry-after', () => {
    const failure = classifyUpstreamFailure({ status: 429, type: '', message: '', retryAfterMs: 3000 });
    assert.equal(failure.providerRetryAfterMs, 3000);
  });
});

describe('classifyThrownError', () => {
  it('网络失败是 TRANSPORT，取消是 TIMEOUT', () => {
    const transport = classifyThrownError(new TypeError('fetch failed'));
    assert.equal(transport.code, FAILURE_CODE.transport);
    assert.equal(transport.disposition, FAILURE_DISPOSITION.transient);

    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    assert.equal(classifyThrownError(aborted).code, FAILURE_CODE.timeout);
  });

  it('把 cause 链里的 socket 码带进诊断', () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ENOTFOUND' };
    assert.match(classifyThrownError(error).message, /ENOTFOUND/);
  });
});

describe('readErrorEnvelope', () => {
  it('识别两种实测信封形状', () => {
    assert.deepEqual(
      readErrorEnvelope({ type: 'error', error: { type: 'RegionError', message: 'nope' } }),
      { type: 'RegionError', message: 'nope' },
    );
    assert.deepEqual(
      readErrorEnvelope({ error: { type: 'server_error', message: 'boom' } }),
      { type: 'server_error', message: 'boom' },
    );
    assert.equal(readErrorEnvelope({ choices: [] }), undefined);
    assert.equal(readErrorEnvelope(undefined), undefined);
  });
});

describe('createUpstreamError', () => {
  it('挂着自有数据属性 code 与 failure，且 failure.code === error.code', () => {
    const error = createUpstreamError(classifyUpstreamFailure({
      status: 429,
      type: 'FreeUsageLimitError',
      message: 'Rate limit exceeded.',
      retryAfterMs: 1500,
      requestId: 'msg_0123456789abOPQRSTUVWXYZab',
    }));
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const failure = Object.getOwnPropertyDescriptor(error, 'failure');
    assert.ok(code !== undefined && 'value' in code, 'code 必须是自有数据属性');
    assert.ok(failure !== undefined && 'value' in failure, 'failure 必须是自有数据属性');
    assert.equal(failure.value.code, error.code);
    assert.equal(typeof failure.value.message, 'string');
    assert.notEqual(failure.value.message, '');
    assert.equal(failure.value.status, 429);
    assert.equal(failure.value.providerRetryAfterMs, 1500);
    assert.equal(failure.value.requestId, 'msg_0123456789abOPQRSTUVWXYZab');
  });

  it('产生的 failure 满足宿主 failureSnapshot 的校验条件', () => {
    const cases = [
      classifyUpstreamFailure({ status: 200, type: 'server_error', message: 'boom' }),
      classifyThrownError(new Error('nope')),
      classifyUpstreamFailure({ status: 99, type: '', message: '' }),
    ];
    for (const classification of cases) {
      const { failure } = createUpstreamError(classification);
      assert.equal(typeof failure.message, 'string');
      assert.ok(failure.message.length > 0);
      assert.equal(typeof failure.code, 'string');
      assert.ok(failure.code.length > 0);
      if (failure.status !== undefined) {
        assert.ok(Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599);
      }
      if (failure.providerRetryAfterMs !== undefined) {
        assert.ok(failure.providerRetryAfterMs > 0);
      }
    }
  });
});

describe('parseRetryAfter', () => {
  it('秒数与 HTTP 日期都能解析，非法值返回 undefined', () => {
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('nonsense'), undefined);
    assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 0);
  });
});
