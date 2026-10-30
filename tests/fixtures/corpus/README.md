# 测试语料 fixture（hermetic）

本目录是实验语料的**逐字拷贝**（verbatim copy），供单元测试与本地冒烟独立运行
（不依赖仓库外的 `research/` 目录，CI 可跑）。

- 上游：`<workspace>/research/memory-knowledge-seam/experiments/memory-experiment/`
  （RESULTS-v3 基准实验语料：m1-m12 富化 + n1-n10 提炼 + 500 条 DSH 仓库文档段落干扰项）
- 覆盖：`all-memories.json` / `enriched.json` / `expanded.json` / `distractors.json` /
  `human-queries.json`（20 条真实用户消息，17 有目标 + 3 none）/ `human-expanded.json`
  （human 查询集离线 reasoner variants，C 臂诊断用，0.1.4 起）/ `data.mjs`（hard 查询集）
- `enriched-llm.json`（**本仓 LLM 生成物**，0.1.11 起）：22 条全覆盖的富化，作为
  t000002 度量的**对照输入**（对比 `enriched.json` 的基准富化）。由
  `node scripts/enrich-llm-gen.mjs` 生成，有采样方差（实测两批在 L1 路径下 50% vs 64%），
  `_meta` 记生成时间与 provider/model；**重新生成会改变度量数字**（EXPERIMENTS §11.5）。

## 语料分档（度量口径用）

- **知识条目** `m1-m12`（12 条）：可被查询的事实，基准富化全覆盖
- **评审过程记录** `n1-n10`（10 条）：对话轨迹，非知识条目，基准富化未覆盖

两个查询集在富化维度上互补：hard 集 14 条目标**全在 m1-m12**，human 集 17 条有目标
**全在 n1-n10** ⇒ human 集上的任何数字都是**零富化**条件下的表现（EXPERIMENTS §11.1）。
报「富化覆盖率」必须写明分母（知识条目口径 12/12=100%，全量口径 12/22=55%）。

## 重新同步（语料更新后）

```sh
SRC=<workspace>/research/memory-knowledge-seam/experiments/memory-experiment
cp $SRC/all-memories.json $SRC/enriched.json $SRC/expanded.json \
   $SRC/distractors.json $SRC/human-queries.json $SRC/human-expanded.json $SRC/data.mjs .
```

同步后必须更新 `tests/service.spec.ts` 与 `test-smoke.mjs` 中断言值
（hard 确定性臂 A 7% / C 21% / D 50%、human A 65%、human C 71%）。
`human-expanded.json` 为 LLM 生成物（抽样有方差，见 EXPERIMENTS §7）：更换时需记录批次。
`enriched-llm.json` 同为 LLM 生成物：更换时需记录批次（`_meta` 自动记时间与模型）。
