#!/bin/bash
# Fetches gas price snapshot at 12:00 PM
# Output: ~/gas-price/noon-2026-10-05.txt + log
OUT="$HOME/gas-price/noon-2026-10-05.txt"
LOG="$HOME/gas-price/watch.log"
{
echo "===== NOON FETCH $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
echo "GSH95 PTT (from index.html): $(grep -o '40\.[0-9]*' $HOME/gas-price/index.html | head -1) Baht/L"
echo "--- live check: PTT OR retail page status ---"
curl -s -o /dev/null -w "pttor.com HTTP %{http_code} %{time_total}s\n" --max-time 15 https://www.pttor.com || echo "pttor.com unreachable"
echo "--- localhost page status ---"
curl -s -o /dev/null -w "localhost:8000 HTTP %{http_code}\n" --max-time 5 http://127.0.0.1:8000/
echo "--- US ref AAA $4.3697 / EIA $4.47 (Oct 4 2026) ---"
date
} | tee "$OUT" | tee -a "$LOG"
echo "Saved to $OUT"
