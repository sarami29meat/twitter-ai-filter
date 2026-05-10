#!/bin/bash
# check.sh — 拡張機能リロード → テストURLに遷移 → ログ確認
TEST_URL="${1:-https://x.com/theutiic/status/205035052064115546}"
WAIT="${2:-8}"

echo "[check] 拡張機能リロード..."
curl -s -X POST http://localhost:7654/reload > /dev/null

sleep 2

echo "[check] Chrome を $TEST_URL に遷移..."
osascript -e "tell application \"Google Chrome\"
  activate
  set URL of active tab of first window to \"$TEST_URL\"
end tell"

echo "[check] ${WAIT}秒待機..."
sleep "$WAIT"

echo ""
echo "===== ログ ====="
cat ~/twitter-ai-filter/dev-logs.txt
echo "===== 終了 ====="
