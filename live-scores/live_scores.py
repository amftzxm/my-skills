#!/usr/bin/env python3
"""Fetch live football scores from aiscore.mobi with goal timelines.

Single request to the site's score feed. No page scraping, no protobuf.
Feed refreshes server-side every ~15s.

With --timeline (default on for matches with goals), also fetches each
match detail page and extracts goal minutes so a 4-goal match shows
its full held history, e.g. 2-2 [12', 34', 67', 89'] held 8'.
"""
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

FEED = "https://aiscore.mobi/files/tiktok2.txt"
HOME = "https://aiscore.mobi/"
UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"

GOAL_ICONS = ["match-events/goal.png", "match-events/phan-luoi.png"]
MAX_WORKERS = 8


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")


def parse(raw):
    """Split each CSV record into (minute, home_goals, away_goals, home, away, match_id).

    Field 0 match id, 1 minute/status, 2 home goals, 3 away goals,
    10 corners, last two fields home and away team names.
    """
    out = []
    for rec in json.loads(raw):
        p = rec.split(",")
        if len(p) < 5:
            continue
        out.append((p[1], p[2], p[3], p[-2], p[-1], p[0]))
    return out


def build_url_map(page):
    """Match id -> match detail page path, from homepage links."""
    urls = {}
    for m in re.finditer(r"location\.href='(\/match-[^']*vtv(\d+))'", page):
        urls[m.group(2)] = m.group(1)
    return urls


def fetch_goal_minutes(path):
    """Parse goal minutes from a match detail page.

    Each event row is <div class="tr"> with three cells in order:
    home | minute | away. Goals carry a goal icon; cards use the same
    cells, so we test cell contents rather than the row.
    """
    try:
        html = fetch("https://aiscore.mobi" + path)
    except Exception:
        return None

    # The page repeats a goal/own-goal legend after the event table. An
    # unbounded cell match swallows it, making every match look like it
    # scored, so cut it off first.
    cut = html.find("listing-match-note-wrap")
    if cut > 0:
        html = html[:cut]

    goals = []
    for row in html.split('<div class="tr">')[1:]:
        mm = re.search(r"minute-event[^>]*>\s*(\d{1,3})", row)
        if not mm:
            continue
        home = re.search(r'class="td home-event"[^>]*>([\s\S]*?)(?=<div class="td )', row)
        away = re.search(r'class="td away-event"[^>]*>([\s\S]*?)$', row)
        is_goal = lambda cell: cell and any(i in cell.group(1) for i in GOAL_ICONS)
        if is_goal(home) or is_goal(away):
            goals.append(int(mm.group(1)))
    return sorted(set(goals))


def timeline_str(goals, minute):
    """Format goal timeline + held time since last goal."""
    if goals is None:
        return "[?]"
    if not goals:
        return f"[0'] held {minute}'"
    last = goals[-1]
    held = max(0, minute - last)
    return f"[{', '.join(str(g) + "'" for g in goals)}] held {held}'"


def fmt(m, tl=None):
    st = m[0]
    status = st if st in ("HT", "FT") else st + "'"
    score = f"{m[1]}-{m[2]}"
    extra = f"  {tl}" if tl else ""
    return f"{status:>5}  {score}  {m[3]} vs {m[4]}{extra}"


def main():
    show_timeline = "--no-timeline" not in sys.argv
    try:
        feed_raw = fetch(FEED)
        rows = parse(feed_raw)
    except Exception as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1

    if not rows:
        print("No live matches right now.")
        return 0

    live = [r for r in rows if r[0] != "FT"]

    timelines = {}
    if show_timeline and live:
        try:
            page = fetch(HOME)
            urls = build_url_map(page)
        except Exception:
            urls = {}

        targets = []
        for r in live:
            mid = r[5]
            path = urls.get(mid)
            if path and (int(r[1]) + int(r[2]) > 0 or "--all-timeline" in sys.argv):
                targets.append((mid, path))

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            futs = {ex.submit(fetch_goal_minutes, path): mid for mid, path in targets}
            for f in as_completed(futs):
                mid = futs[f]
                try:
                    timelines[mid] = f.result()
                except Exception:
                    timelines[mid] = None

    print(f"{len(live)} live matches\n")
    for r in live:
        mid = r[5]
        tl = None
        if show_timeline:
            g = timelines.get(mid)
            try:
                minute = int(r[0]) if r[0] not in ("HT", "FT") else (45 if r[0] == "HT" else None)
            except ValueError:
                minute = None
            if minute and (int(r[1]) + int(r[2]) > 0 or "--all-timeline" in sys.argv):
                tl = timeline_str(g, minute)
        print(fmt(r, tl))
    return 0


if __name__ == "__main__":
    sys.exit(main())
