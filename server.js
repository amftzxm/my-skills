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

const fs = require('fs');
const path = require('path');

const HOME = 'https://aiscore.mobi/';
const FEED = 'https://aiscore.mobi/files/tiktok2.txt';
const PORT = Number(process.env.PORT) || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

/**
 * All adjustable settings. Loaded from config.json if present, else
 * sensible defaults. Changes are persisted back to config.json by
 * POST /config/save.
 */
let settings = Object.assign({}, {
  feedTTL: 10000,      // score feed cache TTL (ms)
  homeTTL: 600000,     // homepage cache TTL (ms)
  goalTTL: 60000,      // goal detail cache TTL (ms)
  pollInterval: 10000, // client /api/live poll (ms)
  clockTz: 'local',    // 'local' | 'UTC' | 'GMT+7'
  tickBlink: true,     // only the ' blinks
  highlightRow: true,  // flash row when score changes
  showHeld: false,     // show "held since" on timeline
}, JSON.parse(
  fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '{}'
));

const HOME_TTL_MS = settings.homeTTL;
const FEED_TTL_MS = settings.feedTTL;
const GOAL_TTL_MS = settings.goalTTL;
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 ' +
  'Chrome/120 Mobile Safari/537.36';

function persistSettings() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('failed to persist config:', e.message);
  }
}

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
  if (minute === 'HT' || minute === 'FT') return minute;
  return minute + '<span class="min-tick" aria-hidden="true">' + String.fromCharCode(39) + '</span>';
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


function renderPage(groups, live, matched, now, time) {
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
            '<li class="match-item" data-id="' + esc(p[0]) + '" role="button" aria-label="View details for ' + esc(home) + ' vs ' + esc(away) + '">' +
            '<button class="copy-btn" data-teams="' + esc(home) + ' vs ' + esc(away) + '" aria-label="Copy match name" title="Copy match name">📋</button>' +
            '<span class="teams">' + home + ' vs ' + away + '</span>' +
            '<span class="score">' + esc(p[2]) + '-' + esc(p[3]) + '</span>' +
            '<span class="' + cls + '">' + label + '</span><span class="chevron">›</span></li>'
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
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="expires" content="0">
<title>Live Scores</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px 16px 68px; background:#0f1115; color:#e6e6e6;
    font:15px/1.5 system-ui,-apple-system,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .topbar h1 { margin:0; }
  .nav { position:relative; }
  #nav-btn { background:#171a21; color:#e6e6e6; border:1px solid #242833; border-radius:8px;
    font-size:17px; line-height:1; padding:7px 11px; cursor:pointer; }
  #nav-btn:hover { background:#1f232d; }
  .nav-menu { position:absolute; right:0; top:calc(100% + 6px); min-width:160px; z-index:50;
    background:#171a21; border:1px solid #242833; border-radius:10px; overflow:hidden;
    box-shadow:0 8px 24px rgba(0,0,0,.45); }
  .nav-menu a { display:block; padding:10px 14px; color:#cfd3da; text-decoration:none; font-size:14px; }
  .nav-menu a:hover, .nav-menu a.active { background:#1f232d; color:#fff; }
  .meta { color:#8a8f98; font-size:13px; margin-bottom:20px; display:inline-flex; align-items:center; gap:8px; }
  .live-badge { display:inline-flex; align-items:center; gap:6px; background:linear-gradient(135deg,#0d2416,#0a1f14); border:1px solid #16a34a; border-radius:999px; padding:3px 11px; font-size:11px; font-weight:700; color:#4ade80; letter-spacing:.02em; }
  .live-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px rgba(74,222,128,.5); animation:pulse 1.4s ease-in-out infinite; }
  .live-badge.refreshed .live-dot { animation:none; }
  .live-badge.refreshed .live-dot::after { content:""; display:inline-block; width:7px; height:7px; border-radius:50%; background:#4ade80; animation:refreshPulse 0.6s ease-out; }
  @keyframes refreshPulse { 0%{transform:scale(.6);opacity:.4;} 50%{transform:scale(1.7);opacity:1;} 100%{transform:scale(.6);opacity:.4;} }
  @keyframes pulse { 0%{opacity:.4;} 50%{opacity:1;} 100%{opacity:.4;} }
  .meta-separator { color:#334155; }
  .info { color:#8a8f98; font-size:13px; }
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
  .min-tick { animation:minBlink 1.1s steps(2,start) infinite; }
  @keyframes minBlink { to { visibility:hidden; } }
  .score { font-weight:700; font-variant-numeric:tabular-nums; color:#fff; }
  .teams { color:#cfd3da; min-width:0; white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; }
  .lead { color:#4ade80; }
  .empty { color:#8a8f98; padding:20px; text-align:center; }

  li.match-item { cursor:pointer; position:relative; user-select:none; -webkit-tap-highlight-color:transparent;
    /* Two stacked rows: team names on top (full width); beneath, score and
       match time as separate columns: score | time. */
    grid-template-columns:auto auto minmax(0,1fr); gap:2px 0; padding:8px 36px 8px 14px; }
  li.match-item:active { background:#1f232d; }
  li.match-item .teams { grid-row:1; grid-column:1 / -1; }
  li.match-item .score { grid-row:2; grid-column:1; justify-self:start; font-size:14px; }
  li.match-item .min { grid-row:2; grid-column:2; justify-self:start;
    border-left:1px solid #2b3040; margin-left:9px; padding-left:9px; font-size:13px; }
  li.match-item .chevron { position:absolute; right:14px; top:50%; font-size:20px; color:#6b7280;
    line-height:1; transition:transform .2s; transform:translateY(-50%); }
  li.match-item .chevron.rotate { transform:translateY(-50%) rotate(90deg); }
  li.match-item .copy-btn { position:absolute; left:14px; top:50%; background:none; border:none; color:#6b7280;
    font-size:15px; cursor:pointer; padding:4px 6px; border-radius:4px; transition:all .15s;
    transform:translateY(-50%); line-height:1; }
  li.match-item .copy-btn:hover { color:#8a8f98; background:rgba(138,143,152,.12); }
  li.match-item .copy-btn.copied { color:#4ade80; }
  li.match-item.flash { animation:flashRow .4s ease-out; }
  @keyframes flashRow {
    0% { background:#0f5e34; }
    100% { background:transparent; }
  }
  li.match-timeline { display:block; background:#0f1115; padding:10px 14px 12px; }
  /* Score timeline shown under a match item after click. */
  li.match-timeline .goalrow { max-height:200px; overflow:hidden; margin:0; padding:0;
    display:flex; align-items:stretch; }
  li.match-timeline .goalrow-connector { width:2px; flex:0 0 2px; background:#242833;
    border-radius:2px; margin:4px 6px 0 0; align-self:stretch; }
  li.match-timeline .goalrow-inner { display:flex; flex-wrap:nowrap; align-items:center; gap:12px; padding:8px 2px 4px; position:relative; }
  li.match-timeline .goalrow-inner::before { content:""; position:absolute; left:0; right:0; top:50%; height:2px;
    background:#334155; border-radius:2px; transform:translateY(-50%); }
  li.match-timeline .mg { display:inline-flex; flex-direction:column; align-items:center; justify-content:center;
    min-width:46px; padding:4px 8px; background:#0f172a; border:1px solid #334155; border-radius:8px;
    font-size:13px; font-weight:700; color:#fbbf24; font-variant-numeric:tabular-nums;
    position:relative; z-index:1; line-height:1.1; }
  li.match-timeline .mg i { font-style:normal; font-size:9px; color:#64748b; font-weight:600; }

  li.match-timeline .tl-empty { font-size:12px; color:#8a8f98; padding:4px 0; }
  .loading {
    text-align:center;
    color:#8a8f98;
    padding:20px 0;
    font-size:13px;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    min-height:60px;
  }
  .spinner {
    display:block;
    width:24px;
    height:24px;
    border:3px solid rgba(138,143,152,0.3);
    border-radius:50%;
    border-top-color:#8a8f98;
    animation:spin 0.8s linear infinite;
    margin:12px auto;
  }
  @keyframes spin {
    0% { transform:rotate(0deg); }
    100% { transform:rotate(360deg); }
  }
  footer { color:#6b7280; font-size:12px; margin-top:20px; text-align:center; }
</style>
</head>
<body>
<div class="topbar"><h1>Live Scores</h1>
<div class="nav"><button id="nav-btn" aria-haspopup="true" aria-expanded="false" aria-label="Menu">☰</button>
<div id="nav-menu" class="nav-menu" hidden><a href="/">Live scores</a><a href="/config">Config</a></div></div></div>
<p class="meta" id="meta-line"><span class="live-badge"><span class="live-dot"></span><span class="badge-text">LIVE &middot; <span id="last-update">live</span></span></span><span class="meta-separator">&middot;</span><span class="info"><span id="match-count">${live}</span> matches &middot; <span id="league-count">${groups.size}</span> leagues</span></p>
${body}
<footer>Source: aiscore.mobi &middot; matched ${matched}/${live} leagues &middot; localhost:${PORT}<script>
(function(){
  // Top-right dropdown: toggles the nav menu, closes on outside click or Escape.
  var navBtn = document.getElementById('nav-btn');
  var navMenu = document.getElementById('nav-menu');
  if (navBtn && navMenu) {
    navBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = navMenu.hasAttribute('hidden');
      if (open) { navMenu.removeAttribute('hidden'); navBtn.setAttribute('aria-expanded', 'true'); }
      else { navMenu.setAttribute('hidden', ''); navBtn.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('click', function(e){
      if (!navMenu.hasAttribute('hidden') && !navMenu.contains(e.target)) {
        navMenu.setAttribute('hidden', '');
        navBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !navMenu.hasAttribute('hidden')) {
        navMenu.setAttribute('hidden', '');
        navBtn.setAttribute('aria-expanded', 'false');
        navBtn.focus();
      }
    });
  }
  function closeOthers(except){
    document.querySelectorAll('li.match-timeline').forEach(function(tl){
      if (tl !== except && tl.parentNode) tl.parentNode.removeChild(tl);
    });
    document.querySelectorAll('.match-item.open').forEach(function(mi){
      if (mi !== except) mi.classList.remove('open');
    });
    document.querySelectorAll('.match-item .chevron.rotate').forEach(function(c){
      var owner = c.closest ? c.closest('.match-item') : null;
      if (owner !== except) c.classList.remove('rotate');
    });
  }
  function bindItem(li){
    li.addEventListener('click', function(){
      var id = this.dataset.id;
      var next = this.nextElementSibling;
      var isOpen = next && next.classList && next.classList.contains('match-timeline');
      // Toggle closed when the open card is clicked again.
      if (isOpen) {
        next.parentNode.removeChild(next);
        this.classList.remove('open');
        var chevOff = this.querySelector('.chevron');
        if (chevOff) chevOff.classList.remove('rotate');
        return;
      }
      closeOthers(this);
      // rotate this item's chevron
      var chev = this.querySelector('.chevron');
      if (chev) chev.classList.add('rotate');
      this.classList.add('open');
      var loading = document.createElement('li');
      loading.className = 'match-timeline';
      loading.innerHTML = '<div class="spinner"></div>';
      this.parentNode.insertBefore(loading, this.nextSibling);
      var self = this;
      fetch('/timeline/' + id).then(function(r){ return r.json(); })
        .then(function(d){ renderInto(d, loading, self); })
        .catch(function(){ console.error('Failed to load timeline for match ' + id); loading.innerHTML = '<div class="loading" style="color:#ff9a9a">failed to load timeline</div>'; });
    });
  }
  document.querySelectorAll('.match-item').forEach(bindItem);
  function renderInto(d, slot, owner){
    var goals = d.goals || [];
    if (!slot.isConnected) return;
    if (goals.length === 0) {
      var held = d.held !== null ? ' held ' + d.held + 'm' : '';
      if (settings.showHeld && held) {
        slot.innerHTML = '<div class="tl-empty">no goals yet' + held + '</div>';
      } else {
        slot.innerHTML = '<div class="tl-empty">no goals yet</div>';
      }
      return;
    }
    var parts = goals.map(function(g, i){
      var prev = i > 0 ? goals[i-1] : 0;
      var gap = g - prev;
      var label = i === 0 ? 'kickoff' : (gap === 0 ? 'same' : gap + 'm');
      return '<span class="mg">' + g + '′<i>' + label + '</i></span>';
    }).join('');
    slot.innerHTML =
      '<div class="goalrow"><div class="goalrow-connector"></div>' +
      '<div class="goalrow-inner">' + parts + '</div></div>';
  }
  function escHtml(s){ return String(s).replace(/[&<>"]/g, function(m){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]; }); }


  // --- Live poll: patch scores in place so an open timeline never collapses.
  //     Replaces the old 30s full-page meta refresh. The shared 10s feed
  //     cache upstream means more browsers polling does not multiply fetches.
  var POLL_MS = 10000;
  var TICK_OPEN = '<span class="min-tick" aria-hidden="true">';
  var TICK = TICK_OPEN + String.fromCharCode(39) + '</span>';
  function mnHtml(label){
    var raw = String(label).replace(/<[^>]*>/g, '').replace(/[′']/g, '');
    return (raw === 'HT' || raw === 'FT') ? raw : raw + TICK;
  }
  var highlightedScore = null;
  function teamsHtml(m){
    var h = escHtml(m.home), a = escHtml(m.away);
    var parts = m.score.split('-');
    var hg = Number(parts[0]), ag = Number(parts[1]);
    if (!Number.isNaN(hg) && !Number.isNaN(ag)) {
      if (hg > ag) h = '<span class="lead">' + h + '</span>';
      else if (ag > hg) a = '<span class="lead">' + a + '</span>';
    }
    return h + ' vs ' + a;
  }
  function liveTick(){
    fetch('/api/live').then(function(r){ return r.json(); }).then(function(d){
      var seen = {};
      (d.matches || []).forEach(function(m){
        seen[m.id] = true;
        var li = document.querySelector('li.match-item[data-id="' + m.id + '"]');
        if (!li) return; // brand-new matches appear on next manual load
        var sc = li.querySelector('.score');
        var mn = li.querySelector('.min');
        var tm = li.querySelector('.teams');
        if (sc && sc.textContent !== m.score) sc.textContent = m.score;
        if (mn) {
          var want = mnHtml(m.statusLabel);
          if (mn.innerHTML !== want) mn.innerHTML = want;
          var rawMin = String(m.statusLabel).replace(/<[^>]*>/g, '').replace(/[′']/g, '');
          var isFt = rawMin === 'HT' || rawMin === 'FT';
          mn.classList.toggle('ft', isFt);
        }
        // Rebuild teams only when the score changed (winner highlight flips).
        if (tm && tm.dataset.s !== m.score) {
          tm.dataset.s = m.score;
          if (settings.highlightRow && highlightedScore !== m.score) {
            li.classList.add('flash');
            highlightedScore = m.score;
            setTimeout(function(){ li.classList.remove('flash'); highlightedScore = null; }, 400);
          }
          tm.innerHTML = teamsHtml(m);
          // Refresh an open timeline in place (it stays open; markers update live)
          var slot = li.nextElementSibling;
          if (slot && slot.classList && slot.classList.contains('match-timeline')) {
            fetch('/timeline/' + m.id).then(function(r){ return r.json(); })
              .then(function(td){ if (slot.isConnected) renderInto(td, slot, li); })
              .catch(function(){});
          }
        }
      });
      // Matches that left the feed (went FT) stay visible but gray out.
      document.querySelectorAll('li.match-item').forEach(function(li){
        if (seen[li.dataset.id]) return;
        var mn = li.querySelector('.min');
        if (mn && mn.textContent !== 'FT') { mn.textContent = 'FT'; mn.classList.add('ft'); }
      });
      var line = document.getElementById('meta-line');
      if (line) {
        var n = document.querySelectorAll('li.match-item').length;
        var k = document.querySelectorAll('section').length;
        var clock = clockTime(); // HH:MM:SS
        line.innerHTML = '<span class="live-badge"><span class="live-dot"></span><span class="badge-text">LIVE &middot; <span id="last-update">updated ' + clock + '</span></span></span>' +
          '<span class="meta-separator">&middot;</span>' +
          '<span class="info"><span id="match-count">' + n + '</span> matches &middot; <span id="league-count">' + k + '</span> leagues</span>';
        var dot = line.querySelector('.live-badge .live-dot');
        if (dot) { dot.classList.add('refreshed'); setTimeout(function(){ dot.classList.remove('refreshed'); }, 600); }
      }
    }).catch(function(){ /* transient; next tick retries */ });
  }
  function clockTime(){
    var tz;
    if (settings.clockTz === 'local') tz = undefined;
    else if (settings.clockTz === 'UTC') tz = 'UTC';
    else tz = 'Asia/Bangkok';
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(new Date());
    return p.filter(function(x){ return x.type === 'hour' || x.type === 'minute' || x.type === 'second'; }).map(function(x){ return x.value; }).join(':');
  }
  function tickClock(){
    var c = document.getElementById('clock-now');
    if (c) c.textContent = clockTime();
  }
  tickClock(); setInterval(tickClock, 1000);
  var settings = {};
  var bc = new BroadcastChannel('live-scores-settings');
  function refreshSettings(){
    fetch('/settings').then(function(r){ return r.json(); }).then(function(s){
      settings = s;
      applySettings();
    }).catch(function(){});
  }
  refreshSettings();
  bc.onmessage = function(e){
    if (e.data && e.data.type === 'settings-changed') refreshSettings();
  };

  function applySettings(){
    // Poll interval: recreate the interval with the new value
    liveTick();
    window.__pollInterval = settings.pollInterval;
    window.__pollTimeout = setInterval(liveTick, settings.pollInterval);
    if (window.__origPollTimeout) clearInterval(window.__origPollTimeout);
    window.__origPollTimeout = window.__pollTimeout;
    // Clock timezone
    tickClock();
    if (window.__tickTimeout) clearInterval(window.__tickTimeout);
    window.__tickTimeout = setInterval(tickClock, 1000);
    document.dispatchEvent(new CustomEvent('settings-changed', { detail: settings }));
  }

  document.addEventListener('settings-changed', function(e){
    var s = e.detail;
    TICK_OPEN = s.tickBlink ? '<span class="min-tick" aria-hidden="true">' : '';
    TICK = TICK_OPEN + String.fromCharCode(39) + '</span>';
    // Refresh all minute labels immediately with new blink behavior
    document.querySelectorAll('.min').forEach(function(mn){
      var raw = String(mn.textContent).replace(/[′']/g, '');
      if (raw === 'HT' || raw === 'FT') return;
      mn.innerHTML = mn.textContent + TICK_OPEN + String.fromCharCode(39) + '</span>';
    });
    // Refresh timeline markers too
    document.querySelectorAll('.mg span').forEach(function(spn){
      if (spn.classList.contains('mg')) return;
      var g = spn.previousElementSibling;
      if (g && g.classList && g.classList.contains('mg')) {
        var inner = spn.innerHTML.replace(/[′']/g, '');
        spn.innerHTML = inner + TICK_OPEN + String.fromCharCode(39) + '</span>';
      }
    });
  });

  // --- Copy match name button: click the 📋 icon to copy team names to clipboard.
  document.addEventListener('click', function(e){
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    e.stopPropagation();
    var text = btn.getAttribute('data-teams') || '';
    function showCopied(){
      btn.classList.add('copied');
      var orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(function(){
        btn.classList.remove('copied');
        btn.textContent = orig;
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied).catch(function(){
        fallbackCopy(text, btn);
      });
    } else {
      fallbackCopy(text, btn);
    }
  });
  function fallbackCopy(text, btn){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showCopied();
    } catch(err) {
      console.error('copy failed', err);
    }
    document.body.removeChild(ta);
  }

})();
</script></footer>
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
  // Keep every scoring event: both teams can score in the same minute
  // (or 45+1 / 45+2 read as 45), so deduplicating minutes hides a goal -
  // a 3-1 would render only 3 markers.
  return goals.slice().sort((a, b) => a - b);
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


/**
 * Config page: every knob and behaviour of this app in one place.
 * All values come straight from the live constants above, so the page
 * can never drift out of date.
 */
function fmtMs(ms) {
  if (ms < 1000) return ms + ' ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.round(s / 60) + 'm ' + (s % 60) + 's';
}

function cfgRow(k, v) {
  return '<tr><th>' + esc(k) + '</th><td>' + v + '</td></tr>';
}

function renderConfig() {
  const rowsServer = [
    cfgRow('Port', 'localhost:' + PORT + ' (override with PORT=)'),
    cfgRow('Node', process.version),
    cfgRow('Uptime', fmtMs(Math.round(process.uptime() * 1000))),
    cfgRow('Server time', esc(localNow())),
    cfgRow('Dependencies', 'zero — Node stdlib only'),
  ].join('');
  const rowsData = [
    cfgRow('Homepage feed', esc(HOME)),
    cfgRow('Score feed', esc(FEED)),
    cfgRow('Feed cache TTL', fmtMs(FEED_TTL_MS) + ' — poller rhythm'),
    cfgRow('Homepage cache TTL', fmtMs(HOME_TTL_MS) + ' — leagues change slowly'),
    cfgRow('Goal-page cache TTL', fmtMs(GOAL_TTL_MS) + ' — per-match detail pages'),
    cfgRow('Upstream UA', esc(UA)),
  ].join('');
  const rowsUi = [
    cfgRow('Client poll', 'every ' + fmtMs(10000) + ' via /api/live — patches scores in place'),
    cfgRow('Badge', 'LIVE · updated HH:MM:SS, pulse on refresh'),
    cfgRow('Minute tick', 'only the ’ blinks — number stays solid; HT/FT plain grey'),
    cfgRow('Timeline', 'tap a match → /timeline/:id goal rail + spinner while loading'),
    cfgRow('Nav', '☰ top-right → Live scores / Config'),
  ].join('');
  const rowsRoutes = [
    cfgRow('/', 'Live homepage (HTML)'),
    cfgRow('/api/live', 'JSON poll feed: id, score, clock'),
    cfgRow('/timeline/:id', 'JSON goal minutes for one match'),
    cfgRow('/config', 'this page'),
    cfgRow('/health', 'JSON liveness probe'),
  ].join('');
  const rowsConfig = [
    // Feed cache TTL
    '<tr><th><select name="feedTTL" data-default="' + settings.feedTTL + '">' +
      '<option value="5000" ' + (settings.feedTTL===5000?'selected':'') + '>Feed cache: 5s</option>' +
      '<option value="10000" ' + (settings.feedTTL===10000?'selected':'') + '>Feed cache: 10s</option>' +
      '<option value="15000" ' + (settings.feedTTL===15000?'selected':'') + '>Feed cache: 15s</option>' +
      '<option value="30000" ' + (settings.feedTTL===30000?'selected':'') + '>Feed cache: 30s</option></select></th>' +
      '<td>How long the score feed is cached — shorter = fresher but more requests</td></tr>',
    // Homepage cache TTL
    '<tr><th><select name="homeTTL" data-default="' + settings.homeTTL + '">' +
      '<option value="300000" ' + (settings.homeTTL===300000?'selected':'') + '>Homepage cache: 5m</option>' +
      '<option value="600000" ' + (settings.homeTTL===600000?'selected':'') + '>Homepage cache: 10m</option>' +
      '<option value="1800000" ' + (settings.homeTTL===1800000?'selected':'') + '>Homepage cache: 30m</option>' +
      '<option value="3600000" ' + (settings.homeTTL===3600000?'selected':'') + '>Homepage cache: 1h</option></select></th>' +
      '<td>How long league names are cached — leagues change slowly</td></tr>',
    // Goal cache TTL
    '<tr><th><select name="goalTTL" data-default="' + settings.goalTTL + '">' +
      '<option value="15000" ' + (settings.goalTTL===15000?'selected':'') + '>Goal-page cache: 15s</option>' +
      '<option value="30000" ' + (settings.goalTTL===30000?'selected':'') + '>Goal-page cache: 30s</option>' +
      '<option value="60000" ' + (settings.goalTTL===60000?'selected':'') + '>Goal-page cache: 60s</option>' +
      '<option value="120000" ' + (settings.goalTTL===120000?'selected':'') + '>Goal-page cache: 2m</option></select></th>' +
      '<td>How long one match goal list is cached (goal pages are loaded on demand)</td></tr>',
    // Poll interval
    '<tr><th><select name="pollInterval" data-default="' + settings.pollInterval + '">' +
      '<option value="5000" ' + (settings.pollInterval===5000?'selected':'') + '>Poll: every 5s</option>' +
      '<option value="10000" ' + (settings.pollInterval===10000?'selected':'') + '>Poll: every 10s</option>' +
      '<option value="15000" ' + (settings.pollInterval===15000?'selected':'') + '>Poll: every 15s</option>' +
      '<option value="30000" ' + (settings.pollInterval===30000?'selected':'') + '>Poll: every 30s</option></select></th>' +
      '<td>How often the browser polls /api/live for live score updates</td></tr>',
    // Clock timezone
    '<tr><th><select name="clockTz" data-default="' + settings.clockTz + '">' +
      '<option value="local" ' + (settings.clockTz==='local'?'selected':'') + '>Clock: browser local time</option>' +
      '<option value="UTC" ' + (settings.clockTz==='UTC'?'selected':'') + '>Clock: UTC</option>' +
      '<option value="GMT+7" ' + (settings.clockTz==='GMT+7'?'selected':'') + '>Clock: GMT+7 (Thailand)</option></select></th>' +
      '<td>Which timezone the clock shows</td></tr>',
    // Tick blink
    '<tr><th><select name="tickBlink" data-default="' + settings.tickBlink + '">' +
      '<option value="true" ' + (settings.tickBlink?'selected':'') + '>Tick blink: on</option>' +
      '<option value="false" ' + (!settings.tickBlink?'selected':'') + '>Tick blink: off</option></select></th>' +
      '<td>Only the minute apostrophe blinks — number stays solid</td></tr>',
    // Highlight row
    '<tr><th><select name="highlightRow" data-default="' + settings.highlightRow + '">' +
      '<option value="true" ' + (settings.highlightRow?'selected':'') + '>Row highlight: on</option>' +
      '<option value="false" ' + (!settings.highlightRow?'selected':'') + '>Row highlight: off</option></select></th>' +
      '<td>Flash the row when a score changes</td></tr>',
    // Show held
    '<tr><th><select name="showHeld" data-default="' + settings.showHeld + '">' +
      '<option value="true" ' + (settings.showHeld?'selected':'') + '>Held-timer: on</option>' +
      '<option value="false" ' + (!settings.showHeld?'selected':'') + '>Held-timer: off</option></select></th>' +
      '<td>Show "held X m" on the goal timeline</td></tr>',
  ].join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Config · Live Scores</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px 16px 68px; background:#0f1115; color:#e6e6e6;
    font:15px/1.5 system-ui,-apple-system,sans-serif; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .topbar h1 { font-size:20px; margin:0; }
  .nav { position:relative; }
  #nav-btn { background:#171a21; color:#e6e6e6; border:1px solid #242833; border-radius:8px;
    font-size:17px; line-height:1; padding:7px 11px; cursor:pointer; }
  #nav-btn:hover { background:#1f232d; }
  .nav-menu { position:absolute; right:0; top:calc(100% + 6px); min-width:160px; z-index:50;
    background:#171a21; border:1px solid #242833; border-radius:10px; overflow:hidden;
    box-shadow:0 8px 24px rgba(0,0,0,.45); }
  .nav-menu a { display:block; padding:10px 14px; color:#cfd3da; text-decoration:none; font-size:14px; }
  .nav-menu a:hover, .nav-menu a.active { background:#1f232d; color:#fff; }
  .cfg { background:#171a21; border:1px solid #242833; border-radius:10px; margin:12px 0; overflow:hidden; }
  .cfg h2 { font-size:13px; font-weight:600; color:#9ecbff; padding:10px 14px; margin:0;
    background:#1b1f28; border-bottom:1px solid #242833; }
  .cfg h2 .hint { color:#6b7280; font-weight:400; margin-left:8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 14px; border-bottom:1px solid #1f232d; vertical-align:top; }
  tr:last-child th, tr:last-child td { border-bottom:none; }
  th { color:#8a8f98; font-weight:600; width:38%; }
  td { color:#cfd3da; word-break:break-word; }
  select { background:#1f232d; color:#e6e6e6; border:1px solid #242833; border-radius:6px;
    padding:4px 8px; font-size:12.5px; cursor:pointer; }
  select:hover { border-color:#8a8f98; }
  .save-status { font-size:12px; color:#6b7280; margin-top:10px; text-align:center; }
  footer { color:#6b7280; font-size:12px; margin-top:20px; text-align:center; }
</style>
</head>
<body>
<div class="topbar"><h1>Config</h1>
<div class="nav"><button id="nav-btn" aria-haspopup="true" aria-expanded="false" aria-label="Menu">☰</button>
<div id="nav-menu" class="nav-menu" hidden><a href="/">Live scores</a><a href="/config" class="active">Config</a></div></div></div>
<section class="cfg"><h2>Server</h2><table>${rowsServer}</table></section>
<section class="cfg"><h2>Data source &amp; caching</h2><table>${rowsData}</table></section>
<section class="cfg"><h2>Live UI behaviour</h2><table>${rowsUi}</table></section>
<section class="cfg"><h2>Routes</h2><table>${rowsRoutes}</table></section>
<section class="cfg" id="adjustments"><h2>Adjustments <span class="hint">— click a dropdown to change it live</span></h2><table>${rowsConfig}</table></section>
<div class="save-status" id="save-status">settings auto-saved on change</div>
<footer>Source: aiscore.mobi &middot; localhost:${PORT}</footer>
<script>
(function(){
  var navBtn = document.getElementById('nav-btn');
  var navMenu = document.getElementById('nav-menu');
  if (navBtn && navMenu) {
    navBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = navMenu.hasAttribute('hidden');
      if (open) { navMenu.removeAttribute('hidden'); navBtn.setAttribute('aria-expanded', 'true'); }
      else { navMenu.setAttribute('hidden', ''); navBtn.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('click', function(e){
      if (!navMenu.hasAttribute('hidden') && !navMenu.contains(e.target)) {
        navMenu.setAttribute('hidden', '');
        navBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !navMenu.hasAttribute('hidden')) {
        navMenu.setAttribute('hidden', '');
        navBtn.setAttribute('aria-expanded', 'false');
        navBtn.focus();
      }
    });
  }
  // Config dropdowns: save changes live and notify other tabs.
  var bc = new BroadcastChannel('live-scores-settings');
  var statusEl = document.getElementById('save-status');
  function saveStatus(msg){
    if (statusEl) statusEl.textContent = msg;
  }
  var selects = document.querySelectorAll('#adjustments select, select[name]');
  selects.forEach(function(sel){
    sel.addEventListener('change', function(){
      var payload = {};
      payload[sel.name] = sel.value;
      saveStatus('saving...');
      fetch('/config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function(r){ return r.json(); }).then(function(d){
        if (d.ok){ saveStatus('saved · ' + sel.options[sel.selectedIndex].text);
          bc.postMessage({ type: 'settings-changed', key: sel.name });
        } else { saveStatus('save failed: ' + d.error); }
      }).catch(function(e){ saveStatus('save failed'); console.error(e); });
    });
  });
  // Also react to settings changed in other tabs.
  bc.onmessage = function(e){
    if (e.data && e.data.type === 'settings-changed'){
      saveStatus('synced from another tab');
    }
  };
})();
</script>
</body>
</html>`;
}


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

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }

  if (path !== '/' && path !== '/config' && path !== '/config/save' && path !== '/settings' && path !== '/api/live' && !path.match(/^\/timeline\//)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  if (path === '/config') {
    try {
      return res.end(renderConfig());
    } catch (e) {
      console.error('CONFIG ERROR:', e.message, e.stack);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Server error: ' + e.message + '\n');
    }
  }

  if (path === '/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settings));
  }

  if (path === '/config/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        for (const key of Object.keys(payload)) {
          if (key === 'feedTTL' && [5000, 10000, 15000, 30000].includes(Number(payload.feedTTL))) settings.feedTTL = Number(payload.feedTTL);
          else if (key === 'homeTTL' && [300000, 600000, 1800000, 3600000].includes(Number(payload.homeTTL))) settings.homeTTL = Number(payload.homeTTL);
          else if (key === 'goalTTL' && [15000, 30000, 60000, 120000].includes(Number(payload.goalTTL))) settings.goalTTL = Number(payload.goalTTL);
          else if (key === 'pollInterval' && [5000, 10000, 15000, 30000].includes(Number(payload.pollInterval))) settings.pollInterval = Number(payload.pollInterval);
          else if (key === 'clockTz' && ['local', 'UTC', 'GMT+7'].includes(payload.clockTz)) settings.clockTz = payload.clockTz;
          else if (key === 'tickBlink' && typeof payload.tickBlink === 'boolean') settings.tickBlink = payload.tickBlink;
          else if (key === 'highlightRow' && typeof payload.highlightRow === 'boolean') settings.highlightRow = payload.highlightRow;
          else if (key === 'showHeld' && typeof payload.showHeld === 'boolean') settings.showHeld = payload.showHeld;
        }
        persistSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, settings }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  try {
    // Feed first - it is 8KB and is the reason for the request.
    // The homepage is cached and only refetched when its TTL lapses.
    const feedRaw = await get(FEED, FEED_TTL_MS);
    const page = await get(HOME, HOME_TTL_MS);
    const { leagues, matchToLeague } = buildMaps(page);
    const rows = parseFeed(feedRaw);
    const timeParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(new Date());
    const time = timeParts.filter(function(x){ return x.type === 'hour' || x.type === 'minute' || x.type === 'second'; }).map(function(x){ return x.value; }).join(':');
    const now = localNow();

    if (path.match(/^\/timeline\/(\d+)$/)) {
      const id = path.match(/^\/timeline\/(\d+)$/)[1];
      // Fetch homepage + feed fresh so this on-demand endpoint never serves stale data.
      const pageRaw = await get(HOME, 0);
      const feedRaw = await get(FEED, 0);
      const { leagues, matchToLeague } = buildMaps(pageRaw);
      const urls = buildUrlMap(pageRaw);
      const rows = parseFeed(feedRaw);
      const row = rows.find((r) => r[0] === id);
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'match not found' }));
      }
      const goalPath = urls.get(id);
      let goals = null;
      if (goalPath) goals = await goalMinutesFor(id, goalPath);
      // Safety net: never show more markers than the score has goals (a
      // duplicated event table would double-count). Same-minute goals stay.
      const total = Number(row[2]) + Number(row[3]);
      if (Array.isArray(goals) && goals.length > total) goals = [...new Set(goals)];
      const minute = toMinute(row[1]);
      let lastGoal = null, held = null;
      if (Array.isArray(goals) && goals.length) {
        lastGoal = goals[goals.length - 1];
        if (minute !== null) held = Math.max(0, minute - lastGoal);
      } else if (minute !== null) {
        held = minute;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id, row: [row[0], row[1], row[2], row[3]],
        statusLabel: statusLabel(row[1]),
        score: row[2] + '-' + row[3],
        home: esc(row[30]), away: esc(row[31]),
        league: esc(leagues.get(matchToLeague.get(id))),
        goals: goals || [], lastGoal, held, minute,
      }));
    }

    // Lightweight JSON for the client poller: just id + score + clock.
    // Uses the shared 10s feed cache, so upstream fetches stay at <=6/min
    // no matter how many browsers poll.
    if (path === '/api/live') {
      const feedRaw = await get(FEED, FEED_TTL_MS);
      const pageRaw = await get(HOME, HOME_TTL_MS);
      const { leagues, matchToLeague } = buildMaps(pageRaw);
      const rows = parseFeed(feedRaw).filter((p) => p[1] !== 'FT');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({
        now: localNow(),
        matches: rows.map((p) => ({
          id: p[0],
          score: p[2] + '-' + p[3],
          statusLabel: statusLabel(p[1]),
          home: p[30], away: p[31],
          league: leagues.get(matchToLeague.get(p[0])) || '(unknown)',
        })),
      }));
    }

    let html;
    const { groups, live, matched } = groupByLeague(page, feedRaw);
    html = renderPage(groups, live, matched, now, time);

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
