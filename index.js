const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.7';

const app = express();
app.set('trust proxy', 1); // Trust Cloudflare's X-Forwarded-Proto header
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 7000;
const APP_DIR = __dirname;

// Serve static assets (favicon, icon)
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.ico')));
app.use('/favicon.png', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.png')));
app.use('/icon.png',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.png')));
app.use('/icon.svg',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.svg')));
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Persistent config ─────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return { apiKey: process.env.OPENSUBTITLES_API_KEY || '' };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();
function getApiKey() { return config.apiKey || ''; }

// ── Manifest ──────────────────────────────────────────────────────────────────
function getManifest(baseUrl) {
  return {
    id: 'com.local.english-forced-subtitles',
    version: VERSION,
    name: 'English Forced Subtitles',
    description:
      'Provides English forced subtitles (foreign dialogue only) when available. ' +
      'Returns nothing if no forced subtitle exists — effectively disabling subtitles ' +
      'for fully-English content.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    logo: baseUrl ? `${baseUrl}/icon.png` : undefined,
    behaviorHints: { configurable: true, configurationRequired: !getApiKey() },
    configureUrl: baseUrl ? `${baseUrl}/configure` : undefined,
  };
}

// ── Landing page ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const hasKey = !!getApiKey();
  res.send(landingPage(baseUrl, hasKey));
});

// ── Configure page ────────────────────────────────────────────────────────────
app.get('/configure', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const hasKey = !!getApiKey();
  res.send(configurePage(baseUrl, hasKey, getApiKey()));
});

app.post('/configure', (req, res) => {
  const { apiKey } = req.body;
  if (apiKey && apiKey.trim()) {
    config.apiKey = apiKey.trim();
    saveConfig(config);
    console.log('[Config] API key saved');
  }
  res.redirect('/configure?saved=1');
});

// ── API: get status (for AJAX) ────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ configured: !!getApiKey() });
});

// ── Manifest endpoint ─────────────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(getManifest(baseUrl));
});

// ── Subtitle handler ──────────────────────────────────────────────────────────
app.get('/subtitles/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const [imdbId, season, episode] = id.split(':');

  if (!getApiKey()) {
    console.log('[Subtitles] No API key configured — returning empty');
    return res.json({ subtitles: [] });
  }

  console.log(`[Request] type=${type} imdbId=${imdbId} s=${season || '-'} e=${episode || '-'}`);

  try {
    const subtitles = await findForcedSubtitle(imdbId, season, episode, type);
    console.log(`[Result] ${subtitles.length} subtitle(s) for ${imdbId}`);
    res.json({ subtitles });
  } catch (err) {
    console.error(`[Error] ${err.message}`);
    res.json({ subtitles: [] });
  }
});

// ── Forced subtitle detection ─────────────────────────────────────────────────
// Strategy 1: trust the foreign_parts_only flag on the result object (most reliable)
// Strategy 2: fall back to keyword matching on release name

const FORCED_KEYWORDS = [
  'forced', 'foreign', 'forc.', 'foreign.parts', 'foreign_parts',
  'foreignparts', 'forced.subs', 'forced_subs', 'forcedsubs',
];
const EXCLUDE_KEYWORDS = [
  'hearing.impaired', 'hearingimpaired', '.hi.', 'sdh', 'cc.',
  'full.subs', 'complete', 'director', 'commentary',
];

function isForced(result) {
  const attrs = result.attributes || {};
  const releaseName = (attrs.release || attrs.files?.[0]?.file_name || '').toLowerCase();

  // Strategy 1: use the per-result metadata flag from OpenSubtitles
  if (attrs.foreign_parts_only === true) {
    console.log(`  ✓ Accepted via metadata flag: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  // Strategy 2: fall back to keyword matching on the release name
  const hasForced = FORCED_KEYWORDS.some(k => releaseName.includes(k));
  const hasExclude = EXCLUDE_KEYWORDS.some(k => releaseName.includes(k));

  if (hasForced && !hasExclude) {
    console.log(`  ✓ Accepted via keyword: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  const flag = attrs.foreign_parts_only;
  console.log(`  ✗ Rejected: "${attrs.release || '(unnamed)'}" (flag=${flag}, forced=${hasForced}, exclude=${hasExclude})`);
  return false;
}

// ── Core subtitle logic ───────────────────────────────────────────────────────
async function findForcedSubtitle(imdbId, season, episode, type) {
  const params = new URLSearchParams({
    imdb_id: imdbId.replace('tt', ''),
    languages: 'en',
    order_by: 'download_count',
    order_direction: 'desc',
  });

  if (type === 'series' && season && episode) {
    params.set('season_number', season);
    params.set('episode_number', episode);
  }

  const response = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
    headers: {
      'Api-Key': getApiKey(),
      'Content-Type': 'application/json',
      'User-Agent': 'StremioForcedSubtitles/1.0',
    },
  });

  if (!response.ok) throw new Error(`OpenSubtitles API: ${response.status}`);

  const data = await response.json();
  const results = data.data || [];

  if (results.length === 0) {
    console.log(`  No results from OpenSubtitles`);
    return [];
  }

  console.log(`  ${results.length} candidate(s) — checking metadata flag then keywords...`);

  // Find the first result that passes the keyword filter
  const best = results.find(r => isForced(r));

  if (!best) {
    console.log(`  ✗ No forced subtitle found — suppressing subtitles`);
    return [];
  }

  const fileId = best.attributes?.files?.[0]?.file_id;
  const releaseName = best.attributes?.release || 'Forced';
  const uploadDate = best.attributes?.upload_date?.slice(0, 10) || '';
  if (!fileId) return [];

  const downloadUrl = await getDownloadUrl(fileId);
  if (!downloadUrl) return [];

  console.log(`  ✓ Accepted: "${releaseName}"`);
  return [{
    id: `forced-en-${fileId}`,
    url: downloadUrl,
    lang: 'eng',
    id_prefix: `[Forced] ${releaseName}${uploadDate ? ' · ' + uploadDate : ''}`,
  }];
}

async function getDownloadUrl(fileId) {
  const response = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      'Api-Key': getApiKey(),
      'Content-Type': 'application/json',
      'User-Agent': 'StremioForcedSubtitles/1.0',
    },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.link || null;
}

// ── HTML Pages ────────────────────────────────────────────────────────────────

const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #13131a;
    --surface2: #1c1c28;
    --border: #2a2a3a;
    --accent: #7c5cff;
    --accent2: #c084fc;
    --green: #34d399;
    --amber: #fbbf24;
    --red: #f87171;
    --text: #e8e8f0;
    --muted: #6b7280;
    --radius: 12px;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Syne', sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 60% 40% at 20% 10%, rgba(124,92,255,0.12) 0%, transparent 60%),
      radial-gradient(ellipse 40% 30% at 80% 80%, rgba(192,132,252,0.08) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    max-width: 680px;
    margin: 0 auto;
    padding: 48px 24px 80px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 48px;
  }

  .logo-icon {
    width: 48px; height: 48px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    box-shadow: 0 0 32px rgba(124,92,255,0.4);
    flex-shrink: 0;
  }

  .logo-text { line-height: 1; }
  .logo-name { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
  .logo-sub  { font-size: 12px; color: var(--muted); margin-top: 3px; font-family: 'DM Mono', monospace; }

  h1 { font-size: 36px; font-weight: 800; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 12px; }
  h1 span { background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }

  .subtitle { color: var(--muted); font-size: 15px; line-height: 1.6; margin-bottom: 40px; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px;
    margin-bottom: 20px;
  }

  .card-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 18px;
  }

  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 22px;
    border-radius: 10px;
    font-family: 'Syne', sans-serif;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    border: none;
    transition: all 0.15s ease;
    text-decoration: none;
    white-space: nowrap;
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #fff;
    box-shadow: 0 4px 20px rgba(124,92,255,0.35);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(124,92,255,0.5); }

  .btn-outline {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-outline:hover { background: var(--surface2); border-color: var(--accent); }

  .btn-ghost {
    background: var(--surface2);
    color: var(--muted);
    font-size: 13px;
  }
  .btn-ghost:hover { color: var(--text); }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot-amber { background: var(--amber); box-shadow: 0 0 8px var(--amber); }

  .mono { font-family: 'DM Mono', monospace; font-size: 13px; }

  input[type="text"], input[type="password"] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    color: var(--text);
    font-family: 'DM Mono', monospace;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,92,255,0.15); }
`;

function landingPage(baseUrl, hasKey) {
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioUrl  = `stremio://${baseUrl.replace(/^https?:\/\//, '')}/manifest.json`;
  const manifestJson = JSON.stringify({
    id: 'com.local.english-forced-subtitles',
    version: VERSION,
    name: 'English Forced Subtitles',
    description: 'Provides English forced subtitles (foreign dialogue only) when available. Returns nothing if no forced subtitle exists.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true },
    configureUrl: `${baseUrl}/configure`,
  }, null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>English Forced Subtitles — Stremio Add-on</title>
  <style>
    ${SHARED_STYLES}

    .hero { margin-bottom: 40px; }

    .status-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 32px;
    }

    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 20px;
    }

    .action-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px 20px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-decoration: none;
      color: var(--text);
      display: block;
    }
    .action-card:hover { border-color: var(--accent); background: var(--surface2); transform: translateY(-2px); }

    .action-icon { font-size: 26px; margin-bottom: 12px; }
    .action-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .action-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }

    .url-row {
      display: flex; align-items: center; gap: 10px;
    }
    .url-box {
      flex: 1;
      padding: 10px 14px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .how-it-works {
      display: flex; flex-direction: column; gap: 14px;
    }
    .step {
      display: flex; gap: 14px; align-items: flex-start;
    }
    .step-num {
      width: 26px; height: 26px;
      border-radius: 50%;
      background: var(--surface2);
      border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700; color: var(--accent);
      flex-shrink: 0; margin-top: 1px;
    }
    .step-text { font-size: 14px; color: var(--muted); line-height: 1.6; }
    .step-text strong { color: var(--text); }

    .toast {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--surface2);
      border: 1px solid var(--green);
      color: var(--green);
      padding: 12px 18px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      pointer-events: none;
      z-index: 100;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .card, .action-card { animation: fadeIn 0.4s ease both; }
    .card:nth-child(2) { animation-delay: 0.05s; }
    .card:nth-child(3) { animation-delay: 0.1s; }
  </style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">💬</div>
    <div class="logo-text">
      <div class="logo-name">English Forced Subtitles</div>
      <div class="logo-sub">Stremio Add-on · v${VERSION}</div>
    </div>
  </div>

  <div class="hero">
    <h1>Subtitles <span>only when<br>you need them</span></h1>
    <p class="subtitle">
      Automatically loads English forced subtitles for foreign dialogue in otherwise<br>
      English content. Stays silent when there's nothing to translate.
    </p>
  </div>

  <div class="status-bar">
    <div class="status-dot ${hasKey ? 'dot-green' : 'dot-amber'}"></div>
    <span style="color:var(--muted)">${hasKey ? 'Add-on configured and ready' : 'API key not yet configured — visit Configure to set up'}</span>
    <a href="/configure" style="margin-left:auto; color:var(--accent); font-size:12px; font-weight:700; text-decoration:none;">Configure →</a>
  </div>

  <div class="action-grid">
    <a href="${stremioUrl}" class="action-card" style="animation-delay:0s">
      <div class="action-icon">🚀</div>
      <div class="action-title">Install in Stremio</div>
      <div class="action-desc">Opens Stremio Desktop and installs the add-on in one click</div>
    </a>
    <a href="/configure" class="action-card" style="animation-delay:0.05s">
      <div class="action-icon">⚙️</div>
      <div class="action-title">Configure</div>
      <div class="action-desc">Set your OpenSubtitles API key to enable subtitle lookups</div>
    </a>
  </div>

  <div class="card">
    <div class="card-title">Manifest URL</div>
    <div class="url-row">
      <div class="url-box" id="manifestUrl">${manifestUrl}</div>
      <button class="btn btn-ghost" onclick="copyUrl('${manifestUrl}', 'url')">Copy</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Copy Manifest JSON</div>
    <p style="font-size:13px; color:var(--muted); margin-bottom:16px; line-height:1.6">
      Paste this into Stremio → Add-ons → click the puzzle piece icon
    </p>
    <button class="btn btn-outline" onclick="copyManifest()" style="width:100%; justify-content:center">
      <span>📋</span> Copy Manifest JSON
    </button>
    <textarea id="manifestJson" style="position:absolute;left:-9999px" readonly>${manifestJson.replace(/</g, '&lt;')}</textarea>
  </div>

  <div class="card">
    <div class="card-title">How it works</div>
    <div class="how-it-works">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">When you play a title in Stremio, this add-on is asked for subtitles</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">It queries OpenSubtitles for <strong>English forced-only</strong> subtitles using the <code style="background:var(--surface2);padding:1px 5px;border-radius:4px;font-size:12px">foreign_parts_only</code> filter</div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text"><strong>Found:</strong> returns the best-matched track → Stremio auto-selects it</div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text"><strong>Not found:</strong> returns an empty list → no subtitle loads at all</div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  const manifestJsonRaw = ${JSON.stringify(manifestJson)};

  function copyUrl(text, type) {
    navigator.clipboard.writeText(text).then(() => showToast('URL copied to clipboard'));
  }

  function copyManifest() {
    navigator.clipboard.writeText(manifestJsonRaw).then(() => showToast('Manifest JSON copied!'));
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = '✓ ' + msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }
</script>
</body>
</html>`;
}

function configurePage(baseUrl, hasKey, currentKey) {
  const maskedKey = currentKey ? currentKey.slice(0, 8) + '•'.repeat(Math.max(0, currentKey.length - 8)) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configure — English Forced Subtitles</title>
  <style>
    ${SHARED_STYLES}

    .back-link {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--muted); font-size: 13px; font-weight: 600;
      text-decoration: none; margin-bottom: 40px;
      transition: color 0.15s;
    }
    .back-link:hover { color: var(--text); }

    .form-group { margin-bottom: 22px; }
    .form-label {
      display: block;
      font-size: 12px; font-weight: 700;
      letter-spacing: 1px; text-transform: uppercase;
      color: var(--muted); margin-bottom: 10px;
    }
    .form-hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
    .form-hint a { color: var(--accent); text-decoration: none; }
    .form-hint a:hover { text-decoration: underline; }

    .input-row { display: flex; gap: 10px; }
    .input-row input { flex: 1; }

    .current-key {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px;
      background: var(--bg);
      border: 1px solid var(--green);
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .current-key-label { font-size: 12px; color: var(--muted); }
    .current-key-val { font-family: 'DM Mono', monospace; font-size: 13px; color: var(--green); }

    .alert {
      padding: 14px 18px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 24px;
      display: flex; align-items: center; gap: 10px;
    }
    .alert-success {
      background: rgba(52,211,153,0.1);
      border: 1px solid rgba(52,211,153,0.3);
      color: var(--green);
    }

    .divider {
      border: none; border-top: 1px solid var(--border);
      margin: 28px 0;
    }

    .test-result {
      margin-top: 14px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
    }
    .test-ok   { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--green); }
    .test-fail { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--red); }

    @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .card { animation: fadeIn 0.35s ease both; }
    .card:nth-child(3) { animation-delay: 0.07s; }
  </style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← Back to add-on</a>

  <div class="logo">
    <div class="logo-icon">⚙️</div>
    <div class="logo-text">
      <div class="logo-name">Configure Add-on</div>
      <div class="logo-sub">English Forced Subtitles</div>
    </div>
  </div>

  ${hasKey ? `<div class="alert alert-success">✓ API key is configured. The add-on is active.</div>` : ''}

  <div class="card">
    <div class="card-title">OpenSubtitles API Key</div>

    ${hasKey ? `
    <div class="current-key">
      <div class="status-dot dot-green"></div>
      <div>
        <div class="current-key-label">Current key</div>
        <div class="current-key-val">${maskedKey}</div>
      </div>
    </div>` : ''}

    <form method="POST" action="/configure">
      <div class="form-group">
        <label class="form-label" for="apiKey">${hasKey ? 'Replace API key' : 'Enter your API key'}</label>
        <div class="input-row">
          <input type="password" id="apiKey" name="apiKey" placeholder="e.g. AbC1dEf2GhI3..." autocomplete="off" />
          <button type="button" class="btn btn-ghost" onclick="toggleShow()">Show</button>
        </div>
        <p class="form-hint">
          Get a free key at <a href="https://www.opensubtitles.com/en/consumers" target="_blank">opensubtitles.com/en/consumers</a>
          — sign up, register a consumer app, copy the key.
        </p>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%; justify-content:center">
        💾 Save API Key
      </button>
    </form>

    <div id="testResult" class="test-result"></div>

    <hr class="divider">

    <button class="btn btn-ghost" style="width:100%; justify-content:center" onclick="testKey()">
      🔌 Test current key
    </button>
  </div>

  <div class="card">
    <div class="card-title">After Saving</div>
    <p style="font-size:14px; color:var(--muted); line-height:1.7; margin-bottom:18px">
      Once your key is saved, go back to the main page and click <strong style="color:var(--text)">Install in Stremio</strong>.
      Make sure to <strong style="color:var(--text)">disable other subtitle add-ons</strong> in Stremio so they don't override this one.
    </p>
    <a href="/" class="btn btn-outline" style="width:100%; justify-content:center">← Back to main page</a>
  </div>
</div>

<script>
  // Show saved message if redirected back after save
  if (window.location.search.includes('saved=1')) {
    const url = new URL(window.location);
    url.searchParams.delete('saved=1');
    history.replaceState({}, '', url);
  }

  function toggleShow() {
    const input = document.getElementById('apiKey');
    const btn = event.target;
    if (input.type === 'password') { input.type = 'text'; btn.textContent = 'Hide'; }
    else { input.type = 'password'; btn.textContent = 'Show'; }
  }

  async function testKey() {
    const res = document.getElementById('testResult');
    res.style.display = 'flex';
    res.className = 'test-result';
    res.textContent = '⏳ Testing...';

    try {
      // Test by searching for a known movie (The Matrix tt0133093) with forced subtitles
      const r = await fetch('/api/test-key');
      const data = await r.json();
      if (data.ok) {
        res.className = 'test-result test-ok';
        res.textContent = '✓ API key is valid and working';
      } else {
        res.className = 'test-result test-fail';
        res.textContent = '✗ ' + (data.error || 'Key test failed — check the key and try again');
      }
    } catch {
      res.className = 'test-result test-fail';
      res.textContent = '✗ Could not reach the test endpoint';
    }
  }
</script>
</body>
</html>`;
}

// ── API key test endpoint ──────────────────────────────────────────────────────
app.get('/api/test-key', async (req, res) => {
  if (!getApiKey()) return res.json({ ok: false, error: 'No API key configured' });
  try {
    const r = await fetch('https://api.opensubtitles.com/api/v1/subtitles?imdb_id=133093&languages=en&foreign_parts_only=only', {
      headers: { 'Api-Key': getApiKey(), 'User-Agent': 'StremioForcedSubtitles/1.0' },
    });
    if (r.status === 401) return res.json({ ok: false, error: 'Invalid API key (401 Unauthorized)' });
    if (!r.ok) return res.json({ ok: false, error: `API returned ${r.status}` });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ English Forced Subtitles add-on v${VERSION} starting...`);
  console.log(`   Web UI:   http://127.0.0.1:${PORT}/`);
  console.log(`   Config:   http://127.0.0.1:${PORT}/configure`);
  console.log(`   Manifest: http://127.0.0.1:${PORT}/manifest.json\n`);
  if (!getApiKey()) {
    console.warn(`⚠️  No API key set — visit http://127.0.0.1:${PORT}/configure to add one\n`);
  }
});
