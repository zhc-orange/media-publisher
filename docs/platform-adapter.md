# 平台适配指南

每个平台是一个 JSON 文件，放在 `src/config/platforms/`。改配置不需要动引擎代码。

## 最小示例

```json
{
  "id": "example",
  "name": "示例平台",
  "nameEn": "Example",
  "order": 10,
  "entry": "https://example.com/creator/upload",
  "note": "需登录",
  "noteEn": "Login required",
  "limits": { "title": 30, "description": 1000, "tags": 10, "maxFileMB": 2048 },
  "loginCheck": {
    "selectors": [".avatar"],
    "rejectTexts": ["登录", "扫码登录"],
    "urlExcludes": "/login",
    "timeoutMs": 600000
  },
  "video": {
    "input": ["input[type=\"file\"]"],
    "accept": "video",
    "openButton": ["text=上传视频"],
    "timeoutMs": 180000
  },
  "title": { "selectors": ["input[placeholder*=\"标题\"]"] },
  "content": { "selectors": ["div[contenteditable=\"true\"]"] },
  "tags": { "mode": "inline-hash", "prefix": "#" },
  "upload": {
    "doneSelectors": [".video-preview"],
    "pendingTexts": ["上传中"],
    "timeoutMs": 1800000,
    "stallTimeoutMs": 180000
  }
}
```

## 字段说明

| 字段 | 说明 |
| --- | --- |
| `entry` | 创作中心入口 URL |
| `engine` | `electron`（默认，内置浏览器）或 `chrome`（本机 Chrome 独立窗口） |
| `uploadEntry` | 可选，上传页模板，支持 `{channelId}` 占位（YouTube 用） |
| `combineTitleDesc` | 为 `true` 时标题与正文合并写入 `title.selectors` 指向的同一个输入框（快手） |
| `loginCheck.selectors` | 登录后才有的元素；为空时依赖 `hasFileInput` 判定 |
| `loginCheck.rejectTexts` | 登录页特征文案，命中即视为未登录 |
| `loginCheck.urlExcludes` | URL 包含该片段时视为未登录 |
| `video.input` | 视频文件输入框选择器（支持 Shadow DOM） |
| `video.openButton` | 找不到输入框时依次点击的入口（`text=...` 表示按可见文本匹配） |
| `video.initialWaitMs` | 首次等待输入框的时间（慢页面可调大） |
| `title` / `content` | 标题、正文选择器；`content.selectors` 为空表示该平台没有独立正文 |
| `tags.mode` | `inline-hash`（正文后追加 `#话题`）、`enter-input`（逐个回车）、`comma-input`（逗号分隔）、`none` |
| `upload.doneSelectors` | 上传完成的 DOM 标志 |
| `upload.pendingTexts` | 上传中的页面文案（注意不要把「转码中」误判成上传中） |
| `upload.timeoutMs` | 总超时 |
| `upload.stallTimeoutMs` | 无进展超时 |

## 调试技巧

1. 程序里点该平台「扫描」，会在 `%APPDATA%\自媒体发布助手\diagnostics\` 生成页面结构 JSON。
2. 重点看 `page.fields`（输入框、contenteditable、placeholder、css）与 `page.buttons`。
3. 页面内容在 Shadow DOM 里也能扫到（`inShadow: true`）。
4. 修改 JSON 后重启程序生效。
5. 失败时日志会说明卡在哪一步（打开 / 登录 / 注入 / 上传 / 标题 / 正文 / 话题）。

## 注意事项

- 选择器优先用稳定的 `id` / `placeholder` / `aria-label`，少用易变的 class。
- 上传完成判定尽量同时依赖 `doneSelectors` 与 `pendingTexts`，避免"还没上传完就填标题"。
- 封面暂未自动化，不要配置 `cover` 期望自动生效。
- 不要把账号 Cookie、二维码、昵称等个人信息写进配置或提交到仓库。
