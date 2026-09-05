# 安全策略

## 支持面

本仓库是 DeepSeek Harness 的跨会话知识库插件（`ctx.knowledge` 服务 + `knowledge_*` 工具）。安全边界值得关注的面：

- **暴露面**：无网络入口（无 HTTP/RPC 端点）；仅通过 Cordis 宿主机制接收 Agent 调用；写入路径受 ask 门控（`tools/pre-execute`）；global scope 写权限限定于 `allowedGlobalWriters` allowlist
- **敏感数据**：SQLite 文件 `~/.dsh/knowledge.sqlite` 存储用户写入的知识条目（workspace 隔离，session-scoped 条目仅本会话可见）；不接触 token、密码、PII
- **对外请求**：L1 查询扩展会调用宿主 LLM 服务（`ctx.get('llm')`），超时降级为纯 lexica，不泄漏 query 内容
- **发布产物**：零运行时外部网络依赖（`dependencies` 全为 dsh 宿主包 alpha.5，经宿主 peer 链可达）

## 报告漏洞

若你发现漏洞或安全缺陷，**不要**公开 issue——到 GitHub 仓库 Security 标签页用私密漏洞报告
（Private vulnerability reporting，首选）。

## 响应

- 确认收到后 72 小时内回复。
- 严重漏洞优先修复并发布补丁版本。
