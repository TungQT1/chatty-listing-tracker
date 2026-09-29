/**
 * Chatty Daily Rank Checker — GitHub Actions version
 * Runs every day at 8pm Bangkok (13:00 UTC)
 * - Detects big ranking changes and logs them. Slack alerts are off.
 * - Bi-weekly summary is logged only. Slack reports are off.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const SLACK_TOKEN   = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = 'C0AJBNMS732'; // #chatty-super-bot

const KEYWORDS = [
  'live chat', 'AI chatbot', 'chatbot', 'inbox', 'chat',
  'help center', 'FAQ', 'livechat', 'WhatsApp',
  'helpdesk', 'customer support', 'ai chat',
];

const P0_KEYWORDS = ['live chat', 'AI chatbot', 'chatbot', 'chat', 'ai chat', 'inbox', 'livechat'];

const COMPETITORS = [
  { name: 'Tidio',      slug: 'tidio-chat' },
  { name: 'Rep AI',     slug: 'rep-ai-sales-associate' },
  { name: 'Moosedesk', slug: 'moosedesk' },
  { name: 'Zipchat',   slug: 'zipchat' },
  { name: 'LiveChat',  slug: 'livechat' },
  { name: 'tawk.to',   slug: 'tawk-to' },
  { name: 'Gorgias',   slug: 'gorgias' },
  { name: 'Vanchat',   slug: 'vanchat' },
  { name: 'Reamaze',   slug: 'reamaze' },
];

// Files are in repo root (GitHub Actions checks out to workspace root)
const LOG_FILE   = path.join(__dirname, 'ranking-log.json');
const STATE_FILE = path.join(__dirname, 'rank-state.json');
const TARGET     = 'chatty';

// ─── Alert thresholds ──────────────────────────────────────────────────────
const DROP_ALERT_P0    = 2;
const DROP_ALERT_OTHER = 4;
const COMP_RISE_ALERT  = 3;
const CHATTY_DANGER    = 5;

// ─── Slack ─────────────────────────────────────────────────────────────────
function slackPost(text) {
  console.log('Slack report disabled. Not posted:\n' + text);
  return Promise.resolve({ ok: true, skipped: true });
}

// ─── Shopify search ────────────────────────────────────────────────────────
async function searchKeyword(page, keyword) {
  const url = `https://apps.shopify.com/search?q=${encodeURIComponent(keyword)}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const apps = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => {
          try {
            const u = new URL(h);
            return u.hostname === 'apps.shopify.com' &&
                   u.searchParams.has('surface_intra_position') &&
                   !u.pathname.includes('/categories') &&
                   !u.pathname.includes('/search');
          } catch { return false; }
        })
        .map(h => {
          const u = new URL(h);
          return {
            slug: u.pathname.replace('/', ''),
            position: parseInt(u.searchParams.get('surface_intra_position')),
            type: u.searchParams.get('surface_type') || 'search',
          };
        })
        .sort((a, b) => a.position - b.position)
    );

    const organics = apps.filter(a => a.type !== 'search_ad');
    const allPos   = apps.findIndex(a => a.slug.includes(TARGET));
    const orgPos   = organics.findIndex(a => a.slug.includes(TARGET));

    const competitorRanks = {};
    COMPETITORS.forEach(comp => {
      const idx = organics.findIndex(a => a.slug.includes(comp.slug));
      competitorRanks[comp.name] = idx >= 0 ? idx + 1 : null;
    });

    return {
      keyword,
      position:        allPos >= 0 ? allPos + 1 : null,
      organicPosition: orgPos >= 0 ? orgPos + 1 : null,
      competitors:     competitorRanks,
      top10organic:    organics.slice(0, 10).map(a => a.slug),
      checkedAt:       new Date().toISOString(),
    };
  } catch (e) {
    return { keyword, position: null, organicPosition: null, competitors: {}, error: e.message, checkedAt: new Date().toISOString() };
  }
}

// ─── Change detection ──────────────────────────────────────────────────────
function detectAlerts(current, previous) {
  const alerts = [];
  if (!previous) return alerts;

  const prevMap = {};
  previous.results.forEach(r => { prevMap[r.keyword] = r; });

  current.results.forEach(r => {
    const prev = prevMap[r.keyword];
    if (!prev) return;

    const isP0 = P0_KEYWORDS.includes(r.keyword);
    const threshold = isP0 ? DROP_ALERT_P0 : DROP_ALERT_OTHER;

    if (r.organicPosition && prev.organicPosition) {
      const drop = r.organicPosition - prev.organicPosition;
      if (drop >= threshold) {
        alerts.push({ type: 'chatty_drop', keyword: r.keyword, from: prev.organicPosition, to: r.organicPosition, drop, isP0 });
      }
    }
    if (isP0 && r.organicPosition && r.organicPosition >= CHATTY_DANGER && (!prev.organicPosition || prev.organicPosition < CHATTY_DANGER)) {
      alerts.push({ type: 'chatty_danger', keyword: r.keyword, position: r.organicPosition, isP0 });
    }

    if (r.competitors && prev.competitors) {
      COMPETITORS.forEach(comp => {
        const currPos = r.competitors[comp.name];
        const prevPos = prev.competitors[comp.name];
        if (currPos && prevPos) {
          const rise = prevPos - currPos;
          if (rise >= COMP_RISE_ALERT) {
            alerts.push({ type: 'comp_rise', keyword: r.keyword, competitor: comp.name, from: prevPos, to: currPos, rise });
          }
        }
        if (currPos && currPos <= 3 && (!prevPos || prevPos > 3)) {
          alerts.push({ type: 'comp_top3', keyword: r.keyword, competitor: comp.name, position: currPos });
        }
      });
    }
  });

  return alerts;
}

// ─── Slack message builders ────────────────────────────────────────────────
function rankEmoji(pos) {
  if (!pos) return '⚫';
  if (pos === 1) return '🥇';
  if (pos <= 3) return '🟢';
  if (pos <= 6) return '🟡';
  if (pos <= 10) return '🟠';
  return '🔴';
}

function buildAlertMessage(alerts) {
  const lines = [':rotating_light: *Chatty Ranking Alert — Action Needed*\n'];
  alerts.forEach(a => {
    if (a.type === 'chatty_drop') {
      lines.push(`${a.isP0 ? '🚨' : '⚠️'} *"${a.keyword}"* — Chatty dropped from #${a.from} to #${a.to} (↓${a.drop} spots)${a.isP0 ? ' — P0 KEY!' : ''}`);
    } else if (a.type === 'chatty_danger') {
      lines.push(`🚨 *"${a.keyword}"* — Chatty fell to #${a.position} (danger zone on P0 keyword!)`);
    } else if (a.type === 'comp_rise') {
      lines.push(`⚠️ *"${a.keyword}"* — ${a.competitor} rose from #${a.from} to #${a.to} (↑${a.rise} spots)`);
    } else if (a.type === 'comp_top3') {
      lines.push(`🚨 *"${a.keyword}"* — ${a.competitor} entered top 3 at #${a.position}`);
    }
  });
  lines.push('\n📊 Full dashboard: https://ngnbthuy123131.github.io/chatty-listing-tracker/');
  return lines.join('\n');
}

function buildBiweeklyReport(current, twoWeeksAgo) {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const lines = [
    `:bar_chart: *Chatty Bi-Weekly Ranking Report — ${today}*\n`,
    '*Keyword performance (organic rank):*',
  ];

  const prevMap = {};
  if (twoWeeksAgo) twoWeeksAgo.results.forEach(r => { prevMap[r.keyword] = r; });

  current.results.forEach(r => {
    const prev = prevMap[r.keyword];
    const curr = r.organicPosition;
    const prevPos = prev?.organicPosition;
    let change = '';
    if (curr && prevPos) {
      const diff = curr - prevPos;
      if (diff < 0) change = ` *(↑${Math.abs(diff)})*`;
      else if (diff > 0) change = ` *(↓${diff})*`;
      else change = ' *(=)*';
    }
    const isP0 = P0_KEYWORDS.includes(r.keyword) ? ' ⭐' : '';
    lines.push(`${rankEmoji(curr)} *"${r.keyword}"*${isP0} — #${curr || '—'}${change}`);
  });

  lines.push('\n📊 Full dashboard: https://ngnbthuy123131.github.io/chatty-listing-tracker/');
  return lines.join('\n');
}

// ─── State helpers ─────────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastReportDate: null };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastReportDate: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n=== Chatty Daily Rank Check — ${new Date().toLocaleString()} ===\n`);

  if (!SLACK_TOKEN) {
    console.error('ERROR: SLACK_TOKEN env var not set');
    process.exit(1);
  }

  let log = [];
  if (fs.existsSync(LOG_FILE)) { try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {} }

  const previous = [...log].reverse().find(e => e.results.some(r => r.organicPosition !== undefined));

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const results = [];
  for (const kw of KEYWORDS) {
    process.stdout.write(`Checking "${kw}" ... `);
    const r = await searchKeyword(page, kw);
    results.push(r);
    console.log(r.organicPosition ? `#${r.organicPosition} organic` : (r.error ? `ERROR: ${r.error}` : 'Not found'));
    await page.waitForTimeout(1500);
  }
  await browser.close();

  const current = { date: new Date().toISOString().split('T')[0], time: new Date().toISOString(), results };
  log.push(current);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  console.log('\nRankings saved to ranking-log.json');

  // ── Alert check ──────────────────────────────────────────────────────────
  const alerts = detectAlerts(current, previous);
  if (alerts.length > 0) {
    console.log(`\n🚨 ${alerts.length} alert(s) detected — Slack report disabled`);
    await slackPost(buildAlertMessage(alerts));
    console.log('Slack alert skipped.');
  } else {
    console.log('\nNo major changes detected. No alert sent.');
  }

  // ── Bi-weekly report ─────────────────────────────────────────────────────
  const state = loadState();
  const today = new Date();
  const lastReport = state.lastReportDate ? new Date(state.lastReportDate) : null;
  const daysSince  = lastReport ? Math.floor((today - lastReport) / (1000 * 60 * 60 * 24)) : 999;

  if (daysSince >= 14) {
    console.log('\n📊 Bi-weekly report due — Slack report disabled');
    const twoWeeksAgoDate = new Date(today - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const twoWeeksAgo = log.filter(e => e.date <= twoWeeksAgoDate && e.results.some(r => r.organicPosition !== undefined)).slice(-1)[0] || null;
    await slackPost(buildBiweeklyReport(current, twoWeeksAgo));
    state.lastReportDate = today.toISOString().split('T')[0];
    saveState(state);
    console.log('Bi-weekly report skipped.');
  } else {
    console.log(`Next bi-weekly report in ${14 - daysSince} day(s).`);
  }

  console.log('\nDone.');
}

run().catch(e => { console.error(e); process.exit(1); });
