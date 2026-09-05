# dsh-knowledge-sqlite

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/dsh-knowledge-sqlite.svg)](https://www.npmjs.com/package/dsh-knowledge-sqlite)

Cross-session knowledge for DeepSeek Harness: ctx.knowledge service + knowledge_* tools, SQLite FTS5 trigram retrieval (CJK substring) with L1 query expansion. V1.11 contract (write/update/search/list/delete + budget + events + error codes).（与 GitHub about / 包管理器 description 一致；<120 字符，无节标题——Standard Readme #4）。

[English](README.en.md) ｜ 中文为权威版本，翻译可能滞后。


## 状态

<当前状态：活跃开发 / 维护模式 / 验证期（先 N 周真实使用再决定）/ 已归档（欢迎 fork 接手）>


## 功能

- <功能点 1：一句话说清用户得到什么>
- <功能点 2>
- （矩阵实测新增功能点）模板升级新增说明。

## 安装

> 要求 dsh 宿主 >= <peer 版本，如 0.1.2-alpha.4>（见 package.json peerDependencies；旧宿主用户用 <兼容的旧版>）。

```sh
dsh plugin add dsh-knowledge-sqlite
# 或在 profile 的 package.json 加：dsh-knowledge-sqlite: ^x.y.z
# 然后重启 / 重载挂载它的 profile
```

## 使用

<最小可复制示例：命令 / 工具调用 / 点击路径。示例代码块必须可直接粘贴执行。>

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `<field>` | `<default>` | <作用与生效方式（live / 重启生效）> |


## 非目标（边界）

<明确不做什么：本版本刻意不覆盖的场景与原因——非目标能防止范围蔓延（humen/agent 都受益）；
示例措辞：「v0.1 不做 <X>，因为 <原因>」

## 安全

漏洞**不要**公开 issue——走 [SECURITY.md](SECURITY.md) 指定的私密漏洞报告渠道。

## 文档

<!-- 无 docs/ 目录时删除本行；可选：ROADMAP / AUDIT 等 -->
- [设计](docs/DESIGN.md)
- [开发与验证纪律](DEVELOPMENT.md) · [发布流程](PUBLISHING.md)

## 贡献

- 问题与讨论：GitHub Issues / Discussions；是否收 PR 见 [CONTRIBUTING.md](CONTRIBUTING.md)
- AI 协作者先读 [AGENTS.md](AGENTS.md)（含 AI 协作守则）
- 行为准则：尊重、建设性、对事不对人（详见 CONTRIBUTING.md）

## License

[MIT](LICENSE)
