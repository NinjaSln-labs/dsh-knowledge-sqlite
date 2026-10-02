# 发布记录：dsh-knowledge-sqlite

> 本文件由模板单源拼装（core + 分类 append）：发布通道/发布流程/应急发布由分类 append 决定；
> 共性纪律在 core。

## 发布状态（2026-10-02 更新）

| 项 | 状态 |
|---|---|
| npm | **0.1.10 latest**（`knowledge-sqlite-v0.1.10` tag，0.1.9 → 0.1.10） |
| GitHub | `NinjaSln-labs/dsh-knowledge-sqlite` main；发版 tag `knowledge-sqlite-v*` |
| profile | `web` 已装 `dsh-knowledge-sqlite@0.1.10`（registry `^0.1.10`，非 `file:`）；宿主 dsh `0.2.0-rc.2` 下 cordis boot + `probe seed` 实测通过 |
| 本地验证 | 40/40 vitest 全绿 + smoke 基线复现（A 7%/C 21%/D 50%/human-A 65%）+ check:deploy FAIL 0 |

## 版本历史

> 每版一行：**做了什么 + 为什么 + 怎么验证的**；重大教训展开写进当版条目。

- **0.1.10** — 宿主升级对齐 dsh `0.2.0-rc.2`（deps 全量 `^0.2.0-rc.2` + schemastery `~3.18.4`；
  新增 devDeps `dsh-sandbox`/`dsh-sandbox-policy`——dsh-tools 直接 import，缺失即断）；
  live L1 降级补结构化 reason 诊断（`expansion.reason` + `stats.degradeReasons`）；
  `QueryExpansionConfig.provider` 死配置接通（扩展专用 provider pinning 生效）；
  `knowledge_probe` 默认 corpusPath 指向包内 fixture（部署态套件不再 ENOENT）。
  验证：40/40 vitest + smoke 基线不变 + check:deploy FAIL 0
- **0.1.9** — 宿主升级对齐 `0.1.5-rc.1`（test-vs-runtime skew：devDeps 停在 alpha.5，测试跑在旧宿主 API 上）；验证：38/38 + smoke 基线不变 + check:deploy FAIL 0
- **0.1.7** — 单库化后首个发布（monorepo → 独立仓库）：scaffold adopt `dsh-plugin` 模板、`dsh-scope` 等三包从 deps 移入 devDeps 防 profile 双套；验证：38/38 + smoke + check:deploy + contract 12/12
- **0.1.6** — 扩展请求显式关闭思维链（`reasoningEffort: 'off'` → pi-ai `thinking: {type:'disabled'}`）；
  根因：扩展跟随会话默认路由，主模型若为 reasoning 模型则 thinking 预热致 TTFT 3.4s / 总耗时 11.3s，
  timeout 3000 下 100% 降级；部署配套 profile patch `queryExpansion.model: 'deepseek-v4-flash'`
- **0.1.5** — L1 扩展持久缓存（SQLite `expansion_cache` 表替代进程 Map）；首次 live 扩展落库实测
- **0.1.4** — FTS5 trigram 检索 + L1 查询扩展；RESULTS-v3 实验基线
- **0.1.3** — 语料 hermetic 入库（fixture/corpus/）；路径漂移回归测试
- **0.1.2** — strict JSON 校验：-0/NaN 归一化、undefined 字段 omit；契约检查 11/11
- **0.1.1** — ask 门控 + global allowlist + workspace 隔离；probe contract 套件
- **0.1.0** — V1.11 契约初始实现

## 发布后验证（共性纪律）

- 确认 latest 已更新（包管理器或 GitHub Release 页）
- provenance/attestations 徽章（按通道）或等价完整性校验
- 实机重装/升级路径实测一遍（面向用户的安装命令照 README 走一遍）

> 通道专属验证命令由分类 append 覆盖（按实际通道选择对应命令）。

## 发布通道（npm OIDC Trusted Publishing）

**认证**：npm **Trusted Publishing（OIDC）**——无需 token，`.github/workflows/publish.yml` 的
`id-token: write` 自动鉴权 + provenance 签名（源仓库 public）。

## 日常发布流程

> 用显式两步而非 `npm version` 自动 commit+tag：npm version 默认打 `v%s` tag，与本库触发器
> `knowledge-sqlite-v*` 不符；且工作树脏时 npm 的自动 commit/tag 会被**静默跳过**（实践库实战）。

```sh
npm version patch --no-git-tag-version               # ① bump 版本（package.json + lockfile）
V="$(node -p "require('./package.json').version")"
git commit -am "chore: release dsh-knowledge-sqlite v$V — <一句话主旨>"
git tag knowledge-sqlite-v$V
git push && git push --tags                          # ② CI 接手：验证链 → 版本守卫 →（审批门）→ npm publish
```

## canary 灰度通道（先灰度再全量）

```sh
npm version prerelease --preid=next --no-git-tag-version
V="$(node -p "require('./package.json').version")"
git commit -am "chore: canary dsh-knowledge-sqlite v$V" && git tag knowledge-sqlite-v$V
git push && git push --tags
# 实测通过 → 晋级 latest：npm dist-tag add dsh-knowledge-sqlite@x.y.z latest
```

## 首次发布前置（一次性）

1. **Trusted Publisher 配置**：npmjs.com 包设置 → Trusted Publisher（owner / repo / `publish.yml`
   文件名逐字段一致；npm 不预校验，配错只在 publish 时报错；首次可能未保存成功——失败先重配一次）
2. **首次 bootstrap**：首版可手动 `npm publish`（本机 `npm login` 交互登录 + 2FA；2025-12 新规后
   npm 网站直接发布新包已禁，CLI 登录流程仍可），随后立即切 Trusted Publishing 由 CI 发布
3. **验证发布成功**：`npm view dsh-knowledge-sqlite dist-tags` + npm 页 provenance 徽章 + `npm audit signatures`

## 应急手动发布（CI 不可用时）

```sh
npm run build && npm run typecheck && npm test && npm publish --access public
```

> 本地手动发布**无法生成 provenance**（需 CI 的 OIDC），不要加 `--provenance`（本地会报错）；
> 本机为 `npm login` 登录态。仅应急用，事后照常走 CI。
> prerelease 应急发布加 `--tag next`（同 CI 分支逻辑，防止占用 latest）。

## 维护要点

- **扩展 provider/model 跟随会话默认**：主模型切 reasoning 路由会使扩展隐性退化；0.1.6 已加 `reasoningEffort: 'off'`，部署建议 patch `queryExpansion.model: 'deepseek-v4-flash'`
- **单库 `file:` 依赖 pnpm 不重拷**：改源码后 `npm run build` → 删 `~/.dsh/profiles/web/node_modules/dsh-knowledge-sqlite` 再 `dsh plugin --profile web install`
- **安全**：无 token 管理（OIDC）；workflow 权限最小化（contents: read + id-token: write）
