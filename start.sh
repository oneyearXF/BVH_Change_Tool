#!/bin/bash
# BVH 动画剪辑工具 - 启动脚本
# 启动一个本地 HTTP 服务器（ES modules 需要 HTTP 协议）

PORT=8080
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  🎬 BVH 动画剪辑工具"
echo "========================================"
echo ""

# 找到可用的 Python
PYTHON=""
for cmd in python3 python; do
    if command -v $cmd &> /dev/null; then
        PYTHON=$cmd
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "❌ 未找到 Python，请安装 Python 3"
    echo "   或者使用其他 HTTP 服务器手动启动："
    echo "   npx serve $SCRIPT_DIR"
    echo "   cd $SCRIPT_DIR && npx http-server"
    exit 1
fi

echo "📂 工作目录: $SCRIPT_DIR"
echo "🌐 启动服务器: http://localhost:$PORT"
echo ""
echo "⚠️  请使用现代浏览器打开 (Chrome/Firefox/Edge)"
echo "   页面左上角应显示 '✔ v2.1 修复版' —— 如果没有，说明是旧缓存，按 Ctrl+Shift+R 强制刷新"
echo "   按 Ctrl+C 停止服务器"
echo ""

cd "$SCRIPT_DIR"

# 优先使用禁用缓存的服务器（serve.py），否则退回 python -m http.server
if [ -f "$SCRIPT_DIR/serve.py" ]; then
    SERVER=("$PYTHON" "$SCRIPT_DIR/serve.py" --port "$PORT" --dir "$SCRIPT_DIR")
else
    SERVER=("$PYTHON" -m http.server "$PORT")
fi

# 尝试自动打开浏览器（带随机参数，绕过上一次的缓存）
URL="http://localhost:$PORT/?v=$(date +%s)"
if command -v xdg-open &> /dev/null; then
    xdg-open "$URL" &> /dev/null &
elif command -v open &> /dev/null; then
    open "$URL" &> /dev/null &
fi

"${SERVER[@]}"
