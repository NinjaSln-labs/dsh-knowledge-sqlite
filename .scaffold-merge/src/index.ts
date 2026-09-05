/**
 * dsh-knowledge-sqlite — Host half 入口（从零新建骨架）
 *
 * dsh 插件 = 一个 Cordis 插件包：default 导出必须是**插件对象本体**
 * （OBJECT form，绝不是返回 { apply } 的工厂——loader 直接把 module.default
 * 传给 ctx.plugin()，FUNCTION 会被当作插件体调用，工厂被静默忽略：
 * entry 显示 ACTIVE 但 apply 永远不跑，knowledge-sqlite 踩过）。
 */
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type ConfigType } from './config.ts'

export { Config } from './config.ts'

export const name = 'dsh-knowledge-sqlite'

export default {
  name,
  Config,
  apply(ctx: Context, config: ConfigType = {}): void {
    const cfg = resolveConfig(config)
    if (!cfg.enabled) return

    // ── 服务访问模式 ──────────────────────────────────────────────
    // 可选服务：ctx.get() + undefined 检查（探针/降级模式）
    const optional = ctx.get('someService')
    if (optional !== undefined) {
      // 有则增强
    }
    // 硬依赖服务：在插件对象上声明 inject: ['xxx']（缺服务时进入等待，
    // Cordis 重挂后自动恢复）——需要时给 default 对象加 inject 字段

    // ── 生命周期：每个副作用必须可逆 ──────────────────────────────
    // 定时器用 ctx.timeout / ctx.interval（沙箱禁用 setTimeout 等全局）
    // 订阅用 ctx.on(...)，保留 disposer 或直接用 ctx.effect() 收口
    //   ctx.effect(() => ctx.on('some/event', handler), (disposer) => disposer())
    // stop/update/undefine 时由 Fiber 统一清理

    // <本插件的实际能力：工具 defineTool→registerTool / 命令 / RPC / Slot UI>
  },
}
