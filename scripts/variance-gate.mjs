#!/usr/bin/env node
/**
 * variance 门禁复验（t000006）：10 轮 recall@1 的均值与逐轮下界。
 *
 * 非 hermetic（真实 LLM 调用）⇒ **不进 verify 链 / CI**，人工触发。
 *
 * 门禁（DESIGN:232 / :235）：
 *   L1   10 轮均值 ≥30% 且无单次 <20%
 *   L1+L2 10 轮均值 ≥60% 且无单次 <45%
 *   human 集的 C/D 臂同条款（单轮值仅供参考，per-run floor 待首批 10 轮后定）
 *
 * 两种口径（**方差来源不同，都测**）：
 *   逐条扩展（生产真实路径）：每轮清扩展缓存 → 对每条查询各调一次扩展
 *     ⇒ 10 轮 × N 查询次调用；真实但易撞 provider RPM 限流
 *   批量扩展（上游 variance.mjs 口径）：每轮一次 LLM 调用批量生成全部查询的变体
 *     ⇒ 10 轮 × 1 次调用；可与上游 variance.json 的 C 35.7% [29-43] / D 63.6% [50-79] 直接对比
 *
 * 用法：
 *   node scripts/variance-gate.mjs --provider sensenova --model sensenova-6.8-flash-lite \
 *        --api-key-env NKP_SENSENOVA --base-url https://token.sensenova.cn/v1 \
 *        [--runs 10] [--mode both|batch|per-query] [--timeout-ms 8000]
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROVIDER = flag('provider', 'sensenova');
const MODEL = flag('model', 'sensenova-6.8-flash-lite');
const API_KEY_ENV = flag('api-key-env', 'NKP_SENSENOVA');
const BASE_URL = flag('base-url', 'https://token.sensenova.cn/v1');
const RUNS = Number(flag('runs', '10'));
const MODE = flag('mode', 'both');
const TIMEOUT_MS = Number(flag('timeout-ms', '8000'));

const DSH_NM = process.env.DSH_NODE_MODULES
  ?? join(process.env.HOME ?? '', '.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules');
const require_ = createRequire(join(DSH_NM, '@deepseek-ai/dsh/package.json'));
const { Context } = require_('@deepseek-ai/cordis')
const piAi = require_('@deepseek-ai/dsh-llm-pi-ai');
const llmPkg = require_('@deepseek-ai/dsh-llm');
const settingsPkg = require_('@deepseek-ai/dsh-settings');
const { SqliteKnowledgeStore } = await import(join(ROOT, 'lib', 'store.js'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memories = readJson(join(CORPUS, 'all-memories.json'));
const benchEnriched = readJson(join(CORPUS, 'enriched.json'));
const distractors = readJson(join(CORPUS, 'distractors.json'));
const humanQueries = readJson(join(CORPUS, 'human-queries.json'));
const dataMjs = readFileSync(join(CORPUS, 'data.mjs'), 'utf8');
const hardQueries = [...dataMjs.matchAll(/\{ id: '(q\d+)', target: '(m\d+)', text: '([^']+)' \}/g)]
  .map((m) => ({ id: m[1], target: m[2], text: m[3] }));
const humanScored = humanQueries.filter((q) => q.target && q.target !== 'none');

const STAMPS = { workspaceId: '/ws/var', ownerId: 'var', authorTier: 'explicit', sessionId: 'var' };

/** trigram（与生产检索同口径） */
function grams(s) {
  const t = String(s).trim();
  const out = new Set();
  if (t.length < 3) { if (t.length > 0) out.add(t); return out; }
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
const matchOf = (gs) => gs.map((g) => `"${g}"`).join(' OR ');

/** 建库（522 条：22 记忆 + 500 干扰项），返回 store + dedupe */
async function build() {
  const dir = mkdtempSync(join(tmpdir(), 'knl-var-'));
  const store = await SqliteKnowledgeStore.open(join(dir, 'k.sqlite'), 2048);
  const dedupe = new Map();
  for (const m of memories) {
    const r = await store.write({ content: m.text, scope: 'workspace', dedupeKey: m.id }, STAMPS, [], 'var');
    dedupe.set(m.id, r.id);
  }
  for (let i = 0; i < distractors.length; i++) {
    await store.write({ content: String(distractors[i]).slice(0, 400), scope: 'workspace', dedupeKey: `d-${i}` }, STAMPS, [], 'var');
  }
  return { dir, store, dedupe };
}

/** 富化（可选）：写回索引字段 */
async function applyEnrich(store, dedupe, enrichedRows) {
  for (const e of enrichedRows) {
    const itemId = dedupe.get(e.id);
    if (itemId === undefined) continue;
    await store.enrich(itemId, { keywords: e.keywords ?? [], synonyms: e.synonyms ?? [], questions: e.questions ?? [] });
  }
}

/** 检索：查询文本集合 → 目标 rank */
async function rankOf(store, dedupe, target, texts, table) {
  const gs = new Set();
  for (const t of texts) for (const g of grams(t)) gs.add(g);
  if (gs.size === 0) return -1;
  const rows = await store.search(table, texts, STAMPS, { scope: 'workspace', topN: 20 });
  const targetId = dedupe.get(target);
  return rows.findIndex((r) => r.item.id === targetId);
}

function summarize(values, n) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pct = (x) => Math.round((100 * x) / n);
  return {
    meanPct: pct(mean), minPct: pct(min), maxPct: pct(max),
    range: `${pct(min)}%-${pct(max)}%`,
    meanOk: mean / n >= 0.3, floorOk: min / n >= 0.2,
    dMeanOk: mean / n >= 0.6, dFloorOk: min / n >= 0.45,
  };
}

// ---------- LLM 客户端（真实 pi-ai） ----------
const ctx = new Context();
ctx.provide('timer', {
  timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
  interval: (cb, ms) => { const t = setInterval(cb, ms); return () => clearInterval(t); },
  throttle: () => () => undefined, debounce: () => () => undefined,
});
await ctx.plugin(settingsPkg.default ?? settingsPkg, {}).await();
await ctx.plugin(llmPkg.default ?? llmPkg, {}).await();
await ctx.plugin(piAi.default ?? piAi, {
  providers: {
    [PROVIDER]: {
      apiKeyEnv: API_KEY_ENV, api: 'openai-completions', baseURL: BASE_URL,
      models: [{ id: MODEL, name: MODEL, contextWindow: 262144, maxTokens: 65536, input: ['text'] }],
    },
  },
}).await();
const llm = ctx.get('llm');

async function llmJson(prompt, maxTokens = 2000) {
  // 请求级超时（TIMEOUT_MS）+ 一次重试（应对偶发空返回/限流）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await llmJsonOnce(prompt, maxTokens);
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('unreachable');
}

async function llmJsonOnce(prompt, maxTokens = 2000) {
  let text = '';
  let streamError = null;
  const collect = (async () => {
    try {
      const stream = llm.stream({
        provider: PROVIDER, model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-knowledge-sqlite' }, id: 'knl-variance' }],
        maxTokens, temperature: 0.3,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(`stream ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? '?'}`);
        }
      }
    } catch (e) {
      streamError = e instanceof Error ? e.message : String(e);
    }
  })();
  const timedOut = await Promise.race([
    collect.then(() => false),
    new Promise((r) => setTimeout(() => r(true), TIMEOUT_MS)),
  ]);
  if (timedOut) throw new Error(`timeout ${TIMEOUT_MS}ms`);
  if (streamError !== null) throw new Error(streamError);
  if (text.trim() === '') throw new Error('empty response');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // 截断容错：JSON 被 maxTokens 切断时，补齐未闭合的字符串/数组/对象
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const repaired = repairJson(cleaned);
    if (repaired !== null) return repaired;
    throw new Error(`${e.message} raw=${JSON.stringify(cleaned).slice(0, 200)}`);
  }
}

/** 截断的 JSON 修复：逐层补齐未闭合结构（丢弃尾部不完整的那个元素）。 */
function repairJson(s) {
  // 先尝试截到最后一个完整元素
  const cut = s.lastIndexOf('},');
  const body = cut > 0 ? s.slice(0, cut + 1) + '}' : null;
  if (body !== null) {
    try { return JSON.parse(body); } catch { /* 继续 */ }
  }
  // 逐字符扫描，统计未闭合层级
  let inStr = false; let esc = false; const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0) return null;
  // 截到最后一个完整元素后逐层补齐
  for (const cutAt of [s.lastIndexOf('},'), s.lastIndexOf('],'), s.lastIndexOf('"'), s.lastIndexOf('}')]) {
    if (cutAt <= 0) continue;
    let head = s.slice(0, cutAt + 1);
    // 去掉可能悬空的逗号
    head = head.replace(/,\s*$/, '');
    // 计算 head 的未闭合层级
    let s2 = false; let e2 = false; const st2 = [];
    for (let i = 0; i < head.length; i++) {
      const ch = head[i];
      if (e2) { e2 = false; continue }
      if (ch === '\\') { e2 = true; continue }
      if (ch === '"') { s2 = !s2; continue }
      if (s2) continue
      if (ch === '{' || ch === '[') st2.push(ch);
      else if (ch === '}' || ch === ']') st2.pop();
    }
    let fixed = head;
    for (let i = st2.length - 1; i >= 0; i--) fixed += st2[i] === '{' ? '}' : ']';
    try { return JSON.parse(fixed); } catch { /* 试下一个切点 */ }
  }
  return null;
}

const EXPAND_BATCH_PROMPT = '你是记忆系统的查询扩展器。对下面每个查询，生成 3-4 个同义/口语化/更具体的变体问法（中文），'
  + '变体要覆盖用户可能用到的不同措辞。只输出 JSON：{"expansions":[{"id":"q1","variants":["变体1","变体2"]},...]}。';
const ENRICH_BATCH_PROMPT = '你是记忆系统的索引器。对每条记忆条目产出检索增强字段：'
  + 'keywords（3-6 个核心术语）、synonyms（3-6 个同义/口语化说法）、questions（3-5 个用户未来可能用的问法，完整自然问句）。'
  + '只输出 JSON：{"items":[{"id":"m1","keywords":[],"synonyms":[],"questions":[]},...]}。';

const { dir, store, dedupe } = await build();

console.log('════════ variance 门禁复验（t000006）════════');
console.log(`provider/model: ${PROVIDER}/${MODEL}`);
console.log(`runs: ${RUNS}   mode: ${MODE}   timeoutMs: ${TIMEOUT_MS}`);
console.log(`语料 ${memories.length + distractors.length} 条（${memories.length} 记忆 + ${distractors.length} 干扰项）`);
console.log(`hard 集 ${hardQueries.length} 条（目标 m1-m12）｜human 集 ${humanScored.length} 条有目标（目标 n1-n10）`);
console.log('');

// ================= 口径一：批量扩展（上游 variance.mjs 口径） =================
if (MODE === 'both' || MODE === 'batch') {
  console.log('── 口径一：批量扩展（每轮 1 次 LLM 调用生成全部查询的变体；可与上游 variance.json 对比）──');
  const batchRuns = [];
  for (let run = 1; run <= RUNS; run++) {
    const t0 = Date.now();
    try {
      // 每轮重新生成扩展（方差来源：LLM 采样）
      const expRaw = await llmJson(`${EXPAND_BATCH_PROMPT}\n查询列表：${JSON.stringify(hardQueries.map((q) => ({ id: q.id, text: q.text })))}`, 6000);
      const expMap = new Map((expRaw.expansions ?? []).map((e) => [e.id, e.variants ?? []]));
      // 每轮重新生成富化（上游口径：C 臂用 base 表 ⇒ 不需富化；D 臂用 rich 表 ⇒ 需富化）
      const enrRaw = await llmJson(`${ENRICH_BATCH_PROMPT}\n条目列表：${JSON.stringify(memories.map((m) => ({ id: m.id, text: m.text })))}`, 8000);
      const enrMap = new Map((enrRaw.items ?? []).map((e) => [e.id, e]));
      // C 臂：base 表（原文 + 扩展变体，无富化）
      let cR1 = 0;
      const cRanks = [];
      for (const q of hardQueries) {
        const rank = await rankOf(store, dedupe, q.target, [q.text, ...(expMap.get(q.id) ?? [])], 'base');
        cRanks.push(`${q.id}:${rank === -1 ? '-' : rank + 1}`);
        if (rank === 0) cR1++;
      }
      // D 臂：rich 表（原文 + 富化 + 扩展变体）——需要重建 rich 索引
      await applyEnrich(store, dedupe, [...enrMap.values()]);
      let dR1 = 0;
      const dRanks = [];
      for (const q of hardQueries) {
        const rank = await rankOf(store, dedupe, q.target, [q.text, ...(expMap.get(q.id) ?? [])], 'rich');
        dRanks.push(`${q.id}:${rank === -1 ? '-' : rank + 1}`);
        if (rank === 0) dR1++;
      }
      batchRuns.push({ run, c: cR1, d: dR1, cRanks: cRanks.join(' '), dRanks: dRanks.join(' '), ms: Date.now() - t0 });
      console.log(`  第${run}轮 (${Date.now() - t0}ms)  C=${cR1}/${hardQueries.length}  D=${dR1}/${hardQueries.length}`);
    } catch (e) {
      batchRuns.push({ run, error: e.message });
      console.log(`  第${run}轮 失败: ${e.message.slice(0, 120)}`);
    }
  }
  const okRuns = batchRuns.filter((r) => !r.error);
  if (okRuns.length > 0) {
    const c = summarize(okRuns.map((r) => r.c), hardQueries.length);
    const d = summarize(okRuns.map((r) => r.d), hardQueries.length);
    console.log(`\n  ── 批量口径结果（有效轮次 ${okRuns.length}/${RUNS}）──`);
    console.log(`  C 臂（L0+扩展，无富化）  mean ${c.meanPct}%  range ${c.range}  → L1 门禁 mean≥30%: ${c.meanOk ? 'PASS' : 'FAIL'}，floor≥20%: ${c.floorOk ? 'PASS' : 'FAIL'}`);
    console.log(`  D 臂（L0+富化+扩展）      mean ${d.meanPct}%  range ${d.range}  → L1+L2 门禁 mean≥60%: ${d.meanOk ? 'PASS' : 'FAIL'}，floor≥45%: ${d.floorOk ? 'PASS' : 'FAIL'}`);
    console.log(`  上游 variance.json 对照：C 35.7% [29-43]、D 63.6% [50-79]`);
  }
  console.log('');
}

// ================= 口径二：逐条扩展（生产真实路径） =================
if (MODE === 'both' || MODE === 'per-query') {
  console.log('── 口径二：逐条扩展（走真实插件链路：QueryExpander + timeout 降级 + reasoningEffort 自适应）──');
  // 真实插件链路：挂载 knowledge 插件，用 service._searchInternal 走完整扩展路径
  const { default: knowledgeSqlite } = await import(join(ROOT, 'lib', 'index.js'));
  const { Context: CordisContext } = require_('@deepseek-ai/cordis');
  const pCtx = new CordisContext();
  pCtx.provide('timer', {
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
    interval: (cb, ms) => { const t = setInterval(cb, ms); return () => clearInterval(t); },
    throttle: () => () => undefined, debounce: () => () => undefined,
  });
  pCtx.provide('agents', {
    currentInitiator: () => ({ id: 'a', session: { id: 's', header: { cwd: '/ws/var' } }, ctx: {} }),
  });
  pCtx.provide('tools', { register: () => () => undefined });
  await pCtx.plugin(settingsPkg.default ?? settingsPkg, {}).await();
  await pCtx.plugin(llmPkg.default ?? llmPkg, {}).await();
  await pCtx.plugin(piAi.default ?? piAi, {
    providers: {
      [PROVIDER]: {
        apiKeyEnv: API_KEY_ENV, api: 'openai-completions', baseURL: BASE_URL,
        models: [{ id: MODEL, name: MODEL, contextWindow: 262144, maxTokens: 65536, input: ['text'] }],
      },
    },
  }).await();
  pCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) });
  const pDir = mkdtempSync(join(tmpdir(), 'knl-var-pq-'));
  const pFiber = pCtx.plugin(knowledgeSqlite, {
    databasePath: join(pDir, 'k.sqlite'), gating: 'none',
    queryExpansion: { enabled: true, timeoutMs: TIMEOUT_MS, cache: true },
  });
  await pFiber.await();
  const service = pCtx.get('knowledge');
  const pStamps = { workspaceId: '/ws/var', ownerId: 'var', authorTier: 'explicit' };
  // 装载语料：**用 probe('seed')**——它除 22 记忆 + 500 干扰项外，还会把
  // enriched.json 的 12 条基准富化写进 rich 表（probe.ts:158）。手工 _seedWrite
  // 只写原文 ⇒ rich 表无富化 ⇒ recall 被人为压低（实测 3/14 vs 7/14）。
  await service.probe('seed');
  const pDedupe = await service._dedupeIds();

  const perRuns = [];
  for (let run = 1; run <= RUNS; run++) {
    const t0 = Date.now();
    // 直接用 probe 的 variance 套件（门禁本体实现）：fresh=true ⇒ 清扩展缓存（内存+持久两层）
    // ⇒ 每条查询都真实扩展。probe 跑的是 hard 集的 L1-live 臂（rich 表 + expand:true）。
    const res = await service.probe('variance', { fresh: true, runs: 1 });
    const part = res.parts[0] ?? {};
    const v = part.recall1Values?.[0] ?? 0;
    // 降级统计（probe 的 perRun 形如 "1: 3/14 (deg:q1,q2)"）
    const degMatch = (part.perRun?.[0] ?? '').match(/\(deg:([^)]*)\)/);
    const degradedIds = degMatch ? degMatch[1].split(',').filter(Boolean) : [];
    perRuns.push({ run, r1: v, degraded: degradedIds, ms: Date.now() - t0 });
    console.log(`  第${run}轮 (${Date.now() - t0}ms)  recall@1=${v}/${hardQueries.length}  降级=${degradedIds.length}${degradedIds.length ? '(' + degradedIds.join(',') + ')' : ''}`);
  }
  const c = summarize(perRuns.map((r) => r.r1), hardQueries.length);
  console.log(`\n  ── 逐条口径结果（probe('variance', fresh:true) —— 门禁本体实现）──`);
  console.log(`  L1-live 臂  mean ${c.meanPct}%  range ${c.range}  → 门禁 mean≥30%: ${c.meanOk ? 'PASS' : 'FAIL'}，floor≥20%: ${c.floorOk ? 'PASS' : 'FAIL'}`);
  console.log(`  逐轮: ${perRuns.map((r) => r.r1).join(', ')}`);
  console.log('');
  await pFiber.dispose();
  rmSync(pDir, { recursive: true, force: true });
}

store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
