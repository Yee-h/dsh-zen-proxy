/**
 * `src/tools.js`：闸门要求的工具四连补齐与响应侧名称回写。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REQUIRED_TOOL_NAMES,
  UNAVAILABLE_TOOL_DESCRIPTION,
  applyToolQuartet,
  restoreToolName,
  toolNameOf,
} from '../src/tools.js';

/** 宿主形状的工具定义。 */
const hostTool = (name) => ({ name, description: `${name} 工具`, parameters: { type: 'object', properties: {} } });

const declaredNames = (tools) => tools.map((tool) => toolNameOf(tool)).sort();

describe('applyToolQuartet', () => {
  it('只声明 glob 与 read 时，请求体里出现四个要求名', () => {
    const { tools, added } = applyToolQuartet([hostTool('glob'), hostTool('read')]);
    for (const name of REQUIRED_TOOL_NAMES) {
      assert.ok(declaredNames(tools).includes(name), `缺少 ${name}`);
    }
    assert.equal(new Set(declaredNames(tools)).size, declaredNames(tools).length, '不得重复声明');
    assert.deepEqual(added.sort(), ['bash', 'grep']);
    const decoy = tools.find((tool) => toolNameOf(tool) === 'grep');
    assert.equal(decoy.function.description, UNAVAILABLE_TOOL_DESCRIPTION);
  });

  it('仅大小写不同时不重复声明，而是改写成小写并要求回写', () => {
    const { tools, rename } = applyToolQuartet([hostTool('Glob'), hostTool('Read')]);
    const names = declaredNames(tools);
    assert.equal(names.filter((name) => name === 'glob').length, 1);
    assert.equal(names.filter((name) => name === 'read').length, 1);
    assert.equal(names.filter((name) => name.toLowerCase() === 'glob').length, 1);
    assert.equal(rename.get('glob'), 'Glob');
    assert.equal(restoreToolName('glob', rename), 'Glob');
  });

  it('pwsh 被填入 bash 槽且响应侧工具调用名还原为 pwsh', () => {
    const { tools, rename, added } = applyToolQuartet([
      hostTool('pwsh'),
      hostTool('glob'),
      hostTool('grep'),
      hostTool('read'),
    ]);
    assert.ok(declaredNames(tools).includes('bash'), 'bash 槽必须被填上');
    assert.equal(declaredNames(tools).includes('pwsh'), false, 'pwsh 应被改名，而不是并存');
    assert.equal(added.length, 0, '有可代答工具时不应再补占位工具');
    assert.equal(rename.get('bash'), 'pwsh');
    assert.equal(restoreToolName('bash', rename), 'pwsh');
    assert.equal(restoreToolName('glob', rename), 'glob');
  });

  it('改名保留下游声明的其余字段', () => {
    const { tools } = applyToolQuartet([hostTool('pwsh')]);
    const promoted = tools.find((tool) => toolNameOf(tool) === 'bash');
    assert.equal(promoted.function.description, 'pwsh 工具');
    assert.deepEqual(promoted.function.parameters, { type: 'object', properties: {} });
  });

  it('调用方没有任何工具时把 tool_choice 置为 none', () => {
    const { toolChoice, tools } = applyToolQuartet([], { toolChoice: true });
    assert.equal(toolChoice, 'none');
    assert.deepEqual(declaredNames(tools), [...REQUIRED_TOOL_NAMES].sort());
  });

  it('调用方有工具时不改写 tool_choice', () => {
    const { toolChoice } = applyToolQuartet([hostTool('glob')], { toolChoice: true });
    assert.equal(toolChoice, undefined);
  });

  it('responses 风格补出扁平工具形状', () => {
    const { tools } = applyToolQuartet([], { style: 'responses' });
    for (const tool of tools) {
      assert.equal(tool.type, 'function');
      assert.equal(typeof tool.name, 'string');
      assert.equal(tool.function, undefined);
      assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
    }
  });

  it('非四连工具原样保留', () => {
    const { tools } = applyToolQuartet([hostTool('glob'), hostTool('my-custom-tool')]);
    assert.ok(declaredNames(tools).includes('my-custom-tool'));
  });

  it('容忍 OpenAI 形状 {function:{name}} 的输入', () => {
    const openaiShape = { type: 'function', function: { name: 'pwsh', description: 'd', parameters: {} } };
    const { tools, rename } = applyToolQuartet([openaiShape]);
    assert.equal(toolNameOf(tools.find((tool) => toolNameOf(tool) === 'bash')), 'bash');
    assert.equal(rename.get('bash'), 'pwsh');
  });

  it('undefined / 非数组输入不抛错', () => {
    assert.equal(applyToolQuartet(undefined).tools.length, 4);
    assert.equal(applyToolQuartet('nope').tools.length, 4);
  });
});

describe('restoreToolName', () => {
  it('没有映射时原样返回', () => {
    assert.equal(restoreToolName('glob', undefined), 'glob');
    assert.equal(restoreToolName('glob', new Map()), 'glob');
    assert.equal(restoreToolName(undefined, undefined), '');
  });
});
