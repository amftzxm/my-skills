#!/usr/bin/env node
/**
 * Live scores web app - zero dependencies.
 *
 *   node server.js          # http://localhost:3000
 *   PORT=8080 node server.js
 *
 * On each request it fetches aiscore.mobi's homepage (league names) and
 * the score feed (scores), joins them by match id, and returns HTML.
 * The homepage is cached since it is ~3.6MB and leagues change slowly.
 */
'use strict';

const http = require('http');

const HOME = 'https://aiscore.mobi/';
const FEED = 'https://aiscore.mobi/files/tiktok2.txt';
const PORT = Number(process.env.PORT) || 3000;
const HOME_TTL_MS = 10 * 60 * 1000;
const FEED_TTL_MS = 10 * 1000;
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 ' +
  'Chrome/120 Mobile Safari/537.36';

const cache = { home: null, feed: null };

async function get(url, ttl) {
  const key = url === HOME ? 'home' : 'feed';
  const hit = cache[key];
  if (hit && Date.now() - hit.at < ttl) return hit.text;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  const text = await res.text();
  cache[key] = { text, at: Date.now() };
  return text;
}

/**
 * League id -> name, and match id -> league id.
 *
 * League headings carry data-leaid; each match container (matchDiv)
 * carries data-mlid pointing at its league. That id link is what makes
 * the join reliable - guessing by document position matches nothing.
 */
function buildMaps(page) {
  const leagues = new Map();
  const headRe = /data-leaid="(\d+)"([\s\S]{0,700}?)<\/div>\s*<div  id="tb_/g;
  let m;
  while ((m = headRe.exec(page)) !== null) {
    const name = m[2].match(/<a class="leaRow" href="javascript:void\(0\);">([\s\S]*?)<\/a>/);
    if (name && !leagues.has(m[1])) leagues.set(m[1], name[1].trim());
  }
  const matchToLeague = new Map();
  const rowRe = /<div  id="tb_(\d+)" data-mlid="(\d+)"/g;
  while ((m = rowRe.exec(page)) !== null) matchToLeague.set(m[1], m[2]);
  return { leagues, matchToLeague };
}

/** Score feed record: id, minute, home, away, ..., homeName, awayName. */
function parseFeed(raw) {
  return JSON.parse(raw.trim())
    .map((r) => r.split(','))
    .filter((p) => p.length > 5);
}

function statusLabel(minute) {
  return minute === 'HT' || minute === 'FT' ? minute : minute + "'";
}

function groupByLeague(page, feedRaw) {
  const { leagues, matchToLeague } = buildMaps(page);
  const groups = new Map();
  let live = 0;
  let matched = 0;
  for (const p of parseFeed(feedRaw)) {
    if (p[1] === 'FT') continue;
    const league = leagues.get(matchToLeague.get(p[0]));
    if (league) matched++;
    const key = league || '(unknown)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
    live++;
  }
  return { groups, live, matched };
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Fixed bottom tab bar. A bottom bar rather than a top nav because the
 * user is on a phone: the thumb reaches the bottom of the screen far
 * more easily than the top, and it never competes with the sticky
 * filter bar for space.
 */
const NAV_ITEMS = [
  ['/', '\u26BD', 'All Live'],
  ['/under', '\u2B07', 'Under 2'],
  ['/held', '\u23F1', 'Held'],
];

function navBar(active) {
  const tabs = NAV_ITEMS.map(([href, icon, label]) => {
    const on = href === active ? ' class="tab on"' : ' class="tab"';
    const cur = href === active ? ' aria-current="page"' : '';
    return (
      `<a href="${href}"${on}${cur}>` +
      `<span class="ic" aria-hidden="true">${icon}</span>` +
      `<span>${label}</span></a>`
    );
  }).join('');
  return `<nav class="tabs" aria-label="Sections">${tabs}</nav>`;
}

// Shared with both templates so the two pages cannot drift apart.
const NAV_CSS = `
  .tabs { position:fixed; left:0; right:0; bottom:0; z-index:30;
    display:flex; background:#12151c; border-top:1px solid #242833;
    padding-bottom:env(safe-area-inset-bottom); }
  .tab { flex:1; text-align:center; text-decoration:none; color:#6b7280;
    padding:8px 4px 9px; font-size:11px; font-weight:600; letter-spacing:.02em;
    display:flex; flex-direction:column; align-items:center; gap:3px;
    min-height:52px; border-top:2px solid transparent;
    -webkit-tap-highlight-color:transparent; }
  .tab .ic { font-size:18px; line-height:1; }
  .tab.on { color:#4ade80; border-top-color:#4ade80; background:#16211a; }
`;

function renderPage(groups, live, matched, now) {
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === '(unknown)') return 1;
    if (b[0] === '(unknown)') return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  const sections = ordered
    .map(([league, rows]) => {
      const items = rows
        .map((p) => {
          const label = statusLabel(p[1]);
          const cls = label === 'HT' || label === 'FT' ? 'min ft' : 'min';
          let home = esc(p[30]);
          let away = esc(p[31]);
          const hg = Number(p[2]);
          const ag = Number(p[3]);
          if (!Number.isNaN(hg) && !Number.isNaN(ag)) {
            if (hg > ag) home = '<span class="lead">' + home + '</span>';
            else if (ag > hg) away = '<span class="lead">' + away + '</span>';
          }
          return (
            '<li><span class="' + cls + '">' + esc(label) + '</span>' +
            '<span class="score">' + esc(p[2]) + '-' + esc(p[3]) + '</span>' +
            '<span class="teams">' + home + ' vs ' + away + '</span></li>'
          );
        })
        .join('');
      return (
        '<section><h2><span>' + esc(league) + '</span>' +
        '<span class="count">' + rows.length + '</span></h2>' +
        '<ul>' + items + '</ul></section>'
      );
    })
    .join('');

  const body = live ? sections
    : '<div class="empty">No live matches right now.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Live Scores</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px 16px 68px; background:#0f1115; color:#e6e6e6;
    font:15px/1.5 system-ui,-apple-system,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  .meta { color:#8a8f98; font-size:13px; margin-bottom:20px; }
  section { background:#171a21; border:1px solid #242833;
    border-radius:10px; margin-bottom:12px; overflow:hidden; }
  h2 { font-size:13px; font-weight:600; color:#9ecbff; padding:10px 14px;
    margin:0; background:#1b1f28; border-bottom:1px solid #242833;
    display:flex; justify-content:space-between; gap:10px; }
  h2 .count { color:#6b7280; font-weight:400; }
  ul { list-style:none; margin:0; padding:0; }
  li { display:grid; grid-template-columns:56px 46px 1fr; gap:10px;
    align-items:baseline; padding:8px 14px;
    border-bottom:1px solid #1f232d; }
  li:last-child { border-bottom:none; }
  .min { color:#f0b429; font-variant-numeric:tabular-nums;
    font-size:13px; text-align:right; }
  .min.ft { color:#6b7280; }
  .score { font-weight:700; font-variant-numeric:tabular-nums; color:#fff; }
  .teams { color:#cfd3da; }
  .lead { color:#4ade80; }
  .empty { color:#8a8f98; padding:20px; text-align:center; }
  footer { color:#6b7280; font-size:12px; margin-top:20px; text-align:center; }
${NAV_CSS}
</style>
</head>
<body>
${navBar('/')}
<h1>Live Scores</h1>
<p class="meta">${live} matches &middot; ${groups.size} leagues &middot; generated ${now} &middot; refreshes every 30s</p>
${body}
<footer>Source: aiscore.mobi &middot; matched ${matched}/${live} leagues &middot; localhost:${PORT}</footer>
</body>
</html>`;
}

/**
 * minute as int, or null for HT/FT.
 * Matches with a '+' (45+3, 90+2) read as the base minute.
 */
function toMinute(status) {
  if (status === 'HT' || status === 'FT') return null;
  const m = /^(\d+)/.exec(status);
  return m ? Number(m[1]) : 0;
}

const tier = (m) =>
  m === null ? 'Other' :
  m >= 60 ? 'Final third (60+\')' :
  m >= 45 ? 'Second half (45-59\')' :
  'First half (<45\')';

/**
 * Table of live matches with <=1 total goal.
 *
 * This is a filter on the current score, not a forecast of the final
 * total. Early 0-0s and late 0-0s look identical here but mean very
 * different things, hence the tier column.
 */
function renderUnder(rows, leagueOf, now) {
  const liveCount = rows.filter((p) => p[1] !== 'FT').length;
  const hits = rows
    .filter((p) => p[1] !== 'FT')
    .map((p) => ({ p, m: toMinute(p[1]) }))
    .filter(({ p }) => Number(p[2]) + Number(p[3]) <= 1);

  const byTier = new Map();
  for (const h of hits) {
    const t = tier(h.m);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(h);
  }

  const order = ["Final third (60+')", "Second half (45-59')",
                 "First half (<45')", 'Other'];
  const shown = order.filter((t) => byTier.has(t));

  // Compact two-line rows instead of a 5-column table: a phone has no
  // room for a league column. Each row carries data-* so the client can
  // filter without a round trip.
  const row = ({ p, m }) => {
    const total = Number(p[2]) + Number(p[3]);
    const label = statusLabel(p[1]);
    const league = leagueOf.get(p[0]) || '—';
    const t = tier(m);
    return (
      `<div class="row" data-tier="${esc(t)}" data-total="${total}"` +
      ` data-min="${m === null ? -1 : m}">` +
      `<span class="min">${esc(label)}</span>` +
      `<span class="score">${esc(p[2])}-${esc(p[3])}</span>` +
      `<span class="match"><span class="teams">` +
      `${esc(p[30])} <i>vs</i> ${esc(p[31])}</span>` +
      `<span class="league">${esc(league)}</span></span>` +
      `</div>`
    );
  };

  const sections = shown
    .map((t) => {
      const list = byTier.get(t).sort((a, b) => (b.m ?? -1) - (a.m ?? -1));
      // The big tiers start collapsed so the first screen is not 168
      // rows of first-half 0-0s. Expanding is instant and local.
      const open = t === "Final third (60+')" ? ' open' : '';
      return (
        `<details class="tier" data-tier="${esc(t)}"${open}>` +
        `<summary><span class="tname">${esc(t)}</span>` +
        `<span class="count">${list.length}</span></summary>` +
        `<div class="rows">${list.map(row).join('')}</div>` +
        `</details>`
      );
    })
    .join('');

  const body = hits.length
    ? sections
    : '<div class="empty">No live matches at 1 goal or fewer.</div>';

  // Chip counts, computed server-side so the bar is useful before JS runs.
  const countTier = (t) => (byTier.get(t) || []).length;
  const countGoals = (n) => hits.filter((h) => Number(h.p[2]) +
    Number(h.p[3]) === n).length;
  const chips = [
    ['all', 'All', hits.length],
    ["Final third (60+')", "60'+", countTier("Final third (60+')")],
    ["Second half (45-59')", '45-59', countTier("Second half (45-59')")],
    ["First half (<45')", '<45', countTier("First half (<45')")],
    ['goal:0', '0-0', countGoals(0)],
    ['goal:1', '1-0', countGoals(1)],
  ]
    .map(
      ([k, label, n]) =>
        `<button class="chip" data-filter="${esc(k)}"` +
        ` data-count="${n}">${label}<b>${n}</b></button>`
    )
    .join('');


  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Live - Under 2 Goals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; padding:12px 12px 72px; background:#0f1115; color:#e6e6e6;
    font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
    overscroll-behavior-y:contain; }

  /* Sticky header: title scrolls away, filter bar never does. */
  .top { position:sticky; top:0; z-index:20; background:#0f1115;
    padding-top:4px; margin:-12px -12px 0; padding-left:12px;
    padding-right:12px; padding-bottom:8px;
    border-bottom:1px solid #1f232d; }
  h1 { font-size:17px; margin:0 0 2px; }
  .meta { color:#8a8f98; font-size:12px; margin:0 0 10px; }
  .warn { background:#2a2113; border:1px solid #5a4416; color:#f0b429;
    border-radius:8px; padding:9px 12px; font-size:12px; line-height:1.45;
    margin-bottom:12px; }

  /* Horizontally scrolling chip row — no wrap, so it costs one line. */
  .chips { display:flex; gap:7px; overflow-x:auto; padding-bottom:2px;
    scrollbar-width:none; -ms-overflow-style:none;
    -webkit-overflow-scrolling:touch; }
  .chips::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; background:#1b1f28; border:1px solid #2b3040;
    color:#9aa3b2; border-radius:999px; padding:7px 12px; font-size:13px;
    font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent;
    display:flex; align-items:center; gap:6px; min-height:34px; }
  .chip b { font-weight:700; font-size:11px; color:#6b7280;
    background:#12151c; border-radius:999px; padding:1px 6px; }
  .chip.on { background:#12341f; border-color:#2b7a44; color:#4ade80; }
  .chip.on b { background:#0d2416; color:#4ade80; }

  /* Collapsible tiers replace stacked always-open sections. */
  details.tier { background:#171a21; border:1px solid #242833;
    border-radius:10px; margin-bottom:10px; overflow:hidden; }
  summary { list-style:none; cursor:pointer; padding:12px 14px;
    font-size:13px; font-weight:600; color:#9ecbff; background:#1b1f28;
    display:flex; justify-content:space-between; align-items:center;
    gap:10px; -webkit-tap-highlight-color:transparent; min-height:44px; }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:'▾'; color:#4b5563; font-size:11px;
    transition:transform .15s; }
  details[open] summary::after { transform:rotate(180deg); }
  summary .count { color:#6b7280; font-weight:400; font-size:12px; }

  /* Two-line row: min+score, then teams with league underneath. */
  .row { display:grid; grid-template-columns:44px 50px 1fr; gap:9px;
    align-items:center; padding:9px 14px;
    border-bottom:1px solid #1f232d; }
  .rows .row:last-child { border-bottom:none; }
  .min { color:#f0b429; font-variant-numeric:tabular-nums; font-size:13px;
    text-align:right; white-space:nowrap; }
  .score { font-weight:700; font-variant-numeric:tabular-nums; color:#fff;
    font-size:15px; white-space:nowrap; }
  .match { min-width:0; display:flex; flex-direction:column; gap:1px; }
  .teams { color:#dfe3e8; font-size:14px; line-height:1.3;
    overflow:hidden; text-overflow:ellipsis; }
  .teams i { font-style:normal; color:#5b6472; font-size:12px; }
  .league { color:#6b7280; font-size:11.5px; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }

  .hidden { display:none !important; }
  .empty { color:#8a8f98; padding:24px; text-align:center; }
  .status { text-align:center; color:#6b7280; font-size:12px;
    margin-top:6px; min-height:16px; }
  footer { color:#6b7280; font-size:12px; margin-top:18px;
    text-align:center; }
  footer a { color:#9ecbff; }
  @media (min-width:700px) {
    body { max-width:760px; margin:0 auto; }
  }
${NAV_CSS}
</style>
</head>
<body>
${navBar('/under')}
<div class="top">
  <h1>Live &middot; Under 2 Goals</h1>
  <p class="meta">${hits.length} of ${liveCount} at 1 goal or fewer &middot;
generated ${now}</p>
  <div class="chips" id="chips">${chips}</div>
</div>
<div class="warn">&#9888;&#65039; A <b>snapshot of the score</b>, not a forecast.
A 0-0 at 12&#39; and a 0-0 at 78&#39; are not the same bet — use the filters to
separate them.</div>
${body}
<p class="status" id="status"></p>
<footer>Source: aiscore.mobi &middot; generated ${now}</footer>
<script>
(function () {
  var KEY = 'underFilter';
  var chips = document.getElementById('chips');
  var status = document.getElementById('status');

  function rows() { return document.querySelectorAll('.row'); }
  function tiers() { return document.querySelectorAll('details.tier'); }

  function matches(row, f) {
    if (f === 'all') return true;
    if (f.indexOf('goal:') === 0) {
      return row.dataset.total === f.slice(5);
    }
    return row.dataset.tier === f;
  }

  function apply(f) {
    var shown = 0;
    rows().forEach(function (r) {
      var ok = matches(r, f);
      r.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });

    // Hide a tier when the filter emptied it, and open every tier that
    // still has matches so the filter actually reveals them.
    tiers().forEach(function (t) {
      var any = t.querySelectorAll('.row:not(.hidden)').length > 0;
      t.classList.toggle('hidden', !any);
      if (any && f !== 'all') t.open = true;
      if (f === 'all' && t.dataset.tier.indexOf('60+') === -1) t.open = false;
    });

    chips.querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.filter === f);
    });

    status.textContent = shown + ' of ' + rows().length + ' shown';
    try { localStorage.setItem(KEY, f); } catch (e) {}
  }

  chips.addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (c) apply(c.dataset.filter);
  });

  var saved = 'all';
  try { saved = localStorage.getItem(KEY) || 'all'; } catch (e) {}
  apply(saved);
})();
</script>
</body>
</html>`;
}

/**
 * Match id -> match page path. The homepage links every fixture it lists
 * as /match-<slug>-vtv<id>, which is where we recover the id.
 */
function buildUrlMap(page) {
  const urls = new Map();
  const re = /location\.href='(\/match-[^']*vtv(\d+))'/g;
  let m;
  while ((m = re.exec(page)) !== null) urls.set(m[2], m[1]);
  return urls;
}

const goalCache = new Map();  // id -> { goals: number[]|null, at }
const GOAL_TTL_MS = 60 * 1000;

/**
 * Goal minutes for one match, from its detail page.
 *
 * Each event is a <div class="tr"> holding three cells in the order
 * home | minute | away. Goals carry a "goal" icon; yellow and red cards
 * use the same cells, so we test the cell contents rather than the row.
 */
async function fetchGoalMinutes(path) {
  const res = await fetch('https://aiscore.mobi' + path, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let html = await res.text();

  // The page repeats a goal / own-goal legend after the event table. An
  // unbounded cell match swallows it, making every match look like it
  // scored, so cut it off first.
  const cut = html.indexOf('listing-match-note-wrap');
  if (cut > 0) html = html.slice(0, cut);

  const GOAL_ICONS = ['match-events/goal.png', 'match-events/phan-luoi.png'];
  const isGoal = (cell) =>
    cell && GOAL_ICONS.some((i) => cell[1].includes(i));

  const goals = [];
  for (const row of html.split('<div class="tr">').slice(1)) {
    const mm = /minute-event[^>]*>\s*(\d{1,3})/.exec(row);
    if (!mm) continue;
    const home = /class="td home-event"[^>]*>([\s\S]*?)(?=<div class="td )/
      .exec(row);
    const away = /class="td away-event"[^>]*>([\s\S]*?)$/.exec(row);
    if (isGoal(home) || isGoal(away)) goals.push(Number(mm[1]));
  }
  return [...new Set(goals)].sort((a, b) => a - b);
}

/** Bounded-concurrency map, so we don't open 260 sockets at once. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function goalMinutesFor(id, path) {
  const hit = goalCache.get(id);
  if (hit && Date.now() - hit.at < GOAL_TTL_MS) return hit.goals;
  let goals = null;
  try {
    goals = await fetchGoalMinutes(path);
  } catch (e) {
    goals = null;               // page missing or upstream error
  }
  goalCache.set(id, { goals, at: Date.now() });
  return goals;
}

/**
 * Server time formatted for the user (Thailand, GMT+7).
 * Uses Asia/Bangkok rather than a fixed offset so it stays correct if
 * Thailand ever changes its offset. Returned as "YYYY-MM-DD HH:MM GMT+7".
 */
function localNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return `${date} ${time} GMT+7`;
}

const HELD_CSS = `
  .top { position:sticky; top:0; z-index:20; background:#0f1115;
    margin:-12px -12px 0; padding:4px 12px 8px;
    border-bottom:1px solid #1f232d; }
  .top h1 { font-size:17px; margin:0 0 2px; }
  .top .meta { color:#8a8f98; font-size:12px; margin:0 0 10px; }
  .chips { display:flex; gap:7px; overflow-x:auto; scrollbar-width:none; }
  .chips::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; background:#1b1f28; border:1px solid #2b3040;
    color:#9aa3b2; border-radius:999px; padding:7px 12px; font-size:13px;
    font-weight:600; cursor:pointer; display:flex; align-items:center;
    gap:6px; min-height:34px; -webkit-tap-highlight-color:transparent; }
  .chip b { font-weight:700; font-size:11px; color:#6b7280; background:#12151c;
    border-radius:999px; padding:1px 6px; }
  .chip.on { background:#12341f; border-color:#2b7a44; color:#4ade80; }
  .chip.on b { background:#0d2416; color:#4ade80; }
  .note { background:#16211a; border:1px solid #2b7a44; color:#8fd6a6;
    border-radius:8px; padding:9px 12px; font-size:12px; line-height:1.45;
    margin:12px 0; }
  .card { display:flex; flex-direction:column; background:#171a21;
    border:1px solid #242833; border-radius:12px; padding:12px 14px;
    margin-bottom:10px; transition:border-color .15s; }
  .card.hot { border-color:#5a4416; background:#1c1a13; }
  .card-head { display:flex; flex-direction:column; gap:2px; margin-bottom:10px;
    padding-bottom:10px; border-bottom:1px solid #242833; }
  .card-head .teams { font-size:14.5px; color:#e2e8f0; font-weight:600;
    overflow:hidden; display:-webkit-box; -webkit-line-clamp:2;
    -webkit-box-orient:vertical; line-height:1.3; }
  .card-head .teams i { font-style:normal; color:#475569; font-size:11px; margin:0 4px; }
  .card-head .league { font-size:11px; color:#64748b; }
  .card-body { display:grid; grid-template-columns:1fr auto auto; gap:14px;
    align-items:center; }
  .l { display:flex; flex-direction:column; align-items:flex-start; gap:2px; }
  .l .min { color:#f0b429; font-size:11px; font-weight:600;
    font-variant-numeric:tabular-nums; }
  .l .score { font-weight:800; font-size:26px; color:#fff;
    font-variant-numeric:tabular-nums; line-height:1.05; }
  .mid { display:flex; }
  .held-pill { display:flex; flex-direction:column; align-items:center;
    background:#0a1f14; border:1px solid #16a34a; border-radius:10px;
    padding:6px 14px; min-width:74px; }
  .held-pill b { font-size:20px; color:#4ade80; font-weight:800;
    font-variant-numeric:tabular-nums; line-height:1; }
  .card.hot .held-pill { background:#1c1a13; border-color:#5a4416; }
  .card.hot .held-pill b { color:#f0b429; }
  .held-pill i { font-style:normal; font-size:10px; color:#6b7280; }
  .since { font-size:10.5px; color:#6b7280; }
  .r { display:flex; align-items:center; }
  .hidden { display:none !important; }
  .empty { color:#8a8f98; padding:32px 16px; text-align:center; font-size:14px; }
  #status { text-align:center; color:#6b7280; font-size:12px; margin-top:8px; }
  /* Goal expand row - sits below the card grid, clean flex row */
  .goalrow { max-height:0; overflow:hidden;
    transition:max-height .22s ease; margin:8px -2px 0; padding:0 4px; }
  .goalrow.show { max-height:160px; }
  .goalrow-inner { display:flex; flex-wrap:wrap; gap:6px; align-items:center;
    padding:8px 0 2px; border-top:1px solid #242833; }
  .goalsep { width:1px; height:16px; background:#334155; margin:0 2px; }
  .mg { display:inline-flex; align-items:center; justify-content:center;
    min-width:38px; padding:5px 10px; background:#0f172a; border:1px solid #334155;
    border-radius:8px; font-size:14px; font-weight:700; color:#fbbf24;
    font-variant-numeric:tabular-nums; }
  .goalbtn { background:#1e293b; border:1px solid #334155; color:#fbbf24;
    border-radius:8px; padding:4px 10px; font-size:12px; font-weight:600;
    cursor:pointer; transition:background .12s, transform .08s; }
  .goalbtn:hover { background:#334155; }
  .goalbtn:active { transform:scale(.96); }
  .goalmarks { font-size:11.5px; color:#64748b; font-style:normal; }
`;

/**
 * Page: how long each scoreline has held.
 *
 * "Held" = minutes since the last goal. A 0-0 that has never been scored
 * in reads as held since kickoff.
 *
 * This describes what has already happened. A long hold does not make
 * the next goal less likely, so it is deliberately not framed as a
 * prediction.
 */
function renderHeld(matches, now) {
  const list = matches
    .filter((m) => m.held !== null)
    .sort((a, b) => b.held - a.held || b.minute - a.minute);

  const chips = [
    [0, 'All', list.length],
    [15, "15'+", list.filter((m) => m.held >= 15).length],
    [30, "30'+", list.filter((m) => m.held >= 30).length],
    [45, "45'+", list.filter((m) => m.held >= 45).length],
  ]
    .map(([min, label, n]) =>
      `<button class="chip" data-min="${min}">${label}<b>${n}</b></button>`)
    .join('');

  const cards = list
    .map((m, idx) => {
      const p = m.p;
      const since = m.lastGoal === null ? 'kickoff' : m.lastGoal + "'";
      const hot = m.held >= 30 ? ' hot' : '';
      // Inline summary: "8 goals ▾" toggle. Full timeline expands below.
      let goalToggle = '';
      if (m.goals && m.goals.length > 0) {
        const n = m.goals.length;
        goalToggle = `<button class="goalbtn" data-goals="${esc(JSON.stringify(m.goals))}" data-idx="${idx}">` +
          `${n} goal${n > 1 ? 's' : ''} &#9662;</button>`;
      } else if (m.goals && m.goals.length === 0) {
        goalToggle = `<span class="goalmarks">0 goals</span>`;
      }
      const goalsInline = (m.goals && m.goals.length)
        ? `<div class="goalrow"><div class="goalrow-inner">` +
          m.goals.map((g) => `<span class="mg">${g}'</span>`).join('') +
          `</div></div>`
        : '';
      return (
        `<div class="card${hot}" data-held="${m.held}">` +
        `<div class="card-head"><span class="teams">${esc(p[30])} <i>vs</i> ` +
        `${esc(p[31])}</span><span class="league">${esc(m.league || '—')}</span></div>` +
        `<div class="card-body"><div class="l"><span class="min">${esc(statusLabel(p[1]))}</span>` +
        `<span class="score">${esc(p[2])}-${esc(p[3])}</span></div>` +
        `<div class="mid"><div class="held-pill"><b>${m.held}</b>` +
        `<i>min held</i><br><span class="since">since ` +
        `${esc(since)}</span></div></div>` +
        `<div class="r">${goalToggle}</div></div>` +
        `${goalsInline}</div>`
      );
    })
    .join('');

  const missing = matches.length - list.length;
  const body = list.length ? cards
    : '<div class="empty">No live matches with a timeline right now.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Held - Time Since Last Goal</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px 12px 72px; background:#0f1115; color:#e6e6e6;
    font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
  footer { color:#6b7280; font-size:12px; margin-top:18px; text-align:center; }
${HELD_CSS}${NAV_CSS}
</style>
</head>
<body>
${navBar('/held')}
<div class="top">
  <h1>Held &middot; Time Since Last Goal</h1>
  <p class="meta">${list.length} live with a timeline &middot; ${now}</p>
  <div class="chips" id="chips">${chips}</div>
</div>
<div class="note"><b>What this is:</b> minutes since the last goal in each
match. A 0-0 never yet scored reads as held since kickoff.
<b>A description, not a prediction</b> &mdash; a long hold does not make the
next goal any less likely.</div>
${body}
<p id="status"></p>
<footer>Source: aiscore.mobi &middot; ${missing} without a timeline &middot;
${now}</footer>
<script>
(function () {
  var KEY = 'heldMin';
  var chips = document.getElementById('chips');
  var status = document.getElementById('status');
  var cards = document.querySelectorAll('.card');
  function apply(min) {
    var n = 0;
    cards.forEach(function (c) {
      var ok = Number(c.dataset.held) >= Number(min);
      c.classList.toggle('hidden', !ok);
      if (ok) n++;
    });
    chips.querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.min === String(min));
    });
    status.textContent = n + ' of ' + cards.length + ' shown';
    try { localStorage.setItem(KEY, min); } catch (e) {}
  }
  chips.addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (c) apply(c.dataset.min);
  });
  var s = 0;
  try { s = localStorage.getItem(KEY) || 0; } catch (e) {}
  apply(s);
  // --- Goal timeline toggle (inline expand, no overlay) ---
  document.querySelectorAll('.goalbtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = btn.closest('.card').querySelector('.goalrow');
      var open = row.classList.toggle('show');
      btn.innerHTML = open
        ? JSON.parse(btn.dataset.goals).length + ' goals &#9650;'
        : JSON.parse(btn.dataset.goals).length + ' goals &#9662;';
    });
  });
})();
</script>
<style>
  .goalrow { max-height:0; overflow:hidden;
    transition:max-height .22s ease; margin:8px -2px 0; padding:0 4px; }
  .goalrow.show { max-height:160px; }
  .goalrow-inner { display:flex; flex-wrap:wrap; gap:6px; align-items:center;
    padding:8px 0 2px; border-top:1px solid #242833; }
  .goalsep { width:1px; height:16px; background:#334155; margin:0 2px; }
  .mg { display:inline-flex; align-items:center; justify-content:center;
    min-width:38px; padding:5px 10px; background:#0f172a; border:1px solid #334155;
    border-radius:8px; font-size:14px; font-weight:700; color:#fbbf24;
    font-variant-numeric:tabular-nums; }
  .goalbtn { background:#1e293b; border:1px solid #334155; color:#fbbf24;
    border-radius:8px; padding:4px 10px; font-size:12px; font-weight:600;
    cursor:pointer; transition:background .12s, transform .08s; }
  .goalbtn:hover { background:#334155; }
  .goalbtn:active { transform:scale(.96); }
  .goalmarks { font-size:11.5px; color:#64748b; font-style:normal; }
</style>
</body>
</html>`;
}

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }

  if (path !== '/' && path !== '/under' && path !== '/held') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  try {
    // Feed first - it is 8KB and is the reason for the request.
    // The homepage is cached and only refetched when its TTL lapses.
    const feedRaw = await get(FEED, FEED_TTL_MS);
    const page = await get(HOME, HOME_TTL_MS);
    const { leagues, matchToLeague } = buildMaps(page);
    const rows = parseFeed(feedRaw);
    const now = localNow();

    let html;
    if (path === '/under') {
      const leagueOf = new Map();
      for (const p of rows) {
        const lg = leagues.get(matchToLeague.get(p[0]));
        if (lg) leagueOf.set(p[0], lg);
      }
      html = renderUnder(rows, leagueOf, now);
    } else if (path === '/held') {
      // Needs one page fetch per match, so it is far more expensive than
      // the feed. Bounded concurrency plus a cache keeps it bearable.
      const urls = buildUrlMap(page);
      const live = rows.filter((p) => p[1] !== 'FT' && urls.has(p[0]));
      const goals = await pool(
        live, 12, (p) => goalMinutesFor(p[0], urls.get(p[0])));

      const matches = live.map((p, i) => {
        const raw = toMinute(p[1]);
        const minute = raw === null ? (p[1] === 'HT' ? 45 : null) : raw;
        const g = goals[i];
        let lastGoal = null;
        let held = null;
        let goalsList = null;
        if (minute !== null && Array.isArray(g)) {
          goalsList = g;
          if (g.length) {
            lastGoal = g[g.length - 1];
            held = Math.max(0, minute - lastGoal);
          } else {
            held = minute;          // never scored: held since kickoff
          }
        }
        const lg = leagues.get(matchToLeague.get(p[0]));
        return { p, minute, lastGoal, held, goals: goalsList, league: lg };
      });
      html = renderHeld(matches, now);
    } else {
      const { groups, live, matched } = groupByLeague(page, feedRaw);
      html = renderPage(groups, live, matched, now);
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Upstream fetch failed: ' + err.message + '\n');
  }
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error\n');
      console.error(err);
    });
  })
  .listen(PORT, () => {
    console.log('Live scores: http://localhost:' + PORT);
  });
