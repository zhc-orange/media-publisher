# scripts 说明

这里放自测与开发调试脚本。**日常使用不需要运行它们**。

## 自测（推荐）

```bash
pnpm selftest            # 引擎端到端：本地 mock 平台上传+填写
pnpm selftest:retry      # 页面晚挂载监听时的重试注入
pnpm selftest:parallel   # 双平台并发
pnpm selftest:chrome     # Chrome 通道（真实 Chrome + CDP）跑完整引擎
```

这些脚本会在本机启动 Electron / Chrome，不需要登录真实平台。

## 开发调试脚本

| 脚本 | 用途 |
| --- | --- |
| `probe-page.js` | 打开任意 URL，导出页面字段/按钮结构 |
| `probe-engine.js` | 用 mock 平台跑单个平台的完整引擎流程 |
| `check-login.js` | 用指定 profile 检查各平台登录态 |
| `debug-media.js` | 验证 `app-media://` 预览协议 |
| `inspect-*.js` | 各平台页面结构探测（需要对应平台登录态） |
| `test-*-flow.js` | 真实平台上传/填写验证（需要登录态与测试视频） |
| `make-icon.js` | 生成应用图标 |

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `MP_PROFILE` | 指定 Electron userData 目录（通常是 `%APPDATA%\自媒体发布助手` 的副本） |
| `MP_VIDEO` | 测试视频的绝对路径 |
| `MP_COVER` | 测试封面的绝对路径 |
| `MP_YT_CHANNEL` | YouTube 频道 ID（`inspect-yt-upload.js` 用） |

## 注意

- 这些脚本会读取本机真实登录态，**不要把运行产物（日志、诊断、截图、Cookie）提交到仓库**。
- 真实平台脚本会上传测试视频到对应账号，请使用测试账号或确认可以删除草稿。
- 平台页面改版后，探测脚本本身也可能需要更新。
