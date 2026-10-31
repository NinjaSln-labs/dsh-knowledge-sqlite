#!/usr/bin/env node
/**
 * human 集校准审计（t000005）：human 查询集的三项可复算偏差审计。
 *
 * hermetic：只用仓内 fixture，不联网 ⇒ 可复现，不进 CI verify 链。
 *
 * 三项审计：
 *   A. 查询性质：知识查询 vs 会话操作指令（判据：长度 < 12 字 或 命中操作词表）
 *   B. 标注目标分布：落在已富化知识条目（m*）还是未富化过程记录（n*）
 *   C. 词法重叠的来源分解：对标注目标（n*，由消息本身 LLM 提炼）vs 对语义对应的
 *      独立事实条目（m*，人工指定映射）——若两者差距巨大，则重叠是**构造产物**
 *      而非真实检索行为
 *   D. relabel 影响：把目标换成 m* 后各检索路径的 recall@1
 *
 * 用法：node scripts/human-set-audit.mjs
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hqAll = readJson(join(CORPUS, 'human-queries.json'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const enriched = new Set(readJson(join(CORPUS, 'enriched.json')).map((e) => e.id));
const expanded = new Map(readJson(join(CORPUS, 'expanded.json')).map((e) => [e.id, e]));
const distractors = readJson(join(CORPUS, 'distractors.json'));
const memText = new Map(memories.map((m) => [m.id, m.text]));

/**
 * 语义对应：每条 human 查询在 m1-m12 中语义最接近的**独立事实条目**（人工指定，
 * 依据「这条查询实际在问什么」，不是「它被标注成什么」）。
 * m1-m12 是 harness 运维事实，与 human 集的设计讨论主题不同——映射只用于
 * 测量「词法重叠是否为构造产物」，不代表 m* 是正确标注。
 */
const RELABEL = {
  h0: 'm2', h2: 'm2', h3: 'm2', h6: 'm6', h7: 'm6', h8: 'm2', h9: 'm2', h10: 'm2',
  h11: 'm2', h12: 'm6', h13: 'm11', h14: 'm12', h15: 'm12', h16: 'm12', h17: 'm12',
  h18: 'm5', h19: 'm5',
};

/** 操作指令判据（可复算，不靠主观打分） */
const OP_PATTERNS = [
  /^(继续|开始|切换|好了|刚才|研究好了|先做|是的|确认一下|如果是这样)/,
  /^(你制定|我想先|我想想想|我是不是可以|已经)/,
  /(切换成|新开|开始吧|继续 pro|预评审一下)/,
];
const isOperation = (text) => {
  const t = text.trim();
  if (t.length < 12) return true;
  return OP_PATTERNS.some((re) => re.test(t));
};

/** trigram 集合（与 src/search.ts queryGrams 同口径） */
function grams(s) {
  const t = String(s).trim();
  const out = new Set();
  if (t.length < 3) { if (t.length > 0) out.add(t); return out; }
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
function overlap(a, b) {
  const qg = grams(a); const tg = grams(b);
  const inter = [...qg].filter((g) => tg.has(g)).length;
  return {
    inter,
    contains: tg.size ? inter / tg.size : 0,
    dice: qg.size + tg.size ? (2 * inter) / (qg.size + tg.size) : 0,
  };
}

const targeted = hqAll.filter((q) => q.target && q.target !== 'none');
const noneQ = hqAll.filter((q) => q.target === 'none');

console.log('════════ human 集校准审计（t000005）════════');
console.log(`语料 ${memories.length} 条（知识条目 m1-m12 + 过程记录 n1-n10）+ 干扰项 ${distractors.length} 条`);
console.log(`查询 ${hqAll.length} 条：有目标 ${targeted.length}、none ${noneQ.length}`);

// ── A. 查询性质 ──
console.log('\n── A. 查询性质（判据：长度<12 字 或 命中操作词表）──');
for (const q of targeted) {
  console.log(`  ${q.id} ${isOperation(q.text) ? '[操作指令]' : '[知识查询]'} → ${q.target}  ${q.text.slice(0, 38)}`);
}
const ops = targeted.filter((q) => isOperation(q.text));
const knowledge = targeted.filter((q) => !isOperation(q.text));
console.log(`  ⇒ 操作指令 ${ops.length}/${targeted.length}（${Math.round((100 * ops.length) / targeted.length)}%）、知识查询 ${knowledge.length}/${targeted.length}（${Math.round((100 * knowledge.length) / targeted.length)}%）`);

// ── B. 目标分布 ──
console.log('\n── B. 标注目标分布（富化维度）──');
const onEnriched = targeted.filter((q) => enriched.has(q.target));
const onPlain = targeted.filter((q) => !enriched.has(q.target));
console.log(`  落在已富化知识条目（m1-m12）：${onEnriched.length}/${targeted.length}`);
console.log(`  落在未富化过程记录（n1-n10）：${onPlain.length}/${targeted.length}`);
const byTarget = {};
for (const q of targeted) byTarget[q.target] = (byTarget[q.target] ?? 0) + 1;
console.log(`  目标分布：${JSON.stringify(byTarget)}`);

// ── C. 词法重叠来源分解 ──
console.log('\n── C. 词法重叠的来源分解（目标覆盖率 = 共享 trigram / 目标 gram）──');
let sumA = 0; let sumB = 0; let higher = 0;
for (const q of targeted) {
  const alt = RELABEL[q.id];
  const a = overlap(q.text, memText.get(q.target) ?? '');
  const b = alt ? overlap(q.text, memText.get(alt) ?? '') : { contains: 0 };
  sumA += a.contains; sumB += b.contains;
  if (a.contains > b.contains) higher++;
  console.log(`  ${q.id}  标注目标 ${q.target}: ${String(Math.round(a.contains * 100)).padStart(3)}%   独立事实 ${alt ?? '-'}: ${String(Math.round(b.contains * 100)).padStart(3)}%`);
}
const n = targeted.length;
console.log(`  ⇒ (a) 标注目标（n*，由消息本身 LLM 提炼）平均：${Math.round((100 * sumA) / n)}%`);
console.log(`  ⇒ (b) 独立事实条目（m*，手写）平均：${Math.round((100 * sumB) / n)}%`);
console.log(`  ⇒ (a) > (b) 的查询数：${higher}/${n} ⇒ 重叠是**构造产物**（若为真实检索行为，两者应接近）`);

// ── D. relabel 影响 ──
console.log('\n── D. relabel 影响（522 条语料，各检索路径的 recall@1）──');
const STAMPS = { workspaceId: '/ws/measure', ownerId: 'measure', authorTier: 'explicit', sessionId: 'measure' };
const dir = mkdtempSync(join(tmpdir(), 'knl-human-audit-'));
const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
const dedupe = new Map();
for (const m of memories) {
  const r = await store.write({ content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'measure');
  dedupe.set(m.id, r.id);
}
for (let i = 0; i < distractors.length; i++) {
  await store.write({ content: String(distractors[i]).slice(0, 400), scope: 'workspace', dedupeKey: `d-${i}` }, STAMPS, [], 'measure');
}
for (const e of readJson(join(CORPUS, 'enriched.json'))) {
  const itemId = dedupe.get(e.id);
  if (itemId === undefined) continue;
  await store.enrich(itemId, { keywords: e.keywords ?? [], synonyms: e.synonyms ?? [], questions: e.questions ?? [] });
}

async function evalArm(targetOf, table, useL1) {
  let r1 = 0;
  for (const q of targeted) {
    const targetId = dedupe.get(targetOf(q));
    const texts = useL1 ? [q.text, ...(expanded.get(q.id)?.variants ?? [])] : [q.text];
    const { rows } = await store.search(table, texts, STAMPS, { scope: 'workspace', topN: 20 });
    if (rows.findIndex((r) => r.item.id === targetId) === 0) r1++;
  }
  return { r1, n: targeted.length, pct: Math.round((100 * r1) / targeted.length) };
}

console.log('  目标集      检索路径        recall@1');
console.log('  ' + '─'.repeat(42));
for (const [tLabel, targetOf] of [
  ['asIs（现状）', (q) => q.target],
  ['relabel（m*）', (q) => RELABEL[q.id] ?? q.target],
]) {
  for (const [pLabel, table, useL1] of [
    ['L0 纯词法', 'base', false],
    ['L0+富化', 'rich', false],
    ['L1 路径', 'rich', true],
  ]) {
    const r = await evalArm(targetOf, table, useL1);
    console.log(`  ${tLabel.padEnd(12)} ${pLabel.padEnd(13)} ${String(r.r1).padStart(2)}/${r.n} (${String(r.pct).padStart(3)}%)`);
  }
  console.log('');
}
store.close();
rmSync(dir, { recursive: true, force: true });
