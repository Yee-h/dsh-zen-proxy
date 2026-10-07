/**
 * 宿主接线：注册两条 provider 路由、声明配置面、跑周期探测。
 *
 * 这是仓库里**唯一**接触宿主包的地方：它把适配器对象挂到真实的
 * `@deepseek-ai/dsh-llm` 的 `LlmAdapter.prototype` 上，使其成为真正的子类。
 * 该 import 是动态且容错的——宿主包在插件仓库内不可解析（宿主运行时注入），
 * 而本仓库的单元测试要能直接加载 `src/adapter.js`。除此之外，其余模块都不 import
 * 任何 `@deepseek-ai/*` 包。
 *
 * @module src/register.js
 */

import {
  ROUTE_LABELS,
  ROUTES,
  createAdapter,
} from './adapter.js';
import {
  CATALOG_METADATA_UNKNOWN,
  freeCandidates,
  hasTraceableCapabilities,
} from './catalog.js';
import { FAILURE_CODE, FAILURE_SCOPE } from './failure.js';
import { PROBE_TIMEOUT_MS, fetchModelListing } from './http.js';
import {
  buildIdentityHeaders,
  deriveId,
  probeSession,
  resolveClientVersion,
} from './identity.js';
import { PROBE_STATE, probeModels } from './probe.js';
import { createScheduler } from './schedule.js';
import {
  loadState,
  modelsWithVerdict,
  reduceRound,
  resolveStateFile,
  saveState,
} from './state.js';

/**
 * 把适配器挂到宿主的 `LlmAdapter.prototype` 上。
 *
 * 解析失败（仓库内单测、离线工具）时保持结构等价的普通对象：六个可覆写点我们全部
 * 自己实现，继承本身不带来行为，只带来类型上的从属关系。
 * @param {object} adapter
 */
function adoptHostBaseClass(adapter) {
  void import('@deepseek-ai/dsh-llm')
    .then((module) => {
      const base = module?.LlmAdapter;
      if (typeof base === 'function') Object.setPrototypeOf(adapter, base.prototype);
    })
    .catch(() => {
      // 宿主包不可解析：适配器的六个可覆写点完全由 src/adapter.js 提供，无需基类。
    });
}

/**
 * 安装插件。
 * @param {object} ctx cordis 上下文（已 inject `llm`）
 * @param {{probeIntervalMinutes?: number, opencodeVersion?: string}} config
 * @param {{pluginName?: string, fetchImpl?: typeof fetch, stateFile?: string}} [options] 测试注入点
 * @returns {object} 供测试与诊断使用的接线句柄
 */
export function register(ctx, config, options = {}) {
  const logger = ctx?.logger ?? console;
  const fetchImpl = options.fetchImpl;
  const pluginName = options.pluginName ?? 'zen-proxy';
  // 周期在每次重新武装时从配置重新求值：运行中改配置能在下一轮生效，无需重启进程。
  const configuredIntervalMs = () => Math.max(1, Number(config?.probeIntervalMinutes) || 10) * 60_000;
  const resolvedVersion = resolveClientVersion(config?.opencodeVersion);
  if (resolvedVersion.usedFallback) {
    logger.warn?.(`zen-proxy: ${resolvedVersion.reason}`);
  }
  const version = resolvedVersion.version;

  // 状态目录由宿主环境解析（DSH_HOME → 宿主配置根），不写死任何用户目录路径。
  // 显式传入的 stateFile 覆盖用给测试，生产路径始终来自环境解析。
  const stateFile = options.stateFile ?? resolveStateFile({ env: process.env });
  let state = loadState(stateFile);

  const adapter = createAdapter({ state: () => state, clientVersion: version, fetchImpl });
  adoptHostBaseClass(adapter);

  const controller = new AbortController();
  let roundSeed = 0;

  function logDiagnostics(diagnostics) {
    for (const entry of diagnostics) {
      logger.warn?.(`zen-proxy: [${entry.code}] ${entry.message}`);
    }
  }

  /**
   * 跑一轮：取清单 → 过滤免费 → 探测 → 折算状态 → 持久化。
   * @returns {Promise<{throttled: boolean, candidates: string[]}>}
   */
  async function runRound() {
    roundSeed += 1;
    const round = `round-${roundSeed}`;
    const session = probeSession();
    const requestId = deriveId('msg_', `listing\0${session}\0${round}`);
    const headers = buildIdentityHeaders({ version, session, requestId, stream: false });

    let listing;
    try {
      listing = await fetchModelListing({
        headers,
        signal: controller.signal,
        fetchImpl,
        timeoutMs: PROBE_TIMEOUT_MS,
        requestId,
      });
    } catch (error) {
      // 清单拿不到时本轮作废：既有目录保持不动，不因一次拉取失败清空选择器。
      logger.warn?.(`zen-proxy: 模型清单拉取失败，本轮探测跳过：${error?.message ?? error}`);
      return { throttled: false, candidates: [] };
    }

    const candidates = freeCandidates(listing);
    const withoutMetadata = candidates.filter((id) => !hasTraceableCapabilities(id));
    if (withoutMetadata.length > 0) {
      logger.warn?.(`zen-proxy: [${CATALOG_METADATA_UNKNOWN}] 以下免费模型没有可溯源的能力元数据，`
        + `将省略 context 字段（不影响它们在目录中的呈现）：${withoutMetadata.join(', ')}`);
    }

    const results = await probeModels(
      candidates,
      { round, version, signal: controller.signal, fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
      (modelId, result) => {
        logger.info?.(`zen-proxy: 探测 ${modelId} → ${result.state}`);
      },
    );

    if (controller.signal.aborted) return { throttled: false, candidates };

    // 插件级失败（身份／版本被拒）与具体模型无关：整条车道降级。
    const pluginFailure = candidates
      .map((id) => results[id])
      .find((result) => result?.state === PROBE_STATE.unknown && result.failure?.scope === FAILURE_SCOPE.plugin);

    const { state: next, diagnostics } = reduceRound(state, {
      models: candidates,
      results,
      pluginFailure: pluginFailure?.failure ?? null,
    });
    logDiagnostics(diagnostics);
    state = next;
    saveState(stateFile, next);
    logger.info?.(`zen-proxy: 一轮探测完成，公告 ${modelsWithVerdict(next, 'available').length} 个可用、`
      + `${modelsWithVerdict(next, 'region').length} 个地区受限`);

    const throttled = candidates.length > 0
      && candidates.every((id) => {
        const result = results[id];
        if (result?.state !== PROBE_STATE.transient) return false;
        const code = result.failure?.code;
        return code === FAILURE_CODE.rateLimit || code === FAILURE_CODE.quota;
      });
    return { throttled, candidates };
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? pluginName;
  ctx.llm.registerAdapter([...ROUTES], adapter);
  ctx.llm.registerConfigurableProviders(ROUTES.map((provider) => ({
    provider,
    displayName: ROUTE_LABELS[provider],
    settingsNs,
    // 该车道没有可编辑的连接信息（凭据是池化的 `Bearer public`，地址写死在上游常量里）。
    settingsPath: [],
  })));

  const scheduler = createScheduler({
    intervalMs: configuredIntervalMs,
    run: runRound,
    onError: (error) => logger.warn?.(`zen-proxy: 探测轮次异常：${error?.message ?? error}`),
  });

  // 注册本身随 fiber 自动释放（宿主的 `registerAdapter` / `registerConfigurableProviders`
  // 都把释放挂在各自的 effect 上），因此这里只需要管好探测循环的生命周期。
  ctx.effect(() => {
    scheduler.start();
    return () => {
      scheduler.stop();
      controller.abort();
    };
  }, 'zen-proxy: probe loop');

  if (Object.keys(state.models).length === 0) {
    logger.info?.('zen-proxy: 本地没有历史探测结果，目录将在首轮探测完成后填充');
  }

  return { adapter, scheduler, runRound, stateFile, routes: [...ROUTES] };
}
