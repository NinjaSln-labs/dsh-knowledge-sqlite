/**
 * dsh-knowledge-sqlite — store 层单测（真实 node:sqlite，提案测试矩阵的存储行）。
 * 覆盖：契约往返（write/search/list/update/delete）、dedupeKey 作用域 upsert、
 * 确定性 id、错误语义、TTL、tombstone、跨 workspace 隔离、session 隔离、分页。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteKnowledgeStore } from '../src/store.ts'
import { matchOf, truncateGrams } from '../src/search.ts'
import type { KnowledgeStamps } from '../src/types.ts'

let store: SqliteKnowledgeStore
let dir: string
const stamps: KnowledgeStamps = { workspaceId: '/ws/a', ownerId: 'sess-a', authorTier: 'explicit' }
const caller = { ...stamps, sessionId: 'sess-a' }
const actor = 'agent-a'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'knl-test-'))
  store = await SqliteKnowledgeStore.open(join(dir, 't.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('write / read 往返', () => {
  it('写入立即可检索（零 LLM），返回确定性 id', async () => {
    const r = await store.write({ content: '部署流程是 pnpm build 之后运行 pnpm dsh web', scope: 'workspace', dedupeKey: 'm1' }, stamps, [], actor)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.id).toMatch(/^k-[0-9a-f]{8}$/)
    expect(r.wasUpdate).toBe(false)
    expect(r.scope).toBe('workspace')

    const { rows } = await store.search('base', ['部署流程'], caller, { topN: 5 })
    expect(rows.map((x) => x.item.id)).toContain(r.id)
  })

  it('dedupeKey upsert：id 稳定、内容更新、不新增行', async () => {
    const w1 = await store.write({ content: '第一版内容', dedupeKey: 'k1' }, stamps, [], actor)
    const w2 = await store.write({ content: '第二版内容', dedupeKey: 'k1' }, stamps, [], actor)
    if ('error' in w1 || 'error' in w2) throw new Error('write failed')
    expect(w2.id).toBe(w1.id)
    expect(w2.wasUpdate).toBe(true)
    const { rows } = await store.search('base', ['第二版'], caller, { topN: 5 })
    expect(rows.some((x) => x.item.id === w1.id)).toBe(true)
    const { rows: stale } = await store.search('base', ['第一版'], caller, { topN: 5 })
    expect(stale.some((x) => x.item.id === w1.id)).toBe(false) // v1 内容已替换
  })

  it('dedupeKey 作用域 (workspace, scope, dedupeKey)：跨 workspace 同 key 互不影响', async () => {
    const a = await store.write({ content: '工作区A的专属记忆', dedupeKey: 'same' }, stamps, [], actor)
    const bStamps = { workspaceId: '/ws/b', ownerId: 'sess-b', authorTier: 'explicit' }
    const b = await store.write({ content: '工作区B的专属记忆', dedupeKey: 'same' }, bStamps, [], 'agent-b')
    if ('error' in a || 'error' in b) throw new Error('write failed')
    expect(a.id).not.toBe(b.id) // 不同 workspace → 不同 id
    // 各自 workspace 只能搜到自己的
    const { rows: aRows } = await store.search('base', ['专属记忆'], caller, { topN: 5 })
    expect(aRows.some((x) => x.item.id === a.id)).toBe(true)
    expect(aRows.some((x) => x.item.id === b.id)).toBe(false)
  })
})

describe('错误语义', () => {
  it('打标字段伪造 → write-rejected（运行期防御）', async () => {
    const forged = await store.write({ content: 'x', workspaceId: '/ws/fake', ownerId: 'hacker', authorTier: 'human' } as never, stamps, [], actor)
    expect('error' in forged && forged.error.code).toBe('write-rejected')
  })

  it('空 content / 超限 content → write-rejected', async () => {
    const empty = await store.write({ content: '   ' }, stamps, [], actor)
    expect('error' in empty && empty.error.code).toBe('write-rejected')
    const big = await store.write({ content: 'x'.repeat(7000) }, stamps, [], actor)
    expect('error' in big && big.error.code).toBe('write-rejected')
  })

  it('global 写无 allowlist → write-rejected', async () => {
    const r = await store.write({ content: 'g', scope: 'global' }, stamps, [], actor)
    expect('error' in r && r.error.code).toBe('write-rejected')
    // 允许后成功
    const ok = await store.write({ content: 'g', scope: 'global' }, stamps, ['agent-a'], actor)
    expect('error' in ok).toBe(false)
  })

  it('delete 未知 id → missing-key；update 未知 id → missing-key', async () => {
    const d = await store.delete('k-00000000', caller)
    expect('error' in d && d.error.code).toBe('missing-key')
    const u = await store.update('k-00000000', { content: 'x' }, caller)
    expect('error' in u && u.error.code).toBe('missing-key')
  })

  it('closed 后操作 → closed', async () => {
    store.close()
    const r = await store.write({ content: 'x' }, stamps, [], actor)
    expect('error' in r && r.error.code).toBe('closed')
  })
})

describe('TTL 语义', () => {
  it('过期条目从搜索过滤，delete 返回 false，list 标记 expired', async () => {
    const ttl = await store.write({ content: '临时密码 S3cr3t', ttl: 1 }, stamps, [], actor)
    if ('error' in ttl) throw new Error('write failed')
    const { rows: fresh } = await store.search('base', ['临时密码'], caller, { topN: 5 })
    expect(fresh.some((x) => x.item.id === ttl.id)).toBe(true)

    await new Promise((r) => setTimeout(r, 1100))
    const { rows: stale } = await store.search('base', ['临时密码'], caller, { topN: 5 })
    expect(stale.some((x) => x.item.id === ttl.id)).toBe(false)

    const del = await store.delete(ttl.id, caller)
    expect('error' in del).toBe(false)
    if (!('error' in del)) expect(del.deleted).toBe(false)

    const list = store.list('all', { includeExpired: true }, caller)
    const meta = list.items.find((i) => i.id === ttl.id)
    expect(meta?.expired).toBe(true)
    // 默认不含过期
    const listDefault = store.list('all', {}, caller)
    expect(listDefault.items.find((i) => i.id === ttl.id)).toBeUndefined()
  })
})

describe('tombstone 与审计', () => {
  it('delete 后搜索过滤，list includeDeleted 可见带 deleted 标记', async () => {
    const r = await store.write({ content: '待删除内容', dedupeKey: 'del-1' }, stamps, [], actor)
    if ('error' in r) throw new Error('write failed')
    const { rows: before } = await store.search('base', ['待删除内容'], caller, { topN: 5 })
    expect(before.some((x) => x.item.id === r.id)).toBe(true)

    const del = await store.delete(r.id, caller)
    expect('error' in del).toBe(false)
    if (!('error' in del)) expect(del.deleted).toBe(true)

    const { rows: after } = await store.search('base', ['待删除内容'], caller, { topN: 5 })
    expect(after.some((x) => x.item.id === r.id)).toBe(false)
    const list = store.list('all', { includeDeleted: true }, caller)
    expect(list.items.some((i) => i.id === r.id && i.deleted === true)).toBe(true)
  })
})

describe('授权隔离', () => {
  it('跨 workspace：搜索空、删除 write-rejected', async () => {
    const r = await store.write({ content: 'A 的私有内容 pnpm', dedupeKey: 'priv' }, stamps, [], actor)
    if ('error' in r) throw new Error('write failed')
    const alien = { workspaceId: '/ws/b', ownerId: 'sess-b', authorTier: 'explicit', sessionId: 'sess-b' }
    const { rows } = await store.search('base', ['私有内容'], alien, { topN: 5 })
    expect(rows.length).toBe(0)
    const del = await store.delete(r.id, alien)
    expect('error' in del && del.error.code).toBe('write-rejected')
  })

  it('session scope：仅属主会话可见', async () => {
    const r = await store.write({ content: '会话草稿 专属', scope: 'session' }, stamps, [], actor)
    if ('error' in r) throw new Error('write failed')
    const { rows: self } = await store.search('base', ['会话草稿'], caller, { topN: 5 })
    expect(self.some((x) => x.item.id === r.id)).toBe(true)
    const alien = { workspaceId: '/ws/a', ownerId: 'sess-b', authorTier: 'explicit', sessionId: 'sess-b' }
    const { rows: other } = await store.search('base', ['会话草稿'], alien, { topN: 5 })
    expect(other.some((x) => x.item.id === r.id)).toBe(false)
  })

  it('global scope：所有 workspace 可读', async () => {
    const r = await store.write({ content: '全局公告 12345', scope: 'global' }, stamps, ['agent-a'], actor)
    if ('error' in r) throw new Error('write failed')
    const alien = { workspaceId: '/ws/b', ownerId: 'sess-b', authorTier: 'explicit', sessionId: 'sess-b' }
    const { rows } = await store.search('base', ['全局公告'], alien, { topN: 5 })
    expect(rows.some((x) => x.item.id === r.id)).toBe(true)
  })
})

describe('分页与列表', () => {
  it('游标分页稳定、无重叠；新条目在前', async () => {
    for (let i = 0; i < 25; i++) {
      await store.write({ content: `条目 ${i}`, dedupeKey: `pg-${i}` }, stamps, [], actor)
    }
    const p1 = store.list('all', { limit: 10 }, caller)
    const p2 = store.list('all', { limit: 10, cursor: p1.nextCursor }, caller)
    const p3 = store.list('all', { limit: 10, cursor: p2.nextCursor }, caller)
    expect(p1.items.length).toBe(10)
    expect(p2.items.length).toBe(10)
    expect(p3.items.length).toBe(5)
    expect(p1.items.some((a) => p2.items.some((b) => b.id === a.id))).toBe(false)
    // 降序：新条目在前（p1 最新），最后一页最后一条是最早写入的 pg-0
    expect(p1.items[0].createdAt).toBeGreaterThan(p2.items[0].createdAt)
    expect(p2.items[0].createdAt).toBeGreaterThan(p3.items[0].createdAt)
    expect(p3.items[4].dedupeKey).toBe('pg-0')
    expect(p3.nextCursor).toBeUndefined()
  })
})

describe('update 路径', () => {
  it('更新内容后立即可按新内容检索；scope/dedupeKey 不可变由服务层挡（store 无此字段）', async () => {
    const r = await store.write({ content: '旧内容 abcd', dedupeKey: 'up-1' }, stamps, [], actor)
    if ('error' in r) throw new Error('write failed')
    const up = await store.update(r.id, { content: '新内容 wxyz' }, caller)
    expect('error' in up).toBe(false)
    const { rows } = await store.search('base', ['wxyz'], caller, { topN: 5 })
    expect(rows.some((x) => x.item.id === r.id)).toBe(true)
    const { rows: stale } = await store.search('base', ['abcd'], caller, { topN: 5 })
    expect(stale.some((x) => x.item.id === r.id)).toBe(false)
  })

  it('富化字段参与检索（rich 表）', async () => {
    const r = await store.write({ content: '核心正文不含关键词', dedupeKey: 'en-1' }, stamps, [], actor)
    if ('error' in r) throw new Error('write failed')
    await store.enrich(r.id, { keywords: ['稀有专有词XyZ'] })
    const { rows: base } = await store.search('base', ['稀有专有词XyZ'], caller, { topN: 5 })
    expect(base.some((x) => x.item.id === r.id)).toBe(false) // base 表不含富化
    const { rows: rich } = await store.search('rich', ['稀有专有词XyZ'], caller, { topN: 5 })
    expect(rich.some((x) => x.item.id === r.id)).toBe(true) // rich 表含富化
  })
})

describe('L1 扩展缓存持久化（expansion_cache）', () => {
  it('roundtrip：set → get；upsert 覆盖；跨 workspace 隔离；坏数据 → null', () => {
    store.setExpansion('/ws/a', '如何 启动 服务', ['怎么把服务跑起来', '服务如何启动'])
    expect(store.getExpansion('/ws/a', '如何 启动 服务')).toEqual(['怎么把服务跑起来', '服务如何启动'])
    // 其它 workspace 不可见
    expect(store.getExpansion('/ws/b', '如何 启动 服务')).toBe(null)
    // upsert 覆盖
    store.setExpansion('/ws/a', '如何 启动 服务', ['更新后的变体'])
    expect(store.getExpansion('/ws/a', '如何 启动 服务')).toEqual(['更新后的变体'])
    // 未命中
    expect(store.getExpansion('/ws/a', '不存在的查询')).toBe(null)
  })

  it('clear 清空全部 workspace 的缓存', () => {
    store.setExpansion('/ws/a', 'q1', ['v1'])
    store.setExpansion('/ws/b', 'q2', ['v2'])
    store.clearExpansionCache()
    expect(store.getExpansion('/ws/a', 'q1')).toBe(null)
    expect(store.getExpansion('/ws/b', 'q2')).toBe(null)
  })

  it('坏数据（非 JSON/非字符串数组）按未命中处理', () => {
    store.setExpansion('/ws/a', 'q1', ['ok'])
    // 直接写入坏数据模拟损坏
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    db.prepare('UPDATE expansion_cache SET variants = ? WHERE ws_id = ? AND query = ?').run('{bad json', '/ws/a', 'q1')
    expect(store.getExpansion('/ws/a', 'q1')).toBe(null)
    db.prepare('UPDATE expansion_cache SET variants = ? WHERE ws_id = ? AND query = ?').run('[1,2,3]', '/ws/a', 'q1')
    expect(store.getExpansion('/ws/a', 'q1')).toBe(null)
  })
})

// ---------- 查询截断（maxQueryTrigrams / idf 优先）——t000025 D4 回归护栏 ----------
describe('查询截断与 idf 优先', () => {
  /** 造一条长查询：gram 数远超 cap，用于触发截断。 */
  const longQuery = (seed: string): string => {
    let s = seed
    for (let i = 0; i < 30; i++) s += `片段${i}abcdef`
    return s
  }

  it('idf 优先截断保留高判别力 gram（顺序截断会丢）——核心对照', () => {
    // 稀有 gram（只出现 1 次）idf 高；常见 gram（每条都有）与不存在 gram（df=0）idf 同为 0
    const df = new Map<string, number>([
      ['rare', 1],
      ['comm', 100],
    ])
    const grams = ['comm', 'other', 'rare']
    const total = 100
    const kept = truncateGrams(grams, df, total, 2)
    // idf(rare) 最高 ⇒ 必留且排首位；idf=0 档按入参稳定排序（comm 先于 other）
    expect(kept).toContain('rare')
    expect(kept[0]).toBe('rare')
    expect(kept.length).toBe(2)
    // 顺序截断（取入参前 2）会保留两个 idf=0 的 gram 而丢掉 rare
    const seq = grams.slice(0, 2)
    expect(seq).not.toContain('rare')
    expect(seq).toEqual(['comm', 'other'])
  })

  it('cap=0 或 gram 数不足 cap 时不截断', () => {
    const df = new Map<string, number>([['a', 1]])
    expect(truncateGrams(['a', 'b'], df, 10, 0)).toEqual(['a', 'b'])
    expect(truncateGrams(['a', 'b'], df, 10, 5)).toEqual(['a', 'b'])
  })

  it('同 df 的 gram 排序稳定（idf 相同则保持入参顺序）', () => {
    const df = new Map<string, number>([['x', 3], ['y', 3], ['z', 9]])
    const kept = truncateGrams(['x', 'y', 'z'], df, 100, 2)
    expect(kept).toEqual(['x', 'y'])
  })

  it('cap>0 时检索结果与不限一致（截断无损）', async () => {
    for (let i = 0; i < 8; i++) {
      await store.write({ content: `条目${i} 内容 独特标记${i}abc`, dedupeKey: `cap-${i}` }, stamps, [], actor)
    }
    const q = longQuery('独特标记')
    const unlimited = await store.search('base', [q], caller, { topN: 10, maxQueryTrigrams: 0 })
    const capped = await store.search('base', [q], caller, { topN: 10, maxQueryTrigrams: 24 })
    expect(capped.qgrams.length).toBeLessThanOrEqual(24)
    expect(unlimited.qgrams.length).toBeGreaterThan(24)
    // 命中集合一致（idf 优先不丢判别 gram）
    expect(capped.rows.map((r) => r.item.id).sort()).toEqual(unlimited.rows.map((r) => r.item.id).sort())
  })

  it('df 限定在调用方可见文档内（跨 workspace 不稀释 idf）', async () => {
    const alienStamps = { workspaceId: '/ws/b', ownerId: 'sess-b', authorTier: 'explicit' }
    // 另一个 workspace 塞入大量含目标 gram 的文档
    for (let i = 0; i < 20; i++) {
      await store.write({ content: `外来内容 共享标记 abc ${i}`, dedupeKey: `alien-${i}` }, alienStamps, [], 'agent-b')
    }
    await store.write({ content: '本工作区 内容 共享标记 abc', dedupeKey: 'own-1' }, stamps, [], actor)
    // 本 workspace 的调用方搜不到外来文档
    const { rows } = await store.search('base', ['共享标记'], caller, { topN: 20 })
    expect(rows.length).toBe(1)
    expect(rows[0].item.content).toContain('本工作区')
    // 外来 workspace 的调用方只看到自己的
    const alienCaller = { ...alienStamps, sessionId: 'sess-b' }
    const { rows: alienRows } = await store.search('base', ['共享标记'], alienCaller, { topN: 20 })
    expect(alienRows.length).toBe(20)
    expect(alienRows.every((r) => r.item.content.includes('外来内容'))).toBe(true)
  })

  it('matchOf 转义内嵌双引号（否则 FTS5 语法错误 → 检索静默返回空）', () => {
    const q = matchOf(['a"b'])
    expect(q).toBe('"a""b"')
  })
})
