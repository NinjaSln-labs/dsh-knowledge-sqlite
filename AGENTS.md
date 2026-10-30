# AGENTS（AI 协作与工程纪律）

## 项目概览

本仓库为独立单库（仓库根 = 插件 `dsh-knowledge-sqlite`），提供跨会话知识持久化服务（SQLite FTS5 trigram + L1 查询扩展）。设计全文见 `docs/DESIGN.md`，检索质量证据链见 `docs/EXPERIMENTS.md`，交接状态见 `.handoff/` 存储（`handoff view` 查看，本机私有，不入库）——本文档只记协作纪律，不复制这些文档内容。

## AI 协作守则（agent 贡献者必读）

1. **先读后动**：开工前读 `.handoff/` 恢复上下文（`handoff view` + `next`），只读权威存储，不读 `.handoff/legacy/` 旧件；改动前对照 `status` 槽核对当前状态。
2. **验证先于断言**：声称「完成/已修复/通过」前必须跑完 §DoD 验证链并留下新鲜输出，禁止无证据收口。
3. **提交规范**：Conventional Commits（`feat:`/`fix:`/`chore:`/`docs:`…）；提交前确认 `.githooks/pre-commit` 通过。
4. **防双源**：README/DESIGN/EXPERIMENTS/CHANGELOG 已有的稳定知识只引用路径，不在新文档中复制；未决项只写 `.handoff/`（经 `handoff` CLI），禁在别处另立待办文本。
5. **脱敏**：任何入库文件不得含 API Key/token/密码/本机绝对路径；`.handoff/` 经 `.gitignore` 保持私有。
6. **回填闭环**：功能改动落地后同步更新 `status` 槽；确认修复的坑 `handoff close`，完成待办经 `close --outcome` 归档。
7. **改动最小化**：不做任务范围外的顺手重构；发现范围外问题先入账（`handoff add`）再继续。
8. **接手复验**：先跑 §DoD 验证链（`handoff check` 门禁为交接完整性判据）；依赖变更后逐维复验。

## 完成的定义（DoD）

一项改动只有同时满足以下全部条件才算完成：

- [ ] `npm run build` && `npm run typecheck` 零错误
- [ ] `npm test` 全绿（当前基线 40 用例）
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

## 交接

<!-- handoff:begin -->
- 接手跑 `handoff check`；要全局视图跑 `handoff view`。
- 活干完、判据满足时 `handoff close <id> --outcome "<做了什么>｜何时重查：<条件>"`——先落账再进版本。
- 登记可能过期，也可能本来就错 ⇒ 动手前把它那条证据原样跑一遍。
<!-- handoff:freshness:begin -->

- 记录这一班的进展：`handoff append exit --covers <id…>`。
<!-- handoff:freshness:end -->
<!-- handoff:end -->

<!-- handoff:repo:begin -->
### 仓专属交接约定（标准块不收编，勿并入上面那块）

- 条目只经 project-handoff 技能自带的 CLI 写；存储索引由脚本重建，勿手写。**手改不再「绕过门禁」**——`check` 逐文件对内容哈希，对不上即报「未经 CLI 记录的写入」，连「同字节覆写后补个手续」也会被写前旁证抓出来。
- 一条待办的**完成判据被满足时立刻 `close`**，别等提交。`close` 写的是交接事实，commit 写的是版本事实，**先落账再进版本**；攒着不提交会让已完成的条目一直挂 open，「还剩多少没做」当场失真（09-22 t000070 实测：活干完了、commit 标题里还带着该 id，却靠用户问「还剩什么」清点才发现没关）。一批活拆成多次提交、或结论要复验才能定终态时，以**判据满足**为准，不以提交次数为准。
- 收尾前跑该技能的 `check`（结构 ＋ 通用对账：各槽数量、status 闭集、引用闭合、`next` 存在且 open、文本槽无死指针；不判已作废 id 与 `c`/`d` 型）。`check rc=0` 只说明**可机械判定的部分**没问题，**不代表散文里的结论是实况**。
- 本轮有实质改动（闭条目／开条目／换 next）时刷新 `exit`；`exit`/`summary` 是给下一班的**陈述**，不是历史记录。
- `exit`/`summary` 等文本槽是**整槽覆写、无追加语义**：改前先 `--dry-run` 看将丢哪些行，别只把新段落喂进去。
- `check` 报出一批「写入**之前**发现被改动过」而你确信没手改：多半是判据缺陷留下的历史误报（修判据也消不掉已记的事件）。**先核对那几个文件确实没被手改**，再用 `rebase --force` 把基线对齐现实——它逐条打印「已结案」清单且**不可追回**，所以核对在前。
- 提及已闭条目时写 `t000095（已闭）` 这类显式标记——已闭与未闭不能靠读者推断。
<!-- 增强档 A：交接新鲜度判据**已随技能下沉**（`handoff check` 的 fresh-queue / fresh-stale
     两维，见 SKILL.md 判据清单），凡用本技能者都自带，不再是「仅本仓」才有。
     抄这段 = 抄一条人人可执行的指令，没有「抄了却没装判据」的问题。 -->
- 收尾跑 `check`（结构 ＋ **交接新鲜度**）：fresh-queue 抓「open 条目在 exit/summary 里沉默」、fresh-stale 抓「把已闭条目说成候立」。这两维随技能走，不用另装。
- 提及已闭条目时写 `t000095（已闭）` 这类显式标记——fresh-stale 靠它判行，措辞不是修辞问题。
- `log.jsonl` 只记 check 事件、不记 close 事件，所以 `exit` 过期在库里**没有痕迹**，只能靠上面那道闸。

<!-- handoff:repo:end -->
