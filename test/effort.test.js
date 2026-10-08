/**
 * `src/effort.js`：思考强度档位与输出预算折算。
 *
 * 档位本身没有上游依据——本车道的网关接受 `reasoning_effort` 一类字段后不执行它们
 * （实测见变更 `add-reasoning-effort-control` 的 `evidence.md` (1)），唯一被执行的
 * 强度旋钮是输出预算上限。因此
 * 「档位」只是插件给宿主的一层语义包装，最终必须落到请求体的 `max_tokens` /
 * `max_output_tokens` 上。本文件只验证纯逻辑。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALWAYS_THINKING_FACTOR,
  DEFAULT_EFFORT,
  FALLBACK_OUTPUT_LIMIT,
  LEVELS,
  MIN_BUDGET,
  budgetFor,
  effortsFor,
  resolveEffort,
} from '../src/effort.js';

/** 有溯源输出上限的模型（mimo-v2.6-flash-free，取自 models.dev 的 limit.output）。 */
const TRACEABLE = Object.freeze({ outputLimit: 32000 });

/** 把预算渲染成档位名称里的数字，与实现须采用同一取整方式。 */
function kilos(budget) {
  return Math.round(budget / 1024) + ' K';
}

describe('src/effort.js', () => {
  describe('档位表', () => {
    it('列出三个档位，顺序为 light → balanced → deep', () => {
      assert.deepEqual(LEVELS.map((entry) => entry.id), ['light', 'balanced', 'deep']);
      for (const entry of LEVELS) {
        assert.equal(typeof entry.name, 'string');
        assert.ok(entry.name.length > 0);
        assert.ok(entry.hint.length > 0);
      }
    });

    it('默认档是均衡，且位于档位表内', () => {
      assert.equal(DEFAULT_EFFORT, 'balanced');
      assert.equal(LEVELS.some((entry) => entry.id === DEFAULT_EFFORT), true);
    });

    it('未知或缺失的档位回退到默认档', () => {
      assert.equal(resolveEffort(undefined).id, DEFAULT_EFFORT);
      assert.equal(resolveEffort('').id, DEFAULT_EFFORT);
      assert.equal(resolveEffort('turbo').id, DEFAULT_EFFORT);
      assert.equal(resolveEffort('deep').id, 'deep');
    });
  });

  describe('预算折算', () => {
    it('档位预算按倍率放大，因为输出上限同时限制思考与正文', () => {
      assert.equal(budgetFor('light', TRACEABLE, undefined), 2048 * ALWAYS_THINKING_FACTOR);
      assert.equal(budgetFor('balanced', TRACEABLE, undefined), 8192 * ALWAYS_THINKING_FACTOR);
    });

    it('深度档取模型容量而不是固定数字', () => {
      assert.equal(budgetFor('deep', TRACEABLE, undefined), 32000);
      assert.equal(budgetFor('deep', { outputLimit: 262144 }, undefined), 262144);
    });

    it('调用方给出的上限低于档位预算时被尊重', () => {
      assert.equal(budgetFor('balanced', TRACEABLE, 1000), 1000);
    });

    it('调用方给出的上限高于档位预算时不突破档位', () => {
      assert.equal(budgetFor('balanced', TRACEABLE, 4000000), 16384);
    });

    it('无溯源的输出上限回退到 32768', () => {
      assert.equal(FALLBACK_OUTPUT_LIMIT, 32768);
      assert.equal(budgetFor('deep', {}, undefined), FALLBACK_OUTPUT_LIMIT);
      assert.equal(budgetFor('deep', undefined, undefined), FALLBACK_OUTPUT_LIMIT);
    });

    it('非正数、NaN 与 Infinity 视为没有该上限，而不是把预算压到 0', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(budgetFor('balanced', TRACEABLE, bad), 16384, String(bad));
      }
    });

    it('结果是不小于下界的整数', () => {
      assert.equal(budgetFor('balanced', { outputLimit: 100 }, undefined), MIN_BUDGET);
      for (const level of ['light', 'balanced', 'deep']) {
        const value = budgetFor(level, TRACEABLE, undefined);
        assert.equal(Number.isSafeInteger(value), true, level);
        assert.ok(value >= MIN_BUDGET, level);
      }
    });
  });

  describe('菜单声明', () => {
    it('每档给出非空的 id / name / description', () => {
      const efforts = effortsFor(TRACEABLE);
      assert.deepEqual(efforts.map((effort) => effort.id), ['light', 'balanced', 'deep']);
      for (const effort of efforts) {
        assert.ok(effort.id.length > 0);
        assert.ok(effort.name.length > 0);
        assert.ok(effort.description.length > 0);
      }
    });

    it('名称里的预算数字与将要发出的预算一致', () => {
      for (const model of [TRACEABLE, {}, { outputLimit: 100 }, { outputLimit: 262144 }]) {
        const menu = new Map(effortsFor(model).map((effort) => [effort.id, effort]));
        for (const level of ['light', 'balanced', 'deep']) {
          const expected = kilos(budgetFor(level, model, undefined));
          assert.ok(
            menu.get(level).name.includes(expected),
            level + ' 的名称应含 ' + expected + '，实际为 ' + menu.get(level).name,
          );
        }
      }
    });

    it('默认档落在菜单内', () => {
      const ids = effortsFor(TRACEABLE).map((effort) => effort.id);
      assert.equal(ids.includes(DEFAULT_EFFORT), true);
    });
  });
});
