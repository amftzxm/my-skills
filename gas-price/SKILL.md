---
name: gas-price
description: Thailand PTT/Bangchak daily fuel prices with localhost web view + CLI background watchers. Use when user asks about gas price, oil price, ราคาน้ำมัน, GSH95, diesel price in Thailand, or wants to serve/watch/fetch fuel prices.
---

# Gas Price Skill (Thailand)

Main interactive area is CLI. Web page is for visualize only via localhost.

## Quick start

```bash
# serve web view (visualize)
cd ~/gas-price && python3 -m http.server 8000
# open http://127.0.0.1:8000

# watch every X seconds (CLI main)
~/gas-price/watch.sh 5
tail -f ~/gas-price/watch.out

# one-shot noon fetch (saves snapshot)
~/gas-price/noon-fetch.sh
cat ~/gas-price/noon-2026-10-05.txt
```

## Current prices (2026-10-05, effective 2026-10-02 05:00 +0.75 THB)

- GSH95: 40.69 THB/L (user's regular, PTT)
- GSH91: 40.32
- E20: 35.69
- E85: 31.63
- Benzin ULG: 49.68 (PTT)
- Diesel B7: 42.19
- Diesel B20: 37.19
- Premium GSH95: 47.79
- Premium Diesel: 50.05
- Shell FuelSave 95: 41.19, V-Power 95: 51.84

Note: Bangkok base, excl. local tax. Upcountry +0.20-0.50.

## Sources

- https://www.pptvhd36.com/wealth/economic/284606
- https://en.thairath.co.th/news/society/2963769
- https://www.siamnews.com/news/economy/54635
- Upstream: PTT OR (pttor.com), Bangchak, Shell TH, PTG, Susco, Caltex
- US ref: https://gasprices.aaa.com/ ($4.3697 Oct 4 2026)

## Files

- `scripts/watch.sh [seconds]` - loop logger -> `~/gas-price/watch.log`
- `scripts/noon-fetch.sh` - snapshot -> `~/gas-price/noon-*.txt`
- `references/index.html` - localhost page template
- Live dir: `~/gas-price/` (server, logs, outputs)

## User context

- Lives in Thailand, fills GSH95 at PTT
- Prefers CLI main, web for visualize
- Server: localhost:8000 (python http.server)
