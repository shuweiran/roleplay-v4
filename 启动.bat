@echo off
chcp 65001 >nul
title 🎭 Roleplay v4 - 一键启动

echo.
echo  ╔═══════════════════════════════════════╗
echo  ║     🎭 Roleplay v4                     ║
echo  ║     多智能体角色扮演系统               ║
echo  ╚═══════════════════════════════════════╝
echo.

:: 检查 Python
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 未检测到 Python！
    echo 请先安装 Python 3.10+：https://www.python.org/downloads/
    echo.
    pause
    exit /b
)

echo ✅ Python 已就绪

:: 安装依赖
echo 📦 正在检查依赖...
pip install -q -r %~dp0requirements.txt 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ⏳ 正在安装依赖（首次需要等待）...
    pip install -r %~dp0requirements.txt
)

echo.
echo 🚀 正在启动服务器...
echo 📌 浏览器已自动打开 → http://localhost:8000
echo.
echo 首次使用：打开网页后，点左下角 ⚙️ 设置 → 填入你的 API Key
echo.

:: 打开浏览器
start http://localhost:8000

:: 启动服务
cd /d "%~dp0"
python -m backend.main --port 8000

echo.
pause
