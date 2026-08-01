#!/bin/bash
cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:7788"

alive() { curl -s -o /dev/null --max-time 1 "$URL"; }

# 服务已经在跑，直接开页面
if alive; then
  echo "服务已在运行，正在打开 $URL"
  open "$URL"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先安装 Node.js 20+（https://nodejs.org 或 brew install node），再双击本文件。"
  echo
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi

# 服务起来后自动打开浏览器
( for _ in $(seq 1 60); do alive && { open "$URL"; break; }; sleep 0.5; done ) &

echo "启动中… 浏览器会自动打开 $URL"
echo "关闭本窗口即停止服务。"
echo
node server.js

echo
read -n 1 -s -r -p "服务已停止，按任意键关闭"
