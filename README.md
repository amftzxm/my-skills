# my-skills

Personal agent skills, installable with the `skills` CLI.

## Skills

| Skill | What it does |
|-------|--------------|
| `server.js` | Zero-dep Node web app. Live scores grouped by league at `/`, client polls `/api/live` every 10s, tap a match for its goal-minute timeline at `/timeline/:id`. Adjustable behaviour on `/config`. Runs on `http://localhost:3000` |
| `league_scores.py` | One-shot static page generator (`live.html`). Same data pipeline (homepage + score feed, joined by match id), no server needed |
| `live-scores/` | Agent skill: fast score reader + instructions |

## Server routes

| Route | Purpose |
|-------|---------|
| `/` | Live matches grouped by league (HTML) |
| `/api/live` | JSON poll feed: id, score, clock |
| `/timeline/:id` | Goal minutes for one match, plus "held since" |
| `/config` | Every knob in one page |
| `/config/save` | Persist a setting change |
| `/settings` | Current settings, for the client |
| `/health` | Liveness probe |

Settings live in `config.json` (feed/homepage/goal cache TTLs, poll interval, clock timezone, tick blink, row highlight, held-timer).

## Install

```bash
npx skills add <owner>/my-skills
```

Or symlink a single skill into `~/.agents/skills/`.
