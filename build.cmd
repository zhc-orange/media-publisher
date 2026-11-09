@echo off
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [!] 未找到 pnpm，请先安装 Node.js 20+ 并执行: npm i -g pnpm
  pause
  exit /b 1
)

if not exist "node_modules\electron-builder" (
  echo [1/2] 正在安装依赖...
  call pnpm install
  if errorlevel 1 goto fail
)

echo [2/2] 正在打包 Windows x64 版本...
call pnpm run build
if errorlevel 1 goto fail

echo.
echo 打包完成，产物在 dist\ 目录。
pause
exit /b 0

:fail
echo.
echo 打包失败，请检查网络或查看上方日志。
pause
exit /b 1
