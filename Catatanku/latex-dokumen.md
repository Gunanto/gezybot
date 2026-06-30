# LaTeX di Dokumen docx & PDF — Analisis Implementasi

> Tanggal: 2026-06-30 · Update: 2026-07-01 (OMML implemented) · Status: **PDF + DOCX dengan LaTeX native — selesai**

## 1. Kondisi Gezy sekarang

### 1.1 Tidak ada tool generate docx/PDF native
- **Tidak ada library docx** (`docx`, `officegen`, dll) di `package.json`.
- **Tidak ada tool `generate_pdf` / `generate_docx`** di `src/server/tools/`.
- Yang ada: `store_file` (simpan file dari content/workspace/URL → shareable URL), `write_file` (tulis ke workspace), `attach_file` (lampirkan ke pesan).

### 1.2 Yang Agent bisa lakukan sekarang
- Tulis file markdown/HTML ke workspace via `write_file`.
- Simpan file ke storage via `store_file` (dari content inline, workspace, atau URL) → dapat share URL.
- **Tidak bisa** membuat docx/PDF dengan rendering LaTeX secara native.

### 1.3 Infrastruktur yang BISA dipakai
| Komponen | Status | Relevansi |
|---|---|---|
| **Playwright** (headless Chromium) | ✅ sudah ada (`playwright@^1.58.2`, `playwright-manager.ts`) | Bisa render HTML→PDF via `page.pdf()`. Bisa render LaTeX via KaTeX/MathJax di HTML. |
| **KaTeX** (client-side) | ✅ sudah ada (`rehype-katex@^7.0.1`) — TAPI ini client-side React, bukan server-side standalone | Perlu install `katex` package untuk server-side render LaTeX→HTML/MathML/SVG. |
| **Markdown→HTML** (server) | ✅ `unified` + `remark-parse` + `remark-gfm` + `remark-math` (sudah dipakai `telegram-rich.ts`) | Bisa konversi markdown+math → HTML untuk render di Playwright. |

### 1.4 Hasil observasi: bagaimana Agent buat dokumen sekarang?
Dari contoh chat Telegram (materi trigonometri), Agent menulis file `.md` lalu kirim via `store_file`. User download file markdown, bukan docx/PDF. LaTeX di file `.md` muncul sebagai `$x^2$` literal — tidak ada yang merendernya.

## 2. Opsi implementasi

### Opsi A: Markdown → HTML (dengan KaTeX) → PDF via Playwright ⭐ RECOMMENDED

**Pipeline:**
```
Agent output (markdown + $LaTeX$)
  → remark-parse + remark-gfm + remark-math → MDAST
  → remark-rehype + rehype-katex → HTML dengan KaTeX-rendered math (SVG/CSS)
  → bungkus HTML dengan template (styling, KaTeX CSS, font)
  → Playwright page.setContent(html) + page.pdf() → PDF
  → simpan via store_file → share URL
```

**Kelebihan:**
- Pakai infrastruktur yang sudah ada (Playwright + unified pipeline).
- Render LaTeX bagus (KaTeX sudah mature, sama yang dipakai UI).
- PDF bisa di-share langsung via `store_file`.
- Bisa tambah styling custom (header/footer, page size A4, margin).

**Kekurangan:**
- Butuh Playwright aktif (Chromium headless) — ada di container Docker? Perlu verifikasi.
- `katex` package perlu install (server-side render).
- `remark-rehype` + `rehype-stringify` perlu install (atau traverse manual seperti `telegram-rich.ts`).

**Estimasi: 1.5–2 hari.**

### Opsi B: Markdown → docx via library `docx` + math sebagai gambar

**Pipeline:**
```
markdown + LaTeX
  → parse markdown
  → docx library (npm: docx) build document
  → LaTeX → KaTeX server-side → SVG → PNG → embed sebagai image di docx
  → save .docx
```

**Kelebihan:**
- docx bisa di-edit user di Word.
- Native Word equation (OMML) lebih baik tapi kompleks.

**Kekurangan:**
- Butuh install `docx` + `katex` + `sharp` (SVG→PNG) — 3 dependensi baru.
- Math sebagai gambar = tidak editable di Word (gambar, bukan equation object).
- Implementasi lebih rumit (docx library API verbose).

**Estimasi: 3–4 hari.**

### Opsi C: Markdown → HTML → PDF (Opsi A) + HTML → docx via Playwright print-to-docx

Tidak ada API Playwright untuk docx langsung. Skip.

### Opsi D: Pakai tool external (pandoc) via run_shell

**Pipeline:**
```
markdown → write_file → run_shell("pandoc input.md -o output.docx --mathml")
```

**Kelebihan:**
- Pandoc handle markdown→docx + math (OMML native!) dengan baik.
- Minimal kode (cuma tool wrapper).

**Kekurangan:**
- **Butuh pandoc terinstall di container Docker** — perlu cek/add ke Dockerfile.
- `run_shell` tool sudah ada tapi aksesnya terbatas (workspace only, bukan system binary).
- Pandoc + LaTeX engine (xelatex) untuk PDF butuh ~1GB install — berat.

**Estimasi: 0.5 hari (kalau pandoc sudah ada) / 1.5 hari (kalau perlu add ke Dockerfile).**

## 3. Rekomendasi

**Opsi A (PDF via Playwright)** dulu — paling realistis dengan infrastruktur yang ada:
1. Tambah tool baru `generate_pdf` di `src/server/tools/`.
2. Tool terima input markdown (dengan LaTeX), konversi ke HTML+KaTeX, render PDF via Playwright, simpan via storage.
3. Agent panggil `generate_pdf(content: "markdown dengan $x^2$")` → dapat share URL PDF.

**docx defer** ke fase berikutnya — butuh library baru + lebih rumit. Untuk sekarang, user yang mau edit bisa konversi PDF→docx via tool online, atau kita tambah Opsi D (pandoc) kalau ada permintaan.

## 4. Pertanyaan untuk kamu

1. **Prioritas PDF atau docx dulu?** Saya rekomendasi PDF (lebih mudah + infrastruktur ada).
2. **Apakah Playwright/Chromium aktif di container Docker VPS?** Cek: `docker exec gezy ls /app/node_modules/playwright` atau lihat log startup "Headless browser launched". Kalau tidak aktif, perlu enable `BROWSER_SESSIONS_ENABLED=true` di env.
3. **Setuju Opsi A (PDF via Playwright + KaTeX)?** Atau mau Opsi D (pandoc) kalau kamu familiar dengan pandoc?
4. **Tool interface:** `generate_pdf(content: string, title?: string)` → return `{ url, fileId }`? Atau pakai `store_file` yang sudah ada dengan source=content + mimeType=pdf?

Jawab dan saya lanjut ke implementasi.

## 5. Implementasi (30 Jun 2026) — PDF DONE, docx DEFER

Dipilih **Opsi A (PDF via Playwright + KaTeX)**. docx defer.

### Yang dikerjakan
- Service baru `src/server/services/document-render.ts`:
  - `markdownToHtml(md)` — parse (unified + remark-parse + remark-gfm + remark-math) lalu **manual MDAST walker** → HTML (heading/list/table/code/blockquote/inline), escape `<`/`>`/`&` di text.
  - `renderMathBlock` / inline math → `katex.renderToString(latex, { displayMode, output: 'mathml', throwOnError: false })`.
  - `buildPdfHtml(md, title)` — bungkus HTML + print CSS (A4, margin, code dark theme, tabel zebra, `.math-block` centered).
  - `markdownToPdf(md, title, opts)` → `playwrightManager.renderPdf(html, opts)` → buffer.
- Method baru `PlaywrightManager.renderPdf(html, opts)` di `src/server/services/playwright-manager.ts`: acquire/release page, `setContent(html)` + `page.pdf({ format:'A4', printBackground, margin })`. Pattern sama dengan `screenshotPage`.
- Tool `generate_pdf` (`src/server/tools/document-tools.ts`, main-only): cek `playwrightManager.isEnabled`, render → simpan via `createFileFromContent` (base64, `application/pdf`) → share URL. Register di `register.ts` grup 'documents'.
- Prompt-builder: bullet `generate_pdf()` di section File storage.
- i18n: label `generate_pdf` di 10 locale (parity OK).
- Docs: `docs-site/src/content/docs/agents/tools.md` section Documents.
- Test: `document-render.test.ts` 21 pass. Typecheck clean. Full suite 4083 pass / 0 fail.

### Keputusan teknis penting
1. **MathML, bukan KaTeX HTML+CSS.** `output: 'mathml'` → Chromium render MathML native di PDF, tanpa butuh KaTeX CSS + font woff2. Offline, zero-infra. Trade-off: render pakai native math font sistem (bukan KaTeX font), tapi akurat & bersih.
2. **Manual MDAST walker, BUKAN `remark-rehype`+`rehype-katex`+`rehype-stringify`.** Alasan: bun global install cache gak resolve subpath export `unist-util-visit-parents/do-not-use-color` yang dipakai rehype-katex → throw di import time server-side. Stack tanpa rehype (unified+remark-parse+remark-gfm+remark-math, udah dipakai `telegram-rich.ts`) jalan normal; `katex` di-import langsung (clean). Jadi parse→MDAST→walk manual→HTML.
3. **Dep baru:** `katex` (explicit, walau transitif dari rehype-katex). `remark-rehype`+`rehype-stringify` tadinya di-add tapi **dihapus** (gak dipakai karena bug #2) — perlu `bun remove` kalau mau bersih.
4. **Granting:** otomatis lewat toolbox 'all' (`['*']`). Tidak ditambah ke built-in non-all (sama kayak `store_file`).

### Sisa / defer
- **E2E di VPS** tunggu deploy (butuh `WEB_BROWSING_HEADLESS_ENABLED=true` + Chromium di container): tes Agent output trigonometri/fisika → buka PDF di Adobe Reader.
- **docx** defer. Kalau dibutuhkan: Opsi B (`docx` npm + math→PNG via KaTeX→SVG→sharp embed) atau Opsi D (pandoc via Dockerfile + `:mathml`).
- **Cleanup dep:** `bun remove remark-rehype rehype-stringify` (di-add tapi akhirnya gak dipakai) — opsional biar lockfile rampung.

## 6. Implementasi docx (30 Jun 2026) — DONE

docx sekarang DIBANGUN (Opsi B), bukan defer lagi.

### Yang dikerjakan
- Paket npm `docx` ditambah (pembuat .docx terstruktur, jalan di Bun).
- Service `src/server/services/document-render-docx.ts`:
  - `markdownToDocxBuffer(md, title)`: parse MDAST (unified stack) → kumpulkan node math (inline, block, DAN ```math fence remap) dengan id stabil → render SEMUA equation dalam satu sesi Chromium (satuan HTML, MathML per `<div id>`) → screenshot per elemen → PNG → embed sebagai `ImageRun` di .docx pada posisi math.
  - Sisa markdown dipetakan ke struktur Word native: heading, paragraf, list (marker tekstual bullet/number), tabel, code block (Consolas + shading), blockquote, inline strong/em/del/code/link/break, dan image math inline (dipakai juga untuk block math).
  - Padding PNG diparse dari IHDR untuk sizing ImageRun (display cap 400px, inline cap 100px).
- Method baru `PlaywrightManager.screenshotHtmlElements(html, ids)` (`playwright-manager.ts`) yang mirror `renderPdf` (acquire/release page, `setContent`, `page.locator('#id').screenshot()`).
- Tool `generate_docx` di `document-tools.ts` (main-only, gate `playwrightManager.isEnabled`, simpan via `createFileFromContent` base64 mime docx). Register `generate_docx` grup 'documents'.
- Prompt-builder: bullet `generate_pdf()`/`generate_docx()` disebut bareng di File storage section.
- i18n: label `generate_docx` di 10 locale (parity OK).
- Docs: `docs-site/agents/tools.md` tambah baris `generate_docx` di tabel Documents + catatan.
- Test: `document-render-docx.test.ts` (5 test: valid zip no-math, rasterize N ids, ```math fence, only-math, title). Mock `screenshotHtmlElements` (no browser). 5 pass.
- Typecheck clean, full suite 4179 pass / 0 fail.

### Keputusan teknis
- Word gak render MathML → equation di-rasterisasi PNG (KaTeX MathML → Chromium screenshot). Offline, satu sesi browser per dokumen, tanpa font/CDN. Equation jadi GAMBAR (gak editable sebagai equation object), tapi layout akurat. Trade-off v1.
- Remap ```math fence (code lang='math') → math block (sama kayak fix di PDF renderer), karena remark-gfm gak convert fence ke `math` node.
- Word numbering v1: marker textual (• / 1.), bukan native numbering config (lebih ringan, tetap editable).

## 7. Upgrade OMML (1 Jul 2026) — equation EDITABLE di Word, bukan gambar lagi

### Yang berubah
- **Equation bukan lagi gambar PNG** — sekarang native Word equation object (OMML). Klik equation di Word → bisa edit.
- Pipeline: `LaTeX → KaTeX(output:'mathml') → strip <annotation> → mml2omml() → OMML XML → ImportedXmlComponent.fromXmlString() → insert ke docx paragraph`
- **Tidak butuh Playwright/Chromium** untuk equation lagi (pure XML conversion, jauh lebih cepat).
- File size: ~8-15KB (vs 103KB dengan PNG approach).
- Display (block) equation dibungkus `<m:oMathPara>` supaya auto-center di Word.
- Inline SVG tetap di-rasterisasi PNG via Playwright (fallback ke text kalau Playwright disabled).
- Tool `generate_docx` gak lagi gate pada `playwrightManager.isEnabled` (Chromium cuma butuh untuk SVG, bukan math).

### Dep baru
- `mathml2omml@0.5.0` — MathML→OMML converter.
- `fflate@0.8.3` (devDependency) — unzip .docx di test untuk verifikasi OMML tags.

### Yang dikerjakan
- `document-render-docx.ts`: hapus 2-pass collect+screenshot approach, ganti dengan 1-pass walk + inline LaTeX→OMML conversion. SVG detection di html nodes (rasterize via Playwright kalau ada SVG).
- `document-render-docx.test.ts`: hapus mock screenshotHtmlElements, ganti dengan test yang unzip docx + assert OMML tags (`m:oMath`, `m:f`, `m:num`, `m:den`, `m:rad`, `m:oMathPara`). 9 test pass.
- `document-tools.ts`: description diperbaiki ("Word (.docx) document with native editable equations"), hapus `format`/`landscape` field (PDF-only), hapus `playwrightManager.isEnabled` gate.
- `prompt-builder.ts`: tambah info format capabilities (PDF: KaTeX/Chromium + SVG native, DOCX: OMML editable + SVG image, TikZ NOT supported) + "Do NOT self-diagnose generated files".
- Typecheck clean, 1140 test pass di area terkait.

### Validasi: butuh VPS
- Deploy (recreate container) → tes `generate_docx` output .docx dengan `$\frac{a}{b}$`, buka di Word → equation harus **editable** (klik equation → bisa edit, bukan gambar).
- cek file size: harus ~8-15KB (bukan 100KB+).

