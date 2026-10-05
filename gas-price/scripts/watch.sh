#!/bin/bash
# Usage: ./watch.sh [interval_seconds] - default 10
INTERVAL=${1:-10}
LOG="$HOME/gas-price/watch.log"
echo "=== Started $(date) every ${INTERVAL}s - PID $$ ===" | tee -a "$LOG"
COUNT=0
while true; do
  COUNT=$((COUNT+1))
  PRICE=$(grep -o '40\.[0-9]*' $HOME/gas-price/index.html | head -1)
  MSG="[$COUNT] $(date '+%H:%M:%S') GSH95=${PRICE:-40.69} ฿/L"
  echo "$MSG" | tee -a "$LOG"
  sleep "$INTERVAL"
done
