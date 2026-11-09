# 贡献指南

感谢参与！这个项目最需要的是**平台页面兼容性**与**选择器更新**。

## 环境

- Windows 10/11
- Node.js 20+、pnpm
- 运行 `pnpm install` 安装依赖

## 提交前

```bash
pnpm test
```

单元测试必须全部通过。涉及引擎/选择器/并发调度的改动，建议再跑：

```bash
pnpm selftest
pnpm selftest:retry
pnpm selftest:parallel
```

## 可以贡献什么

- 平台页面改版后的选择器修复（`src/config/platforms/*.json`）
- 新平台适配（参考 `docs/platform-adapter.md`）
- 上传/登录判定在慢页面、弹窗、Shadow DOM 场景下的稳定性修复
- 文档、英文翻译、UI 文案
- 单元测试与回归用例

## 平台选择器修复

1. 在程序里复现失败，点该平台的「扫描」导出 `diagnostics/*.json`。
2. 根据报告里的 `fields` / `buttons` / `css` 更新对应 JSON。
3. 如果页面结构特殊（Shadow DOM、iframe、自定义组件），在 Issue/PR 里说明。
4. 不要提交包含账号昵称、头像、Cookie、二维码等个人信息的截图或诊断 JSON。

## PR 约定

- 一个 PR 只做一件事，说明"改了哪个平台/哪个问题/如何验证"。
- 不要提交 `node_modules/`、`dist/`、日志、诊断、截图、账号数据。
- 不要引入遥测、自动更新或任何上传用户数据的行为。
- 新增依赖请说明用途，并确认许可证兼容 MIT。

## 安全与隐私

- 不要在任何地方提交 Cookie、token、密码、二维码、手机号。
- 发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开 Issue。
