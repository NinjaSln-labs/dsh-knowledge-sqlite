#!/usr/bin/env node
/**
 * 延迟门禁复验·串行口径（t000004 补充）：绕开 provider RPM 限流，测单条扩展的真实延迟分布。
 *
 * 为什么需要：4 路并发会撞免费 provider 的 RPM 限流（sensenova rpm exhausted /
 * agnes "rate limit for free users"）⇒ 并发口径下大量查询降级、p95 无有效样本。
 * 串行口径给出「单条扩展在无排队时的真实延迟」，是门禁可达性的上界参考。
 *
 * 用法：node scripts/latency-serial.mjs --provider sensenova --model sensenova-6.8-flash-lite \
 *        --api-key-env NKP_SENSENOVA --base-url https://token.sensenova.cn/v1 [--timeout-ms 5000] [--pause-ms 1200]
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
const TIMEOUT_MS = Number(flag('timeout-ms', '5000'));
const PAUSE_MS = Number(flag('pause-ms', '1200'));

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
ctx.provide('agents', {
  currentInitiator: () => ({ id: 'a', session: { id: 's', header: { cwd: '/ws/lat' } }, ctx: {} }),
});
ctx.provide('tools', { register: () => () => undefined });
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
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) });

const dir = mkdtempSync(join(tmpdir(), 'knl-lat-serial-'));
const fiber = ctx.plugin(knowledgeSqlite, {
  databasePath: join(dir, 'k.sqlite'), gating: 'none',
  queryExpansion: { enabled: true, timeoutMs: TIMEOUT_MS, cache: false },
});
await fiber.await()
const service = ctx.get('knowledge');
const stamps = { workspaceId: '/ws/lat', ownerId: 's', authorTier: 'explicit' };

const queries = JSON.parse(readFileSync(join(CORPUS, 'human-queries.json'), 'utf8'))
  .filter((q) => q.target && q.target !== 'none');

console.log(`════ 延迟·串行口径（t000004 补充）════`);
console.log(`provider/model: ${PROVIDER}/${MODEL}`);
console.log(`timeoutMs: ${TIMEOUT_MS}   请求间隔: ${PAUSE_MS}ms（绕 RPM 限流）`);
console.log('');

const rows = [];
for (const q of queries) {
  const t0 = Date.now()
  let degraded = false
  let reason = null
  let lat = null
  try {
    const r = await service._searchInternal(q.text, { table: 'items_fts_rich', expand: true }, stamps)
    degraded = r.degraded !== null
    reason = r.expansion?.reason ?? null
    lat = r.expansion?.latencyMs ?? null
  } catch (e) {
    degraded = true
    reason = `throw: ${e.message}`
  }
  const ms = Date.now() - t0
  rows.push({ id: q.id, ms, lat, degraded, reason })
  console.log(`  ${q.id}: ${String(ms).padStart(5)}ms  deg=${degraded ? 'Y' : 'N'}  ${reason ?? ''}`)
  if (PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS))
}

const live = rows.filter((r) => !r.degraded).map((r) => r.lat ?? r.ms).sort((a, b) => a - b)
const degraded = rows.filter((r) => r.degraded)
console.log('\n──────── 汇总 ────────')
console.log(`  成功 ${live.length}/${rows.length}，降级 ${degraded.length}`)
const kinds = {}
for (const d of degraded) {
  const k = (d.reason ?? 'unknown').split(':')[0].split(' ')[0]
  kinds[k] = (kinds[k] ?? 0) + 1
}
console.log(`  降级原因: ${JSON.stringify(kinds)}`)
if (live.length > 0) {
  const p95 = live[Math.min(live.length - 1, Math.floor(live.length * 0.95))]
  console.log(`  非降级延迟: min=${live[0]}ms  p50=${live[Math.floor(live.length / 2)]}ms  p95=${p95}ms  max=${live[live.length - 1]}ms  mean=${Math.round(live.reduce((a, b) => a + b, 0) / live.length)}ms`)
  console.log(`  门禁 p95 ≤ 2000ms: ${p95 <= 2000 ? 'PASS' : 'FAIL'}`)
}

await fiber.dispose();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
