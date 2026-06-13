# Hivekeep — marketing site

Astro + Tailwind. Design direction: **"app skin + editorial bones"** (see `../hivekeep-1.0-design-directions.md`, tour 3) — keeps the Hivekeep app's aurora/glass/glow identity but uses an editorial structure (numbered sections, mono metadata, product-like panels, captioned figures) so it never reads as "AI-generated".

## Commands
```bash
cd site
bun install
bun run dev      # local dev (http://localhost:4321/hivekeep)
bun run build    # static output -> dist/
bun run preview  # serve the build
```
Deployed as a GitHub Pages **project site** at `https://marlburrow.github.io/hivekeep/` (hence `base: '/hivekeep'` in `astro.config.mjs`).

## Where to drop your assets

**1. Avatars (JSON + images)** — `src/agents.json` (kept out of a `data/` folder on purpose: the repo's root `.gitignore` ignores `data/`)
Each entry: `{ "name": string, "domain": string, "avatar": string | null, "status"?: "online" | "working" | "idle" }`
- Put avatar images in `public/avatars/` and set `"avatar": "/avatars/atlas.png"`.
- `null` avatar → a themed placeholder robot is shown automatically.
- `status` (optional) only affects the hero "// your agents" panel (first 5 entries).
- `name` + `domain` appear in the hero panel **and** the "household" directory.

**2. Screenshots** — `public/screens/`
Used in captioned figures (e.g. `Fig. 2 — a tool renders as UI`). They render with an automatic **feathered/blended** edge (no hard frame). Replace the placeholder block in `src/pages/index.astro` with an `<img src={...} />`. Suggested first shots: a custom-tool render (weather card), the context/token view, a mini-app.

**3. Provider / channel logos**
Channels use `simple-icons` via `astro-icon` (already wired). AI provider logos in the Hivekeep app use `@lobehub/icons` (color) — if you want those exact marks, drop SVGs into `public/providers/` or we add a small React island later.

## Notes
- Icons: `astro-icon` with `lucide` (UI) + `simple-icons` (brands).
- Fonts: Plus Jakarta Sans (app font) + JetBrains Mono (metadata), via Google Fonts.
- All design tokens live in `src/styles/global.css` and mirror the app's aurora palette.

## Analytics (Plausible)
Privacy-friendly, **cookieless** analytics (no consent banner needed). The
per-site script (the `pa-...js` snippet from the Plausible dashboard) is injected
in `src/layouts/Base.astro` and only ships in the **production build**
(`import.meta.env.PROD`), so `bun run dev` never tracks. No `data-domain` in the
new format: the `pa-...` id identifies the site, and **measurement options are
toggled in the Plausible dashboard** (Site settings -> Installation), not in the
script URL. To rotate/replace the site, paste the new `pa-...js` src.

What you get out of the box:
- Pageviews, top pages, countries, devices.
- **Referrers + UTM campaigns** (`?utm_source=...&utm_campaign=...`) - answers
  "which campaign drove traffic". Tag your campaign links and they group in the
  Sources panel.
- **Outbound-link clicks** (GitHub, docs, ...) - enable "Outbound links" in the
  dashboard's optional measurements.
- A custom **`Install Copy`** event fired whenever a visitor copies an install
  command (home one-liner, /install card, or the configurator - the `source`
  prop says which). Enable custom events / add it as a **Goal** in Plausible to
  measure install *intent* per campaign, not just visits.

Adblockers may block `plausible.io` directly; if undercounting matters later,
proxy the script behind the site's own domain (Plausible's proxy guide).
