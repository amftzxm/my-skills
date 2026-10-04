# my-skills

Personal agent skills, installable with the `skills` CLI.

## Skills

| Skill | What it does |
|-------|--------------|
| `server.js` | Zero-dep Node web app: `/` all live, `/under` under-2 goals, `/held` time-since-last-goal. Runs on `http://localhost:3000` |
| `league_scores.py` | One-shot static page generator (`live.html`). Same source, no server needed |
| `live-scores/` | Agent skill: fast score reader + instructions |

## Install

```bash
npx skills add <owner>/my-skills
```

Or symlink a single skill into `~/.agents/skills/`.
