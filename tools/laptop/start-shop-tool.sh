#!/bin/sh
# Linux: serves the Globe Haul Shop Tool on http://localhost:8173/ and opens it in Chrome or Chromium.
# From a terminal in this folder:  sh start-shop-tool.sh   (options: --port 8174, --no-browser)
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$@"
fi
echo "python3 isn't installed. Install it (for example: sudo apt install python3) and run this again." >&2
exit 1
