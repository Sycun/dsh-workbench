# 自定义执行端

在“设置 → 工具接入”创建连接；也可在宿主 `connectors` 配置中提供只读管理的连接。UI 创建的连接留在当前用户状态文件里，宿主连接优先于同名 UI 连接。

## HTTP/JSON 字段

| 字段 | 用途 |
|---|---|
| `id` | 模型调用时使用的稳定连接 ID |
| `adapter` | `http-json`，或已有的 `artex` / `cyberstrikeai` API 适配器 |
| `baseUrl` | HTTP(S) origin，不含路径、查询参数或账户信息；普通 HTTP 仅用于回环地址 |
| `authType` / `tokenRef` | 无认证，或 Bearer 凭据引用；值通过独立凭据入口保存 |
| `healthPath` | 可选的固定 GET 测试路径，由用户点击触发 |
| `statusPath` | 项目状态 GET 路径 |
| `submitPath` | 派工 POST 路径 |
| `bodyTemplate` | JSON 对象，可使用 `{projectId}`、`{taskId}`、`{message}`、`{idempotencyKey}` |
| `runStatusPath` | 可选的执行状态 GET 路径，支持 `{runId}` |
| `runIdField` | 回执中执行 ID 的位置，例如 `runId` 或 `job.id` |

路径变量会进行 URL 编码，JSON 模板变量按字符串替换后再编码。模板不能执行表达式、读取文件或访问环境变量。连接代码拒绝跨 origin 路径和 HTTP 重定向。

例如某个自建工具提供 `GET /health`、`GET /projects/{projectId}`、`POST /jobs`、`GET /jobs/{runId}`，可以按真实服务地址填入这些路径，并选择实际请求字段：

```json
{
  "project": "{projectId}",
  "instruction": "{message}",
  "requestId": "{idempotencyKey}"
}
```

请求会额外携带 `Idempotency-Key` header，但远端是否真正支持幂等需要其自身实现。工作台始终保存提交回执；超时视为未知，先核实再决定下一步。

保存连接之后，选择工作台项目并关联远端标识。没有项目概念的工具可约定一个固定标识，由适配服务解释；工作台不会自行猜测该值。随后由用户为具体任务设置执行范围。

当前适配器仅支持上述任务型 GET/POST JSON 交互。需要更多 HTTP 方法、文件传输、任意数据类型或原生工具 schema 时，可使用 DSH 的 MCP/插件机制，或实现专用适配器。
