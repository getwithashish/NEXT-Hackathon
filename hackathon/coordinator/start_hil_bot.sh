#!/bin/bash
# start_hil_bot.sh — Start the HIL Telegram bot listener
# Run this once; it keeps running in background via the process manager.
# 
# Usage:
#   bash start_hil_bot.sh          # start
#   pkill -f hil_bot.py            # stop

cd "$(dirname "$0")"

# Kill any existing instance
pkill -f "python3 hil_bot.py" 2>/dev/null
sleep 1

echo "Starting HIL bot listener..."
python3 hil_bot.py >> /tmp/hil_bot.log 2>&1
