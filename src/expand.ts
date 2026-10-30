/**
 * dsh-knowledge-sqlite — L1 查询扩展。
 *
 * 每查询一次小模型调用（llm.stream），按归一化查询缓存，timeoutMs 超时/失败降级
 * `degraded: 'lexical'`（不是工具错误）。`expand: false` 或调用方 `variants` 跳过。
 *
 * 缓存两级（0.1.5 起）：进程内存（本查询会话内命中）+ SQLite 持久化（按 workspace 隔离，
 * 跨进程/重启复用——真实使用同查询第二次起 0 延迟、零降级）。`clear()` 同时清两级
 * （variance/fresh 语义：强制独立扩展）。
 *
 * 消息构造遵循 harness 约定（content blocks + source + id）——原型曾因字符串 content
 * 与 finish reason 字符串比较导致全部降级（见 research/memory-knowledge-seam/experiments/prototype/RESULTS-PROTOTYPE.md §4.4）。
 *
 * 诊断（0.1.10）：降级不再是静默空手而归——`callModel` 返回结构化 reason（路由缺失 /
 * selection 抛错 / 无 llm 服务 / 超时 / 流错误），`expand()` 记录到 `stats.lastDegradeReason`
 * 与 `stats.degradeReasons` 计数、经 `ctx.logger` 告警，并把 reason 透出到 `ExpansionOutcome`。
 *
 * 能力自适应（0.1.11）：`reasoningEffort: 'off'` 改为「先带、被拒再去掉重试」。
 * 宿主对**无 reasoning 能力**的模型会硬拒该参数（UNSUPPORTED_REASONING_EFFORT）⇒ 扩展
 * 100% 降级（实测 sensenova/agnes）；而对 reasoning 模型又必须显式关闭思维链（thinking 预热
 * 致 TTFT 3s+，§9）。该拒绝发生在宿主本地校验（不发 provider 请求）⇒ 被拒即证明模型无
 * reasoning 能力，去掉参数重试即通；未被拒的模型本就支持 reasoning，保留 'off' 各自走对分支。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface ExpansionOutcome {
  variants: string[]
  source: 'live' | 'cache' | null
  degraded: boolean
  latencyMs: number
  /** 降级原因（诊断用；仅 degraded:true 时存在）。 */
  reason?: string
}

export interface QueryExpansionConfig {
  enabled: boolean
  /** 专用扩展 provider（0.1.6：显式指定，优先级高于会话默认 provider——扩展是低延迟任务，
   *  不应跟随主模型路由（中转/推理模型 TTFT 可达 3s+，见 EXPERIMENTS §9）；0.1.10 起 callModel 实际读取） */
  provider?: string
  /** 专用扩展模型（V1.11：unset = 会话默认模型） */
  model?: string
  maxOutputTokens: number
  timeoutMs: number
  cache: boolean
}

/** 持久化缓存接口（store 实现：expansion_cache 表，按 workspace 隔离）。 */
export interface ExpansionCacheStore {
  get(wsId: string, normQuery: string): string[] | null
  set(wsId: string, normQuery: string, variants: string[]): void
  clear(): void
}

const EXPANSION_PROMPT = '你是记忆系统的查询扩展器。对用户输入的查询，生成 3-4 个同义/口语化/更具体的变体问法（中文），'
  + '用于检索同义改写。只输出 JSON：{"variants": ["变体1", "变体2", ...]}，不要输出其他内容。'

/** 宿主拒绝「模型不支持该 reasoning effort」的错误码（dsh-llm seam 的 UNSUPPORTED_REASONING_EFFORT）。 */
const UNSUPPORTED_REASONING_EFFORT = 'UNSUPPORTED_REASONING_EFFORT'

export class QueryExpander {
  private readonly cache = new Map<string, string[]>()
  private msgSeq = 0
  stats = {
    calls: 0,
    cacheHits: 0,
    persistHits: 0,
    degraded: 0,
    totalLatencyMs: 0,
    /** 降级原因首段 → 次数（诊断；probe 的 expansion-stats 会展开）。 */
    degradeReasons: {} as Record<string, number>,
    /** 最近一次降级原因（含细节）。 */
    lastDegradeReason: null as string | null,
  }

  constructor(
    private readonly ctx: Context,
    private readonly config: QueryExpansionConfig,
    private readonly persist: ExpansionCacheStore | null = null,
  ) {}

  clear(): void {
    this.cache.clear()
    this.persist?.clear()
  }

  /**
   * 扩展一个查询。缓存键 = 归一化查询（内存层）+ (workspaceId, norm)（持久层）。
   * @param query 原始查询文本
   * @param signal 取消信号（来自工具执行）
   * @param wsId 调用方 workspace id（持久化缓存隔离键）
   */
  async expand(query: string, signal?: AbortSignal, wsId?: string): Promise<ExpansionOutcome> {
    const norm = query.trim().toLowerCase().replace(/\s+/g, ' ')
    if (this.config.cache) {
      const cached = this.cache.get(norm)
      if (cached !== undefined) {
        this.stats.cacheHits++
        return { variants: cached, source: 'cache', degraded: false, latencyMs: 0 }
      }
      // 持久层命中（跨进程/重启）：回填内存缓存
      if (wsId !== undefined && this.persist !== null) {
        const stored = this.persist.get(wsId, norm)
        if (stored !== null) {
          this.stats.cacheHits++
          this.stats.persistHits++
          this.cache.set(norm, stored)
          return { variants: stored, source: 'cache', degraded: false, latencyMs: 0 }
        }
      }
    }
    this.stats.calls++
    const started = Date.now()
    const outcome = await this.callModel(query, signal)
    const latencyMs = Date.now() - started
    this.stats.totalLatencyMs += latencyMs
    if (!outcome.ok) return this.degrade(outcome.reason, latencyMs)
    const variants = parseVariants(outcome.text)
    if (variants.length === 0) {
      return this.degrade(`empty-variants: raw=${JSON.stringify(outcome.text).slice(0, 200)}`, latencyMs)
    }
    if (this.config.cache) {
      this.cache.set(norm, variants)
      if (wsId !== undefined && this.persist !== null) this.persist.set(wsId, norm, variants)
    }
    return { variants, source: 'live', degraded: false, latencyMs }
  }

  /** 记录一次降级：计数 + 日志 + 结构化 reason（诊断；不改变降级语义）。 */
  private degrade(reason: string, latencyMs: number): ExpansionOutcome {
    this.stats.degraded++
    this.stats.lastDegradeReason = reason
    const key = reason.split(':', 1)[0]
    this.stats.degradeReasons[key] = (this.stats.degradeReasons[key] ?? 0) + 1
    this.ctx.logger('dsh-knowledge-sqlite').warn('L1 query expansion degraded — %s', reason)
    return { variants: [], source: null, degraded: true, latencyMs, reason }
  }

  private async callModel(query: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string; reason: string }> {
    // 模型路由：provider 优先取专用扩展 provider（QueryExpansionConfig.provider，0.1.10 起生效），
    // 否则跟随会话默认；model 优先取专用扩展模型，否则会话默认。
    const sel = this.ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
    if (sel === undefined) return { ok: false, text: '', reason: 'no-agentDefaultModel-service' }
    let sessionProvider: string | undefined
    let sessionModel: string | undefined
    try {
      const s = sel.currentSelection()
      sessionProvider = s?.provider
      sessionModel = s?.model
    } catch (error) {
      return { ok: false, text: '', reason: `selection-threw: ${error instanceof Error ? error.message : String(error)}` }
    }
    const provider = this.config.provider ?? sessionProvider
    const model = this.config.model ?? sessionModel
    if (provider === undefined || model === undefined) {
      return { ok: false, text: '', reason: `no-route: provider=${provider ?? '-'} model=${model ?? '-'} session=${sessionProvider ?? '-'}/${sessionModel ?? '-'}` }
    }
    const llm = this.ctx.get('llm') as { stream(options: unknown): AsyncIterable<{ type: string; text?: string; reason?: { kind: string; failure?: { message?: string; code?: string } } }> } | undefined
    if (llm === undefined) return { ok: false, text: '', reason: 'no-llm-service' }
    // 扩展请求带 reasoningEffort:'off'；宿主对**无 reasoning 能力**的模型会硬拒该参数
    // （UNSUPPORTED_REASONING_EFFORT）⇒ 扩展 100% 降级（0.1.11 实测 sensenova/agnes）。
    // 该拒绝发生在宿主本地校验（不发 provider 请求、零成本）⇒ 被拒即证明模型无 reasoning 能力，
    // 此时去掉该参数重试一次即通；未被拒的模型本就支持 reasoning，保留 'off' 以关闭思维链
    // （thinking 预热可让 TTFT 高达 3s+：实测 opencode-go deepseek-v4-flash 默认 thinking 全开，
    // TTFT 3387ms / total 11.3s，见 EXPERIMENTS §9）。
    const attempt = await this.streamOnce(llm, { provider, model, query, signal, reasoningEffort: 'off' })
    if (attempt.ok) return { ok: true, text: attempt.text, reason: '' }
    if (attempt.code === UNSUPPORTED_REASONING_EFFORT) {
      const retry = await this.streamOnce(llm, { provider, model, query, signal, reasoningEffort: undefined })
      if (retry.ok) return { ok: true, text: retry.text, reason: '' }
      return { ok: false, text: '', reason: retry.reason }
    }
    return { ok: false, text: '', reason: attempt.reason }
  }

  /**
   * 单次流式调用：收集文本；失败时带回宿主错误码（用于判定是否值得重试）与结构化 reason。
   * reason 前缀在此处定型（timeout / stream-error），调用方不再二次包装。
   */
  private async streamOnce(
    llm: { stream(options: unknown): AsyncIterable<{ type: string; text?: string; reason?: { kind: string; failure?: { message?: string; code?: string } } }> },
    args: { provider: string; model: string; query: string; signal?: AbortSignal; reasoningEffort?: 'off' },
  ): Promise<{ ok: boolean; text: string; message: string; reason: string; code?: string }> {
    let text = ''
    let streamError: string | null = null
    let streamCode: string | undefined
    const collect = (async (): Promise<void> => {
      try {
        const stream = llm.stream({
          provider: args.provider,
          model: args.model,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `${EXPANSION_PROMPT}\n查询：${args.query}` }],
            source: { kind: 'plugin', plugin: 'dsh-knowledge-sqlite' },
            id: `knl-expand-${this.msgSeq++}`,
          }],
          maxTokens: this.config.maxOutputTokens,
          temperature: 0.2,
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          signal: args.signal,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            streamCode = chunk.reason.failure?.code
            throw new Error(`expansion stream ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown failure'}`)
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error)
      }
    })()
    const timedOut = await this.raceWithTimeout(collect)
    if (timedOut) {
      const reason = `timeout: ${this.config.timeoutMs}ms (provider=${args.provider} model=${args.model})`
      return { ok: false, text: '', message: reason, reason }
    }
    if (streamError !== null) {
      return {
        ok: false,
        text: '',
        message: streamError,
        reason: `stream-error: ${streamError}`,
        ...(streamCode === undefined ? {} : { code: streamCode }),
      }
    }
    return { ok: true, text, message: '', reason: '' }
  }

  /** 与超时竞速（timer 服务：宿主 fiber 计时器，插件停止时自动清理）。collect 先完成 → false；超时 → true。 */
  private raceWithTimeout(promise: Promise<void>): Promise<boolean> {
    const timer = this.ctx.get('timer') as { timeout(cb: () => void, ms: number): () => void } | undefined
    if (timer === undefined) return Promise.resolve(false) // 无 timer 服务：不设超时（collect 自行收敛）
    return new Promise((resolve) => {
      let settled = false
      const disposer = timer.timeout(() => {
        if (!settled) { settled = true; resolve(true) }
      }, this.config.timeoutMs)
      promise.then(
        () => { if (!settled) { settled = true; disposer(); resolve(false) } },
        () => { if (!settled) { settled = true; disposer(); resolve(false) } },
      )
    })
  }
}

/** 解析模型输出中的 variants（容忍 ```json 围栏）。 */
export function parseVariants(text: string): string[] {
  try {
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const data = JSON.parse(t) as unknown
    const list = Array.isArray(data) ? data : (data as { variants?: unknown }).variants
    if (!Array.isArray(list)) return []
    return list.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 6)
  } catch {
    return []
  }
}
