#!/usr/bin/env python3
"""Generate a static HTML page of live scores grouped by league.

Fetches aiscore.mobi's homepage (for league names) and the score feed
(for scores), joins them by match id, and writes live.html.

Usage:
    python3 league_scores.py [output.html]
"""
import datetime
import html
import json
import re
import sys
import urllib.request
from collections import defaultdict

HOME = "https://aiscore.mobi/"
FEED = "https://aiscore.mobi/files/tiktok2.txt"
UA = ("Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 "
      "Chrome/120 Mobile Safari/537.36")


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout).read().decode(
        "utf-8", "replace")


def build_maps(page):
    """League id -> name, and match id -> league id.

    Each league heading carries data-leaid; each match container
    (matchDiv) carries data-mlid pointing at its league. That id link is
    what makes the join reliable.
    """
    leagues = {}
    for m in re.finditer(
            r'data-leaid="(\d+)"(.{0,700}?)</div>\s*<div  id="tb_', page,
            re.S):
        name = re.search(
            r'<a class="leaRow" href="javascript:void\(0\);">(.*?)</a>',
            m.group(2))
        if name:
            leagues.setdefault(m.group(1), name.group(1).strip())

    match_to_league = {
        m.group(1): m.group(2)
        for m in re.finditer(r'<div  id="tb_(\d+)" data-mlid="(\d+)"', page)
    }
    return leagues, match_to_league


def parse(raw):
    """Score feed records: id, minute, home, away, ..., homeName, awayName."""
    return [r.split(",") for r in json.loads(raw) if r.count(",") > 4]


def status_label(minute):
    if minute in ("HT", "FT"):
        return minute
    return minute + "'"


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Live Scores</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:16px; background:#0f1115; color:#e6e6e6;
    font:15px/1.5 system-ui,-apple-system,sans-serif; }}
  h1 {{ font-size:20px; margin:0 0 4px; }}
  .meta {{ color:#8a8f98; font-size:13px; margin-bottom:20px; }}
  section {{ background:#171a21; border:1px solid #242833;
    border-radius:10px; margin-bottom:12px; overflow:hidden; }}
  h2 {{ font-size:13px; font-weight:600; color:#9ecbff; padding:10px 14px;
    margin:0; background:#1b1f28; border-bottom:1px solid #242833;
    display:flex; justify-content:space-between; gap:10px; }}
  h2 .count {{ color:#6b7280; font-weight:400; }}
  ul {{ list-style:none; margin:0; padding:0; }}
  li {{ display:grid; grid-template-columns:56px 46px 1fr; gap:10px;
    align-items:baseline; padding:8px 14px;
    border-bottom:1px solid #1f232d; }}
  li:last-child {{ border-bottom:none; }}
  .min {{ color:#f0b429; font-variant-numeric:tabular-nums;
    font-size:13px; text-align:right; }}
  .min.ft {{ color:#6b7280; }}
  .score {{ font-weight:700; font-variant-numeric:tabular-nums;
    color:#fff; }}
  .teams {{ color:#cfd3da; }}
  .lead {{ color:#4ade80; }}
  .empty {{ color:#8a8f98; padding:20px; text-align:center; }}
  footer {{ color:#6b7280; font-size:12px; margin-top:20px;
    text-align:center; }}
</style>
</head>
<body>
<h1>Live Scores</h1>
<p class="meta">{count} matches &middot; {leagues} leagues &middot;
generated {now} (auto-refreshes every 60s)</p>
{sections}
<footer>Source: aiscore.mobi</footer>
</body>
</html>"""



def render(groups, now):
    chunks = []
    ordered = sorted(groups.items(),
                     key=lambda kv: (kv[0] == "(unknown)", -len(kv[1]),
                                    kv[0]))
    for league, rows in ordered:
        items = []
        for p in rows:
            label = status_label(p[1])
            cls = "min ft" if label in ("HT", "FT") else "min"
            home, away = html.escape(p[30]), html.escape(p[31])
            try:
                hg, ag = int(p[2]), int(p[3])
                if hg > ag:
                    home = '<span class="lead">%s</span>' % home
                elif ag > hg:
                    away = '<span class="lead">%s</span>' % away
            except ValueError:
                pass
            items.append(
                '<li><span class="%s">%s</span>'
                '<span class="score">%s-%s</span>'
                '<span class="teams">%s vs %s</span></li>'
                % (cls, html.escape(label), html.escape(p[2]),
                   html.escape(p[3]), home, away))
        chunks.append(
            '<section><h2><span>%s</span><span class="count">%d</span>'
            '</h2><ul>%s</ul></section>'
            % (html.escape(league), len(rows), "".join(items)))

    total = sum(len(v) for v in groups.values())
    if not total:
        chunks.append('<div class="empty">No live matches right now.</div>')

    return PAGE.format(count=total, leagues=len(groups), now=now,
                       sections="\n".join(chunks))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "live.html"

    try:
        page = fetch(HOME)
        raw = fetch(FEED, timeout=20)
    except Exception as exc:
        print("fetch failed: %s" % exc, file=sys.stderr)
        return 1

    leagues, match_to_league = build_maps(page)
    rows = parse(raw)

    groups = defaultdict(list)
    live = 0
    for p in rows:
        if p[1] == "FT":        # finished, not live
            continue
        live += 1
        league = leagues.get(match_to_league.get(p[0])) or "(unknown)"
        groups[league].append(p)

    now = datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=7))
    ).strftime("%Y-%m-%d %H:%M GMT+7")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(render(dict(groups), now))

    matched = sum(1 for p in rows if p[1] != "FT"
                  and match_to_league.get(p[0]) in leagues)
    print("wrote %s: %d live in %d leagues (%d/%d league-matched, "
          "%d finished skipped)"
          % (out, live, len(groups), matched, live, len(rows) - live))
    return 0


if __name__ == "__main__":
    sys.exit(main())
