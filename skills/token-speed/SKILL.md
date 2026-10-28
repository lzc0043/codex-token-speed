---
name: token-speed
description: 查询 Codex Token 速度计的 t/s、缓存命中率和自动显示连接状态。
---

调用本插件 MCP 的 `token_speed_status` 工具查询状态。状态条由 Codex 自动启动的本地 MCP 服务负责，无需用户手动运行启动脚本。

解释指标时：t/s 是最近有时间窗口的模型输出近似速度，缓存命中率是会话累计缓存输入占比。缺失值保持 `--`，不能把上下文占用率解释成缓存命中率。

若状态为 disconnected / waiting-session，建议重新打开一个本地聊天以重新发送选中会话事件；multiple-windows 需仅保留一个 Codex 主窗口，remote-session 表示远程日志不在本机。显示进程错误按工具返回报告，不自行修改 Codex 文件、安全策略或开调试端口。
