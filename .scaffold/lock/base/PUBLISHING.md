# 发布记录：dsh-knowledge-sqlite

> 本文件由模板单源拼装（core + 分类 append）：发布通道/发布流程/应急发布由分类 append 决定；
> 共性纪律在 core。

## 发布状态（<日期> 更新）

| 项 | 状态 |
|---|---|
| <发布面> | <版本 / dist-tag 状态> |
| GitHub | `NinjaSln-labs/dsh-knowledge-sqlite` main；发版 tag <tag 格式> |
| 本地验证 | <验证链全绿 + 实测结论> |

## 版本历史

> 每版一行：**做了什么 + 为什么 + 怎么验证的**；重大教训展开写进当版条目。

- **x.y.z** — <一句话主旨>（<日期>）：<要点；breaking 标注；验证方式>


## 发布后验证（共性纪律）

- 确认 latest 已更新（包管理器或 GitHub Release 页）
- provenance/attestations 徽章（按通道）或等价完整性校验
- 实机重装/升级路径实测一遍（面向用户的安装命令照 README 走一遍）

> 通道专属验证命令由分类 append 覆盖（按实际通道选择对应命令）。

## 发布通道（npm OIDC Trusted Publishing）

**认证**：npm **Trusted Publishing（OIDC）**——无需 token，`.github/workflows/publish.yml` 的
`id-token: write` 自动鉴权 + provenance 签名（源仓库 public）。

## 日常发布流程

> 用显式两步而非 `npm version` 自动 commit+tag：npm version 默认打 `v%s` tag，与本库触发器
> `knowledge-sqlite-v*` 不符；且工作树脏时 npm 的自动 commit/tag 会被**静默跳过**（实践库实战）。

```sh
npm version patch --no-git-tag-version               # ① bump 版本（package.json + lockfile）
V="$(node -p "require('./package.json').version")"
git commit -am "chore: release dsh-knowledge-sqlite v$V — <一句话主旨>"
git tag knowledge-sqlite-v$V
git push && git push --tags                          # ② CI 接手：验证链 → 版本守卫 →（审批门）→ npm publish
```

## canary 灰度通道（先灰度再全量）

```sh
npm version prerelease --preid=next --no-git-tag-version
V="$(node -p "require('./package.json').version")"
git commit -am "chore: canary dsh-knowledge-sqlite v$V" && git tag knowledge-sqlite-v$V
git push && git push --tags
# 实测通过 → 晋级 latest：npm dist-tag add dsh-knowledge-sqlite@x.y.z latest
```

## 首次发布前置（一次性）

1. **Trusted Publisher 配置**：npmjs.com 包设置 → Trusted Publisher（owner / repo / `publish.yml`
   文件名逐字段一致；npm 不预校验，配错只在 publish 时报错；首次可能未保存成功——失败先重配一次）
2. **首次 bootstrap**：首版可手动 `npm publish`（本机 `npm login` 交互登录 + 2FA；2025-12 新规后
   npm 网站直接发布新包已禁，CLI 登录流程仍可），随后立即切 Trusted Publishing 由 CI 发布
3. **验证发布成功**：`npm view dsh-knowledge-sqlite dist-tags` + npm 页 provenance 徽章 + `npm audit signatures`

## 应急手动发布（CI 不可用时）

```sh
npm run build && npm run typecheck && npm test && npm publish --access public
```

> 本地手动发布**无法生成 provenance**（需 CI 的 OIDC），不要加 `--provenance`（本地会报错）；
> 本机为 `npm login` 登录态。仅应急用，事后照常走 CI。
> prerelease 应急发布加 `--tag next`（同 CI 分支逻辑，防止占用 latest）。

## 维护要点

- **外部数据源变更**（如 pricing）：更新对应数据文件并同步 `updatedAt`
- **client bundle**：改 client 源码后必须 `npm run build`；host 与 client 变更都需要重启 + 刷新浏览器
- **安全**：无 token 管理（OIDC）；workflow 权限最小化
