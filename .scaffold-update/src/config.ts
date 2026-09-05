/**
 * dsh-knowledge-sqlite — 插件配置定义
 *
 * schemastery `Config` 是 Loader / settings UI 读取的配置形状声明；
 * resolveConfig() 给出防御性默认值，partial 配置（与测试）也能得到完整结果。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用'),
  // <配置项：z.boolean()/.number()/.string()/.array(...)，均给 .default(...) 与 .description(...)>
})

export interface ConfigType {
  enabled?: boolean
  // <与 Config 一一对应的 TS 类型，全部可选（partial 进，resolve 出）>
}

/** 防御性解析：任何 partial/测试输入都补全为完整配置 */
export function resolveConfig(config: ConfigType = {}): Required<ConfigType> {
  return {
    enabled: config.enabled ?? true,
    // <逐字段 ?? 默认值，与 Config 的 .default 对齐>
  }
}
