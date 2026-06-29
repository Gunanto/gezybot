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

### 2a. LaTeX di Telegram Rich Messages (Fase 1c)
- [ ] Baca `Catatanku/bottelegram-latex.md` (analisis lengkap + syntax exact)
- [ ] Tes syntax via `@richtextdemobot` (konfirmasi raw LaTeX di `<tg-math>` tidak perlu escape)
- [ ] Tambah `remark-math` ke pipeline di `src/server/channels/telegram-rich.ts`
- [ ] Tambah case `'inlineMath'` → `<tg-math>{value}</tg-math>` (raw, no escape)
- [ ] Tambah case `'math'` (block) → `<tg-math-block>{value}</tg-math-block>` (raw, no escape)
- [ ] Update `isBlockLevel()` + `markdownHasRichBlocks()` agar math memicu rich path
- [ ] Unit test: inline math, block math, math + heading/list, karakter LaTeX khusus (`\frac`, `_`, `^`, `\sum`), edge case `</tg-math>` literal
- [ ] Test end-to-end via VPS (Agent output trigonometri/fisika)
- [ ] Estimasi: ~1.75 jam

**Keputusan desain pending (M1–M3 di dokumen LaTeX):**
- M1: tidak escape di dalam math (raw) — recommended, tes demo bot dulu
- M2: inline math tanpa block lain tetap rich path — recommended
- M3: fallback ke `sendMessage` plain text kalau rich reject — recommended

### 2b. LaTeX di dokumen yang dihasilkan Agent (docx & PDF)
- [ ] Audit tool `store_file` / generator dokumen di Gezy sekarang — apakah Agent bisa buat docx/PDF? Cari tool terkait (`grep -r "docx\|pdf\|generate.*document\|store_file" src/server/tools/`)
- [ ] Cek apakah ada library docx/PDF di `package.json` (mis. `docx`, `pdfkit`, `puppeteer`)
- [ ] Tentukan: LaTeX render ke gambar (MathJax/KaTeX → SVG/PNG) lalu embed di docx/PDF, atau pakai native equation support (Word OMML untuk docx, LaTeX passthrough untuk PDF via LaTeX engine)
- [ ] Implement renderer math → gambar (Kalau KaTeX server-side sudah ada via `rehype-katex`, bisa reuse untuk SVG)
- [ ] Integrasi ke pipeline generator dokumen
- [ ] Test: dokumen dengan rumus trigonometri/fisika, cek render di Word/Adobe Reader
- [ ] Docs
- [ ] Estimasi: butuh audit dulu sebelum estimate (mungkin 2–4 hari tergantung stack)

---

## Referensi dokumen
- `Catatanku/bottelegram-api-10.1.md` — analisis lengkap Fase 1 (done) + Fase 2 (streaming draft)
- `Catatanku/bottelegram-latex.md` — analisis LaTeX di Telegram (syntax exact, risk, mitigasi)
- `Catatanku/bottelegram.md` — panduan Telegram lengkap (access control + rich messages)
