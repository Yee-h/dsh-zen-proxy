/**
 * `src/identity.js`：身份头齐备、版本门槛、会话／请求 id 派生。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_CLIENT_VERSION,
  OPENCODE_CLIENT,
  OPENCODE_PROJECT,
  PUBLIC_AUTHORIZATION,
  REQUEST_PATTERN,
  SESSION_PATTERN,
  buildIdentityHeaders,
  compareVersions,
  parseVersion,
  probeRequest,
  probeSession,
  requestForTurn,
  resolveClientVersion,
  sessionForConversation,
  userAgentFor,
} from '../src/identity.js';

describe('buildIdentityHeaders', () => {
  it('同时给出六个闸门要求的身份头，且 authorization 是池化免密凭据', () => {
    const headers = buildIdentityHeaders({
      version: '1.18.31',
      session: 'ses_0123456789abABCDEFGHIJKLMN',
      requestId: 'msg_0123456789abOPQRSTUVWXYZab',
    });
    for (const name of [
      'user-agent',
      'authorization',
      'x-opencode-client',
      'x-opencode-project',
      'x-opencode-session',
      'x-opencode-request',
    ]) {
      assert.equal(typeof headers[name], 'string', `缺少 ${name}`);
      assert.notEqual(headers[name], '', `空的 ${name}`);
    }
    assert.equal(headers.authorization, PUBLIC_AUTHORIZATION);
    assert.equal(headers['x-opencode-client'], OPENCODE_CLIENT);
    assert.equal(headers['x-opencode-project'], OPENCODE_PROJECT);
    assert.match(headers['user-agent'], /^opencode\//);
    assert.equal(headers['x-opencode-session'], 'ses_0123456789abABCDEFGHIJKLMN');
    assert.equal(headers['x-opencode-request'], 'msg_0123456789abOPQRSTUVWXYZab');
  });

  it('不发 dsh 的 attribution UA', () => {
    const headers = buildIdentityHeaders({ version: '1.18.31', session: 'ses_a', requestId: 'msg_a' });
    assert.doesNotMatch(headers['user-agent'], /deepseek-harness/);
  });
});

describe('版本门槛', () => {
  it('接受门槛下界并原样用作 UA', () => {
    const resolved = resolveClientVersion('1.18.0');
    assert.equal(resolved.usedFallback, false);
    assert.equal(resolved.version, '1.18.0');
    assert.equal(userAgentFor(resolved.version), 'opencode/1.18.0');
    const headers = buildIdentityHeaders({ version: resolved.version, session: 'ses_a', requestId: 'msg_a' });
    assert.equal(headers['user-agent'], 'opencode/1.18.0');
  });

  it('低于门槛时不使用该值，改为记录诊断并回退到门槛值', () => {
    const resolved = resolveClientVersion('1.17.0');
    assert.equal(resolved.usedFallback, true);
    assert.equal(resolved.version, MIN_CLIENT_VERSION);
    assert.match(resolved.reason, /1\.17\.0/);
    const headers = buildIdentityHeaders({ version: resolved.version, session: 'ses_a', requestId: 'msg_a' });
    assert.notEqual(headers['user-agent'], 'opencode/1.17.0');
    assert.equal(headers['user-agent'], 'opencode/1.18.0');
  });

  it('无法解析的版本也回退', () => {
    assert.equal(resolveClientVersion('not-a-version').version, MIN_CLIENT_VERSION);
  });

  it('parseVersion / compareVersions', () => {
    assert.deepEqual(parseVersion('v1.18.31'), [1, 18, 31]);
    assert.deepEqual(parseVersion('1.18'), [1, 18, 0]);
    assert.equal(parseVersion('nope'), undefined);
    assert.ok(compareVersions([1, 18, 0], [1, 17, 9]) > 0);
    assert.equal(compareVersions([1, 18, 0], [1, 18, 0]), 0);
  });
});

describe('会话与请求 id 派生', () => {
  it('同一对话两次派生相等，不同对话不相等', () => {
    const first = sessionForConversation('session-abc');
    const second = sessionForConversation('session-abc');
    const other = sessionForConversation('session-xyz');
    assert.equal(first, second);
    assert.notEqual(first, other);
  });

  it('形状为 ses_ + 12 位十六进制 + 14 位 base62', () => {
    const session = sessionForConversation('session-abc');
    assert.match(session, SESSION_PATTERN);
    assert.equal(session.length, 4 + 12 + 14);
  });

  it('请求 id 形状为 msg_ + 12 位十六进制 + 14 位 base62，且按会话与轮次变化', () => {
    const session = sessionForConversation('session-abc');
    const first = requestForTurn(session, 'turn-1');
    assert.match(first, REQUEST_PATTERN);
    assert.equal(requestForTurn(session, 'turn-1'), first);
    assert.notEqual(requestForTurn(session, 'turn-2'), first);
    assert.notEqual(requestForTurn(sessionForConversation('other'), 'turn-1'), first);
  });

  it('探测会话与任何用户对话的会话都不同', () => {
    const probe = probeSession();
    assert.match(probe, SESSION_PATTERN);
    assert.notEqual(probe, sessionForConversation('session-abc'));
    assert.notEqual(probe, sessionForConversation(''));
    assert.match(probeRequest('round-1', 'fledge-alpha-free'), REQUEST_PATTERN);
    assert.notEqual(probeRequest('round-1', 'a-free'), probeRequest('round-1', 'b-free'));
  });

  it('空对话标识退化为全局会话而不是随机值', () => {
    assert.equal(sessionForConversation(undefined), sessionForConversation(''));
  });
});
