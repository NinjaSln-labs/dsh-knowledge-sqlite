# CHANGELOG — dsh-knowledge-sqlite

## Unreleased

- **docs**: 运行时富化管线判据 FAIL ⇒ 不实现（t000024 闭环，EXPERIMENTS §20）——**未改 `src/`**，
  纯度量。按条目判据「否则不实现」：知识条目侧查询集上，运行时富化臂 recall@1 必须
  ≥ 基准富化臂，实测**不达标**。
  - **三批次判定**（同一 provider/model 三次独立生成，判据取**下界**——单批次跑赢不构成证据）：
    基准 54%（22 条语料）/ 50%（522 条）vs LLM 批次 A/B/C 的 11/13/14 与 11/12/12
    ⇒ 下界 11 < 基准 ⇒ **FAIL**。批次 C 在 22 条口径下（58%）超过基准，但同批次在 522 条
    口径下掉到 50% ⇒ 不稳定性本身就是问题。
  - **失败机制不是「抽象度」而是字面漂移**：失分项如「规划模式」（基准，命中）vs
    「计划模式」（LLM，不命中）、「角色配置」vs「角色设定」——语义等价但 trigram 完全
    不相交。量化：富化文本与查询的 trigram 交集本就极稀疏（基准均值 1.25、LLM 1.13–1.38），
    **13/24 条查询与任何富化文本交集为 0** ⇒ 字符级重叠通道只有约 1–2 个 gram 宽，
    任何字面漂移都翻转命中。
  - **产出质量门禁在当前架构下不可实现**（比「质量不够」更强的结论）：只看「原文 + 富化产出」
    的三个候选信号（平均短语长 7.6/10.3/9.2、与原文 trigram 重叠 31%/25%/26%、
    实体密度 10%/11%/10%）**无法把好批次与坏批次分开**，且与 recall 无单调对应。
  - **两个候选修法亦无效**：长度归一化（46%→50%，仍低于基准）；抽象度假设（90% vs 89%，
    **无区分度，§11.5 的假设被证伪**）。
  - **覆盖面已校正**：补测「都只富化 m1–m12」的对照臂，结论不变 ⇒ 差距非覆盖面所致。
  - **对既有结论的影响**：§11.6「值得，但须带质量门禁」中「值得」的前提（基准增益可被运行时
    复现）不成立 ⇒ L2 定位下调为「离线/人工富化」，运行时只保留 L1（其增益不依赖产出质量）。
  - 新增可复现脚本 `scripts/runtime-enrich-gate.mjs`（hermetic，多批次下界判定）与三批
    LLM 富化归档 `tests/fixtures/corpus/llm-batches/`（真实 provider 生成）。
  - 顺带修 `scripts/enrich-measure.mjs`、`scripts/human-set-audit.mjs`、`scripts/variance-gate.mjs`：
    `store.search` 返回值改为 `{rows, qgrams}` 后三处解构未同步。
- **feat**: 查询截断启用批（t000025 闭环，EXPERIMENTS §16）——**改了 `src/`**。
  关闭 DESIGN:135 规定的生产 `maxQueryTrigrams` 默认 24（此前实现默认 0=不限）。
  - **D1：`dfOf` 的 O(N) 全表扫描 → `fts5vocab` 词表查询**。先前记录「node:sqlite
    未启用 vocab、t_vocab 表不存在」**已过时**：Node v24.18.0 实测 `fts5vocab` 可用，
    词表随 FTS 写入自动更新。采用 instance 模式（term→doc），522 条语料每查询
    **7.085ms → 0.362ms（≈20x）**，且开销不再随规模线性放大。
  - **D2：df 跨 workspace 稀释 idf → 限定调用方可见文档**（词表 JOIN `items`，
    套用与检索 SQL 相同的可见性条件）。
  - **D3：snippet/provenance 用未截断 gram → 用实际 MATCH 的 gram 集**
    （`store.search` 回传 `qgrams`）。
  - **D4：零测试覆盖 → 新增 6 个用例**（idf 优先 vs 顺序截断对照、cap 截断无损、
    跨 workspace df 隔离、matchOf 转义、截断边界）。
  - **顺带修掉真实缺陷**：`matchOf` 未转义 gram 内的 `"` ⇒ FTS5 MATCH 语法错误 ⇒
    `store.search` 的 catch 分支**静默返回空数组**（检索失效无报错）。修法：按 FTS5
    字面量规则转义为 `""`，已加单测。
  - **召回无损**：cap24 逐条 rank 与「不限」完全一致（hard 50%、human 59%）；
    顺序截断仍丢判别词（human 41%，反例对照）。
  - **延迟代价**：cap24 相对 cap0 的 p95 差值 522 条语料 **+10.22ms → +0.52ms**
    （72 条 +0.14ms、222 条 +0.85ms）⇒ 达成「p95 回到 cap=0 量级」判据。
  - **配置默认值变更**：`retrieval.maxQueryTrigrams` 默认 0 → 24。显式配 0 的部署不受影响。
- **feat**: 延迟门禁口径修订（t000026 闭环，EXPERIMENTS §17）——**改了 `src/`**。
  - 新增 `classifyDegrade(reason)`：降级按原因分类——`provider`（stream-error 限流/
    连接错误、no-route、no-llm-service 等环境变量）/ `implementation`（timeout 真慢、
    empty-variants 真坏）/ `other`。provider 类**不计入 p95**并单列 id。
  - 门禁改**三态**：`gateState: pass | fail | indeterminate`，`gate` 布尔仅在 pass 时为 true；
    新增 `gateReason` 人类可读判据。⇒ provider 限流时为 **indeterminate（不可判定）**，
    既不误判为通过也不误判为不通过。
- **feat**: variance 门禁补 C/D 双臂 + 阈值声明扩展模型（t000030 闭环，EXPERIMENTS §18）
  ——**改了 `src/`**。关闭 DESIGN:235「both the C arm and the D arm」的缺口。
  - 每轮同时跑 C 臂（base 表 + 逐条真实扩展）与 D 臂（rich 表 + 逐条真实扩展），
    **共用同一批扩展变体** ⇒ 臂间差只来自「有无富化」。
  - 两臂分别给 mean/range/floor 判据：C mean≥30% floor≥20%；D mean≥60% floor≥45%。
  - 新增 `expansionModel: { provider, model, note }` 声明扩展路由——阈值是在
    `deepseek-chat` 上标定的，换扩展模型即换尺（§15.3 实测低 8.7–9.6pp）⇒ 读数与
    门槛的前提条件同现。
- **feat**: reasoning 模型扩展输出截断修复（t000027 闭环，EXPERIMENTS §13.4）——**改了 `src/`**。
  - 根因：`maxOutputTokens` 默认 300 是**总输出预算**，reasoning 模型思维链
    （实测 46–67 个 reasoning-delta chunk）吃光预算 ⇒ 正式输出被 JSON 截断 ⇒
    `empty-variants` 降级。非 reasoning 模型在同预算下正常 ⇒ reasoning 专属问题。
  - 修法：**只在空变体这条失败路径上**用 2 倍预算重试一次（600）。正常路径行为不变
    （非 reasoning 模型不触发第二次调用）；重试仍失败则照常降级为 `empty-variants`。
  - 新增诊断计数 `stats.retryRecovered`。
- **feat**: 知识条目侧查询集（t000028 闭环，EXPERIMENTS §19）——**改了 `src/`**（新增 probe
  套件）+ 新增 fixture。关闭 §14 审计出的「human 集的对偶缺口」。
  - 新增 `tests/fixtures/corpus/knowledge-queries.json`：**27 条**（24 有目标 + 3 none），
    目标覆盖已富化知识条目 m1–m12 各 2 条，写法对齐 human 集（真实口吻、少量 none、
    目标唯一），且**不复用 `enriched.json` 的问法**（避免富化臂平凡命中）。
  - 三项判据全部 PASS：L0 纯词法 recall@1 **非平凡下界**（22 条语料 42%、522 条语料
    29%——既不恒为 0 也不被平凡命中）、富化增益可测（**+12pp / +21pp**，与 §11.3 +35pp
    同向）、3 条 none 不误报。
  - 新增 `probe('knowledge')` 套件（A/D 双臂读数 + 三项 `gates` 布尔），
    `probe('all')` 与 `knowledge_probe` 工具的 `suite` 枚举均已含 `knowledge`。
  - 新增可复现脚本 `scripts/knowledge-set-audit.mjs`（hermetic）。
- **docs**: variance 门禁复验（t000006 闭环，EXPERIMENTS §15）——**未改 `src/`**，纯度量。
  可复现脚本 `scripts/variance-gate.mjs`（真实 LLM 调用，非 hermetic，不进 CI verify 链）。
  - **门禁（逐条口径 / 门禁本体 `probe('variance', {fresh:true})`）通过**：10 轮逐轮
    8,8,5,7,7,7,4,8,6,6 /14 ⇒ **mean 47%**（≥30% PASS）、**range 29%–57%**（floor ≥20%
    PASS）、**降级 0/140**。
  - **同口径对比上游偏低 8.7–9.6pp**：批量 C 臂 27% [21-29]（上游 35.7% [29-43]）、
    批量 D 臂 54% [36-71]（上游 63.6% [50-79]）⇒ 归因于**扩展模型不同**
    （sensenova-6.8-flash-lite vs deepseek-chat），非实现回归；零词法重叠的 hard 集对扩展
    质量敏感。⇒ 门禁阈值须声明扩展模型。
  - **批量 D 臂 floor 未达标**（36% < 45%）：「每轮新生成富化」质量波动更大（§11.5 已测
    LLM 富化 21%–64%）⇒ 该臂天然难满足 floor；基准富化（逐条口径）floor 29%，稳。
  - **门禁本体缺口**：`probe('variance')`（`src/probe.ts:309`）只跑一个臂（rich 表 + 逐条
    扩展），未实现 DESIGN:235 要求的 C/D 双臂 ⇒ 本轮的 C/D 双臂由
    `scripts/variance-gate.mjs --mode batch` 按上游 `variance.mjs` 口径补齐。
  - **富化的排序增益不依赖扩展模型**：批量口径 D 54% vs C 27%（+27pp），与 §11.3（+35pp）、
    §11.6 一致。
  - **t000001 修复的代价已量化**：每次扩展调 2 次 `llm.stream`（带 off 被拒 → 去参重试）；
    被拒那次是宿主**本地校验**（0ms、不发 provider 请求）⇒ 不烧配额、不加延迟，但宿主
    侧多一次 stream 构造（宿主未暴露模型 reasoning 能力查询 API，无法事前探测）。
- **docs**: human 集校准审计（t000005 闭环，EXPERIMENTS §14）——**未改 `src/`、未改 fixture**
  （`human-queries.json` 是历史证据链的基准，保持不动）。可复现脚本
  `scripts/human-set-audit.mjs`（hermetic）。三项可复算偏差：
  - **53% 是会话操作指令**而非知识检索（判据：长度<12 字 或 命中操作词表；样本
    h13「我想先切换成 v4」、h15「切换好了。开始吧」、h19「已经开 v4 pro 评审了。」）。
  - **0/17 落在已富化知识条目**：17 条有目标查询全部指向 n1–n10（未富化的过程记录），
    从未测过「知识条目上的 L2」。
  - **词法重叠是构造产物**：n1–n10 由这 20 条消息本身经 LLM 提炼 ⇒ 共享 trigram
    对标注目标平均 **26%**、对语义对应的独立事实条目（m*，人工指定映射）**0%**
    （16/17 更高）。DESIGN:271 原只写「heavy lexical overlap」，未追问其来源。
  - **relabel 影响**：目标换成 m* 后 recall@1 **0/17**（L0/L0+富化/L1 三路径全 0）——
    不是标注错（逐条核对语义都对），而是语料缺「知识条目侧」查询集：m1–m12 是 harness
    运维事实、human 集问记忆插件设计讨论，两套语料主题不相交。
  - 顺带印证 EXPERIMENTS §11.4：human 集 **L0+富化（59%）< L0 纯词法（65%）**——
    部分覆盖的富化在有干扰项时会抢走未富化条目的 rank-1。
  - ⇒ DESIGN:243 门禁（「L1 ≥ 50% and L1+L2 ≥ 60%」）与 DESIGN:271 偏差声明已加量化注：
    读数只在「记忆条目为 n* 过程记录」这一语料形态下成立，不代表真实知识条目上的检索质量。
    补齐知识条目侧查询集另开待办（t000028）。
- **docs**: 延迟门禁复验（t000004 闭环，EXPERIMENTS §13）——**未改 `src/`**，纯度量。
  可复现脚本 `scripts/latency-gate.mjs`（DESIGN:246 并发口径）+ `scripts/latency-serial.mjs`
  （串行口径，绕 RPM 限流）；非 hermetic（真实 LLM 调用），不进 CI verify 链。
  关键发现：
  - **门禁 FAIL，且不是并发或限流造成的**：串行口径下最慢的那条**成功**请求也 > 2.0s
    （sensenova min=2321ms / p50 3408ms / p95 6502ms；cloudflare gpt-oss-20b
    min=1978ms / p95 4734ms）⇒ 单条扩展本身已超 SLO。需**更快的扩展模型**才可能达标，
    调 timeout 无效（与 EXPERIMENTS §8.2「调参不能对抗延迟」一致；DESIGN 说的
    「timeoutMs 2.5s 给 SLO 留余量」今天也不成立）。
  - **免费 provider 的 RPM 限流是最大测量干扰**：sensenova `429 rpm exhausted`、agnes
    `429 You've reached the API rate limit for free users`；限流在 40–120ms 内返回，
    **降级 ≠ 慢**。probe 排除降级后 p95=null ⇒ 门禁**不可判定**（不是「通过」）。
    连带效应：降级与 empty-variants 都不写缓存 ⇒ provider 不可用期间缓存永远填不上
    （实测「cached 口径」也 17/17 降级，而非设计中的 0 延迟命中）。
  - **顺带发现 reasoning 模型的 `empty-variants` 截断**（t000001 修复的盲区）：cloudflare
    gpt-oss-20b 7/17 降级为 JSON 截断——`maxOutputTokens` 默认 300 是**总输出预算**，
    reasoning 模型思维链（实测 46–67 个 reasoning-delta chunk）吃光预算 ⇒ 正式输出被截断。
    对照：sensenova（非 reasoning）在 300 下全部正常 ⇒ reasoning 模型专属问题。
  - **门禁口径待修订**（§8.2 已建议）：当前把「provider 限流」（环境变量）与「模型延迟」
    （实现属性）混在一起 ⇒ 建议排除 provider 错误类降级，或把门禁声明为环境变量
    （"在 provider X + 模型 Y 下"）。
- **docs**: 查询截断（maxQueryTrigrams）度量与实现缺陷清单（t000003 闭环，EXPERIMENTS §12）
  ——**未改 `src/`**，纯度量。可复现脚本 `scripts/cap-measure.mjs`（hermetic，不进 CI
  verify 链）。关键发现：
  - **cap 在生产路径上确实触发**：L1 路径下 hard 集查询 gram 数最小 26 / 中位 46，
    14/14 全部超 cap 24 ⇒ 截断每次都生效，不是备而不用参数（纯原文查询则从不触发）。
  - **idf 优先截断召回无损**：cap 24（甚至 12）与「不限」逐条 rank 完全一致；顺序截断
    则丢判别词（human 59%→41% @cap24、35% @cap12），复现 EXPERIMENTS §2 的反例。
    idf 值只有少数档位（0.00~2.44），排序极早饱和 ⇒ cap 24 余量充足。
  - **规模效应（修正 §11 口径）**：hard 集富化增益在 22→522 条全尺度稳健（+29pp~+36pp），
    绝对值 64%→50% 是干扰项稀释 BM25 排序所致（DESIGN 的 64% 出自 12 条实验语料，
    probe 的 50% 是 522 条生产基线）；**human 集上部分覆盖的富化掉 17pp**——已富化条目
    更易与干扰项匹配、抢走未富化条目的 rank-1 ⇒ 富化净收益取决于**覆盖率**。
  - **实现缺陷 4 项（只记未修）**：D1 `dfOf` O(N) 全表扫描且每次查询都做（cap 24 的
    额外开销随规模线性增长：72→522 条 +1.35ms→+10.22ms ⇒ 「默认 cap 改 24」不能单独做）；
    D2 `dfOf` 扫全表跨 workspace，与注释「本 workspace 可见文档」不符；D3
    snippet/provenance 用未截断的全量 gram（与 MATCH 的 gram 集不一致）；D4
    `truncateGrams`/`dfOf` 零测试覆盖。
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
