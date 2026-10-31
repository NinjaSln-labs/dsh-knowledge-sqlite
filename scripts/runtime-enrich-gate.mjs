#!/usr/bin/env node
/**
 * 运行时富化臂的质量门禁度量（t000024 判据）。
 *
 * 判据（t000024）：**知识条目侧查询集**上，运行时富化臂 recall@1 ≥ 基准富化臂，
 * 否则不实现运行时富化管线。
 *
 * 为什么必须多批次：EXP §11.5 实测 LLM 富化在 hard 集上是 21%–64% 波动
 * （单次生成不能判定质量）⇒ 单次跑赢基准不构成证据，须看**下界**。
 *
 * 三个度量：
 *   1. **质量对比**（知识条目侧查询集 knowledge-queries.json）：无富化 / 基准富化 /
 *      LLM 生成富化 三臂 recall@1 —— 判据主口径
 *   2. **产出质量校验**（门禁要校验的两个维度）：抽象度 / 词法分散度
 *      —— 基准富化用抽象概念（「忽略文件」），LLM 富化倾向具体实体（「node_modules目录」），
 *      而 hard/knowledge 集是零词法重叠的抽象改写查询 ⇒ 具体实体富化无用
 *   3. **批次下界**：多批次 LLM 富化下的 recall@1 最小值 vs 基准臂
 *
 * hermetic 部分：只读仓内 fixture（enriched.json / enriched-llm.json / knowledge-queries.json）
 * ⇒ 可进 CI。LLM 再生成（多批次）需另跑 scripts/enrich-llm-gen.mjs（联网、人工触发）。
 *
 * 用法：node scripts/runtime-enrich-gate.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));
const { queryGrams } = await import(join(ROOT, 'lib', 'search.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const benchArr = readJson(join(CORPUS, 'enriched.json'));
const kQueries = readJson(join(CORPUS, 'knowledge-queries.json'));
const distractors = readJson(join(CORPUS, 'distractors.json'));

const byId = (a) => new Map(a.map((e) => [e.id, e]));
const benchMap = byId(benchArr);

/**
 * LLM 富化批次集合：llm-batches/*.json（每个文件一个批次）。
 * §11.5 实测 LLM 富化有采样方差（hard 集 21%–64%）⇒ 单批次不能判定质量，
 * 必须多批次看**下界**。
 *
 * 仓内 `enriched-llm.json` 是「最近一批」的副本（供 t000002 的对照脚本用），
 * 与归档目录可能重复 ⇒ 批次集合**只取归档目录**，避免同一批被算两次。
 */
function loadLlmBatches() {
  const batches = [];
  const archiveDir = join(CORPUS, 'llm-batches');
  if (!existsSync(archiveDir)) return batches;
  for (const f of readdirSync(archiveDir).filter((x) => x.endsWith('.json')).sort()) {
    const raw = readJson(join(archiveDir, f));
    const items = Array.isArray(raw) ? raw : raw.items ?? [];
    batches.push({ label: f.replace(/\.json$/, ''), map: byId(items) });
  }
  return batches;
}

const llmBatches = loadLlmBatches();
const llmMap = llmBatches.length > 0 ? llmBatches[0].map : null;

const STAMPS = { workspaceId: '/ws/gate', ownerId: 'gate', authorTier: 'explicit', sessionId: 'gate' };

// ---------- 产出质量校验的两个维度（门禁要判的东西） ----------

/**
 * 抽象度：富化字段中「不含原文具体实体」的比例。
 *
 * 判据依据（EXP §11.5）：基准富化的 synonyms 是抽象概念（「忽略文件」「不要提交」
 * 「知识检索」「词法打分」）；LLM 富化倾向具体实体（「node_modules目录」「.dsh目录」
 * 「SQLite 全文索引」）。查询集是**零词法重叠的抽象改写**查询 ⇒ 抽象富化才命中。
 *
 * 算法：实体 = 原文里出现、且是路径/命令/标识符/专有名词的 token；
 * 一个富化短语若**不含**任何实体 token ⇒ 抽象（抽象度分母计）。
 */
function entityTokens(text) {
  const out = new Set();
  // 路径 / 命令 / 标识符（含点、下划线、斜杠、大小写混杂）
  for (const m of String(text).matchAll(/[A-Za-z0-9_./-]*[A-Z][A-Za-z0-9_./-]*|[A-Za-z0-9_./-]*\.[a-z]{2,}|\/[A-Za-z0-9_./-]+|[a-z0-9]+-[a-z0-9-]+/g)) {
    if (m[0].length >= 3) out.add(m[0].toLowerCase());
  }
  return out;
}

/** 抽象度：0–1，越高越抽象（不含原文实体）。 */
function abstractness(sourceText, phrases) {
  if (phrases.length === 0) return 1;
  const ents = entityTokens(sourceText);
  const abstract = phrases.filter((p) => {
    const toks = String(p).toLowerCase();
    for (const e of ents) if (toks.includes(e)) return false;
    return true;
  });
  return abstract.length / phrases.length;
}

/**
 * 词法分散度：富化字段与其余文档的 trigram 重叠度越低越好
 * （分散度高 ⇒ 富化文本不与干扰项撞词 ⇒ 不抢走 rank-1，EXP §12.4 的负增益来源）。
 */
function lexicalSpread(allDocTexts, ownText, phrases) {
  const own = new Set(queryGrams([ownText, ...phrases].join(' ')));
  const ownCount = own.size;
  if (ownCount === 0) return 0;
  let maxOverlap = 0;
  for (const other of allDocTexts) {
    if (other === ownText) continue;
    const g = new Set(queryGrams(other));
    let hit = 0;
    for (const x of own) if (g.has(x)) hit++;
    const ov = hit / ownCount;
    if (ov > maxOverlap) maxOverlap = ov;
  }
  return 1 - maxOverlap;
}

// ---------- 检索臂评测 ----------

async function evalArm(name, enrichmentMap, { scale = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'knl-regate-'));
  const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
  const dedupe = new Map();
  for (const m of memories) {
    const r = await store.write({ content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'gate');
    dedupe.set(m.id, r.id);
  }
  for (let i = 0; i < Math.min(scale, distractors.length); i++) {
    await store.write({ content: String(distractors[i]).slice(0, 400), scope: 'workspace', dedupeKey: `d-${i}` }, STAMPS, [], 'gate');
  }
  let enrichedCount = 0;
  for (const [id, f] of enrichmentMap) {
    if (!f?.keywords?.length && !f?.synonyms?.length && !f?.questions?.length) continue;
    const itemId = dedupe.get(id);
    if (itemId === undefined) continue;
    await store.enrich(itemId, { keywords: f.keywords ?? [], synonyms: f.synonyms ?? [], questions: f.questions ?? [] });
    enrichedCount++;
  }
  const scored = kQueries.filter((q) => q.target && q.target !== 'none');
  let r1 = 0;
  const ranks = [];
  for (const q of scored) {
    const { rows } = await store.search('rich', [q.text], STAMPS, { scope: 'workspace', topN: 20, maxQueryTrigrams: 24 });
    const idx = rows.findIndex((r) => r.item.id === dedupe.get(q.target));
    ranks.push(`${q.id}:${idx === -1 ? '-' : idx + 1}`);
    if (idx === 0) r1++;
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return { name, enrichedCount, r1, n: scored.length, pct: Math.round((100 * r1) / scored.length), ranks: ranks.join(' ') };
}

// ================= 输出 =================
console.log('════════ 运行时富化臂质量门禁（t000024 判据）════════');
console.log(`判据：知识条目侧查询集上，运行时富化臂 recall@1 ≥ 基准富化臂 ⇒ 否则不实现管线`);
console.log(`查询集：knowledge-queries.json（${kQueries.length} 条，${kQueries.filter((q) => q.target !== 'none').length} 有目标）`);
console.log('');

for (const scale of [0, 500]) {
  const label = scale === 0 ? '22 条（无干扰项）' : `${memories.length + Math.min(scale, distractors.length)} 条（含干扰项）`;
  console.log(`── 语料 ${label} ──`);

  const base = await evalArm('基准富化', benchMap, { scale });
  console.log(`  ${'基准富化'.padEnd(12)} 富化 ${String(base.enrichedCount).padStart(2)}/${memories.length}  recall@1 ${String(base.r1).padStart(2)}/${base.n} (${String(base.pct).padStart(3)}%)`);

  // 无富化基线（判定富化是否真的有用）
  const none = await evalArm('无富化', new Map(), { scale });
  console.log(`  ${'无富化'.padEnd(12)} 富化  0/${memories.length}  recall@1 ${String(none.r1).padStart(2)}/${none.n} (${String(none.pct).padStart(3)}%)`);

  // LLM 批次：每批次一个臂
  const batchResults = [];
  for (const b of llmBatches) {
    const r = await evalArm(`LLM ${b.label}`, b.map, { scale });
    batchResults.push({ label: b.label, r1: r.r1, n: r.n, pct: r.pct });
    console.log(`  ${(`LLM ${b.label}`).padEnd(12)} 富化 ${String(r.enrichedCount).padStart(2)}/${memories.length}  recall@1 ${String(r.r1).padStart(2)}/${r.n} (${String(r.pct).padStart(3)}%)`);
  }

  if (batchResults.length === 0) {
    console.log('  判据：无法判定（缺 LLM 生成富化 ⇒ 跑 scripts/enrich-llm-gen.mjs 生成）');
  } else {
    const worst = Math.min(...batchResults.map((b) => b.r1));
    const best = Math.max(...batchResults.map((b) => b.r1));
    // 判据用**下界**：单批次跑赢不构成证据（§11.5 波动 21%–64%）
    const okWorst = worst >= base.r1;
    console.log(`  判据：LLM 各批次 ${batchResults.map((b) => b.r1).join('/')} vs 基准 ${base.r1} ⇒ 下界 ${worst} ${okWorst ? '≥' : '<'} 基准 ⇒ **${okWorst ? 'PASS' : 'FAIL'}**`);
    console.log(`  （批次区间 ${worst}–${best}；判据取下界——单批次跑赢不构成证据，EXP §11.5 实测波动 21%–64%）`);
  }
  console.log('');
}

// ---------- 产出质量校验（抽象度 / 词法分散度） ----------

console.log('── 产出质量校验（基准富化 vs LLM 生成富化）──');
const memText = new Map(memories.map((m) => [m.id, m.text]));
const allTexts = memories.map((m) => m.text);

function qualityReport(label, map) {
  if (map === null) return;
  let absSum = 0;
  let spreadSum = 0;
  let n = 0;
  const rows = [];
  for (const [id, f] of map) {
    const src = memText.get(id);
    if (src === undefined) continue;
    const phrases = [...(f.keywords ?? []), ...(f.synonyms ?? []), ...(f.questions ?? [])];
    if (phrases.length === 0) continue;
    const a = abstractness(src, phrases);
    const s = lexicalSpread(allTexts, src, phrases);
    absSum += a; spreadSum += s; n++;
    rows.push({ id, a: Math.round(a * 100), s: Math.round(s * 100) });
  }
  if (n === 0) return;
  console.log(`  ${label.padEnd(12)} 抽象度均值 ${Math.round((100 * absSum) / n)}%  词法分散度均值 ${Math.round((100 * spreadSum) / n)}%  （${n} 条）`);
  console.log(`               逐条（id:抽象度%/分散度%）: ${rows.map((r) => `${r.id}:${r.a}/${r.s}`).join(' ')}`);
}
qualityReport('基准富化', benchMap);
qualityReport('LLM生成富化', llmMap);

console.log('');
console.log('抽象度口径：富化短语不含原文具体实体（路径/命令/标识符）的比例——抽象查询只匹配抽象富化（EXP §11.5）');
console.log('分散度口径：1 − 与其他文档的最大 trigram 重叠——重叠高则富化文本撞干扰项词、抢走 rank-1（EXP §12.4 的负增益来源）');
