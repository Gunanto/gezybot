# Fitur Channel & Dokumen — Catatan Komprehensif

> Dibuat: 1 Juli 2026 · Status: **living document — update sesuai perkembangan**

Dokumen ini merangkum seluruh fitur terkait channel komunikasi (Telegram, WhatsApp) dan generasi dokumen (PDF, DOCX, Markdown) di aplikasi Gezy. Mencakup: apa yang sudah berjalan, arsitektur, konfigurasi, dan apa yang masih perlu pengembangan.

---

## Daftar Isi

1. [Arsitektur Channel — Gambaran Umum](#1-arsitektur-channel--gambaran-umum)
2. [Telegram](#2-telegram)
3. [WhatsApp-Web](#3-whatsapp-web)
4. [Dokumen PDF](#4-dokumen-pdf)
5. [Dokumen DOCX](#5-dokumen-docx)
6. [Markdown di Chat (Rich Messages)](#6-markdown-di-chat-rich-messages)
7. [Tool terkait Dokumen & File](#7-tool-terkait-dokumen--file)
8. [Env & Konfigurasi VPS](#8-env--konfigurasi-vps)
9. [Rangkuman: yang sudah work vs perlu pengembangan](#9-rangkuman-yang-sudah-work-vs-perlu-pengembangan)

---

## 1. Arsitektur Channel — Gambaran Umum

### Arsitektur umum

Semua channel mengikuti pola adapter (interface `ChannelAdapter` dari `@gezy/sdk`):

```
External Platform (Telegram / WhatsApp / Discord / ...)
  ↓ adapter (polling atau webhook)
IncomingMessage { platformChatId, platformUserId, content, isMentioned, isReplyToBot, metadata, ... }
  ↓ channels.ts: handleIncomingChannelMessage()
1. Access gate (telegram / whatsapp) — allowlist + mention/reply check
2. Contact approval (new sender → pending)
3. Enqueue to Agent queue
  ↓ agent-engine.ts
Agent produces response → call attach_file() + text reply
  ↓ channels.ts: deliverChannelResponse() / deliverChannelAttachments()
adapter.sendMessage({ chatId, content, attachments, threadId, ... })
  ↓ platform API
External Platform
```

### Flow outbound (streaming-draft)

Untuk Telegram (yang mendukung `streamDraft`), agent response mengikuti jalur streaming:

```
Agent response (LLM streaming)
  ↓ streamDraft().update() → telegram.ts: sendRichMessageDraft (ephemeral bubble)
  ↓ streamDraft().commit() → telegram.ts: sendRichMessage / sendMessage (persistent message)
  ↓ deliverChannelAttachments() → kirim file terlampir via sendDocument/sendPhoto
```

### File-file kunci

| File | Peran |
|---|---|
| `packages/sdk/src/index.ts` | Interface `ChannelAdapter`, `IncomingMessage`, `OutboundMessageParams`, dll |
| `src/server/channels/adapter.ts` | Re-export dari SDK + helper outbound attachment |
| `src/server/channels/telegram.ts` | Adapter Telegram (polling + webhook) |
| `src/server/channels/telegram-rich.ts` | Markdown → Telegram HTML (rich messages) |
| `src/server/channels/whatsapp-web.ts` | Adapter WhatsApp-Web (Baileys, QR pairing) |
| `src/server/services/channels.ts` | Service layer: gate, queue, delivery, attachment haul |
| `src/server/services/document-render.ts` | PDF pipeline (markdown+LaTeX → PDF) |
| `src/server/services/document-render-docx.ts` | DOCX pipeline (markdown+LaTeX → DOCX) |
| `src/server/services/playwright-manager.ts` | Playwright headless Chromium manager |
| `src/server/tools/document-tools.ts` | Tool `generate_pdf` + `generate_docx` |
| `src/server/tools/attach-file-tool.ts` | Tool `attach_file` |
| `src/server/config.ts` | Konfigurasi semua env vars |

---

## 2. Telegram

### 2.1 Yang sudah berjalan (WORK)

| Fitur | Status | Keterangan |
|---|---|---|
| Bot polling (long-poll) | ✅ | `getUpdates` loop dengan backoff exponential, auto-reconnect |
| Bot webhook mode | ✅ | Set webhook ke `${PUBLIC_URL}/api/channels/telegram/${channelId}`, auto-deteksi mode |
| Rich messages (HTML) | ✅ | `telegram-rich.ts`: markdown → subset HTML Telegram (bold, italic, code, pre, links, lists, tables, blockquotes, expandable) |
| Streaming draft | ✅ | `sendRichMessageDraft` → bubble ephemeral yang update real-time, lalu commit jadi persistent message |
| File attachment | ✅ | `attach_file` → `sendDocument`/`sendPhoto` (RC-1 fix: attachment kirim setelah streaming commit) |
| Access control gate | ✅ | Allowlist (`TELEGRAM_ALLOWED_USERS`), owner (`OWNER_TELEGRAM_USER_ID`), allow-all-in-groups (`ALLOW_ALL_USERS_IN_GROUPS`) |
| DM / Group / Supergroup / Channel chat type | ✅ | Chat type dideteksi: `chatType` field |
| Mention detection (`@botname`) | ✅ | Entity `mention` matching `@<botUsername>` + `text_mention` |
| Reply-to-bot detection | ✅ | `reply_to_message.from.id === botId` |
| Forum topics (message_thread_id) | ✅ (commit `63754010`) | Bot reply di topic yang benar — `message_thread_id` diekstrak inbound + disisipkan outbound |
| Typing indicator | ✅ | `sendChatAction` typing (dengan `message_thread_id` kalau ada) |
| LaTeX math di chat | ✅ | Inline `$...$` → KaTeX MathML di rich message HTML (via `telegram-rich.ts`) |
| Image attachment | ✅ | `sendPhoto` untuk image MIME types |

### 2.2 Yang masih bermasalah / perlu pengembangan

| Issue | Status | Keterangan |
|---|---|---|
| Telegram 404 `/webhook/telegram` | ⚠️ | Webhook URL salah di salah satu channel. Telegram masih kirim ke URL lama. Perlu: delete webhook lama, atau set webhook URL yang benar. Terpisah dari kerjaan kita. |
| Math block `$$...$$` di chat | ⚠️ | `telegram-rich.ts` strips math blocks to text (Telegram tidak support MathML di rich messages). Inline math jadi text biasa juga sebenarnya — hanya format dasar. Untuk math sungguhan, gunakan `generate_pdf` atau `generate_docx`. |
| Expandable untuk konten panjang | ✅ | Sudah ada (`<tg-expandable>`) untuk konten yang melebihi batas blok Telegram. |

### 2.3 Arsitektur Telegram detail

**Inbound (polling):**
```
Telegram getUpdates → update.message → processUpdate()
  → skip bot's own messages (loop prevention)
  → filter by allowedChatIds
  → extract text/caption, attachments
  → analyzeTelegramMessage() → chatType, isMentioned, isReplyToBot
  → extract message_thread_id (forum topics) → metadata.threadId
  → onMessage(IncomingMessage)
```

**Inbound (webhook):**
```
Telegram POST → routes/channel-telegram.ts
  → validate webhook secret
  → deriveMessageContext() → sama kayak polling
  → onMessage(IncomingMessage)
```

**Outbound:**
```
adapter.sendMessage(channelId, cfg, params)
  → if attachments: sendTelegramFile() per attachment
    - sendPhoto (image) atau sendDocument (non-image)
    - chat_id + message_thread_id (forum topic) + reply_parameters
  → else: markdownToTelegramHtml(content)
    - if hasBlocks: sendRichMessage (rich_message.html)
      - jika gagal: fallback ke sendMessage (plain text)
    - else: sendMessage dengan text (chunk per 4096 chars)
  → message_thread_id disertakan di semua body kalau params.threadId set
```

**Streaming draft:**
```
adapter.streamDraft()
  → open draft bubble: sendRichMessageDraft (ephemeral)
  → update: throttled (400ms), sendRichMessageDraft update
  → commit: sendRichMessage (persistent) → ganti draft bubble
    - jika gagal: fallback ke sendMessage (plain text)
  → abort: kirim draft kosong untuk hapus bubble
```

### 2.4 TelePost / TeleConversation API (custom)

Gezy menggunakan custom Telegram Bot API yang ekstensi fitur:
- `sendRichMessage` — kirim HTML rich message (bold, italic, code, pre, expandable, table, list, blockquote)
- `sendRichMessageDraft` — versi ephemeral untuk streaming bubble
- `InputRichMessage` dengan field `html` dan `markdown`

API endpoint: relatif terhadap bot token (`/bot<token>/<method>`).

### 2.5 Forum topics — implementasi message_thread_id

**Commit:** `63754010` (1 Jul 2026)

Ketika user reply/mention bot di forum topik A, bot harus balas di topik A. Sebelum fix ini, `message_thread_id` tidak diekstrak dari inbound, dan tidak disisipkan di outbound — bot selalu balas di main thread.

**Flow:**
1. **Inbound** (`telegram.ts:processUpdate`): ekstrak `message.message_thread_id`, simpan di `IncomingMessage.metadata.threadId`
2. **Service** (`channels.ts`): baca `threadId` dari metadata → simpan di `ChannelQueueMeta` + `ChannelOriginMeta` → teruskan ke semua outbound `sendMessage` / `streamDraft` / `sendTypingIndicator`
3. **Outbound** (`telegram.ts:sendMessage` / `streamDraft`): sisipkan `message_thread_id: Number(threadId)` di setiap body API (sendMessage, sendRichMessage, sendRichMessageDraft, sendChatAction, sendPhoto, sendDocument)
4. **SDK** (`packages/sdk/src/index.ts`): tambah `threadId?: string` optional di `OutboundMessageParams` + `sendTypingIndicator` signature

Non-breaking: `threadId` optional di mana-mana. Kalau absent (DM, non-forum chat), behavior gak berubah.

---

## 3. WhatsApp-Web

### 3.1 Yang sudah berjalan (WORK)

| Fitur | Status | Keterangan |
|---|---|---|
| QR pairing | ✅ | Link device via QR scan, session persistent (`data/whatsapp-web/`) |
| Auto-reconnect | ✅ | Reconnect dengan backoff kalau session drop |
| Text message | ✅ | Kirim/terima text |
| Markdown formatting | ✅ | Bold `*text*`, italic `_text_`, strikethrough `~text~`, code `` `code` `` — native WhatsApp formatting |
| Media attachment | ✅ | Image, document, audio, video (kirim + terima) |
| Access control gate | ✅ | Allowlist (`GEZY_WHATSAPP_ALLOWED_USERS`), owner (`OWNER_WHATSAPP_USER_ID`), allow-all-in-groups (`GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS`) |
| DM processing | ✅ | DM dari authorized users → langsung diproses |
| Grup mention | ✅ (text-based) | Jika text mengandung digit nomor bot (`@6282361201550`) → dianggap mention |
| Grup reply-to-bot | ✅ (commit `2b6ed1d8`) | `contextInfo.stanzaId` vs `sentMessageIds` set — reply ke pesan bot → diproses |
| LID resolution | ✅ (workaround) | LID `@lid` → tambah digit LID ke allowlist env (Baileys `lid-mapping.update` tidak pernah fire v7-rc13) |
| Typing indicator | ✅ | `sendChatAction` (WA: `composing`) |
| Multiple linked devices | ✅ | Bot sebagai linked device (JID dengan `:device` suffix, e.g. `6282361201550:11@s.whatsapp.net`) |

### 3.2 Yang masih bermasalah / perlu pengembangan

| Issue | Status | Keterangan |
|---|---|---|
| LID mapping (`lid-mapping.update`) | ⚠️ | Baileys v7-rc13 TIDAK pernah emit event ini. Workaround: tambah LID digit manual ke allowlist. Nomor baru → cek log untuk LID-nya → tambah ke env. Fix permanen butuh upgrade Baileys atau approach berbeda. |
| Mention by contact name (`@Me-PaGun`) | ❌ | Text detection cuma match digit nomor, bukan nama kontak. `@6282361201550` works, `@Me-PaGun` tidak. Native `mentionedJid` dari Baileys juga gak reliable (LID vs PN mismatch). |
| Reply test di grup | ⏳ | Fix `sent-message-ID tracking` sudah di-push (`2b6ed1d8`) tapi belum di-test E2E di VPS. Perlu: deploy terbaru → bot kirim pesan di grup → user reply pesan bot → cek `isReplyToBot:true` di log. |
| Streaming draft | ❌ | WA adapter tidak implement `streamDraft`. Semua reply one-shot (tidak ada ephemeral bubble). |
| Rich message / HTML | ❌ | WA hanya support formatting native (`*bold*`, `_italic_`, dll). Tidak ada rich HTML. |
| Forum topics | N/A | WhatsApp tidak punya forum topics. |

### 3.3 Arsitektur WhatsApp-Web detail

**Adapter:** `WhatsAppWebAdapter` menggunakan library Baileys (`@whiskeysockets/baileys`).

**Inbound:**
```
Baileys sock.ev.on('messages.upsert')
  → skip self messages
  → resolve LID → PN (kalau mapping available)
  → extract text, media
  → deteksi chatType (group/private)
  → deteksi isReplyToBot: contextInfo.stanzaId ∈ sentMessageIds
  → deteksi isMentioned: bot digits di text OR mentionedJid berisi bot JID
  → onMessage({ platformUserId, platformChatId, content, isMentioned, isReplyToBot, ... })
```

**Outbound:**
```
adapter.sendMessage(channelId, cfg, params)
  → jika attachments: kirim media (image/document/audio/video)
  → kirim text: sock.sendMessage(chatId, { text: content })
    - formatting native WA (*bold*, _italic_, ~strike~, `code`)
    - reply: { quoted: { key: { id: replyToMessageId } } }
```

**Access control gate (`whatsappAccessGate`):**
```
if (DM):
  if (userId ∈ allowlist OR userId === owner) → allow
  else → drop + kirim "Maaf, Anda belum terdaftar..."
if (group):
  if (userId ∈ allowlist OR allowAllInGroups):
    if (isReplyToBot OR isMentioned OR allowAllInGroups) → allow
    else → drop (group-no-reply)
  else → drop (group-unregistered)
```

**Env vars:**
```
OWNER_WHATSAPP_USER_ID=62<nomor>           # owner WA number (digits only)
GEZY_WHATSAPP_ALLOWED_USERS=62<nomor1>,62<nomor2>,<LID>  # comma-separated
GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=false     # false = hanya mention/reply; true = semua
```

**Penting nomor WA:**
- Pakai format digit mentah: `6281234567890` (country code tanpa `+`/spasi/dash)
- JID `6281234567890@s.whatsapp.net` juga match
- LID `12345678901234@lid` → tambahkan digit ke allowlist

### 3.4 Bot configuration

Bot WA adalah **linked device** (bukan akun API Business). Bot number: `6282361201550`. JID bot: `6282361201550:11@s.whatsapp.net` (suffix `:11` = device ID).

---

## 4. Dokumen PDF

### 4.1 Yang sudah berjalan (WORK)

| Fitur | Status | Keterangan |
|---|---|---|
| Markdown → PDF | ✅ | `generate_pdf` tool (commit `95ba3553`) |
| LaTeX inline math (`$...$`) | ✅ | KaTeX `output:'mathml'` → Chromium native MathML rendering di `page.pdf()` |
| LaTeX block math (`$$...$$`) | ✅ | Display mode, centered |
| LaTeX ` ```math ``` fence | ✅ | Remap ke block equation |
| Inline SVG | ✅ | Chromium render inline `<svg>` natively (HTML passthrough) |
| GFM tables | ✅ | Zebra striping, header bold |
| Code blocks | ✅ | Dark theme, monospace |
| Headings | ✅ | Slugged IDs |
| Page format (A4/Letter) | ✅ | Configurable |
| Landscape orientation | ✅ | Configurable |
| Shareable URL | ✅ | Save ke file-storage → `/s/<token>` URL |
| Offline (no CDN) | ✅ | Pure MathML, no KaTeX CSS/fonts needed |

### 4.2 Yang tidak/didak support

| Fitur | Status | Keterangan |
|---|---|---|
| TikZ (`\begin{tikzpicture}`) | ❌ | KaTeX tidak support TikZ. Butuh TeX engine (xelatex/pdflatex) — tidak ada di container. Alternatif: SVG atau `generate_image`. |
| KaTeX HTML+CSS mode | ❌ | Dipilih MathML mode — Chromium render native, gak butuh font/CSS. Trade-off: font matematika pakai font sistem (bukan KaTeX font). |
| `remark-rehype` / `rehype-katex` stack | ❌ | Bun gak resolve subpath export `unist-util-visit-parents/do-not-use-color` → throw di import time. Solusi: manual MDAST walker + `katex` package langsung. |

### 4.3 Arsitektur PDF

**Pipeline:**
```
markdown → unified (remark-parse + remark-gfm + remark-math) → MDAST
  → manual walker → HTML (heading/list/table/code/blockquote/inline)
  → math nodes: katex.renderToString(latex, { output: 'mathml' })
  → buildPdfHtml(md, title): wrap HTML + print CSS
  → playwrightManager.renderPdf(html, opts): Chromium page.setContent + page.pdf()
  → buffer → save ke file-storage → share URL
```

**File:** `src/server/services/document-render.ts`

**Tool:** `generate_pdf` (`src/server/tools/document-tools.ts`)
- Availability: main only
- Gate: `playwrightManager.isEnabled` (butuh Chromium aktif)
- Input: `content` (markdown), `title?`, `filename?`, `format?` (A4/Letter), `landscape?`
- Output: shareable URL

**Dependency:** Playwright + Chromium (headless). Env: `WEB_BROWSING_HEADLESS_ENABLED=true` + Chromium terinstall di container.

### 4.4 Print CSS

```css
@page { size: A4; margin: 2cm; }
body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
math { font-size: 1.05em; }
math[display="block"] { display: block; text-align: center; margin: 0.9em 0; }
.math-block { display: block; text-align: center; margin: 0.9em 0; }
/* code blocks: dark theme background */
/* tables: zebra striping */
```

---

## 5. Dokumen DOCX

### 5.1 Yang sudah berjalan (WORK)

| Fitur | Status | Keterangan |
|---|---|---|
| Markdown → DOCX | ✅ | `generate_docx` tool (commit `3614bc7f`) |
| LaTeX equation sebagai OMML | ✅ (commit `12337317` + fix `e7e0191e`) | Native Word equation object (editable di Word). Pipeline: KaTeX mathml → mml2omml → custom parser → ImportedXmlComponent |
| LaTeX inline math (`$...$`) | ✅ | OMML inline (tidak dibungkus `m:oMathPara`) |
| LaTeX block math (`$$...$$`) | ✅ | OMML display wrapped in `<m:oMathPara>` (centered di Word) |
| LaTeX ` ```math ``` fence | ✅ | Block equation OMML |
| Inline SVG | ✅ | Rasterized PNG via Playwright `screenshotHtmlElements` → `ImageRun` (fallback ke text jika Playwright disabled) |
| GFM tables | ✅ | Native Word table (`docx.Table`) |
| Headings | ✅ | Word HeadingLevel 1-6 |
| Lists | ✅ | Textual markers (• / 1.) — Word numbering v1 (editable) |
| Code blocks | ✅ | Consolas font + shading |
| Blockquotes | ✅ | Indent + italic |
| Inline formatting | ✅ | Bold, italic, strikethrough, code |
| Links | ✅ | ExternalHyperlink |
| Shareable URL | ✅ | Save ke file-storage → share URL |
| Tidak butuh Chromium untuk equation | ✅ | OMML = pure XML conversion (gak butuh Playwright). Chromium hanya butuh untuk SVG. |
| Custom OMML parser (fix `<undefined>`) | ✅ (commit `e7e0191e`) | `ImportedXmlComponent.fromXmlString()` pakai xml-js/sax yang gagal ekstrak namespace-prefixed names di Bun. Replace dengan custom parser `parseOmml()`. |

### 5.2 Yang tidak/tidak support

| Fitur | Status | Keterangan |
|---|---|---|
| TikZ | ❌ | Sama seperti PDF — butuh TeX engine. Alternatif: SVG. |
| Word numbering native | ❌ | Lists pakai textual markers (• / 1.). Word native numbering config lebih kompleks. v1 markers sudah readable + editable. |
| Equation grading | ❌ | OMML equation objects dibuat dari LaTeX. Tidak ada flag untuk "graded" atau "practice" mode. |

### 5.3 Arsitektur DOCX

**Pipeline:**
```
markdown → unified (remark-parse + remark-gfm + remark-math) → MDAST
  → single-pass async walk (renderBlock / renderInlineList)
    → math nodes: LaTeX → KaTeX(output:'mathml') → strip <annotation>
      → mml2omml(mathml) → OMML XML string
      → display? wrap in <m:oMathPara> : inline
      → parseOmml(omml) → ImportedXmlComponent tree (custom parser)
      → insert ke Paragraph children (cast as TextRun)
    → SVG html nodes: screenshotHtmlElements → ImageRun PNG
    → other nodes: native docx (Paragraph, TextRun, Table, Heading, CodeBlock, ...)
  → Packer.toBuffer(doc) → .docx buffer
  → save ke file-storage → share URL
```

**File:** `src/server/services/document-render-docx.ts`

**Tool:** `generate_docx` (`src/server/tools/document-tools.ts`)
- Availability: main
- Gate: TIDAK ada `playwrightManager.isEnabled` (OMML gak butuh Chromium; SVG optional)
- Input: `content` (markdown), `title?`, `filename?`
- Output: shareable URL

**Dependencies:**
- `docx@9.7.1` — DOCX builder package
- `katex@^0.17.0` — LaTeX → MathML
- `mathml2omml@0.5.0` — MathML → OMML
- Playwright (optional, hanya untuk SVG rasterization)

### 5.4 Bug history — `<undefined>` wrapper

**Root cause:** `ImportedXmlComponent.fromXmlString()` dari package `docx` pakai `xml-js`/`sax` parser yang gagal ekstrak nama element namespace-prefixed (e.g. `m:oMath`) di runtime Bun — return `rootKey: "undefined"`, yang menghasilkan tag `<undefined>` wrapper di sekitar setiap equation di `document.xml`. Word gak bisa parse tag `<undefined>`, jadi equation tidak muncul.

**Fix** (`e7e0191e`): Replace `fromXmlString()` dengan custom parser `parseOmml()` yang benar handle:
- Element names dengan namespace prefix (`m:oMath`, `m:f`, `m:num`, `m:den`, dll)
- Attributes (`xmlns:m="..."`)
- Text content
- Nested elements
- Self-closing tags

**Regression test:** `document-render-docx.test.ts` — test "does NOT produce `<undefined>` wrapper tags".

### 5.5 Perbandingan: OMML vs PNG approach

| Aspek | OMML (sekarang) | PNG (sebelumnya, commit `3614bc7f`) |
|---|---|---|
| Equation editable di Word | ✅ Ya — native equation object | ❌ Tidak — gambar |
| Butuh Chromium | ❌ Tidak | ✅ Ya (screenshot per equation) |
| File size | ~8-15 KB | ~100-103 KB |
| Speed | Cepat (XML conversion) | Lambat (Chromium screenshot) |
| Display alignment | `m:oMathPara` (centered) | Manual alignment |
| Fallback kalau gagal | `[equation]` text | `[equation]` text |

---

## 6. Markdown di Chat (Rich Messages)

### 6.1 Telegram Rich Messages

**File:** `src/server/channels/telegram-rich.ts`

Telegram mendukung rich messages via custom API `sendRichMessage` (HTML subset):

**Yang di-support (→ HTML Telegram):**
| Markdown | HTML Telegram | Keterangan |
|---|---|---|
| `**bold**` | `<b>bold</b>` | |
| `*italic*` / `_italic_` | `<i>italic</i>` | |
| `~~strike~~` | `<s>strike</s>` | |
| `` `code` `` | `<code>code</code>` | |
| ` ```code block``` ` | `<pre>code block</pre>` | Dengan language class |
| `[link](url)` | `<a href="url">link</a>` | |
| `- item` / `1. item` | `<ul>...<li>` / `<ol>...<li>` | |
| `> blockquote` | `<blockquote>` | |
| `| table |` | `<table>` dengan `<th>`/`<td>` | |
| `---` (hr) | `<hr>` | |

**Yang tidak di-support (stripped to text):**
- `<img>` (gambar tidak inline di rich message, kirim via `attach_file`)
- Raw HTML di markdown
- Math blocks (`$$...$$`) → di-strip ke text (Telegram tidak support MathML)
- Inline math (`$...$`) → jadi text biasa

**Pagination:** Konten yang melebihi batas blok Telegram di-split ke multiple pages (rich messages). Setiap page dikirim sebagai message terpisah.

**Expandable:** Konten yang sangat panjang bisa dibungkus `<tg-expandable>` (collapsed by default).

### 6.2 WhatsApp Markdown

WhatsApp hanya support formatting native (bukan HTML):
| Markdown | WA Native | Keterangan |
|---|---|---|
| `*bold*` | `*bold*` | Bold |
| `_italic_` | `_italic_` | Italic |
| `~strike~` | `~strike~` | Strikethrough |
| `` `code` `` | `` `code` `` | Code |
| Math/LaTeX | ❌ | Tidak support — text biasa |
| Tables | ❌ | Tidak support — text biasa |
| Code blocks | ❌ | Tidak support — text biasa |

---

## 7. Tool terkait Dokumen & File

### 7.1 `generate_pdf`

| Field | Value |
|---|---|
| Registered name | `generate_pdf` |
| Availability | `main` (main agents only) |
| Toolbox group | `documents` |
| Gate | `playwrightManager.isEnabled` (butuh Chromium) |
| Input | `content` (markdown, required), `title?`, `filename?`, `format?` (A4/Letter), `landscape?` |
| Output | `{ url, fileId }` — shareable file-storage URL |
| Pipeline | Markdown+LaTeX → KaTeX MathML → Chromium page.pdf() → buffer → file-storage |

### 7.2 `generate_docx`

| Field | Value |
|---|---|
| Registered name | `generate_docx` |
| Availability | `main` (main agents only) |
| Toolbox group | `documents` |
| Gate | Tidak ada (OMML gak butuh Chromium; SVG optional butuh Chromium) |
| Input | `content` (markdown, required), `title?`, `filename?` |
| Output | `{ url, fileId }` — shareable file-storage URL |
| Pipeline | Markdown+LaTeX → KaTeX mathml → mml2omml → OMML → docx → buffer → file-storage |

### 7.3 `attach_file`

| Field | Source | Output |
|---|---|---|
| Registered name | `attach_file` |
| Availability | `main` |
| Input | `source` (file path/URL), `mimeType?`, `fileName?` |
| Source types | `/s/<token>` ✅ (commit `4ed9f396`), `/api/uploads/...` ✅, `/api/file-storage/...` ✅, `https://...` ✅, workspace path ✅ |
| `/s/<token>` | Query `file_storage` by `accessToken` → `storedPath` → local file. Auto-fill mimeType/fileName dari DB. Check expiry + disk existence. |
| Output | File staged → dikirim setelah text reply (via `deliverChannelAttachments`) |
| RC-1 fix | Attachment kirim SETELAH streaming-draft commit (sebelumnya di-drop). Commit `d1ea1161`. |

### 7.4 `store_file`

| Field | Value |
|---|---|
| Registered name | `store_file` |
| Input | `source` (content/workspace/URL), `mimeType?`, `fileName?` |
| Output | `{ url, fileId }` — shareable `/s/<token>` URL |
| Catatan | URL ini untuk WEB, bukan untuk Telegram. Untuk kirim file ke Telegram, pakai `attach_file`. (RC-2b prompt update) |

---

## 8. Env & Konfigurasi VPS

### 8.1 Telegram

```env
# TelePost API
TELEGRAM_BOT_TOKEN=<token>                # disimpan di Vault (channel config)

# Access control
OWNER_TELEGRAM_USER_ID=<user_id>          # owner Telegram user ID
TELEGRAM_ALLOWED_USERS=username1,username2,user_id  # allowlist (username atau user_id)
ALLOW_ALL_USERS_IN_GROUPS=false            # false = hanya mention/reply di grup; true = semua

# Webhook
PUBLIC_URL=https://aios.gezytech.web.id   # base URL untuk webhook + share links
```

### 8.2 WhatsApp-Web

```env
# Access control
OWNER_WHATSAPP_USER_ID=6285156266044      # owner WA number (digits only)
GEZY_WHATSAPP_ALLOWED_USERS=6285156266044,6289527852099,37456745394304  # allowlist (digits/LID)
GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=false   # false = hanya mention/reply di grup
```

### 8.3 Browser/Playwright (untuk PDF)

```env
WEB_BROWSING_HEADLESS_ENABLED=true        # enable headless Chromium
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright   # path ke Chromium binary
```

### 8.4 General

```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
GEZY_DATA_DIR=/app/data
ENCRYPTION_KEY=<key>                      # Vault encryption key (required)
PUBLIC_URL=https://aios.gezytech.web.id   # base URL untuk webhook + share links
TRUSTED_ORIGINS=https://aios.gezytech.web.id
GEZY_TIMEZONE=Asia/Jakarta
```

### 8.5 Docker compose VPS

```yaml
services:
  gezy:
    image: ghcr.io/gunanto/gezybot:latest
    ports:
      - "4178:3000"
    volumes:
      - gezy-data:/app/data
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      - NODE_ENV=production
      - GEZY_DATA_DIR=/app/data
      - ENCRYPTION_KEY=${ENCRYPTION_KEY:?required}
      - PUBLIC_URL=https://aios.gezytech.web.id
      - TRUSTED_ORIGINS=https://aios.gezytech.web.id
      - GEZY_TIMEZONE=Asia/Jakarta
      - OWNER_WHATSAPP_USER_ID=6285156266044
      - GEZY_WHATSAPP_ALLOWED_USERS=6285156266044,6289527852099,37456745394304
      - GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=false
```

### 8.6 Deploy workflow

```bash
# Pull image terbaru (tunggu GitHub Actions hijau)
docker compose pull

# Recreate container
docker compose up -d --force-recreate gezy

# Hapus image lama
docker image prune -f

# Cek log
docker logs --since 5m gezy | tail -30
```

---

## 9. Rangkuman: yang sudah work vs perlu pengembangan

### 9.1 Yang sudah WORK (di-push ke main, perlu deploy ke VPS)

| Fitur | Commit | Tested VPS? | Keterangan |
|---|---|---|---|
| **PDF** dengan LaTeX (KaTeX MathML) | `95ba3553` | ✅ | Equation render sebagai MathML di Chromium |
| **DOCX** dengan LaTeX OMML (editable) | `12337317` + `e7e0191e` | ⏳ | Equation jadi native Word equation object. Fix `<undefined>` bug. |
| **SVG** di DOCX | `12337317` | ⏳ | Inline SVG → PNG via Playwright |
| **Telegram** streaming draft | sebelumnya | ✅ | Ephemeral bubble → persistent message |
| **Telegram** file attachment (RC-1) | `d1ea1161` | ✅ | Attachment kirim setelah streaming commit |
| **Telegram** access gate | sebelumnya | ✅ | Allowlist + mention/reply |
| **Telegram** forum topics | `63754010` | ⏳ | Bot reply di topic yang benar (message_thread_id) |
| **Telegram** rich messages (HTML) | sebelumnya | ✅ | Markdown → Telegram HTML subset |
| **WhatsApp** access gate | `89d3e29e` | ✅ | Allowlist + mention + reply |
| **WhatsApp** DM processing | `89d3e29e` | ✅ | DM dari authorized users |
| **WhatsApp** group mention (text-based) | `44f22d15` | ✅ | `@6282361201550` di-respon |
| **WhatsApp** reply-to-bot | `2b6ed1d8` | ⏳ | sent-message-ID tracking (belum di-test VPS) |
| **WhatsApp** LID workaround | sebelumnya | ✅ | Tambah LID digit ke allowlist |
| **attach_file** `/s/<token>` | `4ed9f396` | ⏳ | Resolve share URL ke local file |
| **Prompt** update (RC-2b) | `12337317` | ⏳ | Inform format capabilities + don't self-diagnose |

### 9.2 Yang perlu pengembangan

#### Prioritas tinggi

| Issue | Keterangan | Estimasi |
|---|---|---|
| Test WA reply E2E di VPS | Deploy terbaru → bot kirim di grup → user reply → cek `isReplyToBot:true` | 0.1 hari |
| Test DOCX OMML di VPS | Minta Agent buat DOCX dengan `$\frac{a}{b}$` → buka di Word → equation editable | 0.1 hari |
| Test Telegram forum topics di VPS | Reply/mention bot di topik A → bot balas di topik A | 0.1 hari |
| Hapus diagnostic logs | Setelah WA reply confirmed: hapus `log.info("WhatsApp access gate decision")`, `log.warn("LID not found")`, `log.debug("Group message: no mention...")` dari `channels.ts` + `whatsapp-web.ts` | 0.1 hari |

#### Prioritas sedang

| Issue | Keterangan | Estimasi |
|---|---|---|
| LID mapping fix permanen | `lid-mapping.update` tidak pernah fire di Baileys v7-rc13. Butuh: upgrade Baileys, atau event alternatif, atau auto-fetch LID mapping via `contacts` API. | 0.5-1 hari |
| Telegram 404 `/webhook/telegram` | Webhook URL salah di salah satu channel. Cek: `docker exec gezy grep webhook` atau set webhook ulang. | 0.25 hari |
| WA mention by contact name (`@Me-PaGun`) | Text detection cuma match digit. Butuh: akses phone book contact → match nama → dapat nomor → match. Atau pakai `mentionedJid` (tapi LID vs PN issue). | 0.5 hari |
| DOCX Word numbering native | Lists pakai textual markers (•). Upgrade ke native numbering config di `docx` package. | 0.5 hari |

#### Prioritas rendah / nice-to-have

| Issue | Keterangan | Estimasi |
|---|---|---|
| TikZ support | Butuh TeX engine (xelatex) di container — ~1GB install. Alternatif: SVG. | 1-2 hari |
| Math matematika di Telegram chat | Telegram tidak support MathML. Alternatif: render equation sebagai image (generate_image) lalu attach. | 0.5 hari |
| WA streaming draft | WA tidak support ephemeral bubble. Alternatif: "typing..." indicator + one-shot reply. | 0.5 hari |
| DOCX equation grading/mode | Tambah flag untuk "practice" mode (equation hidden, show only answer). | 0.25 hari |

### 9.3 Catatan teknis penting

1. **`write_file` di `.ts` yang sudah ada** trigger format-on-save (single→double quote + semicolon di seluruh file). Gunakan temp file (new file) + `cp` via terminal, atau byte-safe script (`bun run patch.ts`).
2. **`ImportedXmlComponent.fromXmlString()`** dari `docx` package BUG di Bun — pakai `xml-js`/`sax` yang gak ekstrak namespace prefix. Fix: custom parser `parseOmml()`.
3. **KaTeX `output:'mathml'`** menghasilkan `<span><math>...<annotation>...</annotation></math></span>`. Strip `<annotation>` sebelum `mml2omml` (complain "Type not supported: annotation").
4. **`mml2omml()`** export: `import { mml2omml } from 'mathml2omml'` (bukan `mathml2omml`). Function, bukan class.
5. **Pre-commit hook** running typecheck + ~4000 tests (~20s). Commit dengan `git commit -F .commitmsg.tmp` (backtick/`$` di pesan break shell `-m`).
6. **GitHub Actions** build image Docker → push ke `ghcr.io/gunanto/gezybot:latest`. Setelah push ke `main`, tunggu Actions hijau, lalu `docker compose pull && docker compose up -d --force-recreate`.
7. **Baileys v7-rc13** — `lid-mapping.update` event TIDAK pernah fire. Workaround: LID digit di allowlist env.
8. **Bot WA JID** punya `:device` suffix: `6282361201550:11@s.whatsapp.net`. Strip dengan `jidNormalizedUser()` sebelum extract digit (kalau tidak: `628236120155011` — extra "11").
9. **`remark-rehype` + `rehype-katex`** throw di Bun (subpath export issue). Pakai: manual MDAST walker + `katex` package langsung.
10. **WhatsApp formatting** native: `*bold*`, `_italic_`, `~strike~`, `` `code` `` — bukan HTML markdown.
11. **Telegram rich messages** pakai custom API `sendRichMessage` / `sendRichMessageDraft` (TelePost/TeleConversation extension).

---

## 10. Git commits — chronology

| Commit | Date | Description |
|---|---|---|
| `95ba3553` | 30 Jun | feat: generate_pdf (markdown + LaTeX → PDF via Playwright, KaTeX MathML) |
| `3614bc7f` | 30 Jun | feat: generate_docx (PNG approach — equation sebagai image) |
| `d1ea1161` | 30 Jun | fix: RC-1 — kirim attachment setelah streaming-draft commit (Telegram) |
| `89d3e29e` | 30 Jun | feat: WhatsApp-Web access control (allowlist + mention/reply gate) |
| `52f672e3` | 30 Jun | chore: env produksi (PUBLIC_URL + Telegram + WA env) |
| `44f22d15` | 30 Jun | feat: WA grup mention OR reply (text-based mention detection) |
| `b8e07b27` | 30 Jun | fix: WA mention — strip :device dari botJid |
| `2b6ed1d8` | 30 Jun | fix: WA reply-to-bot via sent-message-ID tracking |
| `a8d9ca4b` | 30 Jun | fix: DOCX CSS.escape crash |
| `12337317` | 1 Jul | feat: DOCX equations as native OMML + SVG + prompt update |
| `e7e0191e` | 1 Jul | fix: DOCX <undefined> bug — custom OMML parser |
| `63754010` | 1 Jul | feat: Telegram forum topics — bot replies in correct topic |
| `4ed9f396` | 1 Jul | feat: attach_file recognizes /s/<token> share URLs |
| `ed19bd0c` | 1 Jul | docs: update ToDo status — 1 Juli execution complete |