# CHANGELOG — dsh-knowledge-sqlite

## Unreleased

- **docs**: L2 富化的质量与覆盖率度量（t000002 闭环，EXPERIMENTS §11）——**未改 `src/`**，
  纯度量。关键发现：
  - **覆盖率口径**：语料 22 条 = 12 条知识条目（m1-m12，基准富化 100% 覆盖）+ 10 条评审
    过程记录（n1-n10，未覆盖）；全量口径 12/22 = 55%。报覆盖率必须写明分母。
  - **两个查询集在富化维度上互补**：hard 集 14 条目标全在已富化的 m1-m12，human 集 17 条
    有目标全在未富化的 n1-n10 ⇒ 此前 human 集的 65%/71% 实为**零富化**下的裸 L1 表现，
    **human 集的 L2 从未被测过**。
  - **独立复现 DESIGN 的「L1+L2 = 64%」**：L1 路径下无富化 29% → 基准富化 **64%**
    （增益 +35pp），此前只有 RESULTS-v3 一份出处。
  - **富化的作用是「排序」不是「可达性」**：trigram 重叠度量显示 L1 扩展已把查询的可达性
    做到 14/14（原文仅 1/14），富化对它零增量 ⇒ 富化的 35pp 全部来自把可达但榜外的目标
    拉进 rank-1。与 L1 叠加，非替代。
  - **富化质量有采样方差**：同一模型两批生成在 L1 路径下 50% vs 64%；差异源于**内容风格**
    （基准富化用抽象概念「忽略文件」，LLM 富化用具体实体「node_modules目录」，而 hard 集是
    零词法重叠的抽象改写查询）——已隔离排除长度因素。⇒ 运行时富化须带质量门禁。
  - **结论**：不实现运行时富化管线（DESIGN 的队列/idle 批处理/contentHash 幂等守卫尚未就位，
    且质量门禁缺位时收益不确定）；先做 t000005（human 集校准/扩充），否则 L2 在真实查询上
    仍不可测。
- **feat(scripts)**: 新增 `scripts/enrich-measure.mjs`（hermetic 度量：覆盖率口径 + 富化质量
  三臂对照 + 富化对排序的影响，只用仓内 fixture，不进 CI verify 链）与
  `scripts/enrich-llm-gen.mjs`（LLM 生成富化作对照输入，联网 + 真实 provider，人工触发）；
  fixture 新增 `tests/fixtures/corpus/enriched-llm.json`（LLM 生成物，22 条全覆盖，
  `_meta` 记生成批次）。
- **fix**: L1 扩展按模型能力自适应 `reasoningEffort`（t000001 真因修复）——此前
  扩展请求硬编码 `reasoningEffort: 'off'`，而宿主对**无 reasoning 能力**的模型会硬拒该参数
  （`UNSUPPORTED_REASONING_EFFORT`）⇒ 扩展 100% 降级、检索退化为纯词法。真机实测
  （sensenova-6.8-flash-lite / agnes-3.0-flash 均属此类）：带 `off` 即被拒，
  `expansion.reason` 为 `stream-error: ... does not support reasoning effort "off"`。
  0.1.6 的修复只验证过 reasoning 模型一侧（`reasoning:true` catalog），未覆盖这一侧。
  ⇒ 改为「先带 `off`；被拒则去掉该参数重试一次」。该拒绝发生在宿主**本地校验**
  （不发 provider 请求、零成本），故重试不产生额外调用；未被拒的模型本就支持
  reasoning，保留 `off` 以关闭思维链（thinking 预热致 TTFT 3s+，EXPERIMENTS §9）——
  两类模型各自走对分支。**注意顺序**：不能反过来（先不带）——宿主对支持 reasoning
  的模型在未指定时按 `defaultEffort` 处理而不报错，反序会让 reasoning 模型永久丢掉
  「关思维链」的收益。
- **test**: +3（宿主拒 `reasoningEffort` → 去参重试即通不降级；宿主接受 → 单次调用
  不重试；非 reasoning-effort 类错误不触发重试）→ vitest 43/43。
- **docs**: EXPERIMENTS §9.3「悬而未决」改写为 §9.4「真因定位与修复」，附真机证据链。

## 0.1.10 (2026-10-02)

- **chore(deps)**: 宿主升级对齐 dsh `0.2.0-rc.2`（npm `next`，宿主 `dsh --version`
  实测）——`peer/devDeps` `@deepseek-ai/dsh-*`（tools/llm/session/agent-default-model/
  api-remotes/fs-local/scope/typert-protocol/util-values）统一到 `^0.2.0-rc.2`，
  `@deepseek-ai/schemastery` `^3.18.2` → `~3.18.4`（对齐 compass）。
  新增 devDeps `@deepseek-ai/dsh-sandbox` + `dsh-sandbox-policy@0.2.0-rc.2`
  （dsh-tools 0.2.0-rc.2 的 lib/index.js 直接 import，缺之测试 `Cannot find package`；
  已实测：移除即复现，属运行时可达的传递依赖，必须显式声明）。
  API 增量（deferLoading/projectContent）只加可选字段，`defineTool` 调用无需改动。
- **fix**: live L1 扩展降级补诊断（发现1）——`callModel` 返回结构化 reason
  （`no-agentDefaultModel-service` / `selection-threw` / `no-route` / `no-llm-service` /
  `timeout` / `stream-error` / `empty-variants`），经 `ctx.logger` 告警、记入
  `stats.lastDegradeReason` 与 `stats.degradeReasons` 计数，并透出到 `knowledge_search`
  结果的 `expansion.reason`。此前整条扩展路径静默降级（无日志），100% 降级无从定位。
- **fix**: `QueryExpansionConfig.provider` 死配置接通（发现3）——`callModel` 实际读取该字段、
  `index.ts` 解析并透传（config → resolved → QueryExpander）。EXPERIMENTS §9 建议的
  「扩展专用 provider pinning」自此可真正生效（此前声明了但从不被读取）。
- **fix**: `knowledge_probe` 默认 `corpusPath` 指向包内 fixture（发现2）——新增
  `defaultCorpusPath()` 经 `import.meta.url` 解析 `tests/fixtures/corpus/`，`files` 已含该目录
  （随包发布）。部署态 `seed`/`hard`/`human`/`latency` 套件不再 ENOENT（此前默认指已消失的
  `research/memory-knowledge-seam/experiments/memory-experiment`）。
- **test**: +2（provider pinning 生效；默认语料路径解析且 522 条 seed 成功）；超时/失败降级用例
  补 `expansion.reason` 断言 → vitest 40/40。
- **docs**: README/README.zh 配置示例补 `queryExpansion.provider` 与 corpusPath 默认说明。

## 0.1.9 (2026-09-10)

- **chore(deps)**: 宿主升级对齐——`peerDependencies` 与 `devDependencies` 中的
  `@deepseek-ai/dsh-*` 从 `^0.1.2-alpha.4/5` 统一到 `^0.1.5-rc.1`，
  `@deepseek-ai/schemastery` `^3.18.1` → `^3.18.2`。
  背景：宿主 dsh 发布 `0.1.5-rc.1`（npm `next` dist-tag，2026-09-10），而 devDeps
  停在 `0.1.2-alpha.5`——测试套件实际跑在旧宿主 API 上，与运行时脱节
  （test-vs-runtime skew）。区间 `^0.1.5-rc.1`（`<0.2.0`）不收紧可用宿主范围，
  仅把声明收敛到实测通过的那一版。
- **chore**: `.gitignore` 补 `audit-report/`——repo-audit 生成产物，与 `lib/`/`*.log` 同类。
- **test**: 宿主 0.1.5-rc.1 下验证链全绿——`build`/`typecheck` 零错误 + vitest 38/38 +
  smoke 基线复现（A 7% / C 21% / D 50% / human-A 65% / human-C 71%）+
  `check:deploy` FAIL 0。API 面核对：`defineTool`/`snapshotJsonValue`/
  `z.string|object|const|union|array|boolean` 在 0.1.5-rc.1 均存在；`z.enum`/`z.record`
  缺失与 `src/types.ts` 头部已记录的 schemastery 缺口一致，无需改码。

## 0.1.7 (2026-09-05)

- **fix**: `dsh-scope`/`dsh-typert-protocol`/`dsh-util-values` 从 `dependencies` 移入
  `devDependencies`——避免 `file:` 安装时 pnpm 将它们装进 profile node_modules，
  产生第二套 `@deepseek-ai/*` 导致 `check:deploy` FAIL（symbol 错配/400 前兆）。
  这三个包已是 `peerDependencies`（alpha.5），运行时经宿主 fallback 链提供，
  本地仅需 devDeps 供测试路径解析。
- **chore**: scaffold adopt `dsh-plugin` 模板——新增 `ci.yml`/`githooks/pre-commit`/
  `CLAUDE.md`/`CONTRIBUTING.md`/`DEVELOPMENT.md`/`PUBLISHING.md`/`SECURITY.md`/
  `README.en.md`/`scripts/build.mjs`/`scripts/verify.mjs`；10 个 MERGE-REVIEW 文件
  全部保留项目定制版本（未采纳模板骨架）。
- **docs**: `SECURITY.md`/`PUBLISHING.md` 填实模板占位符；`DEVELOPMENT.md` 速查表
  追加 3 行（config.ts 占位/.scaffold-update 残留/MERGE-REVIEW 误采纳）；
  `package.json` files 加入 `README.en.md`。
- **test**: 验证链全绿——vitest 38/38 + smoke 基线复现（A 7%/C 21%/D 50%/human-A 65%）
  + check:deploy FAIL 0 + contract probe 12/12。

## 0.1.6 (2026-08-16)

- **fix**: 扩展请求显式关闭思维链（`reasoningEffort: 'off'` → pi-ai `thinking: {type:'disabled'}`）。
  根因：扩展 provider/model 跟随会话默认，若默认路由是 reasoning 模型（如 opencode-go 的
  deepseek-v4-flash，`reasoning: true`），thinking 预热使 TTFT 高达 3.4s / 总耗时 11.3s，
  timeout 3000 下 100% 降级（详见 EXPERIMENTS §9 根因分析）；关闭后退化为普通生成。
- 部署配套：profile patch 配置 `queryExpansion.model: 'deepseek-v4-flash'`（默认 provider
  内优先 v4-flash，不配 provider——跟随会话默认路由）。
- **test**: +2（扩展请求携带 reasoningEffort=off；model 显式配置生效、provider 跟随默认；
  mock llm 记录路由参数）。
- 回顾：本次根因是"配置跟随主模型"这一数据流决策，主模型换推理模型后扩展隐性退化——
  新增速查表行（见仓库根 DEVELOPMENT.md）。

## 0.1.5 (2026-08-16)

- **feat**: L1 扩展缓存持久化——SQLite `expansion_cache` 表（按 workspace 隔离，
  跨进程/重启复用）：同查询第二次起 **0 延迟、零降级**（内存 + 持久两级；
  `fresh`/variance 语义同时清两级，保证评估独立性）。
- **change**: `queryExpansion.timeoutMs` 默认 2500 → 3000（降低超时降级率；
  fresh 口径 p95 右移、生产口径（缓存命中）≈0——权衡分析见 EXPERIMENTS §8）。
- **test**: store 3 项（roundtrip/跨 ws 隔离/upsert 覆盖、clear、坏数据）+
  service 1 项（新服务实例同 DB 命中持久缓存、fresh 后重建）。
- 回顾：缓存层从"进程内存"到"持久化"是数据流决策，隔离键（workspace）与内容层一致，
  无新坑入表。

## 0.1.4 (2026-08-16)

- **feat**: human 套件新增 C 臂诊断——离线 reasoner variants（`human-expanded.json`
  落盘入库，deepseek-chat 生成口径与基准一致），分离"扩展模型能力"与"实时降级"两个变量；
  precision@1 与 none 无误报检查同步覆盖 C 臂。
- 实测：本批次 C 臂 12/17 (71%)（基准历史抽样 82%——C/D 臂有 LLM 抽样方差，V1.11 条款；
  详见 EXPERIMENTS §7）。
- 回顾：见仓库根 DEVELOPMENT.md 速查表"语料迁移后路径未同步"行（fixture 同步流程已固化）。

## 0.1.3 (2026-08-16)

- **fix**: probe 语料默认路径与工作区布局一致 —— 语料迁移后 bundle 默认 `corpusPath`、
  测试 `CORPUS`、`test-smoke.mjs` 三处仍指向不存在的 `research/memory-experiment`，
  导致宿主 `knowledge_probe` 套件 ENOENT、`npm test` probe 用例失败。全部改指
  `research/memory-knowledge-seam/experiments/memory-experiment`。
- **test**: 实验语料以 fixture 形式入库（`tests/fixtures/corpus/`，逐字拷贝 + 同步说明），
  单测与冒烟脱离仓库外 `research/` 目录、CI 可跑。
- **feat**: human 套件上报 precision@1（V1.11 信息性门禁 ≥80%，单目标套件口径 ≡ recall@1，
  两臂并列如实报告）与 none 查询无误报检查（top1 必须为空或非记忆条目）。
- 回顾：发版物与工作区布局脱节是"仓库路径已修、测试/发布物未同步"的同类坑
  （详见仓库根 DEVELOPMENT.md 速查表新行）。

## 0.1.2 (2026-08-14)

- **fix**: 工具层 strict JSON —— `-0`/NaN bm25 分数归一化、`undefined` 字段省略
  （search/list 直接工具调用），测试对照 `snapshotJsonValue`。

## 0.1.1 (2026-08-14)

- **feat**: `gating` 配置（默认 `ask` 符合 V1.11；`none` 供受信部署自动放行）。

## 0.1.0 (2026-08-14)

- **feat**: 跨会话知识插件（V1.11 契约）—— `ctx.knowledge` 服务 + `knowledge_*` 工具，
  SQLite FTS5 trigram + L1 查询扩展。
- **feat**: `knowledge_probe` 实验套件（seed/hard/human/contract），后补 variance（10 轮 L1
  门禁）与 latency（4 路并发 p95）套件。
- 阶段 3 门禁：L1 hard 均值 56% PASS、human 65% PASS、p95 延迟 FAIL（如实记录，外部 LLM TTFT）。
