#!/usr/bin/env node
/**
 * L2 富化度量（t000002）：覆盖率口径 + 富化质量对照 + 富化对排序的影响。
 *
 * hermetic：只用仓内 fixture（tests/fixtures/corpus/），不联网、不调 LLM ⇒ 可进 CI。
 * LLM 生成富化的对照需另跑 scripts/enrich-llm-gen.mjs（联网、人工触发），产物放
 * tests/fixtures/corpus/enriched-llm.json（可选存在）。
 *
 * 三个度量：
 *   1. 覆盖率口径：富化条目数 / 语料条目数（区分「知识条目」与「过程记录」两套分母）
 *   2. 富化质量：基准富化 vs 无富化，在 hard 集（目标 m1-m12）与 human 集（目标 n1-n10）上的 recall@1
 *   3. 富化对排序的影响：L1 路径（查询 = 原查询 + 扩展变体）下目标的 rank 分布
 *
 * 用法：node scripts/enrich-measure.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const benchArr = readJson(join(CORPUS, 'enriched.json'));
const expandedArr = readJson(join(CORPUS, 'expanded.json'));
const humanQueries = readJson(join(CORPUS, 'human-queries.json'));
const dataMjs = readFileSync(join(CORPUS, 'data.mjs'), 'utf8');
const hardQueries = [...dataMjs.matchAll(/\{ id: '(q\d+)', target: '(m\d+)', text: '([^']+)' \}/g)]
  .map((m) => ({ id: m[1], target: m[2], text: m[3] }));

const llmPath = join(CORPUS, 'enriched-llm.json');
/** LLM 富化产物：{_meta, items[]} 或裸数组（兼容） */
const llmRaw = existsSync(llmPath) ? readJson(llmPath) : null;
const llmArr = llmRaw === null ? null : (Array.isArray(llmRaw) ? llmRaw : llmRaw.items ?? null);

const byId = (a) => new Map(a.map((e) => [e.id, e]));
const benchMap = byId(benchArr);
const llmMap = llmArr ? byId(llmArr) : null;

// ---- 语料分档：m* = 知识条目（可被查询的事实）；n* = 评审过程记录（对话轨迹）----
const isFact = (id) => id.startsWith('m');
const facts = memories.filter((m) => isFact(m.id));
const traces = memories.filter((m) => !isFact(m.id));

const STAMPS = { workspaceId: '/ws/measure', ownerId: 'measure', authorTier: 'explicit', sessionId: 'measure' };

/** 建库 + 施加富化 → 评测（表 = rich：content + 富化拼接；无富化臂等价纯词法） */
async function measureArm(name, enrichmentMap, { useL1 = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'knl-enrich-'));
  const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
  const dedupe = new Map();
  for (const m of memories) {
    const r = await store.write(
      { content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'measure',
    );
    dedupe.set(m.id, r.id);
  }
  let enrichedCount = 0;
  for (const [id, f] of enrichmentMap) {
    if (!f?.keywords?.length && !f?.synonyms?.length && !f?.questions?.length) continue;
    const itemId = dedupe.get(id);
    if (itemId === undefined) continue;
    await store.enrich(itemId, {
      keywords: f.keywords ?? [], synonyms: f.synonyms ?? [], questions: f.questions ?? [],
    });
    enrichedCount++;
  }

  const expMap = byId(expandedArr);
  const evalSuite = async (queries) => {
    const scored = queries.filter((q) => q.target && q.target !== 'none');
    let r1 = 0;
    const ranks = [];
    for (const q of scored) {
      const texts = useL1 ? [q.text, ...(expMap.get(q.id)?.variants ?? [])] : [q.text];
      const rows = await store.search('rich', texts, STAMPS, { scope: 'workspace', topN: 20 });
      const rank = rows.findIndex((r) => r.item.id === dedupe.get(q.target));
      ranks.push(`${q.id}:${rank === -1 ? '-' : rank + 1}`);
      if (rank === 0) r1++;
    }
    return { r1, n: scored.length, pct: Math.round((100 * r1) / scored.length), ranks: ranks.join(' ') };
  };

  const hard = await evalSuite(hardQueries);
  const human = await evalSuite(humanQueries);
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return { name, enrichedCount, hard, human };
}

// ================= 输出 =================
console.log('════════ L2 富化度量（t000002）════════');
console.log(`语料 ${memories.length} 条：知识条目 ${facts.length}（m1-m12）+ 过程记录 ${traces.length}（n1-n10）`);
console.log(`查询集：hard ${hardQueries.length} 条（目标全在 m1-m12）｜human 有目标 ${humanQueries.filter((q) => q.target && q.target !== 'none').length} 条（目标全在 n1-n10）`);
console.log('');

// 1) 覆盖率
const benchFacts = facts.filter((f) => benchMap.has(f.id)).length;
console.log('── 1. 覆盖率（基准富化的分布）──');
console.log(`  知识条目口径（m1-m12）：   ${benchFacts}/${facts.length} = ${Math.round((100 * benchFacts) / facts.length)}%`);
console.log(`  全量口径（22 条）：        ${benchArr.length}/${memories.length} = ${Math.round((100 * benchArr.length) / memories.length)}%`);
console.log(`  过程记录（n1-n10）：       ${benchArr.length - benchFacts}/${traces.length} 未富化`);
console.log('');

// 2) 富化质量（纯词法路径：查询原文，不含 L1 变体）
console.log('── 2. 富化质量（纯词法路径，查询=原文）──');
const arms = [['无富化', new Map()], ['基准富化', benchMap]];
if (llmMap) arms.push(['LLM新生成', llmMap]);
for (const [name, map] of arms) {
  const r = await measureArm(name, map);
  console.log(`  ${name.padEnd(10)} 富化 ${String(r.enrichedCount).padStart(2)}/${memories.length}  hard recall@1 ${String(r.hard.r1).padStart(2)}/${r.hard.n} (${String(r.hard.pct).padStart(3)}%)   human recall@1 ${String(r.human.r1).padStart(2)}/${r.human.n} (${String(r.human.pct).padStart(3)}%)`);
}
console.log('');

// 3) 富化对排序的影响（L1 路径：查询 = 原查询 + 扩展变体）
console.log('── 3. 富化对排序的影响（L1 路径，查询=原文+扩展变体）──');
const armsL1 = [['无富化', new Map()], ['基准富化', benchMap]];
if (llmMap) armsL1.push(['LLM新生成', llmMap]);
for (const [name, map] of armsL1) {
  const r = await measureArm(name, map, { useL1: true });
  console.log(`  ${name.padEnd(10)} hard recall@1 ${String(r.hard.r1).padStart(2)}/${r.hard.n} (${String(r.hard.pct).padStart(3)}%)   ${r.hard.ranks}`);
}
console.log('');
console.log(llmMap
  ? '（LLM 新生成富化存在：tests/fixtures/corpus/enriched-llm.json）'
  : '（未发现 tests/fixtures/corpus/enriched-llm.json ⇒ 跳过 LLM 对照臂；跑 scripts/enrich-llm-gen.mjs 生成）');
