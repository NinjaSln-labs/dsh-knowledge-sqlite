#!/usr/bin/env node
/**
 * 延迟门禁复验（t000004）：P95 ≤ 2.0s，human 集，4 路并发。
 *
 * 非 hermetic（真实 LLM 调用）⇒ **不进 verify 链 / CI**，人工触发。
 * 门禁口径按 DESIGN:246：p95 ≤ 2000ms，4 路并发，**排除降级查询**（降级不是完整 L1 检索）。
 *
 * 用法：
 *   node scripts/latency-gate.mjs --provider sensenova --model sensenova-6.8-flash-lite \
 *        --api-key-env NKP_SENSENOVA --base-url https://token.sensenova.cn/v1 [--timeout-ms 3000] [--rounds 3]
 *
 * 输出：每轮 fresh（实时扩展·清缓存）与 cached（缓存命中）两口径的 p95 / mean / max / 降级率 / 门禁判定。
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
const TIMEOUT_MS = Number(flag('timeout-ms', '3000'));
const ROUNDS = Number(flag('rounds', '3'));

const DSH_NM = process.env.DSH_NODE_MODULES
  ?? join(process.env.HOME ?? '', '.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules');
const require_ = createRequire(join(DSH_NM, '@deepseek-ai/dsh/package.json'));
const { Context } = require_('@deepseek-ai/cordis');
const piAi = require_('@deepseek-ai/dsh-llm-pi-ai');
const llmPkg = require_('@deepseek-ai/dsh-llm');
const settingsPkg = require_('@deepseek-ai/dsh-settings');
const { default: knowledgeSqlite } = await import(join(ROOT, 'lib', 'index.js'));

const ctx = new Context();
ctx.provide('timer', {
  timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
  interval: (cb, ms) => { const t = setInterval(cb, ms); return () => clearInterval(t); },
  throttle: () => () => undefined,
  debounce: () => () => undefined,
});
// probe 需要真实 caller：agents.currentInitiator() 须返回带 session.cwd 的 agent
ctx.provide('agents', {
  currentInitiator: () => ({ id: 'agent-latency', session: { id: 'sess-latency', header: { cwd: '/ws/latency' } }, ctx: {} }),
});
ctx.provide('tools', { register: () => () => undefined });
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
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) });

const dir = mkdtempSync(join(tmpdir(), 'knl-lat-gate-'));
const fiber = ctx.plugin(knowledgeSqlite, {
  databasePath: join(dir, 'k.sqlite'),
  gating: 'none',
  queryExpansion: { enabled: true, timeoutMs: TIMEOUT_MS, cache: true },
});
await fiber.await();
const service = ctx.get('knowledge');

console.log(`════ 延迟门禁复验（t000004）════`);
console.log(`provider/model: ${PROVIDER}/${MODEL}`);
console.log(`baseURL: ${BASE_URL}`);
console.log(`timeoutMs: ${TIMEOUT_MS}   rounds: ${ROUNDS}`);
console.log('');

const seed = await service.probe('seed');
const sp = seed.parts[0];
console.log(`seed: ok=${sp.ok}  memories=${sp.memories}  enriched=${sp.enriched}  distractors=${sp.distractors}`);
console.log('');

// fresh 口径：实时扩展（清缓存），每轮独立
console.log('── fresh 口径（实时扩展 · 清缓存）──');
const fresh = [];
for (let i = 1; i <= ROUNDS; i++) {
  const r = await service.probe('latency', { fresh: true });
  const p = r.parts[0];
  fresh.push(p);
  console.log(`  第${i}轮 p95=${p.p95LatencyMs}ms mean=${p.meanLatencyMs}ms max=${p.maxLatencyMs}ms total=${p.totalMs}ms 降级=${p.degraded ? p.degraded.split(',').length : 0}/17 gate=${p.gate}`);
  console.log(`       ${p.perQuery}`);
}

// cached 口径：缓存命中（不清缓存）
console.log('\n── cached 口径（缓存命中 · 不清缓存）──');
const cached = await service.probe('latency');
const cp = cached.parts[0];
console.log(`  p95=${cp.p95LatencyMs}ms mean=${cp.meanLatencyMs}ms max=${cp.maxLatencyMs}ms total=${cp.totalMs}ms 降级=${cp.degraded ? cp.degraded.split(',').length : 0}/17 gate=${cp.gate}`);
console.log(`  ${cp.perQuery}`);

console.log('\n════════ 门禁汇总（DESIGN:246 · p95 ≤ 2000ms · 排除降级）════════');
for (const [i, p] of fresh.entries()) {
  const pass = p.p95LatencyMs !== null && p.p95LatencyMs <= 2000;
  const deg = p.degraded ? p.degraded.split(',').length : 0;
  console.log(`  fresh 第${i + 1}轮: p95=${p.p95LatencyMs ?? 'null'}ms → ${pass ? 'PASS' : 'FAIL'}（降级 ${deg}/17）`);
}
const cpass = cp.p95LatencyMs !== null && cp.p95LatencyMs <= 2000;
console.log(`  cached     : p95=${cp.p95LatencyMs ?? 'null'}ms → ${cpass ? 'PASS' : 'FAIL'}`);
console.log(`\n注意：p95=null 表示该轮全部查询都降级 ⇒ 无有效样本，门禁不可判定（不是「通过」）。`);

await fiber.dispose();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
