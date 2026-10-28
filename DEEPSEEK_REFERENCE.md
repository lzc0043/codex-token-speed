# DeepSeek Harness 官方源码参考

权威来源：https://github.com/deepseek-ai/deepseek-harness 。核对固定在`dsh-v0.2.1-rc.3` 标签，提交 `1f81c047fc48fa190a683e469daa699857e9afe8`。

## 实现位置与统计定义

1. [session-stats 规格](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/session/session-stats/README.md)：统计针对完整持久会话日志；分页和压缩不改变计数。
2. [projection.ts](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/session/session-stats/src/projection.ts#L148)：记录 assistant 流首个有效 token 时间；回复组装完成时累计输出 token 和首 token 到完成的墙钟时间。工具计时独立，缺少首 token 或有效 usage 的步骤不进入速度分子、分母。
3. [StatsPills.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-chat/src/client/chat/StatsPills.tsx#L166)：decodeSpeed 使用 decodeTokens / (decodeMs / 1000)；compact 模式的 ActivityPill 只显示速度、UsagePill 只显示缓存命中。通过自己的 conversation.composer.dock 扩展槽挂载。
4. 同文件的 cacheHitPercent（108 行）、billedInputTokens（118 行）使用缓存读取占会话累计输入的比例。DeepSeek 的未缓存输入、缓存读取、缓存写入为互斥计费桶，分母是三者之和。

## Codex 适配

显示只有两项：`42 t/s · 会话缓存 94.2%`。缓存使用会话累计 cached_input_tokens / input_tokens；Codex 的 input 已包含缓存，不能再加一次缓存。

速度使用最近一次已完成模型请求的模型项输出窗口，排除工具执行耗时。Codex 日志没有已确认的真实流首 token 字段，因此速度仍为估算；界面按用户偏好省略近似符号，文档与辅助功能说明保留该限制。不退回输出 / 整轮耗时计算；缺少计时显示 --。

差异：上游速度为会话内可计时步骤的加权结果，本插件当前为最近一次可配对请求，两者不能直接作为同口径速度比较。DeepSeek 的 dock 扩展槽属于其 Cordis 插件体系，Codex 需要单独适配。

实现已按上述固定版本源码核对。真实 Codex 窗口接入仍需单独验证；隔离浏览器和 CI 测试不代表真实客户端接入已通过。
