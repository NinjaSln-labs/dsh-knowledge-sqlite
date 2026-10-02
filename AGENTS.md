# AGENTS（AI 协作与工程纪律）

## 项目概览

本仓库为独立单库（仓库根 = 插件 `dsh-knowledge-sqlite`），提供跨会话知识持久化服务（SQLite FTS5 trigram + L1 查询扩展）。设计全文见 `docs/DESIGN.md`，检索质量证据链见 `docs/EXPERIMENTS.md`，交接状态见 `.handoff/` 存储（`handoff view` 查看，本机私有，不入库）——本文档只记协作纪律，不复制这些文档内容。

## AI 协作守则（agent 贡献者必读）

1. **先读后动**：开工前读 `.handoff/` 恢复上下文（`handoff view` + `next`），只读权威存储，不读 `.handoff/legacy/` 旧件；改动前对照 `status` 槽核对当前状态。
2. **验证先于断言**：声称「完成/已修复/通过」前必须跑完 §DoD 验证链并留下新鲜输出，禁止无证据收口。
3. **提交规范**：Conventional Commits（`feat:`/`fix:`/`chore:`/`docs:`…）；提交前确认 `.githooks/pre-commit` 通过。
4. **防双源**：README/DESIGN/EXPERIMENTS/CHANGELOG 已有的稳定知识只引用路径，不在新文档中复制；未决项只写 `.handoff/`（经 `handoff` CLI），禁在别处另立待办文本。
5. **脱敏**：任何入库文件不得含 API Key/token/密码/本机绝对路径；`.handoff/` 经 `.git/info/exclude` 保持私有。
6. **回填闭环**：功能改动落地后同步更新 `status` 槽；确认修复的坑 `handoff close`，完成待办经 `close --outcome` 归档。
7. **改动最小化**：不做任务范围外的顺手重构；发现范围外问题先入账（`handoff add`）再继续。
8. **接手复验**：先跑 §DoD 验证链（`handoff check` 门禁为交接完整性判据）；依赖变更后逐维复验。

## 完成的定义（DoD）

一项改动只有同时满足以下全部条件才算完成：

- [ ] `npm run build` && `npm run typecheck` 零错误
- [ ] `npm test` 全绿（当前基线 38 用例）
- [ ] `node test-smoke.mjs` 通过
- [ ] `npm run check:deploy` FAIL 0（改了部署面时必跑）
- [ ] 新增/变更行为有对应测试或明确的豁免理由
- [ ] 文档回填完成（CHANGELOG + `.handoff/` status delta，防双源）
- [ ] 提交信息符合 Conventional Commits

## 部署纪律（本仓库适用，硬性）

本仓库为独立单一 npm 包（**非 pnpm workspace**：无 `pnpm-workspace.yaml`、无 overrides——勿从旧 monorepo 习惯误抄）。核心规则：

1. 改了本插件源码（`src/`、`lib/`）未发版 → profile 必须以 `file:` 指向本仓库根安装，禁止留在 registry 安装（同版本号不同内容，版本校验失效）。
2. 安装一律走 `dsh plugin --profile web install`，禁裸 `npm install`（会把 peerDependencies 装进 profile，产生第二套 `@deepseek-ai/*` 阴影）。
3. 每次 install / build 后必跑 `npm run check:deploy`。FAIL 必须修复。
4. `file:` 场景禁止手动软链（Node realpath 解析会脱离宿主 fallback）。
