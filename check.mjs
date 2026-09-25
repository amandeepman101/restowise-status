// One status run. Called by .github/workflows/check.yml every 5 minutes.
//
// The target list is NOT in this repo: it arrives as the STATUS_TARGETS secret,
// because it names internal endpoints. This file only knows how to check a
// URL. Technical results go to Restowise's status-ingest function (owner-only
// Admin view); this repo only ever receives the PLAIN-NAMED rollup, in data/.
import fs from 'node:fs';

const TARGETS = JSON.parse(process.env.STATUS_TARGETS || '[]');
const INGEST_URL = process.env.STATUS_INGEST_URL;
const INGEST_TOKEN = process.env.STATUS_INGEST_TOKEN;
const DIR = process.env.DATA_DIR || 'data';
const SLOW_MS = 3000, TIMEOUT_MS = 10000;
if (!TARGETS.length) { console.error('STATUS_TARGETS is empty'); process.exit(1); }

async function once(t) {
  const t0 = performance.now();
  try {
    const res = await fetch(t.url, { method: t.method || 'GET', headers: t.headers || {}, redirect: 'follow', signal: AbortSignal.timeout(t.timeoutMs || TIMEOUT_MS) });
    const body = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (t.statuspage) {
      // Atlassian Statuspage: none = fine, minor = degraded, major/critical = down.
      const ind = JSON.parse(body)?.status?.indicator;
      return { ok: ind === 'none' || ind === 'minor', slow: ind === 'minor', ms, code: res.status, error: ind === 'none' ? null : `indicator ${ind}` };
    }
    const codeOk = (t.expect || [200]).includes(res.status);
    const bodyOk = !t.includes || body.includes(t.includes);
    const ok = codeOk && bodyOk;
    return { ok, slow: ok && ms > (t.slowMs || SLOW_MS), ms, code: res.status, error: ok ? null : `HTTP ${res.status}${bodyOk ? '' : ' (unexpected body)'}: ${body.slice(0, 160)}` };
  } catch (e) {
    return { ok: false, slow: false, ms: Math.round(performance.now() - t0), code: null, error: String(e?.message || e).slice(0, 200) };
  }
}

// A single miss is usually the network between GitHub and the target, not the
// target: retry once before calling it down.
async function check(t) {
  let r = await once(t);
  if (!r.ok) { await new Promise(s => setTimeout(s, 3000)); r = await once(t); }
  return { key: t.key, name: t.name, grp: t.grp, public: t.public, section: t.section, ...r };
}

const runAt = new Date();
const results = await Promise.all(TARGETS.map(check));

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); } catch { return d; } };
const prev = read('current.json', {});

// Technical half → Restowise (best effort: if Supabase is down, the public page
// still updates and keeps the last-known incidents).
let incidents = prev.incidents || [];
if (INGEST_URL && INGEST_TOKEN) {
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-status-token': INGEST_TOKEN },
      body: JSON.stringify({ run_at: runAt.toISOString(), results: results.map(({ section, ...r }) => r) }),
    });
    const j = await res.json();
    if (res.ok && Array.isArray(j.incidents)) incidents = j.incidents;
    else console.error('ingest refused', res.status, j);
  } catch (e) { console.error('ingest failed', e.message); }
}

// Public rollup: one line per plain name, the worst of its checks. No
// technical names, codes or error text past this point.
const order = [], byName = new Map();
for (const r of results) {
  if (!byName.has(r.public)) { byName.set(r.public, { name: r.public, section: r.section, rs: [] }); order.push(r.public); }
  byName.get(r.public).rs.push(r);
}
const services = order.map(n => {
  const { name, section, rs } = byName.get(n);
  const state = rs.some(r => !r.ok) ? 'down' : rs.some(r => r.slow) ? 'slow' : 'ok';
  return { name, section, state, ms: Math.max(...rs.map(r => r.ms || 0)) };
});
const overall = services.some(s => s.state === 'down') ? 'down' : services.some(s => s.state === 'slow') ? 'slow' : 'ok';

// History: 90 days of per-day tallies + the last 24h of 5-minute points.
const day = runAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const hist = read('history.json', { days: {}, recent: {} });
const cutoff = new Date(runAt.getTime() - 90 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
for (const s of services) {
  const d = (hist.days[s.name] ??= {});
  const t = (d[day] ??= { runs: 0, fails: 0, slows: 0, ms: 0 });
  t.runs++; if (s.state === 'down') t.fails++; if (s.state === 'slow') t.slows++; t.ms += s.ms;
  for (const k of Object.keys(d)) if (k < cutoff) delete d[k];
  const rec = (hist.recent[s.name] ??= []);
  rec.push([runAt.toISOString(), s.ms, s.state]);
  if (rec.length > 288) rec.splice(0, rec.length - 288);
}
for (const n of Object.keys(hist.days)) if (!byName.has(n)) { delete hist.days[n]; delete hist.recent[n]; }

// When the last outage ended — for the "days since" tile.
let lastOutage = prev.last_outage || null;
if (overall === 'down') lastOutage = runAt.toISOString();

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(`${DIR}/current.json`, JSON.stringify({ checked_at: runAt.toISOString(), overall, services, incidents, last_outage: lastOutage }, null, 1));
fs.writeFileSync(`${DIR}/history.json`, JSON.stringify(hist));
// Only a count: this repo is public, so its Actions logs are too, and a key
// names an internal endpoint. Which ones failed is in Admin › Status.
console.log(`${overall} · ${services.filter(s => s.state === 'ok').length}/${services.length} ok · ${results.filter(r => !r.ok).length} failed check(s)`);
