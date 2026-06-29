# LaTeX di Telegram Rich Messages — Analisis Implementasi

> Tanggal: 2026-06-29 · Sumber: Telegram Bot API 10.1 docs + demo bot
> Status: **analisis saja — belum ada kode diubah**.

Fase 1 rich messages sudah live (commit `b5eca4cc`), tapi math/LaTeX sengaja
di-skip (collapse ke plain text). Dokumen ini menilai cara implementasi yang
**aman dan pasti berhasil** berdasarkan syntax exact dari docs Telegram.

---

## 1. Syntax exact Telegram untuk LaTeX

Dari docs API 10.1 (`/bots/api#rich-html-style` + `/bots/api#rich-markdown-style`):

### HTML style (yang kita pakai di Fase 1)
| Level | Tag | Contoh |
|---|---|---|
| Inline | `<tg-math>…</tg-math>` | `<tg-math>x^2 + y^2</tg-math>` |
| Block | `<tg-math-block>…</tg-math-block>` | `<tg-math-block>E = mc^2</tg-math-block>` |

Tidak ada atribut. Isi tag = **raw LaTeX** — Telegram tidak parse HTML/Markdown
di dalamnya, langsung diteruskan ke renderer LaTeX.

### Markdown style (alternatif, tidak kita pakai)
| Level | Syntax | Contoh |
|---|---|---|
| Inline | `$…$` | `$x^2 + y^2$` |
| Block | `$$…$$` | `$$E = mc^2$$` |
| Block | ```` ```math ```` fence | ```` ```math\nE = mc^2\n``` ```` |

### Tipe hasil parse (konfirmasi)
- `RichTextMathematicalExpression` (inline): `{ type: "mathematical_expression", expression: String }`
- `RichBlockMathematicalExpression` (block): `{ type: "mathematical_expression", expression: String }`

---

## 2. Kondisi Gezy sekarang

### 2.1 Deps sudah ada (tidak perlu install baru)
| Package | Versi | Fungsi |
|---|---|---|
| `remark-math` | `^6.0.0` | Parse `$…$` / `$$…$$` di MDAST → node `inlineMath` / `math` |
| `rehype-katex` | `^7.0.1` | UI render math (sudah dipakai client) |
| `remark-parse` + `remark-gfm` | sudah | Pipeline MDAST Fase 1 |

### 2.2 MDAST node dari remark-math (terverifikasi)
```
Input:  "Inline $x^2$ and block:\n$$\nE=mc^2\n$$\n"

MDAST:
  paragraph
    text "Inline "
    inlineMath  value="x^2"        ← raw LaTeX
    text " and block:"
  math  value="E=mc^2"             ← raw LaTeX (block)
```

`remark-math` menghasilkan node `inlineMath` (inline) dan `math` (block-level),
masing-masing dengan field `value: string` = source LaTeX mentah.

### 2.3 Konverter Fase 1 sekarang (`telegram-rich.ts`)
- Tidak pakai `remark-math` di pipeline (hanya `remark-parse` + `remark-gfm`).
- Math di MDAST tanpa `remark-math` → masuk sebagai `text` node biasa →
  dirender sebagai escaped text (`$x^2$` muncul literal). Inilah sebabnya
  LaTeX tidak render di Telegram sekarang.
- Komentar eksplisit di file: "math blocks rendered as text — out of scope
  for Fase 1".

---

## 3. Rencana implementasi (Fase 1c — Math/LaTeX)

### 3.1 Perubahan minimal, 3 titik saja

| File | Perubahan |
|---|---|
| `src/server/channels/telegram-rich.ts` | 1) Tambah `remark-math` ke pipeline `unified()`. 2) Tambah case `'inlineMath'` di `renderInline()` → `<tg-math>{value}</tg-math>`. 3) Tambah case `'math'` di `renderBlock()` → `<tg-math-block>{value}</tg-math-block>`. 4) Update `isBlockLevel()` agar `math` dihitung blok (trigger rich path). |
| `src/server/channels/telegram-rich.test.ts` | Tambah test: inline math, block math, math di tengah paragraf, math + heading/list kombinasi, math dengan karakter LaTeX khusus (`\frac`, `_`, `^`, `\sum`). |
| `Catatanku/bottelegram-api-10.1.md` | Update: math sekarang Fase 1c (done), bukan out-of-scope. |

**Tidak perlu** install paket baru, **tidak perlu** ubah SDK, **tidak perlu**
ubah adapter `sendMessage` — semuanya sudah framework Fase 1.

### 3.2 Aturan escaping di dalam math — PENTING

Docs Telegram: *"Formula source is treated as raw LaTeX."* Artinya isi
`<tg-math>` / `<tg-math-block>` **tidak di-escape HTML**. LaTeX seperti
`x < y` atau `a & b` harus dikirim mentah, bukan `x &lt; y`.

**Implementasi:** di `renderInline` case `'inlineMath'` dan `renderBlock`
case `'math'`, **jangan** panggil `escapeHtml(value)` — keluarkan `value`
mentah.

**Risiko & mitigasi:**
- Kalau LaTeX mengandung literal `</tg-math>` → parser Telegram bingung.
  Tapi ini kasus ekstrem (hampir tidak pernah di output LLM). Mitigasi:
  validasi `value` tidak mengandung `</tg-math` sebelum emit; kalau iya,
  fallback ke plain text.
- Karakter `<`, `>`, `&` di LaTeX (mis. `x < y`, `a \& b`) — kirim mentah.
  Telegram parser tahu ini raw LaTeX, tidak akan salah baca sebagai tag HTML.

**Tes sebelum produksi:** kirim via `@richtextdemobot` beberapa ekspresi
dengan `<`/`>`/`&` untuk konfirmasi parser Telegram benar-benar treat sebagai
raw. Kalau gagal, fallback: escape hanya `<` dan `>` (tapi tidak `\`, `^`,
`_`, `{`, `}` yang penting untuk LaTeX).

### 3.3 Distinguishing `$USD` cashtag vs `$…$` math

Docs: `$USD` (dollar + huruf uppercase + boundary) di-parse sebagai **cashtag**,
bukan math. `remark-math` sudah handle ini dengan benar — `$USD` tanpa closing
`$` tetap jadi `text` node, bukan `inlineMath`. Tidak perlu logic tambahan.

Tapi kalau LLM output `$5` atau `$100` (currency), `remark-math` mungkin
salah parse sebagai math jika ada closing `$` di teks berikutnya. Mitigasi:
ini edge case langka di output Agent; kalau terjadi, fallback `sendMessage`
plain text tetap jadi safety net (Fase 1 sudah ada fallback).

### 3.4 Block math masuk trigger rich path

`isBlockLevel()` perlu include `'math'` agar pesan dengan `$$…$$` atau
```` ```math ```` memicu `sendRichMessage` (bukan `sendMessage` plain).
Inline math saja (`$…$`) tidak perlu trigger rich — bisa render inline di
`sendMessage`? **Tidak** — `<tg-math>` hanya support di rich messages, bukan
legacy `sendMessage`. Jadi kalau ada inline math tanpa block lain, tetap
perlu rich path. Solusi: tambah cek `hasInlineMath` di `markdownHasRichBlocks`.

---

## 4. Estimasi effort

| Bagian | Waktu |
|---|---|
| Tambah `remark-math` + 2 case render + `isBlockLevel` + `hasInlineMath` | 0.5 jam |
| Unit test (8–10 kasus math) | 0.5 jam |
| Test via `@richtextdemobot` (konfirmasi escaping raw LaTeX) | 0.25 jam |
| Test end-to-end via VPS (Agent output trigonometri) | 0.25 jam |
| Docs update | 0.25 jam |
| **Total** | **~1.75 jam** |

Sangat kecil karena infrastruktur Fase 1 sudah ada — ini hanya tambah 2 case
di konverter + 1 plugin remark.

---

## 5. Keputusan desain (perlu konfirmasi kamu)

**M1 — Escape inside math?**
- (a) **Tidak escape** (raw LaTeX mentah) — sesuai docs "raw LaTeX".
  **Recommended**, tapi tes via demo bot dulu.
- (b) Escape `<` `>` `&` saja — konservatif, tapi mungkin break LaTeX
  `\textless` dll.

**M2 — Inline math tanpa block lain?**
- (a) Tetap pakai rich path (`sendRichMessage`) kalau ada inline math.
  **Recommended** — `<tg-math>` hanya support di rich.
- (b) Skip inline math (collapse ke text) kalau tidak ada block lain →
  math tidak render. Tidak ideal.

**M3 — Fallback kalau `sendRichMessage` reject payload math?**
- (a) Fallback ke `sendMessage` plain text (sudah ada di Fase 1). Math
  muncul sebagai `$x^2$` literal. **Recommended** — lebih baik daripada
  pesan hilang.
- (b) Coba strip math tags lalu re-send rich tanpa math.

---

## 6. Risk assessment

| Risk | Likelihood | Impact | Mitigasi |
|---|---|---|---|
| Telegram parser tidak treat `<tg-math>` content sebagai raw (butuh escape) | Rendah (docs eksplisit "raw LaTeX") | Sedang (math render rusak) | Tes via demo bot sebelum deploy |
| LLM output LaTeX tidak valid (syntax error) | Sedang | Rendah (Telegram tampilkan raw text) | Fallback `sendMessage` plain text |
| `$…$` false positive di currency text | Rendah | Rendah (tampil literal) | `remark-math` sudah handle; fallback safety net |
| `</tg-math>` literal di LaTeX | Sangat rendah | Sedang (parser break) | Validasi + fallback plain text |
| Block math terlalu besar (>limit) | Rendah | Rendah (split per-block sudah ada) | `maxBlocksPerPage` handling |

**Kesimpulan: aman untuk implementasi.** Risiko terbesar (escaping) bisa
dimitigasi dengan tes demo bot 5 menit sebelum deploy.

---

## 7. Referensi

- Rich HTML style (tag `<tg-math>`, `<tg-math-block>`):
  <https://core.telegram.org/bots/api#rich-html-style>
- Rich Markdown style (`$…$`, `$$…$$`, ``` ```math ```):
  <https://core.telegram.org/bots/api#rich-markdown-style>
- Tipe `RichTextMathematicalExpression`:
  <https://core.telegram.org/bots/api#richtextmathematicalexpression>
- Tipe `RichBlockMathematicalExpression`:
  <https://core.telegram.org/bots/api#richblockmathematicalexpression>
- Demo bot untuk tes: <https://t.me/richtextdemobot>
- Fitur rich messages: <https://core.telegram.org/bots/features#rich-messages>

### Titik kode Gezy relevan
- `src/server/channels/telegram-rich.ts:1` — konverter MDAST→HTML (tempat
  `remark-math` + case `inlineMath`/`math` masuk)
- `src/server/channels/telegram-rich.ts:120` — `isBlockLevel()` (tambah
  `'math'`)
- `src/server/channels/telegram-rich.ts:90` — `markdownHasRichBlocks()` (tambah
  cek inline math)
- `src/server/channels/telegram.ts:367` — `sendMessage` rich path (tidak diubah;
  sudah handle fallback)
- `package.json` — `remark-math@^6.0.0` sudah ada
