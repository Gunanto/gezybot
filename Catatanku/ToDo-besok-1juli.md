# ToDo Besok — 1 Juli 2026

> Dibuat: 30 Jun 2026 ~17:00 · Update: 1 Jul 2026 ~01:00 · Status: **SELESAI — semua task dikerjakan**
>
> ## Eksekusi 1 Jul 2026 — STATUS
>
> | Task | Status | Commit |
> |---|---|---|
> | 1. DOCX OMML (equation editable) | ✅ Done | `12337317` |
> | 1b. Fix <undefined> bug | ✅ Done | `e7e0191e` |
> | 2. SVG di DOCX | ✅ Done | `12337317` |
> | 4. RC-2b prompt update | ✅ Done | `12337317` |
> | Telegram forum topics (bonus) | ✅ Done | `63754010` |
> | 6. RC-3 attach_file /s/ | ✅ Done | `4ed9f396` |
> | 3. Hapus diagnostic logs | ⏳ Deferred (sampai WA reply confirmed) |
> | 5. Test WA reply | ⏳ Butuh VPS deploy |
> | 7. Update catatan | ✅ Done (this section) |
>
> **Deploy ke VPS:** tunggu GitHub Actions selesai, lalu `docker compose pull && docker compose up -d --force-recreate gezy`.
> **Test di VPS:** DOCX dengan `$\frac{a}{b}# ToDo Besok — 1 Juli 2026

 → buka di Word → equation editable. Telegram forum topic reply → balas di topic yang benar.

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
- **OMML feasibility verified end-to-end** (~22:00): `\frac{a}{b}` → KaTeX mathml → `mml2omml` → `ImportedXmlComponent.fromXmlString` → DOCX 8671 bytes dengan `m:f`/`m:num`/`m:den` native. **Equation editable di Word, bukan gambar.** Besok tinggal implement di `document-render-docx.ts` + update test.

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

### 1. DOCX: equation sebagai native OMML (bukan gambar) — PRIORITAS UTAMA ✅ VERIFIED

**Tujuan:** ganti equation PNG image → native Word equation object (OMML). Equation bisa **diedit di Word** (klik equation → bisa edit, bukan gambar).

**Pipeline baru:**
```
LaTeX → KaTeX (output: 'mathml') → MathML string
     → strip <annotation>...</annotation>
     → mml2omml(mathml) → OMML XML string  (sudah dibungkus <m:oMath>...)
     → ImportedXmlComponent.fromXmlString(omml) → XmlComponent
     → push ke Paragraph children (cast sebagai ParagraphChild)
```

**VERIFIED END-TO-END (30 Jun ~22:00):**
- `mathml2omml@0.5.0` terinstall, jalan di Bun ✅
- Export: `import { mml2omml } from 'mathml2omml'` → OMML XML string ✅
- `\frac{a}{b}` → `<m:oMath><m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>...a...</m:num><m:den>...b...</m:den></m:f></m:oMath>` ✅
- `\frac{3}{4} + \sqrt{2}` → `m:f` + `m:rad` (akar kuadrat) benar ✅
- `ImportedXmlComponent.fromXmlString(omml)` dari `docx` package → XmlComponent tree ✅
- DOCX dibuat 8671 bytes (vs 103KB PNG approach) — jauh lebih kecil ✅
- Inspeksi `word/document.xml`: `m:oMath`, `m:f`, `m:num`, `m:den`, `m:rad` semua hadir dengan namespace benar ✅
- **Tidak butuh Playwright/Chromium** untuk equation lagi ✅

**⚠️ PENTING — jangan pakai kelas `docx` `Math`:**
Kelas `Math` (alias `Math_2`) me-render root key `m:oMath` sendiri. Output `mml2omml` SUDAH dibungkus `<m:oMath>`. Kalau dibungkus `Math` class lagi → double `<m:oMath>` (rusak). Jadi **langsung pakai `ImportedXmlComponent.fromXmlString(omml)`**, bukan `new Math({children:[...]})`.

**⚠️ Strip `<annotation>` sebelum `mml2omml`:**
KaTeX `output:'mathml'` menghasilkan `<span class="katex"><math>...<annotation encoding="application/x-tex">\frac{a}{b}</annotation></math></span>`. `mml2omml` complain "Type not supported: annotation" (warning, tapi tetap jalan). Bersihkan dulu:
```ts
const html = katex.renderToString(latex, { displayMode, throwOnError: false, output: 'mathml' })
const mathMatch = html.match(/<math[\s\S]*?<\/math>/)
let mathml = mathMatch[0].replace(/<annotation[\s\S]*?<\/annotation>/g, '')
const omml = mml2omml(mathml)
```

**⚠️ Display (block) equation → bungkus `<m:oMathPara>`:**
`mml2omml` keluarkan `<m:oMath>` untuk kedua mode (inline + display). Untuk block equation yang center, Word expect `<m:oMathPara><m:oMath>...</m:oMath></m:oMathPara>`. Kalau gak dibungkus, equation jalan tapi gak auto-center. Solusi: kalau `display === true`, bungkus omml manual:
```ts
const wrapped = display
  ? `<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMathPara>`
  : omml
return ImportedXmlComponent.fromXmlString(wrapped)
```

**Implementasi konkret (`document-render-docx.ts`):**
- File: `src/server/services/document-render-docx.ts`
- Import tambahan: `import { ImportedXmlComponent } from 'docx'` dan `import { mml2omml } from 'mathml2omml'`
- Hapus: `playwrightManager` import + `screenshotHtmlElements` call + `buildEquationsHtml` + `pngDims` (gak dipakai untuk math lagi) — TAPI `screenshotHtmlElements` tetap dipakai untuk SVG (task #2), jadi jangan hapus dari `playwright-manager.ts`
- Ganti `renderKatexMathml` → `latexToOmml(latex, display)`: KaTeX mathml → strip annotation → mml2omml → (wrap oMathPara kalau display) → return string
- Ganti `renderMathParagraph(id, images, display)` → `renderMathParagraph(latex, display)`: `new DocxParagraph({ alignment: CENTER, children: [ImportedXmlComponent.fromXmlString(omml)] })`
- Ganti inline `inlineMath` case → return `[ImportedXmlComponent.fromXmlString(omml)]` (cast `as unknown as TextRun`)
- Hapus `mathNodes` collection + `cursor` + `images` Map (gak perlu lagi — equation langsung convert dari latex di node, gak perlu 2-pass)
- Simplifikasi: jadi 1-pass walk (collect + render sekaligus), gak perlu collectMath/walkNode/newMathCursor

**Test (`document-render-docx.test.ts` — perlu update):**
- Hapus mock `screenshotHtmlElements` untuk math (gak dipanggil lagi untuk math)
- Test baru: `\frac{a}{b}` → unzip docx → `word/document.xml` contains `m:oMath` + `m:f` + `m:num` + `m:den`
- Test: `\sqrt{2}` → contains `m:rad`
- Test: block equation (`$$...$$`) → contains `m:oMathPara`
- Test: prose tanpa math → gak ada `m:oMath`, `screenshotHtmlElements` gak dipanggil
- **Pakai byte-safe script** untuk edit file .ts (lihat Pitfalls) — `edit_file`/`write_file` trigger format-on-save yang ubah single→double quote + tambah semicolon di SELURUH file

**Verifikasi VPS:**
- Generate docx dengan math, download, buka di Word/LibreOffice → equation harus **editable** (klik equation → bisa edit, bukan gambar)
- File size: harus ~8-15KB (vs 103KB PNG)

**Effort: ~0.5 hari** (feasibility sudah done, tinggal implement + test)

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

## Catatan teknis (verified 30 Jun ~22:00)

- `mml2omml` export: `import { mml2omml } from 'mathml2omml'` (bukan `mathml2omml`). Pakai `mml2omml(mathmlString)` function, bukan class.
- KaTeX `output: 'mathml'` menghasilkan `<span class="katex"><math>...<semantics>...<annotation encoding="application/x-tex">\frac{a}{b}</annotation></semantics></math></span>`. **Strip `<annotation>` sebelum `mml2omml`** (complain "Type not supported: annotation", warning aja tapi bersihkan biar gak noisy). `<span>` gak masuk ke `mml2omml` karena kita cuma extract `<math>...</math>` via regex.
- **Pakai `ImportedXmlComponent.fromXmlString(omml)` dari `docx`** — BUKAN kelas `Math`. Kelas `Math` bikin double `<m:oMath>` (rusak). `ImportedXmlComponent` parse raw XML string jadi XmlComponent tree, lolos type-check dengan cast `as unknown as ParagraphChild` / `as unknown as TextRun`.
- `mml2omml` output SUDAH dibungkus `<m:oMath xmlns:m=...>...</m:oMath>`. Untuk display (block) equation, bungkus tambahan `<m:oMathPara>...</m:oMathPara>` supaya auto-center di Word.
- **Pakai byte-safe script untuk edit `.ts`** (`bun run /tmp/patch.ts` yang read→string-replace→writeFile). `edit_file`/`write_file` di editor trigger format-on-save → ubah single→double quote + tambah semicolon di SELURUH file (style violation, diff raksasa).
- `mathml2omml@0.5.0` terinstall (sudah ada di `package.json` + `node_modules`).
- Hasil prototype: DOCX 8671 bytes, `m:oMath`+`m:f`+`m:num`+`m:den`+`m:rad` semua benar di `word/document.xml`.