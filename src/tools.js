/**
 * 闸门要求的工具指纹补齐与响应侧名称回写。
 *
 * 免费车道的闸门校验请求体里声明的小写工具名集合必须齐备 `bash`、`glob`、`grep`、`read`
 * （实测：把工具数组整个去掉后，即使六个身份头齐备也返回 `403 FreeTierError`）。
 *
 * 补齐策略按 design D6：
 * 1. 调用方已声明的要求名直接沿用；
 * 2. 只有大小写不同时**改写成小写**而不是重复声明（上游把重复名视为错误）；
 * 3. 缺失的槽位优先把能真正代答的调用方工具改名填入（Windows 上宿主把 shell 工具
 *    叫 `pwsh`，填入 `bash` 槽），这样模型真去调用时工具仍然可执行；
 * 4. 无可代答工具的槽位才补一个自禁用占位工具。
 *
 * 响应侧按「发送拼写 → 调用方拼写」的映射把工具调用名还原，否则被改名的工具
 * （例如 `bash` 槽里的 `pwsh`）在宿主侧会找不到实现。
 *
 * 本模块是**宿主无关的纯逻辑**：不 import 任何 `@deepseek-ai/*` 包。
 *
 * @module src/tools.js
 */

/** 闸门要求的小写工具名集合，顺序即补齐顺序。 */
export const REQUIRED_TOOL_NAMES = Object.freeze(['bash', 'glob', 'grep', 'read']);

/**
 * 能够真正代答某个要求名的调用方工具名（小写）。
 * Windows 上宿主挂载的是 `pwsh` 而不是 `bash`。
 */
const TOOL_DONORS = Object.freeze({ bash: Object.freeze(['pwsh']) });

/** 占位工具的描述：明确告诉模型不要调用它。 */
export const UNAVAILABLE_TOOL_DESCRIPTION = 'This tool is currently unavailable and must not be used.';

/** 无 schema 的占位参数。 */
const EMPTY_PARAMETERS = Object.freeze({ type: 'object', properties: {} });

/**
 * 读取一个工具定义的声明名，兼容宿主形状 `{name,…}` 与 OpenAI 形状 `{function:{name,…}}`。
 * @param {unknown} tool
 * @returns {string}
 */
export function toolNameOf(tool) {
  if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return '';
  const flat = typeof tool.name === 'string' ? tool.name.trim() : '';
  if (flat !== '') return flat;
  const nested = tool.function;
  if (typeof nested === 'object' && nested !== null && typeof nested.name === 'string') {
    return nested.name.trim();
  }
  return '';
}

/** 要求名键：命中集合时返回小写名，否则空串。 */
function slotOf(name) {
  const lower = String(name ?? '').trim().toLowerCase();
  return REQUIRED_TOOL_NAMES.includes(lower) ? lower : '';
}

/**
 * 把任一种输入形状规范化成目标 wire 的工具形状。
 *
 * 宿主交过来的是扁平 `{name, description, parameters}`，上游要的是带包装的形状；
 * 如果下游已经在说 OpenAI（`{type:'function', function:{…}}`），就保留它的包装，
 * 只把名字对齐。不先规范化的话，「改名」会把扁平的调用方工具直接当 wire 形状发出去。
 * @param {unknown} tool
 * @param {string} name 已读出的声明名
 * @param {'chat' | 'responses'} style
 * @returns {object}
 */
function normalizeTool(tool, name, style) {
  const nested = tool?.function;
  const source = typeof nested === 'object' && nested !== null ? nested : tool;
  const parameters = typeof source?.parameters === 'object' && source.parameters !== null && !Array.isArray(source.parameters)
    ? source.parameters
    : { ...EMPTY_PARAMETERS };
  const description = typeof source?.description === 'string' ? source.description : '';
  return style === 'responses'
    ? { type: 'function', name, description, parameters }
    : { type: 'function', function: { name, description, parameters } };
}

function withName(tool, name) {
  const nested = tool.function;
  if (typeof nested === 'object' && nested !== null) {
    return { ...tool, function: { ...nested, name } };
  }
  return { ...tool, name };
}

/**
 * 补齐四连工具名。
 * @param {unknown} tools 调用方声明的工具数组（宿主形状 `{name, description, parameters}`）
 * @param {{style?: 'chat' | 'responses', toolChoice?: boolean}} [options]
 *   `style` 决定补出来的占位工具用哪种包装；`toolChoice` 为真且调用方一个工具都没声明时，
 *   把 `tool_choice` 置为 `none`，避免模型去调用占位工具。
 * @returns {{tools: object[], rename: Map<string, string>, added: string[], toolChoice?: string}}
 *   `rename` 是「发送拼写 → 调用方拼写」的映射
 */
export function applyToolQuartet(tools, { style = 'chat', toolChoice = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const rename = new Map();
  const seen = new Set();
  const out = [];

  for (const tool of list) {
    const current = toolNameOf(tool);
    // 无名工具无法被模型寻址，也进不了四连判定：原样保留，不改写也不丢弃。
    if (current === '') {
      out.push(tool);
      continue;
    }
    const normalized = normalizeTool(tool, current, style);
    const slot = slotOf(current);
    if (slot === '') {
      out.push(normalized);
      continue;
    }
    if (seen.has(slot)) continue;
    seen.add(slot);
    if (current === slot) {
      out.push(normalized);
    } else {
      rename.set(slot, current);
      out.push(withName(normalized, slot));
    }
  }

  const promoted = new Set();
  for (const slot of REQUIRED_TOOL_NAMES) {
    if (seen.has(slot)) continue;
    const donors = TOOL_DONORS[slot] ?? [];
    const index = out.findIndex((tool) => {
      const original = toolNameOf(tool);
      if (original === '' || slotOf(original) !== '') return false;
      return !promoted.has(original.toLowerCase()) && donors.includes(original.toLowerCase());
    });
    if (index === -1) continue;
    const original = toolNameOf(out[index]);
    promoted.add(original.toLowerCase());
    rename.set(slot, original);
    out[index] = withName(out[index], slot);
    seen.add(slot);
  }

  const added = [];
  for (const slot of REQUIRED_TOOL_NAMES) {
    if (seen.has(slot)) continue;
    added.push(slot);
    out.push(style === 'responses'
      ? { type: 'function', name: slot, description: UNAVAILABLE_TOOL_DESCRIPTION, parameters: { ...EMPTY_PARAMETERS } }
      : { type: 'function', function: { name: slot, description: UNAVAILABLE_TOOL_DESCRIPTION, parameters: { ...EMPTY_PARAMETERS } } });
  }

  const result = { tools: out, rename, added };
  if (toolChoice && list.length === 0) result.toolChoice = 'none';
  return result;
}

/**
 * 把上游返回的工具调用名还原成调用方的原始拼写。
 * @param {unknown} name
 * @param {Map<string, string> | undefined} rename
 * @returns {string}
 */
export function restoreToolName(name, rename) {
  const value = typeof name === 'string' ? name : '';
  if (rename === undefined || rename.size === 0) return value;
  return rename.get(value) ?? value;
}
