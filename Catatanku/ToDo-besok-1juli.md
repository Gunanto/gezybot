# ToDo Besok — 1 Juli 2026

> Dibuat: 30 Jun 2026 ~17:00 · Status: **catatan eksekusi besok**

## Status hari ini (30 Jun)

### ✅ Selesai & di-push
- `95ba3553` feat: generate_pdf (markdown + LaTeX → PDF via Playwright, KaTeX MathML)
- `d1ea1161` fix: RC-1 — kirim attachment setelah streaming-draft commit (Telegram)
- `3614bc7f` feat: generate_docx (markdown + LaTeX → DOCX, equation sebagai PNG image)
- `89d3e29e` feat: WhatsApp-Web access control (allowlist + mention/reply gate)
- `52f672e3` chore: env produksi (PUBLIC_URL + Telegram + WA env)
- `27faf19a` chore: diagnostic log WA gate (info-level)
- `44f22d15` feat: WA grup mention OR reply (text-based mention detection)
- `d9ed5912` fix: WA LID → PN resolution (lid-mapping.update listener)
- `45c3e7e7` chore: diagnostic logging LID resolution
- `e37b8282` fix: WA text-based mention + diagnostic
- `b8e07b27` fix: WA mention — strip :device dari botJid sebelum digit extraction
- `2b6ed1d8` fix: WA reply-to-bot via sent-message-ID tracking
- `a8d9ca4b` fix: DOCX CSS.escape crash — ganti dengan direct selector

### ✅Confirmed working di VPS
- generate_pdf dengan LaTeX ✅ (PDF render math sebagai MathML, Chromium native)
- generate_docx dengan LaTeX ✅ (103KB, equation sebagai PNG image)
- WA DM owner ✅ (LID workaround: tambah LID ke allowlist)
- WA grup mention ✅ (text-based: `@6282361201550` di-respon)
- WA gate allowlist + drop ✅

### ⚠️ Belum di-test / bermasalah
- WA grup reply — fix `sent-message-ID tracking` sudah di-push (`2b6ed1d8`) tapi **belum di-test** (butuh deploy terbaru + bot kirim pesan dulu di grup supaya sentMessageIds terisi, lalu reply pesan bot)
- WA mention `@Me-PaGun` (nama kontak) — **tidak bisa** (text detection cuma match digit nomor, bukan nama). Workaround: pakai `@6282361201550`
- LID mapping (`lid-mapping.update`) — **tidak pernah fire** dari Baileys. Workaround: LID ditambah manual ke allowlist (`37456745394304`). Kalau nomor baru, perlu cek log untuk LID-nya lalu tambah ke env.
- TikZ (`\begin{tikzpicture}`) — **tidak render** di mana pun (butuh TeX engine, KaTeX gak support). Alternatif: SVG (sudah jalan di PDF via Chromium native) atau generate_image.
- Telegram 404 `/webhook/telegram` — webhook URL salah. Terpisah, bukan dari kerjaan kita.

---

## Eksekusi besok

### 1. DOCX: equation sebagai native OMML (bukan gambar) — PRIORITAS UTAMA

**Tujuan:** ganti equation PNG image → native Word equation object (OMML). Equation bisa **diedit di Word**.

**Pipeline baru:**
```
LaTeX → KaTeX (output: 'mathml') → MathML string
     → mml2omml(mathml) → OMML XML string
     → insert sebagai raw XML di docx document.xml
```

**Sudah verified:**
- `mathml2omml@0.5.0` terinstall, jalan di Bun ✅
- Export: `mml2omml(mathmlString)` → OMML XML string ✅
- `\frac{a}{b}` → `<m:oMath><m:f><m:num>a</m:num><m:den>b</m:den></m:f></m:oMath>` ✅

**Implementasi:**
- File: `src/server/services/document-render-docx.ts`
- Hapus: `screenshotHtmlElements` call untuk equation (gak perlu lagi Playwright untuk math)
- Ganti: `renderMathParagraph` dan `renderInline` case `inlineMath` → convert LaTeX→MathML→OMML, insert sebagai raw XML
- `docx` package: butuh cara insert raw OMML XML. Cek:
  - `docx` punya `Math` class + `MathRun`, `MathFraction`, dll — bisa build equation native
  - ATAU insert raw XML via `XmlComponent` / custom element
  - ATAU `Packer` support raw XML injection
- KaTeX `output: 'mathml'` → pure MathML (tanpa `<span>` wrapper) → `mml2omml` → OMML
- **Tidak butuh Playwright/Chromium** untuk equation lagi (lebih cepat, gak ada race condition)
- **Tidak butuh `screenshotHtmlElements`** untuk math (method tetap ada untuk SVG nanti)

**Test:**
- Unit test: `\frac{a}{b}` → OMML berisi `m:f`, `m:num`, `m:den`
- E2E VPS: generate docx dengan math, buka di Word, equation harus **editable** (klik equation → bisa edit)
- File size: harus lebih kecil dari PNG approach (OMML = XML text, bukan gambar)

**Effort: ~0.5 hari**

### 2. SVG di DOCX — setelah OMML selesai

**Tujuan:** inline `<svg>` di markdown → render sebagai gambar di DOCX.

**Pipeline:**
```
MDAST html node (berisi <svg>...</svg>)
  → deteksi: value includes '<svg'
  → screenshot via screenshotHtmlElements (sudah ada infra)
  → embed sebagai ImageRun PNG
```

**Implementasi:**
- File: `src/server/services/document-render-docx.ts`
- `renderBlock` case `'html'`: cek kalau value mengandung `<svg` → buat HTML page, screenshot, embed sebagai ImageRun
- Kalau bukan SVG → stripTags (behavior sekarang)

**Effort: ~0.25 hari**

### 3. Hapus diagnostic logs — setelah semua confirmed

**Tujuan:** bersihkan log yang gak perlu lagi.

- `channels.ts`: hapus `log.info(...)` "WhatsApp access gate decision" (L745-756)
- `whatsapp-web.ts`: hapus `log.warn(...)` "LID not found in mapping" dan `log.debug(...)` "Group message: no mention/reply detected"
- `whatsapp-web.ts`: hapus `log.info(...)` "LID mapping stored" dan `log.debug(...)` "LID mapping update received"

**Effort: ~0.1 hari**

### 4. RC-2b: update prompt Agent — inform format capabilities

**Tujuan:** Agent tahu format apa yang works, biar gak salah diagnose lagi.

**Tambah di prompt-builder.ts (section File storage):**
```
- generate_pdf() renders LaTeX math natively (KaTeX MathML via Chromium) and 
  inline SVG natively. TikZ (\begin{tikzpicture}) is NOT supported (no TeX 
  engine) — use SVG for diagrams instead.
- generate_docx() renders LaTeX math as native Word equation objects (OMML, 
  editable in Word). Inline SVG is rendered as an embedded image. TikZ is not 
  supported — use SVG.
- Do NOT self-diagnose generated files by inspecting their XML. Trust the tool 
  output. Equations in DOCX are OMML (not PNG images, not m:oMath tags to 
  search for — they ARE the equation objects).
```

**Effort: ~0.1 hari**

### 5. RC-3: attach_file kenali URL `/s/<token>` — optional

**Tujuan:** Agent bisa attach file dari file-storage langsung ke chat (Telegram/WA) tanpa download_stored_file dulu.

**Implementasi:**
- File: `src/server/tools/attach-file-tool.ts`
- Tambah case: kalau `source` starts with `/s/` → resolve token → file-storage row → local path
- Butuh: query `fileStorage` table by `accessToken`

**Effort: ~0.25 hari**

### 6. Test WA reply — verify sent-message-ID tracking

**Tujuan:** confirm reply-to-bot di grup WA jalan.

**Langkah:**
1. Deploy terbaru (`2b6ed1d8` atau yang lebih baru)
2. Bot harus kirim minimal 1 pesan di grup (supaya `sentMessageIds` terisi)
3. Reply pesan bot di grup
4. Cek log: `"isReplyToBot":true,"allow":true`
5. Kalau masih false → debug: cek `contextInfo.stanzaId` vs `sentMessageIds` set

### 7. Update ToDo.md dan catatan lainnya

- Update `Catatanku/ToDo.md` dengan status terbaru
- Update `Catatanku/latex-dokumen.md` dengan outcome OMML
- Update `Catatanku/whatsapp-grup.md` dengan status reply + mention
- Update `Catatanku/file-telegram.md` dengan status RC-1 confirmed

---

## Urutan eksekusi rekomendasi

1. **DOCX OMML** (prioritas utama — user request explicit)
2. **Hapus diagnostic logs** (bersih setelah OMML confirmed)
3. **RC-2b prompt update** (Agent gak salah diagnose lagi)
4. **SVG di DOCX** (bonus — diagram sebagai gambar)
5. **Test WA reply** (verify di VPS)
6. **RC-3 attach_file /s/** (optional)
7. **Update catatan**

## Dep yang perlu di-install besok

- `mathml2omml@0.5.0` — **sudah terinstall** ✅ (hari ini, untuk testing)
- Tidak ada dep baru lain yang dibutuhkan

## Catatan teknis

- `mml2omml` export: `import { mml2omml } from 'mathml2omml'` (bukan `mathml2omml`)
- KaTeX `output: 'mathml'` menghasilkan `<span class="katex"><math>...</math><annotation>...</annotation></span>` — `mml2omml` complain "Type not supported: span" dan "Type not supported: annotation" tapi tetap menghasilkan OMML yang benar. Mungkin perlu strip `<span>` dan `<annotation>` sebelum `mml2omml` untuk hasil bersih.
- `docx` package punya `Math`, `MathRun`, `MathFraction`, `MathRadical`, `MathSuperScript`, `MathSubScript`, `MathSum` classes — alternatif: build equation pakai docx Math API langsung (tanpa mml2omml). Tapi mapping LaTeX→docx Math API = effort besar. mml2omml lebih praktis.
- Untuk insert raw OMML XML ke docx: cek `docx` package `XmlComponent` atau custom element approach. Atau pakai `Math` class dengan children yang di-parse dari OMML.