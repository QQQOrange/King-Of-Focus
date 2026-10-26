@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   King of Focus  浏览器插件安装
echo ============================================
echo.
echo Chrome / Edge 从 2014 年起就禁止安装"非应用商店"的 .crx，
echo 所以请用下面这种方式（100% 可用，30 秒搞定）：
echo.
echo   1. 接下来会自动打开扩展管理页和插件目录
echo   2. 在扩展管理页右上角打开「开发者模式」
echo   3. 点「加载已解压的扩展程序」，选中弹出的 extension 文件夹
echo   4. 装完回到主程序，侧边栏显示「浏览器插件：已连接」即成功
echo.
pause

start "" "extension"
start "" msedge.exe "edge://extensions" 2>nul
start "" chrome.exe "chrome://extensions" 2>nul

echo.
echo 已尝试打开浏览器。如果没反应，请手动在地址栏输入 chrome://extensions 或 edge://extensions
echo.
pause
