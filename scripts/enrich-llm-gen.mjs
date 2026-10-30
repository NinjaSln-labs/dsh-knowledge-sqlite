#!/usr/bin/env node
/**
 * LLM 生成富化（t000002 度量的对照输入）：为语料条目生成一份**新富化**，
 * 与 fixture 的基准富化（RESULTS-v3 离线产物）对照，度量富化质量。
 *
 * 非 hermetic（联网 + 真实 provider）⇒ **不进 verify 链 / CI**，人工触发。
 * 产物：tests/fixtures/corpus/enriched-llm.json（与 enriched.json 同构：
 * id / keywords[] / synonyms[] / questions[]）。
 *
 * 用法：
 *   node scripts/enrich-llm-gen.mjs [--provider sensenova] [--model sensenova-6.8-flash-lite]
 *   （provider/model 需在该 provider 的配置里声明；凭据经宿主 credentials 或环境变量解析）
 *
 * 生成的富化是 LLM 产物、有采样方差（每次运行结果不同）⇒ 产物入库后应记录生成批次
 * （脚本写入 _meta.generatedAt 与 _meta.provider/model）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus');
const OUT = join(CORPUS, 'enriched-llm.json');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROVIDER = flag('provider', 'sensenova');
const MODEL = flag('model', 'sensenova-6.8-flash-lite');
const API_KEY_ENV = flag('api-key-env', 'NKP_SENSENOVA');
const BASE_URL = flag('base-url', 'https://token.sensenova.cn/v1');

const PROMPT = '你是一个知识库的富化器。给定一条记忆原文，为它生成检索用的富化字段。\n'
  + '要求：\n'
  + '1. keywords：3-5 个关键词或短语，包含原文里出现的专有名词、命令、路径、技术名词。\n'
  + '2. synonyms：3-5 个同义/口语化/更具体的说法，用于同义改写检索。\n'
  + '3. questions：3-4 个"用户可能会怎么问这个问题"的问法（中文）。\n'
  + '只输出 JSON，格式：{"keywords":["..."],"synonyms":["..."],"questions":["..."]}，不要输出其他内容。';

// 复用宿主真实 llm 服务（与插件扩展走同一 seam ⇒ 同一鉴权/路由/超时语义）
const DSH_NM = process.env.DSH_NODE_MODULES
  ?? join(process.env.HOME ?? '', '.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules');
const { createRequire } = await import('node:module');
const require_ = createRequire(join(DSH_NM, '@deepseek-ai/dsh/package.json'));
const { Context } = require_('@deepseek-ai/cordis');
const piAi = require_('@deepseek-ai/dsh-llm-pi-ai');
const llmPkg = require_('@deepseek-ai/dsh-llm');
const settingsPkg = require_('@deepseek-ai/dsh-settings');

const ctx = new Context();
ctx.provide('timer', {
  timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
  interval: () => () => undefined,
  throttle: () => () => undefined,
  debounce: () => () => undefined,
});
await ctx.plugin(settingsPkg.default ?? settingsPkg, {}).await();
await ctx.plugin(llmPkg.default ?? llmPkg, {}).await();
await ctx.plugin(piAi.default ?? piAi, {
  providers: {
    [PROVIDER]: {
      apiKeyEnv: API_KEY_ENV,
      api: 'openai-completions',
      baseURL: BASE_URL,
      models: [{ id: MODEL, name: MODEL, contextWindow: 262144, maxTokens: 65536, input: ['text'] }],
    },
  },
}).await();
const llm = ctx.get('llm');

async function enrich(text) {
  let out = '';
  // 不带 reasoningEffort：无 reasoning 能力的模型带该参数会被宿主拒（UNSUPPORTED_REASONING_EFFORT）
  const stream = llm.stream({
    provider: PROVIDER,
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${PROMPT}\n\n记忆原文：${text}` }], source: { kind: 'plugin', plugin: 'dsh-knowledge-sqlite' }, id: 'knl-enrich-gen' }],
    maxTokens: 600,
    temperature: 0.3,
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
      throw new Error(`stream ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? '?'}`);
    }
  }
  const cleaned = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim().length > 0).slice(0, 6) : []);
  return { keywords: arr(parsed.keywords), synonyms: arr(parsed.synonyms), questions: arr(parsed.questions) };
}

const memories = JSON.parse(readFileSync(join(CORPUS, 'all-memories.json'), 'utf8'));
const results = [];
let failed = 0;

for (const m of memories) {
  let entry = null;
  for (let attempt = 1; attempt <= 3 && entry === null; attempt++) {
    try {
      const r = await enrich(m.text);
      if (r.keywords.length === 0 && r.synonyms.length === 0 && r.questions.length === 0) throw new Error('empty fields');
      entry = { id: m.id, ...r };
    } catch (e) {
      if (attempt === 3) {
        failed++;
        entry = { id: m.id, keywords: [], synonyms: [], questions: [], _error: e.message };
        console.error(`✗ ${m.id}: ${e.message}`);
      }
    }
  }
  if (entry !== null && entry._error === undefined) {
    console.log(`✓ ${m.id} kw=${entry.keywords.length} syn=${entry.synonyms.length} q=${entry.questions.length}`);
  }
  results.push(entry);
}

results.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, JSON.stringify({
  _meta: {
    generatedAt: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,
    note: 'LLM 生成富化（t000002 对照输入）；有采样方差，每次运行不同。',
  },
  items: results.map(({ id, keywords, synonyms, questions }) => ({ id, keywords, synonyms, questions })),
}, null, 2), 'utf8');

console.log(`\n写入 ${OUT}（${results.length} 条，失败 ${failed}）`);
if (failed > 0) console.warn('注意：有失败条目 —— 其富化为空，该条目在对照中等价于「未富化」。');
process.exit(failed > 0 ? 1 : 0);
