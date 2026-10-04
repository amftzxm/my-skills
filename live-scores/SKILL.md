---
name: live-scores
description: Get live football/soccer match scores and in-play status. Use when the user asks for "live score", "live match", "current scores", "who is winning", "any goals scored", match results right now, or asks about a specific league or fixture that is in play. Reads a plain-text feed from aiscore.mobi — one fast request, no scraping.
---

# Live Football Scores

Returns in-play scores and match status from aiscore.mobi.

## When to Use This Skill

Use this when the user asks about live or current match scores:
- "live score", "live scores", "what's the score"
- "is X playing now", "who's winning"
- "any goals today", "current matches"
- Asks about a fixture currently in play

**Do not** use for finished historical results, fixtures that have not kicked off, league tables, or news. This feed only covers matches currently in progress.

## How to Run It

```bash
python3 ~/.agents/skills/live-scores/live_scores.py
```

Run this first. Do not attempt to scrape the website. One request returns everything.

Output format is one match per line: minute/status, score, then `home vs away`. Present results as a table grouped by state (first half, halftime, second half, full time) when there are more than a few matches.

## How It Works

The site's HTML pages render match containers with **empty** score elements — scores are injected client-side by JavaScript. Do not try to parse the HTML.

Instead, read the feed directly:

```
https://aiscore.mobi/files/tiktok2.txt
```

Returns a JSON array of comma-separated strings. Each record:

| Index | Meaning |
|-------|---------|
| 0 | match id |
| 1 | minute (`45+1`, `HT`, `FT`) or stoppage time |
| 2 | home goals |
| 3 | away goals |
| 10 | corners |
| last two | home and away team names |

Fields in between carry odds, cards, and half-time scores.

The site polls this file every 15 seconds, so it is always current. No auth, no API key.

## Important Notes

- **Region skew.** This feed skews toward Asia-Pacific (Japan, Korea, Hong Kong, Mongolia). European and American leagues may show nothing live during European/US daytime hours, since few matches are actually in play then.
- **Empty is normal.** If the script prints "No live matches right now," that is a correct result, not a failure. Report it plainly.
- **Halftime is common.** Many matches show `HT`, because much of Asia plays while Europe and the Americas are asleep.
- **No league names.** The feed does not include the competition. Teams appear without their league; do not guess or infer one unless the user supplies it.

## Troubleshooting

- If the fetch fails, the network is down or the endpoint moved. Retry once, then report the failure rather than guessing at scores.
- Never fabricate scores. If the feed cannot be read, say so.