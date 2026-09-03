# 部署纪律（本仓库适用，硬性）

本仓库为独立单库（仓库根 = 插件 `dsh-knowledge-sqlite`）。核心规则：

1. 改了本插件源码（`src/`、`lib/`）未发版 → profile 必须以 `file:` 指向本仓库根安装，禁止留在 registry 安装（同版本号不同内容，版本校验失效）。
2. 安装一律走 `dsh plugin --profile web install`，禁裸 `npm install`（会把 peerDependencies 装进 profile，产生第二套 `@deepseek-ai/*` 阴影）。
3. 每次 install / build 后必跑 `npm run check:deploy`。FAIL 必须修复。
4. `file:` 场景禁止手动软链（Node realpath 解析会脱离宿主 fallback）。
5. 本仓库为单一 npm 包，**非 pnpm workspace**：无 `pnpm-workspace.yaml`、无 overrides——勿从旧 monorepo 习惯误抄。
