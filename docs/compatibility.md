# 接口核对与验证边界

核对日期：2026-11-11。以下依据本机已安装源码，均未据此发起实际业务工作。

| 组件 | 已核对源码 | 结论 |
|---|---|---|
| DSH | `@deepseek-ai/dsh-tools/lib/index.js` | `defineTool` 参数使用 DSH schema DSL；object 必须明确 additionalProperties |
| DSH | `dsh-client-ui-sidebar/README.zh.md`；`dsh-client-ui-schedule/lib/client.js` | 主面板使用 `main` keyed slot 与同 id 的 `sidebar.panellist` |
| DSH | `dsh-api-session-controller/lib/typert.remote-client.js` | create 接受 cwd/sessionId；prompt 使用 requestId/sessionId/content，mode 为 queue 或 steer |
| DSH | `dsh-client-ui-workspace/lib/client.js` | 打开会话使用 `uiWorkspace.openSession` |
| DSH | `dsh-tool-ask-user/lib/index.js` | 原生人工问答存在；本版本工作台使用独立持久决策记录 |
| CyberStrikeAI | `internal/handler/openapi_agent_runs.go`、`async_agent_runs.go`、`agent.go` | 异步派工、项目绑定、幂等键、持久回执与状态查询 |
| ARTEX | `server/server.go`、`task_control.go` | task/chat 状态、消息派工；创建任务可能立即运行，任务暂停与主对话控制不同 |

DSH 宿主版本 `0.2.2-rc.1`，桌面包声明构建 commit `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`。本机安装含本地修复，兼容性结果不能推广到所有同版本发行版。

验证分层：

- `npm test`：临时目录内验证任务状态、并发持久化、恢复、人工决策、隔离、幂等、网络故障行为和 React 渲染。执行端使用模拟响应。
- `npm run check:host`：导入已安装 DSH 的真实 `defineTool` 校验 7 个工具；宿主服务使用替身检查注册；生成的客户端模块使用 React 服务端渲染。此脚本本身不启动 DSH 桌面；实际桌面测试另行记录。
- 已实测：本机桌面加载；原生员工会话派工；阶段计划、回报、持久问题和用户答复恢复；员工能看到 workbench_* 与 memory_* 工具；两平台服务可达。
- 未验证：复杂模糊意图判断质量、跨平台业务派工/取消、实际 Kali 重启后的服务恢复、生产项目交付。

不把“代码中存在接口”“模块能导入”“替身测试通过”写成“真实系统已接通”。

桌面实测暴露并修复：API 路由改用 `connection.fetch`；客户端显式注入 `remote.session` / `remote.workspace`；正确解包 DSH `{ ok, value, error }` RPC 返回；原生工作区归属通过 workspaceId 传递。

2026-11-11 安装验证：两个平台均通过真实登录并由状态接口确认认证有效；目录绑定及原生工作区关联已装入桌面版。新增与现有目录、默认工作区、对话补充消息和令牌处理由 20 项本地测试覆盖。没有为验证重启 Kali 或派发生产工作。
