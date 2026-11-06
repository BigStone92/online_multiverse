#!/usr/bin/env bash
# Online_Multiverse (산사, 잠깐 쉬어가요) 실행 스크립트

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8860}"
PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")

echo "🏯 Online_Multiverse (산사 3D) 서버 시작 중..."
echo "📡 로컬 주소:      http://localhost:$PORT"
echo "📱 모바일/LAN 주소: http://$LAN_IP:$PORT"

exec "$PYTHON_BIN" "$PROJECT_DIR/main.py" "$PORT"
