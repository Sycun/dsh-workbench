# 可选 Kali / Parallels 适配

通用安装保持空配置。已有 HTTP/JSON 工具或 DSH MCP 不需要 Kali。

需要 Kali 时，在自己的 DSH profile `workbench` 配置行中填写本机数据：

```yaml
- id: workbench
  config:
    kali:
      enabled: true
      vm: YOUR_VM_NAME
      guestUser: YOUR_GUEST_USER
      guestBridge: /ABSOLUTE/PATH/TO/bridge.py
```

`guestUser` 为已有 guest 用户，`guestBridge` 必须是该用户可读的绝对路径。`prlctl` 可指定已有 Parallels CLI 的路径；`guestPython` 可指定 guest Python。程序不自动启动虚拟机、不创建账号。

将 `scripts/kali-bridge.py` 显式部署到 guest，在 guest 的 `/etc/dsh-workbench/platforms.json` 填写自己的平台配置。发布的 `kali-platforms.example.json` 刻意保留空列表。平台条目可使用键 `artex` / `cyberstrikeai`，每项需要 `scheme`（http/https）和 `port`；可选 `unit` 用于查询用户自己的 systemd 服务是否启用。仅访问 guest 回环地址。

`deployment/*.service.example` 都是需要手工填写的模板，不能直接安装。填写用户、组和项目绝对路径，并核对现有启动方式之后再启用；插件安装过程不会执行这些模板。

界面通过已有账号登录，令牌留在 DSH 凭据存储，密码不落入插件配置。检查服务每 15 秒至多一次；关闭工作台时没有另建常驻服务。已启用的 systemd 单元负责 guest 开机启动，Docker 策略负责容器恢复；这些本机运维配置不属于仓库发布内容。
