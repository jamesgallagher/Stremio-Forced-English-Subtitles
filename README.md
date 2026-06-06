# English Forced Subtitles — Stremio Add-on

Automatically provides **English forced subtitles** (foreign dialogue only) when they exist.  
If no forced subtitle is found, it returns **nothing** — keeping subtitles off for fully-English content.

## How it works

1. When you play a movie or episode, Stremio asks this add-on for subtitles
2. The add-on queries OpenSubtitles for English subtitles and checks the `foreign_parts_only` metadata flag
3. **Found:** returns the best forced match → Stremio auto-selects it
4. **Not found:** returns an empty list → no subtitle loads

---

## Deployment (Unraid + Cloudflare Tunnel — recommended)

### 1. Create a GitHub repo

- Go to [github.com](https://github.com) → New repository
- Name it `stremio-forced-subs`, set to Public
- Upload all files from this folder (or push via git)

### 2. Build the Docker image on Unraid

In Unraid, open a terminal and run:

```bash
cd /mnt/user/appdata
git clone https://github.com/YOUR_USERNAME/stremio-forced-subs
cd stremio-forced-subs
docker compose up -d
```

This builds the image and starts the container. The config is saved to `./data/config.json` on your Unraid server.

### 3. Set up Cloudflare Tunnel

In Cloudflare Zero Trust dashboard:
- Create a new tunnel
- Add a public hostname, e.g. `forced-subs.yourdomain.com`
- Point it at `http://localhost:7000`
- Install the cloudflared connector on Unraid (available in Community Applications)

### 4. Configure the add-on

Browse to `https://forced-subs.yourdomain.com` and enter your OpenSubtitles API key.  
Get a free key at [opensubtitles.com/en/consumers](https://www.opensubtitles.com/en/consumers).

### 5. Install in Stremio

In Stremio → Add-ons → paste:
```
https://forced-subs.yourdomain.com/manifest.json
```

---

## Local development (Windows/Mac/Linux)

```bash
npm install
node index.js
```

Browse to `http://localhost:7000` to configure, then install in Stremio via:
```
http://127.0.0.1:7000/manifest.json
```

> **Note:** Modern Stremio requires HTTPS for addons to be called during playback.  
> Local HTTP works for installation testing but not subtitle delivery — use the Cloudflare Tunnel setup for full functionality.

---

## Stremio settings

- **Disable** all other subtitle add-ons (OpenSubtitles, SubDL, etc.)
- Set Default Subtitle Language to **Disabled**

---

## Updating

When a new version is released, on your Unraid terminal:

```bash
cd /mnt/user/appdata/stremio-forced-subs
git pull
docker compose up -d --build
```

Your config (API key) is preserved in `./data/` and is not affected by updates.
