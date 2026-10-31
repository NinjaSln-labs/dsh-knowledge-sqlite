#!/usr/bin/env node
/**
 * 知识条目侧查询集度量（t000028）：human 集的对偶缺口。
 *
 * 背景（EXPERIMENTS §14）：human 集 17 条有目标查询 **0/17** 落在已富化知识条目
 * m1-m12（全部指向未富化的 n1-n10），relabel 后 recall@1 三路径全 0/17 ⇒ 语料缺
 * 「知识条目侧」查询集。本脚本度量新集 knowledge-queries.json 的质量。
 *
 * 三项判据（对应 t000028 验收）：
 *   1. L0 纯词法（A 臂：base 表、无扩展）recall@1 有**非平凡下界**：
 *      不能被词法平凡命中（=100%），也不应恒为 0（=0%）
 *   2. 能分别测出「富化前/后」的差异（C vs D 臂）
 *   3. none 查询（无目标）不误报命中知识条目
 *
 * hermetic：只用仓内 fixture ⇒ 可复现、可进 CI。
 *
 * 用法：node scripts/knowledge-set-audit.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));
const { queryGrams, matchOf } = await import(join(ROOT, 'lib', 'search.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const bench = new Map(readJson(join(CORPUS, 'enriched.json')).map((e) => [e.id, e]));
const distractors = readJson(join(CORPUS, 'distractors.json'));
const kQueries = readJson(join(CORPUS, 'knowledge-queries.json'));

const STAMPS = { workspaceId: '/ws/kaudit', ownerId: 'kaudit', authorTier: 'explicit', sessionId: 'kaudit' };

async function build(scale) {
  const dir = mkdtempSync(join(tmpdir(), 'knl-kaudit-'));
  const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
  const dedupe = new Map();
  for (const m of memories) {
    const r = await store.write({ content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'kaudit');
    dedupe.set(m.id, r.id);
  }
  for (let i = 0; i < Math.min(scale, distractors.length); i++) {
    await store.write({ content: String(distractors[i]).slice(0, 400), scope: 'workspace', dedupeKey: `d-${i}` }, STAMPS, [], 'kaudit');
  }
  for (const [id, f] of bench) {
    const itemId = dedupe.get(id);
    if (itemId === undefined) continue;
    await store.enrich(itemId, { keywords: f.keywords ?? [], synonyms: f.synonyms ?? [], questions: f.questions ?? [] });
  }
  return { dir, store, dedupe };
}

/** 检索（不经 store.search，以便用离线 C 臂的固定扩展集）。 */
async function evalArm(store, dedupe, table, queries, variantsOf) {
  let r1 = 0;
  const ranks = [];
  const scored = queries.filter((q) => q.target && q.target !== 'none');
  for (const q of scored) {
    const texts = variantsOf === null ? [q.text] : [q.text, ...variantsOf(q)];
    const { rows } = await store.search(table, texts, STAMPS, { scope: 'workspace', topN: 20, maxQueryTrigrams: 24 });
    const targetId = dedupe.get(q.target);
    const idx = rows.findIndex((r) => r.item.id === targetId);
    ranks.push(`${q.id}:${idx === -1 ? '-' : idx + 1}`);
    if (idx === 0) r1++;
  }
  return { r1, n: scored.length, pct: Math.round((100 * r1) / scored.length), ranks: ranks.join(' ') };
}

console.log('════════ 知识条目侧查询集审计（t000028）════════');
console.log(`查询集：knowledge-queries.json（${kQueries.length} 条，${kQueries.filter((q) => q.target === 'none').length} none）`);

for (const scale of [0, 500]) {
  const { dir, store, dedupe } = await build(scale);
  const label = scale === 0 ? '22 条（无干扰项）' : `${memories.length + Math.min(scale, distractors.length)} 条（含干扰项）`;
  console.log(`\n── 语料 ${label} ──`);

  // A 臂：base 表 + 纯原文（无扩展、无富化）——L0 纯词法下界
  const a = await evalArm(store, dedupe, 'base', kQueries, null);
  // C 臂：base 表 + 离线扩展变体（本集暂无离线扩展集 ⇒ 等价 A 臂，作为基线）
  // D 臂：rich 表（原文 + 富化）——富化增益
  const d = await evalArm(store, dedupe, 'rich', kQueries, null);

  console.log(`  A 臂（L0 纯词法，base 表）recall@1: ${a.r1}/${a.n} (${a.pct}%)`);
  console.log(`  D 臂（原文 + 富化，rich 表）recall@1: ${d.r1}/${d.n} (${d.pct}%)`);
  console.log(`  富化增益: ${d.pct - a.pct >= 0 ? '+' : ''}${d.pct - a.pct}pp`);
  console.log(`  逐条 rank（A）: ${a.ranks}`);
  console.log(`  逐条 rank（D）: ${d.ranks}`);

  // 判据 1：L0 有非平凡下界
  const lowerBound = a.pct > 0 && a.pct < 100;
  // 判据 2：能测出富化前/后差异（富化臂严格更好）
  const enrichmentVisible = d.r1 > a.r1;
  // 判据 3：none 查询不误报命中知识条目
  const memIds = new Set([...dedupe].filter(([k]) => !k.startsWith('d-')).map(([, id]) => id));
  const noneHits = [];
  for (const q of kQueries.filter((q) => q.target === 'none')) {
    const { rows } = await store.search('base', [q.text], STAMPS, { scope: 'workspace', topN: 20, maxQueryTrigrams: 24 });
    if (rows.length > 0 && memIds.has(rows[0].item.id)) noneHits.push(q.id);
  }
  console.log(`  none 误报: ${noneHits.length === 0 ? '无' : noneHits.join(',')}`);
  console.log(`  判据 1（L0 非平凡下界，不恒 0 且不平凡 100%）: ${lowerBound ? 'PASS' : 'FAIL'}`);
  console.log(`  判据 2（富化前/后差异可测）: ${enrichmentVisible ? 'PASS' : 'FAIL'}`);
  console.log(`  判据 3（none 不误报）: ${noneHits.length === 0 ? 'PASS' : 'FAIL'}`);

  store.close();
  rmSync(dir, { recursive: true, force: true });
}
