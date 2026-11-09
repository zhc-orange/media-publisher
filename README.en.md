# Media Publisher

A Windows desktop assistant for **semi-automatic** multi-platform video publishing: enter the video info once, and it uploads the video and fills the title, description and tags in each platform's creator studio — then stops before publishing so you can review and click **Publish** yourself.

[中文说明](README.md) · [MIT License](LICENSE)

## Features

- One form, many platforms: video, title, description and tags entered once.
- 7 platforms: Douyin, Kuaishou, Bilibili, Xiaohongshu, WeChat Channels, YouTube, TikTok.
- Serial or concurrent processing (1 / 2 / 3 / all).
- Per-platform retry and page reload; retries are queued while a task is running.
- Local video preview and drag & drop.
- Chinese / English UI.
- Local-first: no telemetry, no cloud; sessions stay on your machine.

## Platform status

| Platform | Browser | Status |
| --- | --- | --- |
| Douyin | embedded Chromium | verified |
| Kuaishou | embedded Chromium | verified |
| Bilibili | embedded Chromium | verified (choose category manually before publishing) |
| Xiaohongshu | embedded Chromium | verified |
| WeChat Channels | embedded Chromium | experimental (QR login required) |
| YouTube | local Chrome window | experimental (Google blocks embedded sign-in) |
| TikTok | local Chrome window | experimental |

**Cover images are not automated yet** — set the cover manually in each platform. Covers use very different UIs (canvas crop, frame picker, AI covers), so a single injector cannot handle them.

## Requirements

- Windows 10 / 11 x64
- Node.js 20+ and pnpm when running from source
- Chrome or Edge installed for YouTube / TikTok, plus a working proxy for Google

## Quick start

Download the installer or portable build from [Releases](https://github.com/zhc-orange/media-publisher/releases).

From source:

```bash
git clone https://github.com/zhc-orange/media-publisher.git
cd media-publisher
pnpm install
pnpm start
```

## How it works

The Electron main process drives each platform in a `WebContentsView` through the Chrome DevTools Protocol: navigate, detect login, inject the video via `DOM.setFileInputFiles`, wait for upload, then fill title/description/tags. YouTube and TikTok use a dedicated local Chrome window over CDP because Google blocks sign-in inside embedded browsers.

Platform behavior is data-driven: entry URL, login selectors, video input, title/content/tag selectors and timeouts live in `src/config/platforms/*.json`.

## Development

```bash
pnpm test            # unit tests (node:test)
pnpm selftest        # end-to-end engine test against a local mock platform
pnpm selftest:retry  # slow-page retry test
pnpm selftest:parallel
pnpm build           # build Windows installer + portable exe into dist/
```

## Privacy

No telemetry. Login sessions, logs and diagnostics are stored under `%APPDATA%\自媒体发布助手\`. Delete that folder to reset everything. Videos are only injected into the platform's own upload page.

## Disclaimer

This project is for learning and personal productivity. It is not affiliated with ByteDance, Kuaishou, Bilibili, Xiaohongshu, Tencent, Google or TikTok. Automation may violate some platforms' terms of service; you are responsible for your account and content.

## License

[MIT](LICENSE) © 2026 zhc-orange
