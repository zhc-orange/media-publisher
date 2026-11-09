@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次启动，正在安装依赖（需要网络，约 1-3 分钟）...
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [!] 未找到 pnpm，请先安装 Node.js 20+ 并执行: npm i -g pnpm
    pause
    exit /b 1
  )
  call pnpm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动自媒体发布助手...
call pnpm start
