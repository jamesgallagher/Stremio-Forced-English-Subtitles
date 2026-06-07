const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const OS = require('opensubtitles.com');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const express = require('express');

const VERSION = '1.2.9';

// Timestamped logging
const log  = (...a) => console.log(`[${new Date().toTimeString().slice(0,8)}]`, ...a);
const logW = (...a) => console.warn(`[${new Date().toTimeString().slice(0,8)}] ⚠️ `, ...a);
const logE = (...a) => console.error(`[${new Date().toTimeString().slice(0,8)}] ✗`, ...a);
const PORT = process.env.PORT || 7000;
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Persistent config ─────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return { apiKey: process.env.OPENSUBTITLES_API_KEY || '', username: '', password: '', jwtToken: '' };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

let config = loadConfig();
function getApiKey()  { return config.apiKey  || ''; }
function getUsername(){ return config.username || ''; }
function getPassword(){ return config.password || ''; }
function getJwtToken(){ return config.jwtToken || ''; }

// Build an OpenSubtitles client with current config
// Called fresh each time so it always uses the latest saved credentials
function getOSClient() {
  return new OS({
    apikey: getApiKey(),
    useragent: `StremioForcedSubs v${VERSION}`,
  });
}

// Login and return a token, caching it in config
async function ensureLoggedIn() {
  if (getJwtToken()) return getJwtToken();
  if (!getUsername() || !getPassword()) return null;
  try {
    log('[Auth] Logging in to OpenSubtitles...');
    const os = getOSClient();
    const res = await os.login({ username: getUsername(), password: getPassword() });
    if (res?.token) {
      config.jwtToken = res.token;
      saveConfig(config);
      log('[Auth] Login successful, token cached');
      return res.token;
    }
    logE('[Auth] Login returned no token');
  } catch (e) { logE('[Auth] Login error:', e.message); }
  return null;
}

// ── Stremio Addon SDK ─────────────────────────────────────────────────────────
const builder = new addonBuilder({
  id: 'com.local.english-forced-subtitles',
  version: VERSION,
  name: 'English Forced Subtitles',
  description: 'Provides English forced subtitles (foreign dialogue only) when available. Returns nothing if no forced subtitle exists — effectively disabling subtitles for fully-English content.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
});

builder.defineSubtitlesHandler(async ({ type, id }) => {
  const [imdbId, season, episode] = id.split(':');
  log(`[Request] type=${type} id=${id}`);

  if (!getApiKey() || !getUsername() || !getPassword()) {
    log('  Not fully configured (need API key + username + password) — returning empty');
    return { subtitles: [] };
  }

  try {
    const subtitles = await findForcedSubtitle(imdbId, season, episode, type);
    log(`[Result] ${subtitles.length} subtitle(s) for ${imdbId}`);
    return { subtitles };
  } catch (err) {
    logE(`[Error] ${err.message}`);
    return { subtitles: [] };
  }
});

// ── Forced subtitle detection ─────────────────────────────────────────────────
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

  if (attrs.foreign_parts_only === true) {
    log(`  ✓ Accepted via metadata flag: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  const hasForced = FORCED_KEYWORDS.some(k => releaseName.includes(k));
  const hasExclude = EXCLUDE_KEYWORDS.some(k => releaseName.includes(k));

  if (hasForced && !hasExclude) {
    log(`  ✓ Accepted via keyword: "${attrs.release || '(unnamed)'}"`);
    return true;
  }

  log(`  ✗ Rejected: "${attrs.release || '(unnamed)'}" (flag=${attrs.foreign_parts_only}, forced=${hasForced}, exclude=${hasExclude})`);
  return false;
}

async function findForcedSubtitle(imdbId, season, episode, type) {
  const os = getOSClient();
  const query = {
    imdb_id: imdbId.replace('tt', ''),
    languages: 'en',
    order_by: 'download_count',
    order_direction: 'desc',
  };

  if (type === 'series' && season && episode) {
    query.season_number = season;
    query.episode_number = episode;
  }

  const data = await os.subtitles(query);
  const results = data.data || [];

  if (results.length === 0) { log(`  No results from OpenSubtitles`); return []; }

  log(`  ${results.length} candidate(s) — checking metadata flag then keywords...`);
  const best = results.find(r => isForced(r));
  if (!best) { log(`  ✗ No forced subtitle found — suppressing subtitles`); return []; }

  const fileId = best.attributes?.files?.[0]?.file_id;
  const releaseName = best.attributes?.release || 'Forced';
  const uploadDate = best.attributes?.upload_date?.slice(0, 10) || '';
  if (!fileId) return [];

  // Verify line count now (using a fresh temporary URL) to confirm it's genuinely forced
  // We fetch it here just to count lines, then discard the URL
  // When Stremio actually needs the subtitle, it hits our /subs/:fileId endpoint
  // which fetches a fresh non-expired URL on demand
  log(`  Fetching download URL for fileId=${fileId}...`);
  const tempUrl = await getDownloadUrl(fileId);
  if (!tempUrl) {
    log(`  ✗ Failed to get download URL — check credentials and quota`);
    return [];
  }
  log(`  Download URL obtained — fetching subtitle to verify line count...`);

  const lineCount = await countSubtitleLines(tempUrl);
  if (lineCount === null) {
    log(`  ✗ Could not fetch subtitle to verify line count — skipping`);
    return [];
  }
  if (lineCount > 800) {
    log(`  ✗ Rejected: ${lineCount} lines — exceeds 800 line threshold, likely a full subtitle not forced`);
    return [];
  } else if (lineCount > 400) {
    log(`  ⚠️  Warning: ${lineCount} lines — higher than expected for forced subtitles, proceeding anyway`);
  } else {
    log(`  ✓ Line count looks good (${lineCount} lines)`);
  }
  log(`  Returning track — use subtitle picker to verify it looks correct`);

  // Return a URL that points to our own proxy endpoint
  // This fetches a FRESH download URL from OpenSubtitles when Stremio actually requests the file
  // preventing the "expired URL" problem
  const ourProxyUrl = `${process.env.PUBLIC_URL || 'http://127.0.0.1:7000'}/subs/${fileId}`;
  log(`  ➤ Subtitle URL being returned to Stremio: ${ourProxyUrl}`);

  return [{
    id: `forced-en-${fileId}`,
    url: ourProxyUrl,
    lang: 'eng',
    id_prefix: `[Forced] ${releaseName}${uploadDate ? ' · ' + uploadDate : ''}`,
  }];
}

async function countSubtitleLines(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'StremioForcedSubtitles/1.0' },
    });
    if (!response.ok) {
      log(`  ✗ Subtitle fetch failed: HTTP ${response.status}`);
      return null;
    }
    const text = await response.text();
    const sizeKb = (text.length / 1024).toFixed(1);
    log(`  Subtitle file fetched OK (${sizeKb} KB)`);
    // Count non-empty lines that aren't timestamps or sequence numbers
    // SRT format: sequence number, timestamp, text lines, blank line
    const lines = text.split('\n').filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;                          // blank
      if (/^\d+$/.test(trimmed)) return false;           // sequence number
      if (/-->/.test(trimmed)) return false;              // timestamp
      return true;                                         // actual subtitle text
    });
    return lines.length;
  } catch (e) {
    log(`  Warning: could not fetch subtitle for line count: ${e.message}`);
    return null;
  }
}

async function getDownloadUrl(fileId) {
  const token = await ensureLoggedIn();
  const os = getOSClient();

  try {
    // Pass token if we have one so it uses authenticated quota (20/day vs 5/day)
    const opts = { file_id: fileId };
    if (token) opts.token = token;

    const res = await os.download(opts);
    if (res?.link) {
      log(`[Download] OK — remaining quota: ${res.remaining ?? '?'}`);
      return res.link;
    }
    logE('[Download] No link in response:', JSON.stringify(res));
    return null;
  } catch (e) {
    // Token may have expired — clear and retry once
    if (e.message?.includes('401') || e.message?.includes('token')) {
      log('[Auth] Token expired, refreshing...');
      config.jwtToken = '';
      saveConfig(config);
      const newToken = await ensureLoggedIn();
      if (!newToken) return null;
      try {
        const retry = await os.download({ file_id: fileId, token: newToken });
        if (retry?.link) {
          log(`[Download] Retry OK — remaining quota: ${retry.remaining ?? '?'}`);
          return retry.link;
        }
      } catch (e2) { logE('[Download] Retry failed:', e2.message); }
    } else {
      logE('[Download] Error:', e.message);
    }
    return null;
  }
}

// ── Web UI (configure page) ───────────────────────────────────────────────────
// We get the addon router from the SDK, then attach our own configure routes on top

const addonInterface = builder.getInterface();
const addonRouter = require('stremio-addon-sdk').getRouter(addonInterface);

const app = express();
app.set('trust proxy', 1);
app.use(require('cors')());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_DIR = __dirname;
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.ico')));
app.use('/favicon.png', (req, res) => res.sendFile(path.join(APP_DIR, 'favicon.png')));
app.use('/icon.png',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.png')));
app.use('/icon.svg',    (req, res) => res.sendFile(path.join(APP_DIR, 'icon.svg')));

// Landing page
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const hasKey = !!getApiKey();
  res.send(landingPage(baseUrl, hasKey));
});

// Configure page
app.get('/configure', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.send(configurePage(baseUrl, !!getApiKey(), getApiKey(), getUsername()));
});

app.post('/configure', (req, res) => {
  const { apiKey, username, password } = req.body;
  if (apiKey && apiKey.trim()) config.apiKey = apiKey.trim();
  if (username && username.trim()) config.username = username.trim();
  if (password && password.trim()) config.password = password.trim();
  // Clear cached JWT so it re-authenticates with new credentials
  config.jwtToken = '';
  saveConfig(config);
  log('[Config] Settings saved');
  res.redirect('/configure?saved=1');
});

app.get('/api/status', (req, res) => res.json({ configured: !!getApiKey() }));

app.get('/api/test-key', async (req, res) => {
  if (!getApiKey()) return res.json({ ok: false, error: 'No API key configured' });
  try {
    const os = getOSClient();
    await os.subtitles({ imdb_id: '133093', languages: 'en' });
    res.json({ ok: true });
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('401') || msg.includes('403')) return res.json({ ok: false, error: 'Invalid API key or User-Agent rejected' });
    res.json({ ok: false, error: msg });
  }
});

// ── SRT → VTT converter ──────────────────────────────────────────────────────
function srtToVtt(srt) {
  const normalised = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const converted = normalised.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + converted.trim();
}

// ── Subtitle proxy endpoint ───────────────────────────────────────────────────
app.get('/subs/:fileId', async (req, res) => {
  const { fileId } = req.params;
  log(`[Proxy] Stremio requested subtitle file for fileId=${fileId}`);

  if (!getApiKey()) {
    log(`[Proxy] ✗ No API key configured`);
    return res.status(503).send('No API key configured');
  }

  try {
    log(`[Proxy] Fetching fresh download URL from OpenSubtitles...`);
    const downloadUrl = await getDownloadUrl(fileId);
    if (!downloadUrl) {
      log(`[Proxy] ✗ Could not get download URL — check credentials and quota`);
      return res.status(404).send('Could not get download URL');
    }
    log(`[Proxy] Download URL obtained — fetching subtitle file...`);

    const subResponse = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'StremioForcedSubtitles/1.0',
        'Accept-Encoding': 'identity', // request uncompressed so we can serve it directly
      },
    });

    if (!subResponse.ok) {
      log(`[Proxy] ✗ Subtitle file fetch failed: HTTP ${subResponse.status}`);
      return res.status(502).send('Could not fetch subtitle file');
    }

    const subText = await subResponse.text();
    log(`[Proxy] ✓ Subtitle received (${(subText.length/1024).toFixed(1)} KB) — serving raw SRT`);

    // Serve raw SRT — Stremio fetches this via its 127.0.0.1:11470 proxy which converts to VTT
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Length', Buffer.byteLength(subText, 'utf8'));
    res.send(subText);

    log(`[Proxy] ✓ Raw SRT delivered for fileId=${fileId}`);
  } catch (e) {
    logE(`[Proxy] ✗ Error: ${e.message}`);
    res.status(500).send('Proxy error');
  }
});

// Mount the addon SDK router — this handles /manifest.json and /subtitles/:type/:id.json
app.use('/', addonRouter);

app.listen(PORT, () => {
  log(`\n✅ English Forced Subtitles add-on v${VERSION} starting...`);
  log(`   Web UI:   http://127.0.0.1:${PORT}/`);
  log(`   Config:   http://127.0.0.1:${PORT}/configure`);
  log(`   Manifest: http://127.0.0.1:${PORT}/manifest.json\n`);
  if (!getApiKey()) logW(`⚠️  No API key set — visit http://127.0.0.1:${PORT}/configure to add one\n`);
});

// ── HTML Pages ────────────────────────────────────────────────────────────────
const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f; --surface: #13131a; --surface2: #1c1c28; --border: #2a2a3a;
    --accent: #7c5cff; --accent2: #c084fc; --green: #34d399; --amber: #fbbf24;
    --red: #f87171; --text: #e8e8f0; --muted: #6b7280; --radius: 12px;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Syne', sans-serif; min-height: 100vh; overflow-x: hidden; }
  body::before { content: ''; position: fixed; inset: 0;
    background: radial-gradient(ellipse 60% 40% at 20% 10%, rgba(124,92,255,0.12) 0%, transparent 60%),
                radial-gradient(ellipse 40% 30% at 80% 80%, rgba(192,132,252,0.08) 0%, transparent 60%);
    pointer-events: none; z-index: 0; }
  .container { position: relative; z-index: 1; max-width: 680px; margin: 0 auto; padding: 48px 24px 80px; }
  .logo { display: flex; align-items: center; gap: 14px; margin-bottom: 48px; }
  .logo-icon { width: 48px; height: 48px; background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 14px; display: flex; align-items: center; justify-content: center;
    font-size: 22px; box-shadow: 0 0 32px rgba(124,92,255,0.4); flex-shrink: 0; }
  .logo-name { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
  .logo-sub  { font-size: 12px; color: var(--muted); margin-top: 3px; font-family: 'DM Mono', monospace; }
  h1 { font-size: 36px; font-weight: 800; letter-spacing: -1.5px; line-height: 1.1; margin-bottom: 12px; }
  h1 span { background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .subtitle { color: var(--muted); font-size: 15px; line-height: 1.6; margin-bottom: 40px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; margin-bottom: 20px; }
  .card-title { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); margin-bottom: 18px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 22px; border-radius: 10px;
    font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; cursor: pointer; border: none;
    transition: all 0.15s ease; text-decoration: none; white-space: nowrap; }
  .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; box-shadow: 0 4px 20px rgba(124,92,255,0.35); }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 28px rgba(124,92,255,0.5); }
  .btn-outline { background: transparent; color: var(--text); border: 1px solid var(--border); }
  .btn-outline:hover { background: var(--surface2); border-color: var(--accent); }
  .btn-ghost { background: var(--surface2); color: var(--muted); font-size: 13px; }
  .btn-ghost:hover { color: var(--text); }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot-amber { background: var(--amber); box-shadow: 0 0 8px var(--amber); }
  input[type="text"], input[type="password"] { width: 100%; background: var(--bg); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 16px; color: var(--text); font-family: 'DM Mono', monospace;
    font-size: 13px; outline: none; transition: border-color 0.15s; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,92,255,0.15); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .card { animation: fadeIn 0.4s ease both; }
`;

function landingPage(baseUrl, hasKey) {
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioUrl  = `stremio://${baseUrl.replace(/^https?:\/\//, '')}/manifest.json`;
  const manifestJson = JSON.stringify({
    id: 'com.local.english-forced-subtitles', version: VERSION, name: 'English Forced Subtitles',
    description: 'Provides English forced subtitles (foreign dialogue only) when available.',
    resources: ['subtitles'], types: ['movie', 'series'], catalogs: [],
    behaviorHints: { configurable: true }, configureUrl: `${baseUrl}/configure`,
  }, null, 2);

  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" href="/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>English Forced Subtitles — Stremio Add-on</title>
  <style>${SHARED_STYLES}
    .status-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
      background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
      font-size: 13px; margin-bottom: 32px; }
    .action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .action-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 22px 20px; cursor: pointer; transition: all 0.15s ease; text-decoration: none;
      color: var(--text); display: block; }
    .action-card:hover { border-color: var(--accent); background: var(--surface2); transform: translateY(-2px); }
    .action-icon { font-size: 26px; margin-bottom: 12px; }
    .action-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .action-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .url-row { display: flex; align-items: center; gap: 10px; }
    .url-box { flex: 1; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border);
      border-radius: 8px; font-family: 'DM Mono', monospace; font-size: 12px; color: var(--muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface2);
      border: 1px solid var(--green); color: var(--green); padding: 12px 18px; border-radius: 10px;
      font-size: 13px; font-weight: 600; opacity: 0; transform: translateY(10px);
      transition: all 0.2s ease; pointer-events: none; z-index: 100; }
    .toast.show { opacity: 1; transform: translateY(0); }
  </style></head><body>
  <div class="container">
    <div class="logo">
      <div class="logo-icon">💬</div>
      <div class="logo-text">
        <div class="logo-name">English Forced Subtitles</div>
        <div class="logo-sub">Stremio Add-on · v${VERSION}</div>
      </div>
    </div>
    <h1>Subtitles <span>only when<br>you need them</span></h1>
    <p class="subtitle">Automatically loads English forced subtitles for foreign dialogue.<br>Stays silent when there's nothing to translate.</p>
    <div class="status-bar">
      <div class="status-dot ${hasKey ? 'dot-green' : 'dot-amber'}"></div>
      <span style="color:var(--muted)">${hasKey ? 'Add-on configured and ready' : 'API key not yet configured'}</span>
      <a href="/configure" style="margin-left:auto;color:var(--accent);font-size:12px;font-weight:700;text-decoration:none">Configure →</a>
    </div>
    <div class="action-grid">
      <a href="${stremioUrl}" class="action-card">
        <div class="action-icon">🚀</div>
        <div class="action-title">Install in Stremio</div>
        <div class="action-desc">Opens Stremio Desktop and installs in one click</div>
      </a>
      <a href="/configure" class="action-card">
        <div class="action-icon">⚙️</div>
        <div class="action-title">Configure</div>
        <div class="action-desc">Set your OpenSubtitles API key</div>
      </a>
    </div>
    <div class="card">
      <div class="card-title">Manifest URL</div>
      <div class="url-row">
        <div class="url-box">${manifestUrl}</div>
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${manifestUrl}').then(()=>showToast('URL copied!'))">Copy</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Copy Manifest JSON</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Paste into Stremio → Add-ons → puzzle piece icon</p>
      <button class="btn btn-outline" onclick="copyManifest()" style="width:100%;justify-content:center">📋 Copy Manifest JSON</button>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const manifestJsonRaw = ${JSON.stringify(manifestJson)};
    function copyManifest() { navigator.clipboard.writeText(manifestJsonRaw).then(()=>showToast('Manifest JSON copied!')); }
    function showToast(msg) {
      const t = document.getElementById('toast'); t.textContent = '✓ ' + msg;
      t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2500);
    }
  </script></body></html>`;
}

function configurePage(baseUrl, hasKey, currentKey, currentUsername) {
  const maskedKey = currentKey ? currentKey.slice(0, 8) + '•'.repeat(Math.max(0, currentKey.length - 8)) : '';
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configure — English Forced Subtitles</title>
  <style>${SHARED_STYLES}
    .back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--muted);
      font-size: 13px; font-weight: 600; text-decoration: none; margin-bottom: 40px; transition: color 0.15s; }
    .back-link:hover { color: var(--text); }
    .form-group { margin-bottom: 22px; }
    .form-label { display: block; font-size: 12px; font-weight: 700; letter-spacing: 1px;
      text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
    .form-hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
    .form-hint a { color: var(--accent); text-decoration: none; }
    .input-row { display: flex; gap: 10px; }
    .input-row input { flex: 1; }
    .current-key { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
      background: var(--bg); border: 1px solid var(--green); border-radius: 10px; margin-bottom: 20px; }
    .current-key-label { font-size: 12px; color: var(--muted); }
    .current-key-val { font-family: 'DM Mono', monospace; font-size: 13px; color: var(--green); }
    .alert-success { padding: 14px 18px; border-radius: 10px; font-size: 13px; margin-bottom: 24px;
      background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--green); }
    .divider { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
    .test-result { margin-top: 14px; padding: 12px 16px; border-radius: 8px; font-size: 13px; display: none; }
    .test-ok   { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.3); color: var(--green); }
    .test-fail { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--red); }
  </style></head><body>
  <div class="container">
    <a href="/" class="back-link">← Back to add-on</a>
    <div class="logo">
      <div class="logo-icon">⚙️</div>
      <div class="logo-text">
        <div class="logo-name">Configure Add-on</div>
        <div class="logo-sub">English Forced Subtitles · v${VERSION}</div>
      </div>
    </div>
    ${(hasKey && currentUsername) ? '<div class="alert-success">✓ Fully configured and ready.</div>' : '<div style="padding:14px 18px;border-radius:10px;font-size:13px;margin-bottom:24px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:var(--amber)">⚠️ Enter your OpenSubtitles API key, username and password below.</div>'}
    <div class="card">
      <div class="card-title">OpenSubtitles Credentials</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">
        All three fields are required. Get your API key at
        <a href="https://www.opensubtitles.com/en/consumers" target="_blank" style="color:var(--accent)">opensubtitles.com/en/consumers</a>.
        Your username and password are your OpenSubtitles.com login credentials.
      </p>
      ${hasKey ? `<div class="current-key"><div class="status-dot dot-green"></div>
        <div><div class="current-key-label">Current API key</div><div class="current-key-val">${maskedKey}</div></div></div>` : ''}
      ${currentUsername ? `<div class="current-key"><div class="status-dot dot-green"></div>
        <div><div class="current-key-label">Username</div><div class="current-key-val">${currentUsername}</div></div></div>` : ''}
      <form method="POST" action="/configure">
        <div class="form-group">
          <label class="form-label" for="apiKey">API Key</label>
          <div class="input-row">
            <input type="password" id="apiKey" name="apiKey" placeholder="Your consumer API key..." autocomplete="off"/>
            <button type="button" class="btn btn-ghost" onclick="const i=document.getElementById('apiKey');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="username">Username</label>
          <input type="text" id="username" name="username" placeholder="Your OpenSubtitles.com username" autocomplete="off"/>
        </div>
        <div class="form-group">
          <label class="form-label" for="password">Password</label>
          <div class="input-row">
            <input type="password" id="password" name="password" placeholder="Your OpenSubtitles.com password" autocomplete="off"/>
            <button type="button" class="btn btn-ghost" onclick="const i=document.getElementById('password');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button>
          </div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">💾 Save Credentials</button>
      </form>
      <div id="testResult" class="test-result"></div>
      <hr class="divider"/>
      <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="testKey()">🔌 Test current key</button>
    </div>
    <div class="card">
      <div class="card-title">After Saving</div>
      <p style="font-size:14px;color:var(--muted);line-height:1.7;margin-bottom:18px">
        Once your key is saved, reinstall the add-on in Stremio using the manifest URL.<br>
        Make sure to <strong style="color:var(--text)">disable other subtitle add-ons</strong> so they don't interfere.
      </p>
      <a href="/" class="btn btn-outline" style="width:100%;justify-content:center">← Back to main page</a>
    </div>
  </div>
  <script>
    async function testKey() {
      const res = document.getElementById('testResult');
      res.style.display = 'block'; res.className = 'test-result'; res.textContent = '⏳ Testing...';
      try {
        const r = await fetch('/api/test-key'); const data = await r.json();
        res.className = 'test-result ' + (data.ok ? 'test-ok' : 'test-fail');
        res.textContent = data.ok ? '✓ API key is valid and working' : '✗ ' + (data.error || 'Key test failed');
      } catch { res.className = 'test-result test-fail'; res.textContent = '✗ Could not reach the test endpoint'; }
    }
  </script></body></html>`;
}
