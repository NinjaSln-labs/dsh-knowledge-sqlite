# AGENTS（AI 协作与工程纪律）

> 本文件由模板**单源拼装**（`common/AGENTS-core.md` + 分类 append）——重复段不要在仓库里手改；
> 改规则先改模板源，再重新生成。人工协作者同样适用本文件全部条款。

## 项目概览

Cross-session knowledge for DeepSeek Harness: ctx.knowledge service + knowledge_* tools, SQLite FTS5 trigram retrieval (CJK substring) with L1 query expansion. V1.11 contract (write/update/search/list/delete + budget + events + error codes).。仓库根即工程根；分支、提交、验证、发版规范见下与 CONTRIBUTING.md。

## 提交规范

- **Conventional Commits 前缀 + 中文描述**：`feat(scope):` / `fix(scope):` / `refactor:` / `docs:` / `test:` / `chore:`；scope 用模块名；发布提交固定 `chore: release v<版本> — <一句话主旨>`。
- **提交前必须跑本仓验证链单源**（命令见下方分类纪律节）并全绿；CI 与本地同源。FAIL 修根因，不绕过；确需 `--no-verify` 必须在提交说明注明原因。

## AI 协作守则（agent 贡献者必读）

1. **不猜 API/契约**：写代码前用宿主/依赖的检查工具查精确签名；测试 stub 必须按真实契约形状写（实践库教训：失真的 stub 会掩盖契约 bug）。
2. **完成的定义 = 验证链全绿 + 实机/测试验收**，不是"代码写完"；声称完成前附验证输出。
3. **机密红线**：本机绝对路径、个人邮箱、token/密钥、会过时的部署实况描述一律不入库；提交前 `git grep` 自查（模式见本仓 .gitignore 注释区）。
4. **不静默绕过门禁**：pre-commit/CI FAIL 先修根因；中间态确需跳过必须留痕注明。
5. **改动最小化**：不顺手重构、不改无关文件；构建产物与锁文件按仓库既定规则处理（产物不入库、锁文件必须入库）。
6. **文档同步**：行为/接口变化同步 README、DEVELOPMENT 速查表（或等价文档）、CHANGELOG（如有）。
7. **冲突处理**：本文件与生成它的模板源冲突时以模板源为准并回写；用户显式指示优先于本文件，但需在 PR/提交说明中标注冲突点。

## 安全考虑

- 漏洞**不要**公开披露：走 SECURITY.md 指定的私密漏洞报告渠道。
- 依赖与 CI action 升级走仓库既定自动化（如有）；引入新依赖需在 PR 说明中给出理由。

## 部署纪律（本分类硬性，五条）

1. 改了本插件源码（`src/`、`lib/`）未发版 → profile 必须以 `file:` 指向本目录安装，禁止留在 registry 安装（同版本号不同内容，版本校验失效）。
2. 安装一律走 `dsh plugin --profile web install`，禁裸 `npm install`。
3. 每次 install / build 后必跑：`npm run check:deploy`（本单库即一个插件，无需 --pkg；FAIL 必须修复）。
4. `file:` 场景禁止手动软链。
5. 本机私有信息不入库（详见上方 AI 协作守则第 3 条）。

> 单库说明：本仓库为独立单库，仓库根即插件目录，**不是** pnpm workspace——多包 workspace 的
> `pnpm-workspace.yaml` + `overrides` 防双实例护栏本库不需要；peer 版本兼容由宿主 dsh 决定，
> peerDependencies 如实声明即可。git 钩子在 `.githooks/`（启用：`git config core.hooksPath .githooks`）。
> 全文与事故背景见仓库根 `DEVELOPMENT.md`「部署纪律：profile 安装」。




9. （C3 升级实测）三方合并验证。

8. （C2 升级实测条款）模板新增纪律。
