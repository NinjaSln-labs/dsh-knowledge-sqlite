#!/usr/bin/env node
/**
 * 构建探测包装（build 链后半段）：tsc 之后按文件存在性执行可选项——
 *   scripts/build-client.mjs 存在 → 跑（client bundle；从 dsh-context-compass/scripts/build-client.mjs 复制适配）
 * 不存在 → 静默通过（纯 host 插件无需任何额外产物）。
 * package.json 的 "build" 固定调用本脚本：有 client 的库接入 build-client.mjs 后自动生效，
 * 不用改 build 命令；无 client 的库验证链不再死在缺失脚本上。
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const buildClient = join(ROOT, 'scripts', 'build-client.mjs');
if (existsSync(buildClient)) {
  const r = spawnSync('node', [buildClient], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    console.error(`✗ build-client 失败（exit ${r.status}）`);
    process.exit(1);
  }
}
