# English Forced Subtitles — Stremio Add-on

A self-hosted Stremio add-on that automatically provides English forced subtitles for foreign dialogue in otherwise English content. If no forced subtitle exists for a title, it returns nothing — keeping subtitles off so you're not reading subtitles for content you can already understand.

**Example:** Playing *Black Hawk Down* → Somali dialogue scenes get subtitled. Playing *The Bear* → no subtitles at all.

---

## Requirements

- An [OpenSubtitles.com](https://www.opensubtitles.com) account (free)
- A free API consumer key from OpenSubtitles
- A server to host the add-on (Unraid recommended, or any machine that's always on)
- A public HTTPS URL (Cloudflare Tunnel recommended — free)

---

## Step 1 — Create your OpenSubtitles account and API key

1. Sign up at [opensubtitles.com](https://www.opensubtitles.com) if you don't have an account
2. Go to [opensubtitles.com/en/consumers](https://www.opensubtitles.com/en/consumers)
3. Register a new consumer app (name it anything, e.g. "Stremio")
4. Copy the API key — you'll need it shortly
5. Note your **username** (shown on your profile page — this is NOT your email address)

> Free accounts allow 20 subtitle downloads per day when authenticated.

---

## Step 2 — Deploy on Unraid

### Option A — Using docker-compose (recommended)

Open an Unraid terminal and run:

```bash
cd /mnt/user/appdata
git clone https://github.com/jamesgallagher/Stremio-Forced-English-Subtitles.git forced-subs
cd forced-subs
docker compose up -d --build
```

### Option B — Using the Unraid Docker UI

Add a new container with these settings:

| Setting | Value |
|---|---|
| Repository | `ghcr.io/jamesgallagher/stremio-forced-english-subtitles:latest` |
| Container Port | `7000` |
| Host Port | `7000` |
| Container Path | `/data` |
| Host Path | `/mnt/user/appdata/forced-subs/data` |
| `PUBLIC_URL` env var | `https://your-domain.com` |

> The `/data` volume mapping is required — without it your credentials will be lost every time the container restarts.

---

## Step 3 — Set up a public HTTPS URL (Cloudflare Tunnel)

Stremio requires HTTPS for add-ons. Cloudflare Tunnel is free and the easiest option.

1. In [Cloudflare Zero Trust](https://one.cloudflare.com) → Networks → Tunnels → Create a tunnel
2. Add a public hostname, e.g. `forced-subs.yourdomain.com`
3. Point it at `http://localhost:7000`
4. Install the cloudflared connector on Unraid (available in Community Applications)

---

## Step 4 — Configure the add-on

1. Browse to your public URL, e.g. `https://forced-subs.yourdomain.com`
2. Click **Configure**
3. Enter your:
   - **API Key** — from Step 1
   - **Username** — your OpenSubtitles username (not your email address)
   - **Password** — your OpenSubtitles password
4. Click **Save Credentials**

---

## Step 5 — Install in Stremio

1. Open Stremio
2. Go to **Add-ons** → click the 🧩 puzzle piece icon
3. Paste your manifest URL: `https://forced-subs.yourdomain.com/manifest.json`
4. Click Install

### Recommended Stremio settings

- **Disable all other subtitle add-ons** (OpenSubtitles, SubDL, etc.) — they will override this one
- Settings → Player → Default Subtitle Language → **Disabled**

---

## Updating

```bash
cd /mnt/user/appdata/forced-subs
git pull
docker compose up -d --build
```

Your credentials are stored in `/data/config.json` and are preserved across updates.

---

## Troubleshooting

**No subtitles appearing at all**
Check the container logs (`docker logs -f forced-subs`). You should see `[Request]` lines when you play something. If not, reinstall the add-on in Stremio.

**"Failed to load external subtitles" error**
Check the logs for `[Proxy]` lines. If you see "Proxy error", the subtitle file conversion failed. Check your credentials are correct.

**Login failing with 400 Bad Request**
Your username or password is wrong. Make sure you're using your OpenSubtitles **username**, not your email address. You can find it at opensubtitles.com → your profile page.

**Subtitles showing for fully-English content**
The subtitle file on OpenSubtitles has the "forced" flag set incorrectly. The logs will show a warning about high line count. This is an OpenSubtitles data quality issue — nothing we can do about individual bad uploads.

**Quota exceeded**
Free accounts allow 20 downloads/day (authenticated) or 5/day (unauthenticated). The logs show remaining quota after each download.
