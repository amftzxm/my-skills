#!/usr/bin/env python3
"""
Minimal live match logger for under-betting strategy.
Polls /api/live, fetches /timeline/:id for each match, stores to SQLite.
Run in background:  nohup python3 log_matches.py > logger.log 2>&1 &
"""

import sqlite3
import time
import json
import urllib.request
import signal
import sys
from datetime import datetime

BASE = "http://localhost:3000"
DB_PATH = "/data/data/com.termux/files/home/my-skills/matches.db"
POLL_INTERVAL = 30  # seconds

# ---------- DB schema ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    home TEXT,
    away TEXT,
    league TEXT,
    first_seen TEXT,      -- ISO timestamp when we first saw it live
    last_seen TEXT,       -- ISO timestamp of last update
    status TEXT           -- 'live', 'HT', 'FT'
);

CREATE TABLE IF NOT EXISTS events (
    match_id TEXT,
    minute INTEGER,       -- 0-90+ (null for HT/FT)
    raw_minute TEXT,      -- "45+2", "HT", etc.
    home_score INTEGER,
    away_score INTEGER,
    captured_at TEXT,     -- when we recorded this snapshot
    PRIMARY KEY (match_id, captured_at)
);

CREATE TABLE IF NOT EXISTS goals (
    match_id TEXT,
    minute INTEGER,
    team TEXT,            -- 'home' or 'away'
    scorer TEXT,
    is_penalty INTEGER,   -- 0/1
    PRIMARY KEY (match_id, minute, team, scorer)
);

CREATE TABLE IF NOT EXISTS cards (
    match_id TEXT,
    minute INTEGER,
    team TEXT,            -- 'home' or 'away'
    type TEXT,            -- 'yellow' or 'red'
    PRIMARY KEY (match_id, minute, team, type)
);

CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);
CREATE INDEX IF NOT EXISTS idx_goals_match ON goals(match_id);
CREATE INDEX IF NOT EXISTS idx_cards_match ON cards(match_id);
"""

def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.commit()
    return con

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

def upsert_match(con, m, now):
    con.execute("""
        INSERT INTO matches (id, home, away, league, first_seen, last_seen, status)
        VALUES (?, ?, ?, ?, ?, ?, 
            CASE WHEN ? IN ('HT','FT') THEN ? ELSE 'live' END)
        ON CONFLICT(id) DO UPDATE SET
            last_seen=excluded.last_seen,
            status=excluded.status
    """, (m['id'], m['home'], m['away'], m['league'], now, now, m['statusLabel'], m['statusLabel']))

def insert_snapshot(con, m, timeline, now):
    # events table - score progression snapshot
    row = timeline.get('row', [])
    raw_min = row[1] if len(row) > 1 else m['statusLabel']
    home_sc = int(row[2]) if len(row) > 2 else 0
    away_sc = int(row[3]) if len(row) > 3 else 0
    minute = timeline.get('minute')
    
    con.execute("""
        INSERT OR IGNORE INTO events (match_id, minute, raw_minute, home_score, away_score, captured_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (m['id'], minute, raw_min, home_sc, away_sc, now))

    # goals
    for g in timeline.get('goals', []):
        con.execute("""
            INSERT OR IGNORE INTO goals (match_id, minute, team, scorer, is_penalty)
            VALUES (?, ?, ?, ?, ?)
        """, (m['id'], g['minute'], g['team'], g.get('scorer'), 1 if g.get('isPenalty') else 0))

    # cards
    for c in timeline.get('cards', []):
        con.execute("""
            INSERT OR IGNORE INTO cards (match_id, minute, team, type)
            VALUES (?, ?, ?, ?)
        """, (m['id'], c['minute'], c['team'], c['type']))

def main():
    con = init_db()
    print(f"[{datetime.now()}] Logger started. DB: {DB_PATH}")
    
    def shutdown(sig, frame):
        print(f"\n[{datetime.now()}] Shutting down...")
        con.close()
        sys.exit(0)
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        try:
            now = datetime.now().isoformat()
            live = fetch(f"{BASE}/api/live")
            
            for m in live.get('matches', []):
                upsert_match(con, m, now)
                
                # fetch full timeline
                try:
                    tl = fetch(f"{BASE}/timeline/{m['id']}")
                    insert_snapshot(con, m, tl, now)
                except Exception as e:
                    print(f"  [!] timeline {m['id']}: {e}")
            
            con.commit()
            print(f"[{now}] Polled {len(live.get('matches', []))} live matches")
            
        except Exception as e:
            print(f"[{datetime.now()}] Error: {e}")
        
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()