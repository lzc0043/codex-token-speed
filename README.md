# Codex Token 速度计

给 Codex Desktop 自动显示 **Token/s 与缓存命中率**：

`42 t/s · 会话缓存 94.2%`

启用插件后，Codex 通过插件自带的本地 MCP 服务启动状态条。继续用原来的 Codex 图标；无需每天运行脚本，无需调试端口。适用于 macOS 13+（Apple Silicon / Intel）和 Windows 10/11。

## 安装

复制下面这句话发给 Codex 或其他 Agent，让它帮你安装：

```text
请阅读 https://github.com/lzc0043/codex-token-speed 的 README，先检查并复用兼容的现有 Node.js 环境，帮我安装并启用 Codex Token 速度计，并调用 token_speed_status 验证 MCP 连接状态。
```

**Node.js 版本：推荐 22 或 24，已有 24 无需切换到 22。** Node.js 20.20.2 和 24.22.1 已在 macOS 上通过基础兼容性测试，22 已通过 macOS / Windows CI；尚未验证 Windows 上的 20、24。Node 20 的其他补丁版本未逐一测试，且该版本系列已[停止官方维护](https://nodejs.org/en/about/previous-releases)，因此新安装推荐使用 Node.js 24 LTS。

1. 运行 `node --version` 检查现有环境，按上述兼容情况复用；未安装时，安装 [Node.js 24 LTS](https://nodejs.org/)，确保 Codex 能找到 `node`。
2. 在 Codex 的插件管理中添加本仓库作为插件来源，安装并启用 **Codex Token 速度计**。仓库已包含 `.agents/plugins/marketplace.json`、`plugin.json` 和 `mcp.json`。
3. 打开一个本地聊天。状态条由 MCP 启动，不需要输入启动指令。如果当前聊天没有刷新插件，重新打开聊天或重启 Codex 一次。

也可下载 Release 的完整插件包，解压后将目录添加为本地插件来源。macOS 通用显示程序已包含在包中；Windows 使用系统自带 Windows PowerShell / .NET Framework，无需 .NET SDK。企业策略禁用本地程序或 PowerShell 时无法运行。

已安装 Codex CLI 的用户也可首次执行一次：

```sh
codex plugin marketplace add lzc0043/codex-token-speed
codex plugin add codex-token-speed@codex-token-speed-local
```

这是可从 GitHub / 本地来源安装的插件，**尚未上架 OpenAI 官方公共插件目录**。官方目录对本地 MCP 插件有额外准入和审核要求。[官方打包文档](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)

## 使用和统计口径

指标放在底部操作行内，距窗口底边 27 点，目标与权限及模型名称的文字基线对齐，不另起底栏。保持原有字号，数字比说明深一档并使用等宽字形。速度图标、数字和单位紧凑排列，缓存数字紧随说明，图标按文字视觉中心对齐；固定每组总宽度，余量留在组尾，速度从两位变成四位时缓存组保持原位。向左预留模型控件空间，宽度不足时隐藏，避免重叠。该位置根据窗口几何估计，尚不能读取真实输入栏边界。

背景透明，随窗口移动，不抢焦点，点击穿透。macOS 在 Codex 可见、状态条区域未被其他窗口覆盖时显示，Windows 切换其他应用时隐藏。macOS 过滤全屏顶部辅助窗口并跟随实际内容窗口。这仍是原生附着窗口，Codex 没有公开的输入栏扩展接口，精确对齐依赖真实窗口验收；设置页也可能显示。

| 显示 | 含义 |
| --- | --- |
| `42 t/s` | 最近一次有完整模型项时间窗口的输出速度，使用包含推理 token 的输出总量，排除工具执行时间；本地日志尚无已验证的逐响应生成计时，因此是近似值 |
| `会话缓存 94.2%` | 当前聊天累计缓存输入 token / 累计输入 token；不是上下文占用率 |
| `-- t/s` | 缺少有效计时窗口；两项都未知且闲置时隐藏，正在工作时显示占位 |

同一聊天发送新消息时，保留最近一次完成的测速，收到新用量后更新；它不逐 token 实时测速。模型请求阶段速度图标轻微呼吸，尚未收到新用量的历史速度弱化；工具执行时停止呼吸并弱化历史速度，完成后静止。系统开启减少动态效果时停用呼吸。新聊天尚无用量时以 `--` 占位，切换聊天不会沿用其他聊天的数据。

阶段由本地日志事件驱动；“模型请求中”包含等待响应，并不证明每一刻都有新 token 到达。并行工具全部返回后才恢复模型阶段。界面不通过动画、插值或随机变化伪造测速。

参考 [DeepSeek Harness 官方统计实现](DEEPSEEK_REFERENCE.md)。不显示上下文百分比、费用或 token 总量，不代理模型请求。

## 状态查询与退出

向 Codex 说“查询 Token 速度计状态”，可调用只读工具 `token_speed_status` 查看连接、版本、显示权（overlayOwner）、原生窗口可见状态（overlayVisible）和控件实际收到的文字（displayedText）；overlay 为 standby 表示另一实例持有显示权。activity 表示 idle / generating / tool / complete，speedFresh 表示速度是否来自当前模型阶段的新有效用量，displayLayout 回传原生控件的阶段、弱化和呼吸状态。它只返回指标和诊断状态，不返回聊天正文。

禁用插件或退出宿主 MCP 会话后，其显示进程随 stdin EOF 退出。多个 MCP 会话可存在，但原生锁保证只显示一条状态条，持有者退出后另一个接替。插件不注册系统开机自启。

## 数据与已知限制

- 只在本机读取 `CODEX_HOME`（默认 `~/.codex`）下的会话 JSONL，以及 Codex 本机 IPC 的当前会话事件；不读取认证文件、不上传数据。
- 当前会话选择依赖未稳定公开的 Codex IPC，客户端更新可能需要适配；每 500 毫秒重新核对选中会话，补偿遗漏的切换事件，选择变化立即刷新，丢弃过期异步读取结果；断连、远程聊天和多窗口不猜测其他会话。MCP 生命周期由 Codex 控制，首次连接可能随聊天加载发生。
- macOS 使用 AppKit，Windows 使用系统 WinForms。未签发开发者证书或 Apple 公证；系统安全策略可能要求首次允许。Windows 受企业 PowerShell 策略限制。
- 速度不是 DeepSeek 的真实首 token 解码速度。不能从缺失时间戳的日志还原该值，界面按用户偏好省略近似符号，统计口径仍为估算，缺失数据不编造数值。

## 开发与验证

无需安装 npm 运行依赖：

```sh
npm test
npm run test:native
# macOS 开发者重建通用显示程序（需要 Xcode Command Line Tools）
npm run build:mac
```

CI 在 macOS / Windows 上运行统计、IPC、MCP 协议和原生程序启动/退出测试。CI 不能代替真实 Windows Codex 窗口的视觉验收。实现规格见 [SPEC.md](SPEC.md)，兼容参考与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。

MIT License。
