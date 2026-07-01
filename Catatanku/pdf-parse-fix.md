# Fix: Bot Tidak Bisa Baca PDF — pdf-parse v2 API Breaking Change

> Dibuat: 1 Jul 2026 · Status: **FIXED (commit `95a428b7`)** · Prioritas: tinggi

## Masalah

User kirim file PDF (`5.a.Pengantar_PPM.pdf`, 11 halaman, dibuat Adobe InDesign) ke bot Yefia via Telegram. Bot balas:

> "Sayangnya di environment saya tidak ada PDF reader yang bisa mengekstrak teksnya."

Bot menyimpan file ke workspace (`5.a.Pengantar_PPM.pdf`) tetapi tidak bisa membaca isinya — Agent menganggap tidak ada tool PDF reader.

## Diagnosa

### 1. Tool `read_file` sudah ada fitur PDF text extraction

File `src/server/tools/filesystem-tools.ts` (line 114) punya handler khusus untuk file `.pdf`:

```ts
if (absPath.endsWith('.pdf')) {
  try {
    const pdfParse = (await import('pdf-parse') as any).default
    const pdf = await pdfParse(buffer)
    const text = pdf.text
    // ... return text to Agent
  } catch (e) {
    return { success: false, error: `Failed to extract text from PDF: ${e.message}` }
  }
}
```

Jadi sebenarnya tool `read_file` BISA baca PDF — tapi fell ke `catch` block.

### 2. Package `pdf-parse` ada di dependencies

```json
// package.json
"dependencies": {
  "pdf-parse": "^2.4.5"
}
```

Package terinstall (ada di `node_modules` lokal + ada di `bun.lock`).

### 3. Root cause: API breaking change pdf-parse v1 → v2

Package `pdf-parse@2.4.5` **mengubah API total** dari v1:

**v1 (lama, yang kode pakai):**
```ts
import pdfParse from 'pdf-parse'       // default export = function
const pdf = await pdfParse(buffer)     // call with Buffer → returns { text, numpages }
const text = pdf.text                  // extracted text
const pages = pdf.numpages             // page count
```

**v2 (yang terinstall, 2.4.5):**
```ts
const { PDFParse } = await import('pdf-parse')   // named export CLASS, no default!
const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 })
await parser.load()
const result = await parser.getText()
const text = result.text              // { text, pages[], total }
const pages = result.total             // page count
```

Kode lama memakai:
```ts
const pdfParse = (await import('pdf-parse') as any).default
```

Di v2, `.default` adalah **`undefined`** (v2 hanya ekspor `PDFParse` class sebagai named export,
bukan default function). Akibatnya:
```ts
const pdf = await pdfParse(buffer)
// → TypeError: undefined is not a function
// → fell ke catch block → "Failed to extract text from PDF"
```

Agent menerima error ini, lalu menafsirkan sebagai "tidak ada PDF reader di environment" dan bilang ke user.

### 4. Verifikasi: v2 API jalan di Bun

Test end-to-end di dev environment:

```bash
# Generate PDF via Playwright (markdownToPdf)
# Lalu parse dengan pdf-parse v2 API:
const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 })
await parser.load()
const result = await parser.getText()
# → result.text: "Hello World PDF test\n\n-- 1 of 1 --\n\n"
# → result.total: 1
```

✅ **v2 API bekerja di Bun runtime** — bukan masalah kompatibilitas Bun, tapi masalah API migration.

## Fix yang diterapkan (commit `95a428b7`)

**File:** `src/server/tools/filesystem-tools.ts`

```ts
// OLD (v1 API — broken):
const pdfParse = (await import('pdf-parse') as any).default
const pdf = await pdfParse(buffer)
const text = pdf.text
const numPages = pdf.numpages

// NEW (v2 API — working):
const { PDFParse } = await import('pdf-parse') as any
const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 })
await parser.load()
const result = await parser.getText()
const text = result.text
const numPages = result.total
```

### Perubahan detail

| Field | v1 (lama) | v2 (baru) |
|---|---|---|
| Import | `(await import('pdf-parse')).default` | `const { PDFParse } = await import('pdf-parse')` |
| Instantiation | function call: `pdfParse(buffer)` | class: `new PDFParse({ data, verbosity: 0 })` |
| Load | not needed (immediate) | `await parser.load()` |
| Extract text | `pdf.text` | `await parser.getText()` → `.text` |
| Page count | `pdf.numpages` | `result.total` |
| Input data | `Buffer` | `new Uint8Array(buffer)` |

## Verifikasi

### Lokal (dev)

- Typecheck: `tsc --noEmit` → EXIT 0 ✅
- Tests: `bun test src/server/tools/` → 1044 pass, 0 fail ✅
- Full suite: 4108 pass, 91 skip, 0 fail ✅
- Test PDF extraction end-to-end: buat PDF via Playwright, parse dengan v2 API → text extracted ✅

### VPS (perlu deploy)

```bash
docker compose pull
docker compose up -d --force-recreate gezy
```

Test E2E: kirim PDF ke bot di Telegram → bot harus bisa `read_file` PDF tersebut dan membaca isinya.

## Context tambahan

### Dependency chain pdf-parse

```
pdf-parse@2.4.5
  ├── @napi-rs/canvas@0.1.80   (native canvas, untuk image extraction — gak dipakai di text extraction)
  └── pdfjs-dist@5.4.296       (Mozilla PDF.js — engine aktual untuk text extraction)
```

`pdfjs-dist` adalah dependency dari `pdf-parse`, bukan dependency langsung proyek. Tapi karena `pdf-parse` di dependencies (bukan devDependencies), `bun install --production` di Dockerfile akan menginstall keduanya.

### Docker container

Dockerfile (`docker/Dockerfile`) menambahkan `pdf-parse` via:
```dockerfile
RUN bun install --frozen-lockfile --production
```

`pdf-parse` ada di `dependencies` (bukan `devDependencies`), jadi `--production` flag tidak mengeluarkannya. Container seharusnya punya `pdf-parse` terinstall. Masalahnya **bukan package tidak ada**, tapi **API versi salah** — kode pakai API v1 sedangkan package terinstall adalah v2.

### File-file kunci

| File | Peran |
|---|---|
| `src/server/tools/filesystem-tools.ts` | Tool `read_file` — handler PDF extraction (L114-155) |
| `package.json` | `"pdf-parse": "^2.4.5"` di dependencies |
| `node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.js` | Class `PDFParse` (v2 implementation) |
| `node_modules/.bun/pdfjs-dist@5.4.296/` | pdfjs-dist (text extraction engine, dependency dari pdf-parse) |

### Panggunaan pdf-parse di codebase

`pdf-parse` hanya dipakai di satu tempat: `src/server/tools/filesystem-tools.ts` (tool `read_file`). Tidak ada file lain yang import `pdf-parse`.

### Catatan untuk masa depan

1. **Kalau upgrade `pdf-parse` ke v3+**, cek API lagi — mungkin breaking change baru.
2. **Scope fix**: fix ini hanya untuk text extraction. `PDFParse` v2 juga support image extraction (`getImage`, `getScreenshot`), table extraction (`getTable`), hyperlink extraction (`getHyperlinks`), dan page geometry (`getPathGeometry`). Kalau Agent perlu fitur ini di masa depan, API v2 sudah mendukung.
3. **Performance**: v2 pakai pdfjs-dist (Mozilla PDF.js) yang parse client-side (JS murni, no native binary). Aman di container, tidak butuh system PDF library (poppler/ghostscript).
4. **PDF yang terenkripsi/password**: `PDFParse` konstruktor menerima opsi `password`. Kalau Agent minta baca PDF terpassword, perlu handling password — defer untuk sekarang.
5. **Ekstrak PDF via Playwright alternatif**: kalau `pdf-parse` bermasalah di masa depan, alternatif: render PDF via Chromium (sudah ada di container untuk browse_url) + ekstrak text dari DOM. Tapi ini lebih berat (launch Chromium per PDF). `pdf-parse` jalan di-process, jauh lebih cepat.

## Timeline

| Tanggal | Event |
|---|---|
| 18 Mar 2026 | `pdf-parse@^2.4.5` ditambahkan ke `package.json` (commit `dd94056`) |
| 1 Jul 2026 ~22:00 | User laporkan bot tidak bisa baca PDF dari Telegram |
| 1 Jul 2026 ~23:00 | Diagnosa: v1 → v2 API breaking change |
| 1 Jul 2026 ~23:30 | Fix di-push (commit `95a428b7`) |
| TBD | Deploy VPS + test E2E |