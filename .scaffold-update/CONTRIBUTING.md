# 贡献指南

感谢贡献！本文件由模板**单源拼装**（`common/CONTRIBUTING-core.md` + 分类 append）——重复段勿在仓库手改。

## 分支与合并

- **单维护者（默认）**：直接提交 main；push 即触发 CI 验证链；main 保持线性历史。
- **多人协作时**：feature 分支（`feat/<短名>` 或 `fix/<issue号>`）→ PR → CI 绿 + 评审通过后 squash 合并。

## 提交规范

- **Conventional Commits 前缀 + 中文描述**（改了什么 + 为什么）；发布提交格式见下方分类节。
- **机密红线**：本机绝对路径、个人邮箱、token、部署实况快照一律不入库（与 AGENTS.md 同源纪律）。

## 行为准则

简单说：尊重、建设性、对事不对人。维护者会驳回不友善或与主题无关的 issue / PR。

---

<!-- 以下由分类 append 拼装：开发环境命令、部署/验证纪律、发版流程指路 -->

## 开发环境

```sh
npm install --legacy-peer-deps   # peer 由宿主 dsh 运行时提供，本地只装 devDeps 供构建/测试
npm run build                    # tsc → lib/ + esbuild 客户端 bundle（经 scripts/build.mjs 探测）
npm run typecheck
npm test                         # 验证链单源入口：scripts/verify.mjs（build→typecheck→smoke/vitest→mount，探测式）
```

> 首次安装前先按 package.json TODO 填好依赖占位——占位符（`dsh-<用到的宿主包>` 形态）不是合法
> npm 包名，直接 install 会报 EINVALIDPACKAGENAME。`package-lock.json` 必须生成并入库（CI 的
> `npm ci` 依赖它）。

## 部署纪律

涉及 `src/`、`scripts/` 改动会触发 pre-commit 部署纪律自检（启用：`git config core.hooksPath .githooks`）；确属未部署的中间态用 `--no-verify` 并在说明中注明。完整规则见仓库根 AGENTS.md「部署纪律」。

## 发版流程

见 [PUBLISHING.md](PUBLISHING.md)（显式 bump → tag → CI 验证 → OIDC trusted publishing 发布）。
