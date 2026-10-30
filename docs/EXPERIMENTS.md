# 实验与验证证据（EXPERIMENTS）

> dsh-knowledge-sqlite 的检索质量证据链：基准实验（RESULTS-v3）→ 动态原型验证 →
> 宿主 e2e（bundle 真实加载）。全部脚本与数据集可复现。

## 1. 基准实验（RESULTS-v3，2026-08-14）

语料：12 条真记忆（m1-m12，富化）+ 10 条提炼记忆（n1-n10）+ 500 条 DSH 仓库真实文档段落干扰项。

### 1.1 方差（门禁 1：≥10 次运行，LLM 难查询集 14 条 × 12 条语料）

| 臂 | recall@1 均值 | 范围 |
|---|---|---|
| C 查询扩展-only（L1） | **35.7%** | 29–43% |
| D 富化+扩展（L1+L2） | **63.6%** | 50–79% |

### 1.2 大语料（512 条：12 记忆 + 500 干扰项）

**LLM 难查询集（14 条）**：

| 臂 | recall@1 | recall@3 | MRR | precision@5 | NDCG@5 |
|---|---|---|---|---|---|
| A 纯词法 | 7% | 7% | 0.071 | 0.014 | 0.071 |
| B 写入富化 | 21% | 29% | 0.268 | 0.071 | 0.290 |
| C 查询扩展 | 21% | 29% | 0.264 | 0.071 | 0.287 |
| D 富化+扩展 | **50%** | **71%** | **0.607** | 0.143 | 0.635 |
| E PRF | 7% | **36%** | 0.202 | 0.071 | 0.242 |

**reasoner 交叉查询集（12 条）**：A 75% → D 100%。

### 1.3 人类查询集（20 条真实用户消息，17 条有目标，user-verified；522 条语料）

| 臂 | recall@1 | MRR |
|---|---|---|
| A 纯词法 | 65%（11/17） | 0.703 |
| C 查询扩展 | **82%**（14/17） | 0.853 |
| D 富化+扩展 | **88%**（15/17） | 0.882 |

none 查询（3 条）top1 全为空/干扰项——无误报。

### 1.4 修正后的召回全景

| 场景 | A 纯词法 | C 扩展 | D 富化+扩展 |
|---|---|---|---|
| LLM 难查询 × 12 条 | 7% | 36% | 64% |
| LLM 难查询 × 512 条 | 7% | 21% | 50% |
| reasoner × 512 条 | 75% | 92%* | 100% |
| 人类查询 × 522 条 | 65% | 82% | 88% |

（*reasoner × 12 条语料测得 92%）

## 2. 动态原型验证（kpro-2，2026-08-14）

沙箱内无法跑 node:sqlite → 三件套分层验证（详见 `research/memory-knowledge-seam/experiments/prototype/RESULTS-PROTOTYPE.md`）：

1. **SQLite 存储层**（`prototype/sqlite-trigram-verify.mjs`，真实 node:sqlite + FTS5 trigram）：
   精确复现 A 7% / C 21% / D 50% / human-A 65%（逐查询 rank 一致）
2. **JS BM25 校准**（`prototype/js-bm25-calibration.mjs`）：与 FTS5 bm25 **0/72 处 rank 不一致**
3. **动态插件链路**：write→trigram→search（L0 + L1-live 真实 llm.stream）；
   hard L1-live 43%/64%（≥30% 验收线）、human 65%（≥50%）、contract 11/11、ask 门控拒绝

关键发现（已并入 bundle 实现）：
- `maxQueryTrigrams` 顺序截断丢失长查询判别词（human A 65%→41%）→ 生产用 idf 优先截断或不限
- `llm.stream` 消息必须用 content blocks + source + id；finish reason 是对象
- workspace 身份优先调用方 cwd（`session.header.cwd`）
- 评估目标按 dedupeKey→id 映射解析（确定性 id 是 `k-<hash>` 前缀）

## 3. 宿主 e2e（bundle 真实加载，2026-08-14）

dsh-knowledge-sqlite 作为 profile bundle 挂载到 `dsh web`（`~/.dsh/profiles/web`）后的验证：

| 验证项 | 结果 |
|---|---|
| 工具注册 | knowledge_write/update/search/list/delete/probe ✓ |
| hard 确定性臂 | A 7% / C 21% / D 50%（真实 SQLite，逐查询 rank 一致）✓ |
| hard L1-live（实时扩展） | **64%**（9/14）✓（≥30% 验收线） |
| human A / L1-live | 65% / 65% ✓（≥50% 验收线） |
| contract | 12/12 ✓ |
| ask 门控 | knowledge_write 在 approval=never 下拒绝 ✓ |
| 扩展实测 | 31 次真实调用，26 成功（84%），5 超时降级（2.5s 超时），缓存生效 |

挂载排障记录（社区插件加载的坑：internal loader 依赖 + default export 必须是插件对象）：
`research/memory-knowledge-seam/experiments/prototype/MOUNTING-NOTES.md`。

## 4. 复现

```sh
# 基准实验（memory-experiment 目录）
node eval.mjs            # 五臂 × 12 条（LLM 难查询）
node scale-eval.mjs      # 四臂 × 512 条 + PRF
node variance.mjs        # 10 次方差（需要 API key）
node human-eval.mjs      # 人类查询评估（22 记忆 + 500 干扰项）

# 原型验证（research/memory-knowledge-seam/experiments/prototype 目录）
node sqlite-trigram-verify.mjs   # SQLite 层基线（无 API 依赖）
node js-bm25-calibration.mjs     # JS↔FTS5 校准（无 API 依赖）

# bundle（dsh-plugins/dsh-knowledge-sqlite）
npm test                 # vitest 38 项（store 19 + service 19）
node test-smoke.mjs      # SQLite 冒烟（7/21/50/65 + 契约）
# 宿主：knowledge_probe { suite: 'variance' | 'latency' | 'all' }
```

## 5. 验收门禁对照（阶段 3 状态，2026-08-14 宿主实测）

| 门禁（V1.11） | 目标 | 状态 |
|---|---|---|
| L1 recall@1（hard） | ≥30% 均值，无单次 <20% | **PASS**：10 轮方差均值 **56%**，范围 43–71%（deepseek-v4-flash 实时扩展；基准 C 臂 35.7%±[29-43] 为 reasoner 模型） |
| human 集 L1 | ≥50% | 宿主 65% ✓ |
| 人类集 precision@1 | ≥80%（信息性） | 待 promotion 补测（0.1.3 已补测，见 §6） |
| p95 L1 延迟 | ≤2.0s（4 路并发，人类查询集） | **FAIL**：真实扩展测量 2171ms / 2293ms（fresh 清缓存两次），超目标 ~10-15%；缓存命中后扩展延迟≈0（生产同查询复用缓存显著降低） |
| 写入即检索（零 LLM） | AC | ✓ |
| 授权/打标/错误码/事件 | AC | contract 12/12 ✓ |
| 实验套件入库 | AC | ✓ |

### p95 延迟门禁分析（未过，如实记录）

- 测量口径：人类查询集 17 条，4 路并发，`expand: true`，非降级查询的扩展延迟（V1.11：degraded 查询排除在 p95 外）。
- 数据：两次 fresh 测量 p95 = 2171ms / 2293ms；非降级查询均值 ~1.7-1.8s；超时率 ~12%（2.5s timeoutMs）。
- **根因是外部 LLM API 首包延迟**（deepseek 流式 TTFT 918-2293ms），非实现缺陷。V1.11 设计假设"p95 2.0s < timeoutMs 2.5s"在当前环境的头部关系已破坏（实测 p95 2.3s）。
- 缓解选项（部署时配置）：① `queryExpansion.timeoutMs` 提至 3000 恢复头部余量、降低降级率；② `queryExpansion.model` 换更快路由；③ 生产同查询缓存命中后扩展延迟≈0（真实使用中 p95 接近词法检索）。promotion 重测建议：网络环境稳定后 fresh 重跑，或按真实使用（缓存）口径评估。

## 6. 0.1.3 发布后重测（2026-08-16，宿主实测，bundle 0.1.3）

发布 0.1.3（probe 语料路径修复 + human 套件 precision@1/none 上报）后的门禁重测，
全部经 `knowledge_probe`（真实 SQLite + deepseek-v4-flash 实时扩展）：

| 套件 | 结果 |
|---|---|
| hard 确定性臂 | A 7% / C 21% / D 50% ✓ 精确复现（逐查询 rank 一致） |
| hard L1-live | **50%**（7/14，3 条降级）≥30% PASS |
| human A | 65%（11/17）✓ 复现 |
| human L1-live | **59%**（10/17，9 条降级）≥50% PASS |
| 人类集 precision@1（信息性） | A 65% / L1-live 59%（单目标套件口径 ≡ recall@1，如实并列；<80% 未过，记录为 promotion 观察项） |
| none 无误报 | h1/h4/h5 top1 全空，**无误报 PASS**（新增检查） |
| p95 L1 延迟（fresh，4 路并发） | **2380ms**（非降级 8 条均值 2071ms，9/17 超时降级）> 2000ms **FAIL**——与 0.1.2 时代测量一致，根因不变 |
| contract | 12/12 ✓ |

观察：
- 确定性臂跨版本精确复现，SQL 层检索无回归。
- 降级率随网络抖动波动大：hard 21%（3/14）、human 53%（9/17）——0.1.2 时代实测为 16%（5/31）；
  降级查询走词法回退，命中仍可用（human 59% 中降级查询的命中部分来自 trigram 词法本身）。
- precision@1 信息性门禁（≥80%）首次宿主实测：A 65% / L1-live 59%，未达 80% 线
  （基准 88% 为离线 reasoner 富化+扩展 D 臂）；如实记录，待 promotion 用更强扩展模型或 L2 富化复核。
- p95 延迟门禁仍 FAIL：根因（外部 LLM TTFT 超 2.5s timeoutMs）与缓解选项见 §5 分析，未变。

## 7. 0.1.4 诊断迭代（2026-08-16，宿主实测，bundle 0.1.4）

目标：分离"扩展模型能力"与"实时降级"两个变量——human 套件新增 C 臂
（离线 reasoner variants，`human-expanded.json`，deepseek-chat 生成、与基准同口径）。

### 7.1 human 套件三臂（fresh）

| 臂 | recall@1 | 说明 |
|---|---|---|
| A 纯词法 | **65%**（11/17）| 确定性，跨版本复现 |
| C 离线 reasoner variants | **71%**（12/17）| 确定性；宿主与本地 SQLite 评估逐 rank 一致 ✓ |
| L1-live flash 实时 | **65%**（11/17）| 5/17 降级（h2,h6,h8,h10,h17） |

诊断结论：
- **模型能力差距成立**：C − A = +6 点（reasoner variants 把 h18 从 rank5 拉到 rank1、h9 从 miss 拉到 rank2）；
- **降级拖累明显**：本轮 L1-live 5/17 降级 → 恰好跌回 A 臂水平（65%），扩展增益被完全抵消；
- precision@1（信息性）：A 65% / C 71% / L1-live 65%；none 无误报 PASS（3/3 top1 空）。
- C 臂批次方差：基准历史抽样 82%（14/17），本批次 71%（12/17）——LLM 生成物抽样波动，
  V1.11 人类集 C/D 臂方差条款适用；更换 variants 需记录批次（fixture README 已注明）。

### 7.2 variance 复跑（10 轮 × 14 条 hard，每轮清缓存）

- 均值 **49%**（范围 36-71%），门禁双 PASS（≥30% 均值、无单次 <20%）。
- 与 0.1.2 时代 56%（43-71%）对比：均值下降由**降级污染**驱动——本轮每轮 1-9 条查询
  扩展超时降级（中位 5/14），run 级 recall 与降级数强相关；
- 关键观察：**run 1 仅 1/14 降级时达到 71%**（10/14）——扩展正常时 flash+富化在 hard 集
  达到/超过离线 D 臂（50%）水平，说明实时扩展本身的边际质量不输离线 reasoner 批次，
  当前瓶颈在"能不能在 2.5s 内拿到扩展结果"，而非扩展模型能力。
- 后续优化优先级由此数据进一步明确：**先解决降级/延迟（缓存持久化 + timeoutMs），
  再谈更强扩展模型**（换模型只影响未降级查询的边际收益，且可能加剧 TTFT）。

## 8. 0.1.5 可用性迭代（2026-08-16，宿主实测，bundle 0.1.5）

实现：L1 扩展缓存持久化（SQLite `expansion_cache` 表，workspace 隔离；内存+持久两级，
`fresh`/variance 清两级）+ `queryExpansion.timeoutMs` 默认 2500 → 3000。

### 8.1 缓存路径验证（核心收益）

| 验证 | 结果 |
|---|---|
| human fresh（timeout 3000） | 12/17 降级，L1-live 59%（A 65% / C 71%） |
| human 非 fresh | 缓存查询结果与首次逐 rank 一致（复用确定性）；降级 11/17（h15 实时恢复） |
| latency 非 fresh（生产口径） | **缓存 6 条全部 0ms**（h7/h9/h11/h13/h15/h18）；非降级 p95 2517ms（h19 实时） |
| `expansion_cache` 表 | 7 行落库 ✓（6 条 human + h19），workspace 隔离键正确 |
| 跨进程复用 | 单元测试覆盖（新服务实例同 DB 命中持久缓存）；表数据跨重启存在 |

**缓存收益成立**：同查询第二次起 0 延迟、零降级、结果稳定——真实使用中命中查询
p95 ≈ 0；未命中查询仍是实时扩展的原始成本。

### 8.2 timeoutMs 3000 的诚实结论（未达预期）

- latency fresh：**13/17 降级（76%）**，非降级 4 条全部 2.78-2.95s，p95 **2946ms**——
  比 2500ms 时代（9/17 降级、p95 2380ms）更差；
- 根因：当前网络窗口外部 LLM **TTFT 恶化至 2.8-3.0s+**（本会话内从 918-2565ms 退化），
  timeout 3000 仍不够；"调参不能对抗网络退化"——timeout 再上调只会把 p95 推得更高。
- 门禁影响：fresh 口径 p95 依旧 FAIL（非实现缺陷，环境变量）；生产口径（缓存命中）≈0。
- **路线修正**：timeout 调整到此为止（边际无效）；第 4 步"扩展模型路由实测"优先级提升——
  目标从"更强"改为"**更快**"（第三方路由 TTFT 实测），从根上解决降级。
- 回顾：p95/降级门禁连续 3 次记录 FAIL——流程层面建议把门禁口径修订（生产缓存口径）
  或网络条件声明为环境变量，列入后续决策项（第 5 步）。

## 9. 扩展延迟根因链与 0.1.6 修复（2026-08-16）

### 9.1 根因（问题深挖实测闭环，修正此前归因）

扩展请求的 provider/model **跟随会话默认模型**（expand.ts：`provider = 会话默认 provider`，
`model = config.model ?? 会话默认 model`）。此前各版"外部 LLM TTFT"归因是**误读**——
latencyMs 是完整调用时长而非首包；且未核对实际路由。curl 同时刻对照：

| 路由 | TTFT | 总耗时 | 说明 |
|---|---|---|---|
| api.deepseek.com 官方直连（v4-flash） | **~107ms** | 1.0-1.5s | 直连/代理均快；无 thinking |
| commandcode 网关 gpt-5.6-sol（旧默认） | 2.4-3.1s | 3.2-3.9s | timeout3000 下 76% 降级 |
| opencode-go v4-flash thinking 全开 | 3.4s | 11.3s | `reasoning:true` catalog，timeout3000 下 100% 降级 |
| opencode-go v4-flash thinking disabled | ~2.0s | ~3.4s | 网关自身 TTFT ~2s 为物理属性 |

结论链：主模型切到 reasoning/中转路由 → 扩展隐性跟随 → TTFT 超 timeout → 大规模降级。
网络/代理/官方 API 均无辜（官方直连 TTFT 107ms 反例证伪）。

### 9.2 修复（0.1.6）与验证

- `reasoningEffort: 'off'` → llm-pi-ai 将 'off' 翻译为省略 reasoning → pi-ai deepseek 分支
  `thinking: { type: 'disabled' }`——opencode-go v4-flash 总耗时 11.3s → 3.4s ✓
- 部署配置固定 `queryExpansion.model: 'deepseek-v4-flash'`（不配 provider，跟随会话默认，
  用户决策保留 opencode-go 默认）
- 宿主 latency fresh（off 后）：降级 9/17（53%），非降级 2.0-3.0s，p95 3001ms——
  **网关物理 TTFT ~2s 未解**；human fresh L1-live 59% 无退化
- 缓存兜底不变：命中查询 0 延迟零降级（§8）

### 9.3 悬而未决（t000001 已于 §10 闭环；余下两项另见 §10.3）

- 决策 A/B：接受网关 TTFT ~2s vs 0.1.7 加 `queryExpansion.provider` 走官方直连（107ms）；
  用户此前倾向不直连官方（「官方也可能思维链全开」）——已被本节 curl 实测排除，待用户拍板
- p95 ≤2.0s 门禁口径修订（fresh vs 生产缓存口径）：连续 FAIL 均为网关环境变量，建议修订口径

## 10. 扩展降级真因定位与修复（2026-10-30，t000001 闭环）

### 10.1 真因（真机复现，`expansion.reason` 读出）

§9 的归因链（reasoning 模型 thinking 预热）**只覆盖 reasoning 型模型**。生产默认路由早已
换成**无 reasoning 能力**的模型，该侧的降级原因从未被定位——直到 0.1.10 补上
`expansion.reason` 诊断后才读得出来。真机（宿主 dsh 0.2.0-rc.2 真实 pi-ai 服务，
sensenova-6.8-flash-lite / agnes-3.0-flash，2026-10-30）复现：

```
expansion.reason = "stream-error: expansion stream error: provider \"sensenova\"
  model \"sensenova-6.8-flash-lite\" does not support reasoning effort \"off\""
```

宿主 seam 对**模型不具备 reasoning 能力**时的判定（`dsh-llm` `resolveCallWithInfo`）：
`info.reasoning === undefined` 且请求显式带 `reasoningEffort` ⇒ 抛
`UNSUPPORTED_REASONING_EFFORT`。而 0.1.6 的修复把 `reasoningEffort: 'off'` **硬编码**进
扩展请求 ⇒ 对这类模型 100% 降级、检索退化为纯词法。

因果对照（同一真实路由，唯一变量是是否带 `reasoningEffort`）：

| 模型 | 带 `off` | 不带 |
|---|---|---|
| sensenova-6.8-flash-lite（无 reasoning） | 拒（`UNSUPPORTED_REASONING_EFFORT`，0ms） | **OK** 2.6s / 4 variants |
| agnes-3.0-flash（无 reasoning） | 拒（同上） | **OK** 7.5s / 4 variants |
| 声明 `reasoningEfforts` 的模型 | **OK** 4.8s | OK 3.3s（走 `defaultEffort`，思维链开） |

⇒ 两条结论：① 非 reasoning 模型必须**不带**该参数；② reasoning 模型**带** `off` 才是
「关思维链」的正解（§9.2）。二者不可用同一个固定取值覆盖。

### 10.2 修复（0.1.11）：先带、被拒则去参重试

扩展请求仍先带 `reasoningEffort: 'off'`；宿主以 `UNSUPPORTED_REASONING_EFFORT` 拒绝时，
判定该模型无 reasoning 能力，**去掉该参数重试一次**。该拒绝发生在宿主**本地校验**——
不发 provider 请求、零成本、零额外配额（实测拒绝耗时 0ms）。未被拒的模型本就支持
reasoning，保留 `off` 各自走对分支。

**顺序不可反**：宿主对支持 reasoning 的模型在未指定 `reasoningEffort` 时按
`defaultEffort` 处理而**不报错**（上表第三行）⇒ 若先不带，被拒分支永不触发，
reasoning 模型将永久丢掉「关思维链」的收益（§9.2 的 11.3s 慢路径重现）。

修复后真机复验（sensenova-6.8-flash-lite 真实调用）：
`expansion.source = "live"`、`degraded = false`、`variantsCount = 4`（修复前恒为
`degraded: "lexical"` / `source: null`）。

### 10.3 仍未决（与 §9.3 不同的两项，t000002–t000006）

- 延迟门禁（p95 ≤ 2.0s）与 variance 门禁须在**修复后的真实扩展**下复跑——本节修复
  把「100% 降级」变回「真实调用」，此前基于降级态测得的延迟数字全部作废
- L2 enrichment / 查询截断 / human 集校准仍按 §8/§8.3 细则待办

## 11. L2 富化的质量与覆盖率（2026-10-30，t000002 闭环）

> 可复现脚本：`node scripts/enrich-measure.mjs`（hermetic，只用仓内 fixture）
> 对照输入生成：`node scripts/enrich-llm-gen.mjs`（联网 + 真实 provider，人工触发）
>
> **口径警告（2026-10-30 t000003 复测时发现）**：本节数字在 **22 条语料**（12 记忆 + 10
> 过程记录，**无干扰项**）下测得；probe 的生产基线是 **522 条**（22 + 500 干扰项），
> hard D 臂为 **50%** 而非本节的 64%。两口径差在干扰项稀释 BM25 排序，**增益幅度
> （+29pp~+36pp）两口径一致**。规模效应曲线见 §12.4。

### 11.1 一个此前被掩盖的结构性事实：两个查询集在富化维度上互补

| 查询集 | 条数 | 目标落在 | 基准富化覆盖 |
|---|---|---|---|
| hard | 14 | **全部** m1-m12（已富化） | 100% |
| human | 17 有目标（+3 none） | **全部** n1-n10（**未富化**） | 0% |

⇒ 语料 22 条 = 12 条**知识条目**（m1-m12，可被查询的事实）+ 10 条**评审过程记录**
（n1-n10，对话轨迹）。因此：

- hard 集上的任何 L2 数字，都是「**已富化条目**上的富化效果」；
- human 集的 65%/71% 记录是「**零富化**条件下的裸 L1 表现」——**从未测过 human 集的 L2**。

两个集合都不覆盖「部分富化」这一真实场景 ⇒ **L2 的真实增益此前从未被直接测量**。

### 11.2 覆盖率口径（两套分母，不能混用）

| 口径 | 覆盖率 | 说明 |
|---|---|---|
| 知识条目（m1-m12） | **12/12 = 100%** | 知识条目全覆盖 |
| 全量（22 条） | **12/22 = 55%** | 含过程记录 |
| 过程记录（n1-n10） | 0/10 | 评审轨迹，非知识条目 |

⇒ 报「富化覆盖率」必须写明分母。默认口径取**知识条目**（过程记录本非知识，不富化是合理的）。

### 11.3 富化质量：三臂对照（同语料、同查询集、同检索实现）

富化来源为唯一变量；检索走 `store.search`（FTS5 trigram + BM25），与生产同路径。

**纯词法路径（查询 = 原文，不含 L1 变体）**

| 臂 | 富化条数 | hard recall@1 | human recall@1 |
|---|---|---|---|
| 无富化 | 0/22 | 1/14 (7%) | 13/17 (76%) |
| 基准富化（RESULTS-v3 离线产物） | 12/22 | 4/14 (29%) | 13/17 (76%) |
| LLM 新生成（批次 A / 批次 B） | 22/22 | 3/14 (21%) / 5/14 (36%) | 13/17 (76%) |

**L1 路径（查询 = 原文 + 扩展变体，生产真实路径）**

| 臂 | hard recall@1 | 逐条 rank |
|---|---|---|
| 无富化 | 4/14 (29%) | q1:- q2:- q3:- q4:2 q5:1 q6:1 q7:- q8:- q9:- q10:- q11:- q12:1 q13:1 q14:- |
| 基准富化 | **9/14 (64%)** | q1:1 q2:- q3:1 q4:1 q5:1 q6:1 q7:- q8:1 q9:1 q10:- q11:2 q12:1 q13:1 q14:- |
| LLM 新生成（批次 A / 批次 B） | 7/14 (50%) / **9/14 (64%)** | — |

⇒ **复现了 DESIGN 记录的「L1+L2 = 64%」**（DESIGN 的 64% 出自 12 条实验语料，与本节
同口径；此前只有 RESULTS-v3 一份出处。**注意**：这不等于 probe 的 50%——后者是 522 条
含干扰项的生产基线，见本节开头口径警告与 §12.4）。
富化的真实增益 = **+35pp**（29% → 64%），发生在 L1 路径上；增益幅度在 22→522 条全尺度
稳健（+29pp~+36pp，见 §12.4）。

### 11.4 富化的作用是「排序」而非「可达性」——关键机制发现

用 trigram 集合重叠（与生产检索同一字符级机制）度量「查询能否匹配到目标」：

| 查询文本 | 有共享 trigram 的查询数 | 平均 trigram 覆盖率 |
|---|---|---|
| 原文（无富化） | **1/14** | 1% |
| + L1 扩展变体 | **14/14（100%）** | — |
| + L1 扩展 + 基准富化 | 14/14（无增量） | — |

⇒ **L1 扩展已把可达性做到 100%**；富化对它**零增量**。富化的 35pp 增益全部来自
**排序**——把已可达但排在榜外的目标拉进 rank-1（未命中数 9 → 4）。

这解释了 DESIGN 里「write-time enrichment 单独 29% < query-expansion 单独 36%」的实测：
两者管的是不同环节，**不是可替代关系**。

### 11.5 富化质量有采样方差 ⇒ 单次生成不能判定质量

同一模型（sensenova-6.8-flash-lite）两次生成富化：

| 批次 | 纯词法 hard | L1 路径 hard |
|---|---|---|
| A | 3/14 (21%) | 7/14 (50%) |
| B | 5/14 (36%) | **9/14 (64%)** |

⇒ LLM 富化的效果在 **21%–64%** 间波动，**基准富化则完全确定（29% / 64%）**。
差距来源是**内容风格**，不是长度（已隔离：裁到基准长度后 21%，与长版同档）：

- 基准富化的 synonyms 是**抽象概念**：「忽略文件」「不要提交」「知识检索」「词法打分」
- LLM 富化的 synonyms 是**具体实体**：「node_modules目录」「.dsh目录」「SQLite 全文索引」

hard 集是刻意设计的**零词法重叠抽象改写**查询（如「哪些文件不用管版本控制」）⇒
抽象查询只能匹配抽象富化。具体实体富化在 trigram 字符级匹配下反而无用。

### 11.6 结论：L2 值不值得做运行时管线

**值得，但须带质量门禁**——理由与前提：

1. 增益真实且可复现：**+35pp**（29% → 64%，22 条语料口径），全尺度稳健
   （+29pp~+36pp，§12.4）；
2. 增益在**排序**环节，不与 L1 重复 ⇒ 与 L1 叠加而非替代；
3. **但质量不稳定**：LLM 富化 21%–64% 波动，低于基准的确定性 ⇒ 运行时富化
   **必须校验产出质量**（例如抽象度/词法分散度），否则可能把 recall 拉低于纯词法 + L1；
4. 覆盖面不是瓶颈（知识条目口径已 100%），**瓶颈在单条富化的质量**；
5. **人类集尚未验证 L2，且已见负增益**：human 集目标全在未富化的 n1-n10 上，22 条语料
   口径下各臂 human recall@1 恒为 76%（富化对未富化条目零增益）；**522 条含干扰项口径下
   富化反而掉 17pp**（§12.4）——已富化的 m1-m12 文本更易被干扰项匹配、抢走 n 系列的
   rank-1 ⇒ **部分覆盖的富化在有干扰项时可能有害**。需先扩 human 集到知识条目
   （t000005）才能测 L2 在真实查询上的净收益。

⇒ 因此**不实现运行时富化管线**（DESIGN 的队列/idle 批处理/contentHash 幂等守卫等
机制尚未就位，且在质量门禁缺位时收益不确定），而是：

- 先做 **t000005（human 集校准/扩充）**——否则 L2 在真实查询上的效果仍不可测；
- 再评估 **t000002b（运行时富化 + 质量门禁）**，判据含「生成后质量校验」。

本轮**未改 `src/`**（纯度量，零回归风险）；新增两个脚本与一份 fixture。



## 12. 查询截断（maxQueryTrigrams）与实现缺陷（2026-10-30，t000003 闭环）

> 可复现脚本：`node scripts/cap-measure.mjs`（hermetic，只用仓内 fixture）
> **本节未改 `src/`**（纯度量，零回归风险）

### 12.1 问题

DESIGN 规定生产 `maxQueryTrigrams` **默认 24**（`docs/DESIGN.md:135`），但实现默认
**0 = 不限**（`src/index.ts:383`，注释「对齐实验基线；生产可设 24」），README 示例亦为 0。
截断机制本身已实现（`src/search.ts:43` `truncateGrams`，idf 降序保留），
但**从未在任何生产配置下启用**，且**零测试覆盖**。

### 12.2 cap 在生产路径上确实会触发

查询 gram 数分布（生产查询 = 原文 + L1 扩展变体）：

| 查询集 | 最小 | 中位 | 最大 | 超 24 |
|---|---|---|---|---|
| hard + L1 扩展 | 26 | 46 | 52 | **14/14** |
| human + L1 扩展 | 5 | 16 | 57 | 7/17 |
| hard 纯原文 | 8 | 11 | 14 | 0/14 |

⇒ **L1 路径下 hard 集全部超 cap 24**（最小 26）⇒ 截断在生产路径上**每次都触发**，
不是「备而不用」的参数。（纯原文查询则从不触发——扩展开启与否差别巨大。）

### 12.3 截断策略 × 召回（522 条语料，L1 路径）

| 策略 | hard recall@1 | human recall@1 |
|---|---|---|
| 不限 | 7/14 (50%) | 10/17 (59%) |
| **idf 优先 cap24** | **7/14 (50%)** | **10/17 (59%)** |
| idf 优先 cap12 | 7/14 (50%) | 10/17 (59%) |
| 顺序截断 cap24 | 7/14 (50%) | 7/17 (41%) |
| 顺序截断 cap12 | 3/14 (21%) | 6/17 (35%) |

⇒ 两条结论：

1. **idf 优先截断在 cap 24（甚至 12）下召回无损**——逐条 rank 与「不限」完全一致；
2. **顺序截断会丢判别词**——复现 §2 的反例（human 59% → 41% @cap24、35% @cap12），
   印证「生产必须 idf 优先或不限」。

**为何 cap12 与 cap24 无差异**：idf 值只有少数档位（实测最高 2.44、最低 0.00——
出现在所有文档里的 gram idf=0，对排序无贡献）⇒ idf 排序**极早饱和**，
保留约 12 个判别 gram 已足够。⇒ cap 24 有充分余量。

### 12.4 规模效应：富化增益稳健，但绝对值随干扰项下降

（22 条语料 = 无干扰项；522 条 = 22 + 500 干扰项，probe 的生产基线）

| 干扰项 | 总条数 | hard 无富化 | hard 富化 | 增益 | human 无富化 | human 富化 | 增益 |
|---|---|---|---|---|---|---|---|
| 0 | 22 | 29% | 64% | **+35pp** | 76% | 76% | +0pp |
| 50 | 72 | 29% | 64% | **+35pp** | 76% | 59% | **−17pp** |
| 200 | 222 | 21% | 57% | **+36pp** | 76% | 59% | −17pp |
| 500 | 522 | 21% | 50% | **+29pp** | 65% | 59% | −6pp |

⇒ ① **hard 集富化增益在 22→522 条全尺度稳健**（+29pp~+36pp）；绝对值下降是干扰项
稀释 BM25 排序所致（DESIGN 的 64% 与 probe 的 50% 由此对上，§11 口径警告）；
② **human 集上部分覆盖的富化可能有害**（−17pp）：已富化的 m1-m12 文本更易与干扰项
匹配，抢走未富化 n 系列的 rank-1 ⇒ 富化的净收益取决于**覆盖率**，不是单条质量。

### 12.5 实现缺陷清单（4 项，均未修，本轮只记）

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| D1 | **cap>0 触发 `dfOf` O(N) 全表扫描，且每次查询都做**（无缓存） | `src/store.ts:378,421` | cap 想 bound latency，实测反而更慢且**随规模线性变慢** |
| D2 | **`dfOf` 扫全表（含其他 workspace）**，而 `truncateGrams` 注释称「本 workspace 可见文档」 | `src/store.ts:421` | 跨 workspace 文档稀释 idf；当前 50 条干扰规模下排序未变，规模更大时会显现 |
| D3 | **snippet/provenance 用未截断的全量 gram**，截断只作用于 MATCH | `src/index.ts:312` | 检索用 gram 集与展示用 gram 集不一致 |
| D4 | **零测试覆盖**：`truncateGrams` / `dfOf` 无任何用例 | `tests/` | idf 优先的关键行为（顺序 vs idf）无回归护栏 |

D1 的实测代价（cap 24 vs cap 0 的 p95 差值）：

| 语料规模 | cap=0 p95 | cap=24 p95 | 差值 |
|---|---|---|---|
| 72 条 | 0.81ms | 2.16ms | +1.35ms |
| 222 条 | 1.70ms | 4.69ms | +3.00ms |
| 522 条 | 1.28ms | 11.50ms | **+10.22ms** |

⇒ cap=0 恒定 ~1.3ms；cap=24 的额外开销随 N 线性增长（O(N) 扫描）。
**因此「默认 cap 改 24」不能单独做**——必须先给 `dfOf` 加缓存（或改用
`fts5vocab`，但实测 node:sqlite 的 FTS5 未启用 vocab，`t_vocab` 表不存在）。

### 12.6 结论

- **cap 24 + idf 优先在召回上安全**（§12.3，逐条 rank 与不限一致）⇒ 「生产用 idf 优先
  或不限」这条结论成立且已复现；
- **但启用 cap 的实现路径有性能缺陷**（D1）⇒ 默认值从 0 改 24 须与 D1 修复同批做，
  否则把 O(N) 扫描带进生产路径；
- 修复项另开待办（见 `.handoff/`），本轮**不改 `src/`**。
