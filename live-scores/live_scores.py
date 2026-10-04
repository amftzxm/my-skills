#!/usr/bin/env python3
"""Fetch live football scores from aiscore.mobi.

Single request to the site's score feed. No page scraping, no protobuf.
Feed refreshes server-side every ~15s.
"""
import json
import sys
import urllib.request

FEED = "https://aiscore.mobi/files/tiktok2.txt"
UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")


def parse(raw):
    """Split each CSV record into (minute, home_goals, away_goals, home, away).

    Field 0 match id, 1 minute/status, 2 home goals, 3 away goals,
    10 corners, last two fields home and away team names.
    """
    out = []
    for rec in json.loads(raw):
        p = rec.split(",")
        if len(p) < 5:
            continue
        out.append((p[1], p[2], p[3], p[-2], p[-1]))
    return out


def fmt(m):
    st = m[0]
    status = st if st in ("HT", "FT") else st + "'"
    return f"{status:>5}  {m[1]}-{m[2]}  {m[3]} vs {m[4]}"


def main():
    try:
        rows = parse(fetch(FEED))
    except Exception as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1

    if not rows:
        print("No live matches right now.")
        return 0

    print(f"{len(rows)} live matches\n")
    for r in rows:
        print(fmt(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())