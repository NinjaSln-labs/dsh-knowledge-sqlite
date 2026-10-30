#!/usr/bin/env node
/**
 * 查询截断度量（t000003）：maxQueryTrigrams 的 cap 值与截断策略对召回/延迟的影响。
 *
 * hermetic：只用仓内 fixture（tests/fixtures/corpus/），不联网 ⇒ 可复现。
 *
 * 三项测量：
 *   1. 查询 gram 数分布（生产查询 = 原文 + L1 扩展变体）——cap 是否真的触发
 *   2. 截断策略 × 查询集 recall@1：不限 / idf 优先 cap24 / idf 优先 cap12 /
 *      顺序截断 cap24 / 顺序截断 cap12（顺序截断是 EXPERIMENTS §2 的反例）
 *   3. cap>0 的延迟代价（dfOf 全表扫描 O(N)）随语料规模的增长曲线
 *
 * 用法：node scripts/cap-measure.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));
const { queryGrams, docGrams, matchOf } = await import(join(ROOT, 'lib', 'search.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const bench = new Map(readJson(join(CORPUS, 'enriched.json')).map((e) => [e.id, e]));
const expanded = new Map(readJson(join(CORPUS, 'expanded.json')).map((e) => [e.id, e]));
const distractors = readJson(join(CORPUS, 'distractors.json'));
const humanQueries = readJson(join(CORPUS, 'human-queries.json'));
const dataMjs = readFileSync(join(CORPUS, 'data.mjs'), 'utf8');
const hardQueries = [...dataMjs.matchAll(/\{ id: '(q\d+)', target: '(m\d+)', text: '([^']+)' \}/g)]
  .map((m) => ({ id: m[1], target: m[2], text: m[3] }));
const humanScored = humanQueries.filter((q) => q.target && q.target !== 'none');

const STAMPS = { workspaceId: '/ws/measure', ownerId: 'measure', authorTier: 'explicit', sessionId: 'measure' };
const textsOf = (q) => [q.text, ...(expanded.get(q.id)?.variants ?? [])];

/** 建库（可选带干扰项）；返回 store + db + dedupe 映射。 */
async function build(scale) {
  const dir = mkdtempSync(join(tmpdir(), 'knl-cap-'));
  const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
  const dedupe = new Map();
  for (const m of memories) {
    const r = await store.write({ content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'measure');
    dedupe.set(m.id, r.id);
  }
  for (let i = 0; i < Math.min(scale, distractors.length); i++) {
    await store.write({ content: String(distractors[i]).slice(0, 400), scope: 'workspace', dedupeKey: `d-${i}` }, STAMPS, [], 'measure');
  }
  for (const [id, f] of bench) {
    const itemId = dedupe.get(id);
    if (itemId === undefined) continue;
    await store.enrich(itemId, { keywords: f.keywords ?? [], synonyms: f.synonyms ?? [], questions: f.questions ?? [] });
  }
  const db = new DatabaseSync(join(dir, 'k.sqlite'));
  return { dir, store, db, dedupe };
}

/** 按给定 gram 集检索（复刻 store.search 的 SQL；顺序截断需绕过 store 的固定 idf 逻辑）。 */
function searchWithGrams(db, grams) {
  if (grams.length === 0) return [];
  const sql = `
    SELECT f.rowid, bm25(items_fts_rich) AS score
    FROM items_fts_rich f JOIN items i ON i.rowid = f.rowid
    WHERE f.items_fts_rich MATCH ?
      AND i.deleted = 0
      AND (i.ttl_seconds IS NULL OR i.created_at + i.ttl_seconds * 1000 > ?)
      AND ((i.scope = 'workspace' AND i.workspace_id = ?) OR (i.scope = 'session' AND i.owner_id = ?) OR (i.scope = 'global'))
    ORDER BY score
    LIMIT 20`;
  return db.prepare(sql).all(matchOf(grams), Date.now(), STAMPS.workspaceId, STAMPS.sessionId);
}

function idfMap(db) {
  const df = new Map();
  for (const r of db.prepare('SELECT content FROM items_fts_rich').all()) {
    for (const g of new Set(docGrams(r.content))) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const total = Number(db.prepare('SELECT count(*) AS c FROM items_fts_rich').get().c);
  return { df, total, idf: (g) => { const n = df.get(g) ?? 0; return n <= 0 ? 0 : Math.log((total + 1) / (n + 1)); } };
}

async function evalStrategy(db, dedupe, idf, strategy, queries) {
  let r1 = 0;
  const ranks = [];
  const idStmt = db.prepare('SELECT id FROM items WHERE rowid = ?');
  for (const q of queries) {
    const all = queryGrams(textsOf(q).join(' '));
    let grams = all;
    if (strategy.cap > 0 && all.length > strategy.cap) {
      grams = strategy.mode === 'idf'
        ? [...all].sort((a, b) => idf(b) - idf(a)).slice(0, strategy.cap)
        : all.slice(0, strategy.cap);
    }
    const rows = searchWithGrams(db, grams);
    const targetId = dedupe.get(q.target);
    const idx = rows.findIndex((r) => idStmt.get(r.rowid)?.id === targetId);
    ranks.push(`${q.id}:${idx === -1 ? '-' : idx + 1}`);
    if (idx === 0) r1++;
  }
  return { r1, n: queries.length, pct: Math.round((100 * r1) / queries.length), ranks: ranks.join(' ') };
}

// ================= 1. gram 数分布 =================
console.log('════════ 查询截断度量（t000003）════════');
console.log('\n── 1. 查询 gram 数分布（生产查询 = 原文 + L1 扩展变体）──');
function gramStats(label, queries) {
  const counts = queries.map((q) => ({ id: q.id, n: queryGrams(textsOf(q).join(' ')).length }));
  counts.sort((a, b) => a.n - b.n);
  const over24 = counts.filter((c) => c.n > 24).length;
  const over12 = counts.filter((c) => c.n > 12).length;
  console.log(`  ${label.padEnd(20)} 最小 ${String(counts[0].n).padStart(3)}  中位 ${String(counts[Math.floor(counts.length / 2)].n).padStart(3)}  最大 ${String(counts[counts.length - 1].n).padStart(3)}  超24: ${over24}/${counts.length}  超12: ${over12}/${counts.length}`);
}
gramStats('hard + L1 扩展', hardQueries);
gramStats('human + L1 扩展', humanScored);
{
  const counts = hardQueries.map((q) => queryGrams(q.text).length).sort((a, b) => a - b);
  console.log(`  ${'hard 纯原文'.padEnd(20)} 最小 ${String(counts[0]).padStart(3)}  中位 ${String(counts[Math.floor(counts.length / 2)]).padStart(3)}  最大 ${String(counts[counts.length - 1]).padStart(3)}  超24: ${counts.filter((n) => n > 24).length}/${counts.length}`);
}

// ================= 2. 截断策略 × 召回 =================
const { dir, store, db, dedupe } = await build(500);
const { idf } = idfMap(db);
console.log(`\n── 2. 截断策略 × recall@1（语料 ${memories.length + 500} 条，L1 路径查询）──`);
const STRATEGIES = [
  { name: '不限', cap: 0, mode: 'idf' },
  { name: 'idf 优先 cap24', cap: 24, mode: 'idf' },
  { name: 'idf 优先 cap12', cap: 12, mode: 'idf' },
  { name: '顺序截断 cap24', cap: 24, mode: 'seq' },
  { name: '顺序截断 cap12', cap: 12, mode: 'seq' },
];
console.log('策略                hard            human');
console.log('─'.repeat(60));
for (const s of STRATEGIES) {
  const h = await evalStrategy(db, dedupe, idf, s, hardQueries);
  const hu = await evalStrategy(db, dedupe, idf, s, humanScored);
  console.log(`${s.name.padEnd(18)} ${String(h.r1).padStart(2)}/${h.n} (${String(h.pct).padStart(3)}%)     ${String(hu.r1).padStart(2)}/${hu.n} (${String(hu.pct).padStart(3)}%)`);
}
console.log('\n逐条 rank：');
for (const s of STRATEGIES) {
  const h = await evalStrategy(db, dedupe, idf, s, hardQueries);
  const hu = await evalStrategy(db, dedupe, idf, s, humanScored);
  console.log(`  [${s.name}]`);
  console.log(`    hard : ${h.ranks}`);
  console.log(`    human: ${hu.ranks}`);
}
store.close(); db.close(); rmSync(dir, { recursive: true, force: true });

// ================= 3. 延迟代价随规模 =================
console.log('\n── 3. cap>0 的延迟代价（dfOf 全表扫描 O(N)，每次查询都做）──');
console.log('语料规模    cap=0 p95    cap=24 p95    差值');
console.log('─'.repeat(52));
for (const scale of [50, 200, 500]) {
  const b = await build(scale);
  const run = async (cap, rounds) => {
    const times = [];
    for (let r = 0; r < rounds; r++) {
      for (const q of hardQueries) {
        const t0 = process.hrtime.bigint();
        await b.store.search('rich', textsOf(q), STAMPS, { scope: 'workspace', topN: 20, maxQueryTrigrams: cap });
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }
    times.sort((a, b2) => a - b2);
    return times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  };
  await run(0, 1); // 预热
  const p0 = await run(0, 4);
  const p24 = await run(24, 4);
  console.log(`${String(memories.length + Math.min(scale, distractors.length)).padStart(5)} 条    ${p0.toFixed(2).padStart(7)}ms   ${p24.toFixed(2).padStart(7)}ms   ${(p24 - p0 >= 0 ? '+' : '')}${(p24 - p0).toFixed(2)}ms`);
  b.store.close(); b.db.close(); rmSync(b.dir, { recursive: true, force: true });
}
