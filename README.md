# 自媒体发布助手（Media Publisher）

一个 Windows 桌面端的**半自动**多平台发布助手：录入一次视频信息，自动在多个平台的创作中心上传视频并填写标题、简介、话题，**停在发布前，由你手动检查并点击发布**。

[English README](README.en.md) · [MIT License](LICENSE)

> 本项目只做"填写"，不会替你点击发布，也不会绕过平台的风控或验证码。

## 功能

- **一次录入，多平台填写**：视频、标题、简介、话题只填一遍。
- **支持 7 个平台**：抖音、快手、B 站、小红书、微信视频号、YouTube、TikTok。
- **并发 / 串行可选**：1 / 2 / 3 路或全部并发，开始前一次性创建所有标签页。
- **失败可刷新 / 重试**：单平台出结果即可操作；任务进行中重试会自动排队。
- **视频预览与拖拽**：本地播放器预览，支持把视频拖进窗口。
- **中英文界面**：设置里切换「跟随系统 / 中文 / English」。
- **本地优先**：无遥测、无云端，登录态只保存在本机。

## 平台支持

| 平台 | 浏览器 | 状态 | 说明 |
| --- | --- | --- | --- |
| 抖音 | 内置 Chromium | 已验证 | 标题、简介、话题 |
| 快手 | 内置 Chromium | 已验证 | 标题 + 正文合并写入「作品描述」 |
| B 站 | 内置 Chromium | 已验证 | 标题、简介、标签；发布前需手动选分区 |
| 小红书 | 内置 Chromium | 已验证 | 标题、正文、话题 |
| 微信视频号 | 内置 Chromium | 实验性 | 需微信扫码登录；描述 + 话题 |
| YouTube | 本机 Chrome（独立窗口） | 实验性 | Google 拒绝内嵌浏览器登录，故走 Chrome 通道；需登录一次 |
| TikTok | 本机 Chrome（独立窗口） | 实验性 | 同上，可用 Google / 邮箱 / 手机号登录 |

**封面暂未自动化**：各平台封面编辑器差异太大（画布裁剪、选帧、AI 封面等），请在平台上手动设置封面。

选择器、字数上限、体积上限都在 `src/config/platforms/*.json` 中，页面改版时可以只改配置，不用改代码。

## 环境要求

- Windows 10 / 11（x64）
- 从源码运行：Node.js **20+**、pnpm
- YouTube / TikTok：本机安装 Chrome 或 Edge；访问 Google 通常需要可用的代理

## 快速开始

### 方式一：下载安装包

从 [Releases](https://github.com/zhc-orange/media-publisher/releases) 下载：

- `自媒体发布助手-1.0.0-安装版.exe`：安装版
- `自媒体发布助手-1.0.0-便携版.exe`：免安装便携版

> 安装包未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可。

### 方式二：从源码运行

```bash
git clone https://github.com/zhc-orange/media-publisher.git
cd media-publisher
pnpm install
pnpm start
```

也可以直接双击 `start-dev.cmd`（首次会自动安装依赖）。

## 使用流程

1. 选择视频（或直接拖进窗口）。
2. 填写标题、简介、话题（回车添加）。
3. 左侧勾选要发布的平台。
4. 点「开始填写」，选择处理方式（串行 / 2 路 / 3 路 / 全部并发）。
5. 每个平台填好后，切到对应标签页检查，确认无误后**手动点击发布**。
6. 某个平台失败：看进度里的原因，点「诊断」导出页面结构，修复后点「刷新」或「重试」。

首次使用需要登录各平台。抖音 / 快手 / B 站 / 小红书 / 微信视频号在程序内置标签页登录；YouTube / TikTok 会在独立的 Chrome 窗口里打开，登录一次后会长期保存。

## 开发

```bash
pnpm install          # 安装依赖
pnpm start            # 开发模式启动
pnpm test             # 单元测试（node:test）
pnpm selftest         # 引擎端到端自测（Electron + 本地模拟平台）
pnpm selftest:retry   # 慢页面重试自测
pnpm selftest:parallel# 双平台并发自测
pnpm build            # 构建 Windows 安装包 / 便携版（输出到 dist/）
```

单元测试覆盖：配置校验、字数与话题预算、登录判定、注入脚本、并发调度、异常路径（建标签页失败后 running 必须复位）等。

## 工作原理

```
Electron 主进程
├─ 渲染层（表单 / 平台列表 / 进度 / 日志）  ← preload 白名单 IPC
├─ Runner：并发队列、单平台结果、重试队列、历史
├─ Engine：打开页面 → 登录检测 → 注入视频 → 等上传 → 填标题/正文/话题
│   ├─ 内置通道：WebContentsView + CDP（DOM.setFileInputFiles / Input.*）
│   └─ Chrome 通道：本机 Chrome + CDP WebSocket（YouTube / TikTok）
├─ 平台适配器：src/config/platforms/*.json（选择器、文案上限、超时）
└─ 诊断：失败时导出页面字段/按钮结构，便于修选择器
```

- 上传通过 CDP `DOM.setFileInputFiles` 注入，不弹系统文件选择框。
- 字段定位穿透 Shadow DOM；登录判定、上传完成判定都有轮询与超时保护。
- 本地媒体预览走自定义协议 `app-media://`，只读取你选过的文件。

## 项目结构

```
src/main/                主进程（runner / engine / cdp / tab-manager / chrome-channel）
src/renderer/            渲染层（界面、i18n）
src/config/platforms/    平台配置（新增平台主要改这里）
test/                    单元测试
scripts/                 自测与开发调试脚本（见 scripts/README.md）
docs/                    文档（平台适配指南）
build/                   图标等构建资源
```

## 新增平台

在 `src/config/platforms/` 下新增一个 JSON，定义入口、登录检测、视频输入框、标题/正文/话题选择器、上传超时等即可，无需改引擎代码。字段说明见 [docs/platform-adapter.md](docs/platform-adapter.md)。

## 数据与隐私

- 无遥测、无统计上报、无自动更新请求。
- 数据目录：`%APPDATA%\自媒体发布助手\`
  - `Partitions/`：内置浏览器登录态
  - `chrome-profile/`：YouTube / TikTok 的 Chrome 登录态
  - `logs/`、`diagnostics/`：运行日志与诊断报告
- 删除该目录即可清空所有登录态和本地数据。
- 程序不会上传你的视频或账号信息到任何第三方服务器；视频只注入到对应平台的创作中心。

## 已知限制

- 封面需要手动设置。
- 平台页面随时可能改版，选择器可能失效；失败时用「扫描 / 诊断」导出结构后更新 `src/config/platforms/*.json`。
- 微信视频号只能扫码登录；YouTube / TikTok 需要 Chrome 与可用代理。
- Windows 安装包未签名。
- 自动化操作可能违反部分平台的服务条款，请自行评估风险。

## 免责声明

本项目仅供学习与个人效率使用，与抖音、快手、哔哩哔哩、小红书、腾讯、Google、TikTok 等公司均无关联。

使用本工具产生的任何后果（包括但不限于账号限流、封禁、内容纠纷）由使用者自行承担。请遵守各平台的服务条款与社区规范，不要用于垃圾内容、刷量或任何违规行为。

## 贡献

欢迎提交 Issue / PR，尤其是平台选择器更新与兼容性修复。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © 2026 zhc-orange
