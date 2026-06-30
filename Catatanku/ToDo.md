# ToDo — Lanjutan Besok

## 1. Fase 2: Streaming Draft (`sendRichMessageDraft`, Bot API 10.1) ✅ DONE

Balasan Agent muncul real-time di Telegram (type-on animation seperti ChatGPT), bukan muncul sekaligus di akhir.

- [x] Baca `Catatanku/bottelegram-api-10.1.md` section 3 (rincian Fase 2)
- [x] Tambah method `streamDraft?` opsional di SDK `ChannelAdapter` (`packages/sdk/src/index.ts`) + `ChannelDraftStream` type
- [x] Hook stream-delta di `src/server/services/stream-runner.ts` → `onTextDelta` callback → forward ke adapter
- [x] Tambah `openChannelDraftStream` + `recordChannelDraftCommitted` helper di `channels.ts`, keep `deliverChannelResponse` as fallback
- [x] Implement `streamDraft` di `src/server/channels/telegram.ts`: throttle 400ms, `draft_id`, `sendRichMessageDraft`, commit via `sendRichMessage` (+ fallback `sendMessage`), abort (empty draft)
- [x] Baca `sse.md` (recurring sync-bug traps) — no new SSE event needed (streaming draft is platform-side only, not UI SSE)
- [x] agent-engine.ts: open draft pre-loop, wire `onTextDelta`→`update`, commit at delivery path, abort at abort path, fallback to one-shot on commit failure
- [x] Unit test `telegram-streamdraft.test.ts` (7 tests: open, update throttled, commit rich/plain, abort, double-finalize, update-after-commit)
- [x] Docs: docs-site channels/telegram.md updated
- [x] Run typecheck + test (4046 pass, 0 fail)

**Keputusan desain diterapkan:**
- D7 throttle: 400ms time-based ✅
- D8 thinking block: skip di draft (hanya text-delta yang di-forward) ✅
- D9 error mid-stream: abort draft + fallback deliverChannelResponse ✅
- D10 user stop: abort draft (discard bubble) — catatan: tidak commit sebagian karena fullContent kosong saat abort ✅
- D11 Telegram only (adapter lain tetap one-shot, `streamDraft?` optional) ✅

---

## 2. LaTeX di Telegram + Dokumen Hasil (docx & PDF)

### 2a. LaTeX di Telegram Rich Messages (Fase 1c) ✅ DONE
- [x] Baca `Catatanku/bottelegram-latex.md` (analisis lengkap + syntax exact)
- [x] Tes syntax via `@richtextdemobot` — deferred ke test VPS (implementasi pakai syntax exact dari docs: `<tg-math>` / `<tg-math-block>`, raw LaTeX no escape)
- [x] Tambah `remark-math` ke pipeline di `src/server/channels/telegram-rich.ts`
- [x] Tambah case `'inlineMath'` → `<tg-math>{value}</tg-math>` (raw, no escape + guard `</tg-math>`)
- [x] Tambah case `'math'` (block) → `<tg-math-block>{value}</tg-math-block>` (raw, no escape + guard)
- [x] Handle ```` ```math ```` fence (remark-math tidak auto-convert; remap di `renderCodeBlock` saat `lang === 'math'`)
- [x] Update `isBlockLevel()` (tambah `'math'`) + `markdownHasRichBlocks()` (tambah cek inline math via `hasInlineMath`)
- [x] Unit test: 16 test math (inline, block, fence, raw LaTeX `\frac`/`\sum`/`<`/`>`/`&`, guard `</tg-math>`, math+heading/list/table kombinasi, detection)
- [ ] Test end-to-end via VPS (Agent output trigonometri/fisika) — tunggu deploy
- [x] Docs: docs-site channels/telegram.md updated

**Keputusan desain diterapkan:**
- M1: tidak escape di dalam math (raw LaTeX) ✅ + guard `</tg-math>` literal
- M2: inline math tanpa block lain tetap rich path (`hasInlineMath` check) ✅
- M3: fallback ke `sendMessage` plain text kalau rich reject (sudah ada dari Fase 1) ✅

### 2b. LaTeX di dokumen yang dihasilkan Agent (docx & PDF) — PDF DONE, docx DEFER
- [x] Audit tool generator dokumen: tidak ada tool `generate_pdf`/`generate_docx` native. Yang ada `store_file` (simpan content/workspace/url → share URL), `write_file`, `attach_file`.
- [x] Cek library docx/PDF di `package.json`: tidak ada `docx`/`pdfkit` / `html-to-pdf`. Yang ada: Playwright (headless Chromium, dipakai browse+screenshot; bisa `page.pdf()`), `remark-math`+`rehype-katex` (client-side). → PDF bisa pakai Playwright tanpa dep engine baru.
- [x] Tentukan pendekatan: **Opsi A — Markdown → HTML (KaTeX MathML) → PDF via Playwright `page.pdf()`**. LaTeX passthrough (TeX engine) ditolak karena berat & melanggar prinsip "single container, zero external infra". docx (gambar/native OMML) defer ke fase berikutnya.
- [x] Implement renderer math: `katex.renderToString({ output: 'mathml', throwOnError: false })` — render ke MathML, Chromium gambar native di PDF (offline, tanpa font/CSS KaTeX). Dep tambah: `katex` (explicit), `remark-rehype`+`rehype-stringify` (DITOLAK — bun global-cache gak resolve subpath `unist-util-visit-parents/do-not-use-color`, jadi pakai manual MDAST walker + katex direct, mirip `telegram-rich.ts`).
- [x] Service `src/server/services/document-render.ts`: `markdownToHtml` (MDAST walk + katex mathml) + `buildPdfHtml` (template print CSS A4) + `markdownToPdf` (delegasi ke `playwrightManager.renderPdf`).
- [x] Method `renderPdf(html, opts)` di `playwright-manager.ts` (acquire/release page, `setContent`+`page.pdf`).
- [x] Tool `generate_pdf` di `src/server/tools/document-tools.ts` (main-only; cek `playwrightManager.isEnabled`, simpan via `createFileFromContent` base64 pdf → share URL). Register di `register.ts` grup 'documents'.
- [x] Granting: otomatis via toolbox 'all' (`['*']` expand semua native tool). Tidak ditambah ke built-in toolbox spesifik (sama seperti `store_file`).
- [x] Prompt-builder: tambah bullet `generate_pdf()` di section File storage.
- [x] i18n tool-name label: 10 locale (en, fr, es, de, pt-BR, zh-CN, ja, ru, it, pl) — parity OK (`check-locales.ts`).
- [x] Unit test `document-render.test.ts` (21 test: inline/block/fence math, escape, heading, list <p>, task, table, code, quote, inline fmt, link, image, mix, nonl guard, template title, renderPdf wiring/format). 21 pass.
- [x] Typecheck clean (exit 0) + full suite 4083 pass / 0 fail.
- [x] Docs: docs-site `agents/tools.md` tambah section Documents.
- [ ] Test end-to-end via VPS (Agent output trigonometri/fisika → buka PDF di Adobe Reader) — tunggu deploy (butuh Playwright aktif di container: `WEB_BROWSING_HEADLESS_ENABLED=true` + Chromium).
- [ ] docx (defer): kalau dibutuhkan, opsi B (`docx` npm + math→PNG embed) atau Opsi D (pandoc via Dockerfile). Estimasi 2–4 hari.

**Keputusan desain diterapkan (2b/PDF):**
- D2b-1: PDF via Playwright `page.pdf()` (infra sudah ada), bukan TeX engine (offline/zero-infra). ✅ + md eksplisit (lihat `latex-dokumen.md`)
- D2b-2: Math via KaTeX `output:'mathml'` (native Chromium MathML render), bukan KaTeX HTML+CSS (perlu font woff2 offline). ✅
- D2b-3: Manual MDAST walker + katex direct, BUKAN remark-rehype/rehype-katex/unified-hast stack (subpath export bug di bun cache). ✅
- D2b-4: Tool auto-grant via toolbox 'all', tidak di built-in non-all preset. ✅
- D2b-5: docx defer (scope PDF dulu sesuai rekomendasi `latex-dokumen.md` Opsi A)

---

## Referensi dokumen
- `Catatanku/bottelegram-api-10.1.md` — analisis lengkap Fase 1 (done) + Fase 2 (streaming draft)
- `Catatanku/bottelegram-latex.md` — analisis LaTeX di Telegram (syntax exact, risk, mitigasi)
- `Catatanku/bottelegram.md` — panduan Telegram lengkap (access control + rich messages)
