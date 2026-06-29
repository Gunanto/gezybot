# Bot API 10.1 — Analisis Implementasi di Gezy

> Tanggal: 2026-06-29 · Sumber: <https://core.telegram.org/bots/api-changelog#june-11-2026>
> Status: **analisis saja — belum ada kode diubah**.

Bot API 10.1 (11 Jun 2026) membawa 3 kelompok fitur baru. Dokumen ini menilai
tiap kelompok dari sudut Gezy: nilai, effort, titik tempel, dan keputusan
desain yang perlu kamu ambil sebelum coding.

---

## TL;DR

| Fitur | Nilai untuk Gezy | Effort | Rekomendasi |
|---|---|---|---|
| **Rich Messages** (`sendRichMessage`) | **Tinggi** — render heading/tabel/list/code/blockquote dari output LLM (markdown) dengan rapi di Telegram, bukan plain text. | Sedang | **Fase 1 — kerjakan** |
| **Streaming draft** (`sendRichMessageDraft`) | **Tinggi untuk UX** — user lihat balasan Agent muncul real-time di Telegram (seperti ChatGPT), bukan muncul sekaligus di akhir. | **Besar** — butuh pipeline streaming baru lintas arsitektur | **Fase 2 — terpisah**, setelah Fase 1 stabil |
| **Guard Bots** (join-request queries) | **Rendah** — Gezy bukan bot moderasi grup. | Kecil | **Skip** (kecuali ada use-case spesifik) |
| **Poll link media** | Rendah — Gezy tidak pakai poll tool. | Kecil | **Skip** |

---

## 1. Konteks: keadaan Gezy sekarang

### 1.1 Adapter contract (SDK)
`ChannelAdapter.sendMessage(channelId, config, params: OutboundMessageParams)` —
menerima **satu string `content` utuh** + attachments. Tidak ada method streaming.
`OutboundMessageParams` (`packages/sdk/src/index.ts:361`):
```ts
{ chatId, content, replyToMessageId?, attachments?, locale? }
```
Kontrak ini **sama untuk semua channel** (Telegram, Discord, Slack, Matrix,
WhatsApp, Signal). Perubahan di sini berdampak ke semua adapter.

### 1.2 Delivery flow (server)
`agent-engine.ts:1930-1937` → `deliverChannelResponse(channelMeta, msgId, fullContent, attachments)`.
Pengiriman ke channel **one-shot setelah LLM selesai** — `fullContent` sudah
lengkap. Tidak ada per-chunk streaming ke channel. Streaming hanya ke UI via SSE.

### 1.3 Telegram adapter (`src/server/channels/telegram.ts`)
- `sendMessage` (`:332`) → `splitMessage(content)` (split di 4096 char) →
  `POST /sendMessage` per chunk.
- `sendTypingIndicator` (`:311`) → `sendChatAction` 'typing' (hanya indikator,
  bukan konten).
- Markdown dari LLM **dikirim sebagai plain text** — Telegram tidak render
  heading/tabel/blok kutipan di `sendMessage` biasa (hanya `**bold**`, `_italic_`,
  `` `code` `` inline via `parse_mode=MarkdownV2/HTML`). Tabel & heading tidak
  didukung sama sekali.

### 1.4 Output LLM
Assistant message `content` adalah **markdown** (CommonMark + GFM: heading `#`,
tabel `| | |`, list `-`/`1.`, code fence ` ``` `, blockquote `>`, dll.). Inilah
yang perlu dikonversi ke `InputRichMessage` (HTML atau Markdown API 10.1).

---

## 2. Fase 1 — Rich Messages (`sendRichMessage`)

### 2.1 Apa yang didapat
- Heading 1–6, paragraf, divider, footer.
- List ordered/unordered + task list (checkbox) — dengan custom numerals.
- Tabel (border, stripe, header cell, align, colspan/rowspan).
- Block quote & pull quote + credit.
- Collapsible `<details>` — sangat berguna untuk output panjang (hide
  reasoning/log di balik ringkasan).
- Preformatted code block dengan language.
- Inline: bold/italic/underline/strikethrough/spoiler/code/sub/sup/marked,
  link, mention, email, phone, hashtag, custom emoji.
- Math LaTeX (inline + multi-line) — jika Agent pakai rumus.
- Anchor + in-document link (TOC untuk dokumen panjang).
- Media block: photo/video/audio/animation/voice note dengan caption+credit,
  collage, slideshow, map.

### 2.2 Dua jalur input — pilih satu

API 10.1 `InputRichMessage` menerima **salah satu** dari:
- `html: string` — markup HTML gaya Telegram (subset tag).
- `markdown: string` — Markdown gaya Telegram (subset syntax).

**Catatan penting:** `InputRichMessage` TIDAK menerima `blocks: RichBlock[]`
secara langsung. Yang diterima adalah **string** html/markdown, lalu Telegram
server yang parse menjadi `RichBlock[]`. Jadi kita TIDAK perlu membangun
konverter markdown→RichBlock JSON sendiri — kita cukup emit string html/markdown.

Tag HTML yang didukung (dari changelog + demo bot):
`<h1>..<h6>`, `<p>`, `<hr>`, `<ul>/<ol>/<li>`, `<blockquote>` (block),
`<blockquote expandable>`, `<pre><code class="lang-x">`, `<b>/<i>/<u>/<s>`,
`<spoiler>`, `<sub>/<sup>`, `<mark>`, `<code>`, `<a href>`, `<tg-mention
user="id">`, `<tg-anchor>`, `<tg-anchor-link anchor="name">`, tabel
`<table><tr><th><td align valign colspan rowspan>`, `<caption>`,
`<tg-thinking>…</tg-thinking>` (draft only), dll.

**Rekomendasi: emit HTML string.** Alasan:
- Markdown Telegram punya escaping yang menyebalkan (`_` `*` `[` `]` `(` `)`
  `~` `` ` `` `>` `#` `+` `-` `=` `|` `{` `}` `.` `!` semua harus di-escape
  dengan `\` di MarkdownV2, dan rich-markdown subset-nya berbeda lagi).
- HTML lebih predictable & tidak ambigu (CommonMark→HTML converter sudah mature).
- Banyak library CommonMark→HTML (markdown-it, marked) — tinggal pakai + sanitasi
  ke subset yang didukung Telegram.

### 2.3 Pipeline yang diusulkan

```
LLM output (markdown)
  │
  ├─ UI (SSE)  ── tetap apa adanya (UI render markdown sendiri)
  │
  └─ Channel delivery ── baru untuk Telegram:
        │
        ├─ markdown → HTML (markdown-it atau marked, di-sanitize ke subset TG)
        │   - drop tag yang TG tidak dukung (mis. <img> jadi caption block)
        │   - tabel GFM → <table>
        │   - <details> → <blockquote expandable> (TG tidak ada <details>,
        │     hanya expandable blockquote)
        │
        ├─ POST /bot<token>/sendRichMessage
        │     { chat_id, rich_message: { html: "<...>" }, reply_parameters? }
        │
        └─ fallback: kalau TG return error (mis. payload too large / tag tidak
           dikenal) → fallback ke sendMessage lama (plain text + MarkdownV2).
```

### 2.4 Titik tempel kode (Fase 1)

| File | Perubahan |
|---|---|
| `src/server/channels/telegram.ts` `sendMessage` (`:332`) | Tambah cabang: jika `content` berbau markdown (ada `#`/`|`/`> `-`/``` ``` `), konversi → HTML → `sendRichMessage`. Kalau plain/pendek, tetap `sendMessage` lama. Tambah method `sendRichMessage(token, chatId, html, opts)`. |
| **Baru** `src/server/channels/telegram-rich.ts` | `markdownToTelegramHtml(md: string): string` — pakai markdown-it + sanitizer. Pure function, unit-testable. |
| **Baru** `src/server/channels/telegram-rich.test.ts` | Test konversi: heading, tabel, list, code block, blockquote, bold/italic, link, nested, edge case (empty, >10000 char, tag tidak didukung). |
| `packages/sdk/src/index.ts` `OutboundMessageParams` (`:361`) | **Tidak diubah** di Fase 1 — `content` tetap string markdown; adapter Telegram yang konversi. Ini menjaga kontrak platform-agnostic. |
| `src/server/services/channels.ts` `deliverChannelResponse` | Tidak diubah — tetap kirim `content` ke adapter. |

### 2.5 Keputusan desain Fase 1 (perlu jawaban kamu)

**D1 — Auto-detect vs opt-in.** Kapan pakai rich vs plain?
- (a) **Auto**: kirim rich kalau `content` mengandung elemen markdown blok
  (heading/tabel/list/code fence/blockquote). Kalau hanya paragraf+inline,
  tetap `sendMessage` (lebih ringan, tidak ada overhead parse). **Recommended.**
- (b) **Selalu rich** untuk semua pesan Telegram.
- (c) **Opt-in per channel** via `platformConfig.useRichMessages: boolean`.

**D2 — Library markdown.**
- (a) `markdown-it` (+ plugin `markdown-it-gfm` untuk tabel/task list) — mature,
  pluginable, output HTML bersih. **Recommended.**
- (b) `marked` — lebih cepat, lebih sedikit dependensi, tapi config tabel
  perlu `marked-gfm-heading-id`/ekstensi.
- (c) Tulis parser sendiri — **tidak rekomendasi** (rawan bug, effort besar).

**D3 — Sanitizer.** Subset HTML Telegram terbatas. Tag/attr di luar subset
harus di-strip atau dibungkus text. Pakai `sanitize-html` dengan config
kustom, atau post-process DOM dari markdown-it sebelum serialize. **Pakai
config allowlist** (bukan blocklist) demi keamanan.

**D4 — Fallback strategy.** Jika `sendRichMessage` error 400 (bad request):
- (a) **Auto-fallback** ke `sendMessage` + `parse_mode=MarkdownV2` (escape
  khusus TG). Log warning. **Recommended.**
- (b) Lempar error ke UI (pesan gagal kirim).

**D5 — Ukuran payload.** `sendRichMessage` punya batas (belum terdokumentasi
resmi, tapi 4096 char untuk text lama). `splitMessage` (`:22`) perlu adaptasi:
split di batas blok markdown, bukan di tengah tabel/heading. **Pakai split
per top-level block** — kirim 1 `sendRichMessage` per "page".

**D6 — Attachments.** Foto/video dari Agent saat ini dikirim via
`sendPhoto`/`sendDocument` (`:338` `sendTelegramFile`) dengan caption text.
Fase 1: biarkan caption tetap plain text (`sendMessage` lama untuk caption).
Fase lanjutan: caption bisa jadi `RichBlockCaption` di rich message (tapi
perlu rework attachment flow — media block di rich message pakai `PhotoSize[]`
yang sudah ada di server, berbeda dari upload multipart sekarang). **Defer
ke Fase 1b.**

### 2.6 Estimasi effort Fase 1
- Konverter markdown→HTML subset TG + sanitizer: **1–2 hari**.
- Integrasi `sendRichMessage` di adapter + fallback + split: **0.5–1 hari**.
- Unit test konverter (20+ kasus): **0.5 hari**.
- Test end-to-end dengan Agent nyata: **0.5 hari**.
- Docs + catatan: **0.25 hari**.
- **Total: 2.5–4 hari.**

---

## 3. Fase 2 — Streaming draft (`sendRichMessageDraft`)

### 3.1 Apa yang didapat
Saat Agent LLM stream token, user Telegram melihat balasan **muncul
incrementally** (animasi type-on, sama seperti ChatGPT di web) — bukan
muncul sekaligus setelah LLM selesai (yang sekarang bisa makan 10–60 detik
untuk jawaban panjang). Draft bersifat ephemeral (30 detik), lalu di-commit
dengan `sendRichMessage` untuk persist.

### 3.2 Kenapa ini Fase terpisah (effort besar)
Arsitektur Gezy sekarang **tidak mengirim chunk ke channel selama stream** —
`deliverChannelResponse` dipanggil sekali di `agent-engine.ts:1935` dengan
`fullContent`. Untuk streaming ke Telegram, perlu:

1. **Hook stream delta baru** di `stream-runner.ts` / `agent-engine.ts`:
   saat text-delta masuk, forward ke channel adapter (jika queue item
   berasal dari channel).
2. **Method baru di `ChannelAdapter`** (SDK): `streamDraft?(channelId, config,
   params): Promise<{ update(chunk: string): Promise<void>; commit():
   Promise<OutboundMessageResult>; abort(): Promise<void> }>` — optional,
   adapter tanpa method ini tetap pakai one-shot.
3. **State per stream** di adapter Telegram: simpan `draft_id`, throttle
   update (TG batasi rate draft update — perkiraan 1 update/300ms), buffer
   chunk, debound, lalu `sendRichMessageDraft` dengan HTML parsial.
4. **Commit/abort**: saat stream selesai → `sendRichMessage` final + hapus
   draft. Saat stream abort/error → hapus draft (draft hilang sendiri 30s,
   tapi lebih baik eksplisit).
5. **Throttling & backpressure**: TG membatasi rate API. Stream LLM bisa
   50+ token/detik → tidak boleh tiap token jadi 1 API call. Buffer +
   flush tiap ~500ms atau ~200 char.
6. **Thinking block** (`<tg-thinking>`): saat Agent reasoning (thinking
   delta), bisa tampilkan sebagai block "thinking…" yang collapsible —
   tapi hanya di draft, di commit jadi hidden atau di-skip.

### 3.3 Titik tempel kode (Fase 2)

| File | Perubahan |
|---|---|
| `packages/sdk/src/index.ts` | Tambah optional `streamDraft?` di `ChannelAdapter` + tipe `ChannelDraftStream`. |
| `src/server/services/stream-runner.ts` | Saat text-delta + queue item dari channel → forward ke `adapter.streamDraft().update(chunk)`. |
| `src/server/services/agent-engine.ts:1930` | Ganti `deliverChannelResponse` one-shot dengan: jika adapter dukung `streamDraft`, buka stream di awal turn; commit di akhir. |
| `src/server/channels/telegram.ts` | Implement `streamDraft`: manage `draft_id`, throttle, `sendRichMessageDraft`, commit via `sendRichMessage`. |
| `src/server/services/channels.ts` `deliverChannelResponse` | Refactor jadi 2 mode: streaming-aware vs one-shot fallback. |
| Semua adapter lain (discord/slack/matrix/whatsapp/signal) | Tidak diubah — `streamDraft?` optional, mereka tetap one-shot. |

### 3.4 Keputusan desain Fase 2

**D7 — Throttle policy.** Interval flush draft update:
- (a) **Waktu**: flush tiap 400ms. Sederhana, prediktabel. **Recommended.**
- (b) **Ukuran**: flush tiap 256 char. Bisa burst kalau token besar.
- (c) **Hybrid**: flush tiap min(400ms, 512 char).

**D8 — Thinking block.** Tampilkan reasoning Agent di draft?
- (a) **Ya**, sebagai `<tg-thinking>` collapsible — user lihat Agent "berpikir".
  Bagus untuk transparansi, tapi bisa noisy.
- (b) **Tidak** — skip thinking delta, hanya stream text jawaban. **Recommended
  untuk awal** (lebih bersih); opsi (a) bisa jadi setting `platformConfig.showThinkingInDraft`.

**D9 — Error mid-stream.** Kalau LLM error setelah draft sudah tampil:
- (a) **Hapus draft** + kirim `sendMessage` pendek "⚠️ Maaf, terjadi error
  memproses balasan." **Recommended.**
- (b) Biarkan draft (akan expire 30s) + log.

**D10 — Abort (user stop).** User klik stop di UI → stream abort →
- (a) **Commit apa adanya** (kirim sebagian yang sudah ada sebagai pesan
  final) + suffix "…(dihentikan)". **Recommended.**
- (b) Hapus draft.

**D11 — Channel lain ikut?** Streaming draft hanya API Telegram. Discord/Slack
punya editing-message pattern serupa tapi beda mekanisme. Fase 2: **Telegram
only**; adapter lain tetap one-shot. Catat sebagai future work per-channel.

### 3.5 Estimasi effort Fase 2
- SDK contract + tipe baru: **0.5 hari**.
- stream-runner + agent-engine wiring: **1–1.5 hari** (hati-hati: SSE + queue
  + abort interaksi rumit — baca `sse.md` dulu).
- telegram.ts `streamDraft` impl (throttle, draft_id, commit, abort): **1 hari**.
- Test (mock stream, throttle, abort, error mid-stream): **1 hari**.
- Docs: **0.25 hari**.
- **Total: 4–5.5 hari.**

---

## 4. Fase 3 — Guard Bots & Poll media (skip)

### 4.1 Guard Bots (`answerChatJoinRequestQuery`, `sendChatJoinRequestWebApp`)
- Berguna untuk bot moderasi grup yang filter join-request (captcha, approval).
- Gezy adalah **agent AI pribadi/tim**, bukan guard bot. Use-case lemah.
- **Skip** kecuali kamu punya skenario spesifik (mis. Agent yang auto-approve
  member grup berdasarkan kontak terdaftar — ini bisa jadi mini-feature
  keren tapi very niche).

### 4.2 Poll link media
- Gezy tidak punya tool `send_poll`. Tidak relevan.
- **Skip.**

---

## 5. Pertanyaan untuk kamu (sebelum mulai)

1. **Fase 1 dulu, baru Fase 2?** Atau langsung Fase 1+2 sekalian? Saya
   rekomendasi **Fase 1 dulu** (valuable + lower risk), lalu Fase 2 setelah
   stabil 1–2 minggu.
2. **D1 auto-detect** — setuju pakai auto (rich kalau ada blok markdown, plain
   kalau tidak)?
3. **D2 library** — `markdown-it` OK? (paling mature untuk GFM tables/task lists)
4. **D4 fallback** — auto-fallback ke `sendMessage` MarkdownV2 kalau rich error?
5. **D6 attachments** — caption tetap plain di Fase 1, rich caption Fase 1b?
6. **D8 thinking block** — skip dulu di Fase 2?
7. **Apakah ada bot Telegram Gezy yang sekarang dipakai di grup dengan output
   tabel/heading panjang?** Kalau ya, Fase 1 langsung terasa manfaatnya.

Jawab pertanyaan di atas dan saya bisa lanjut ke rancangan implementasi
detail (type signatures, file skeleton) atau langsung coding Fase 1.

---

## 6. Referensi

- Changelog: <https://core.telegram.org/bots/api-changelog#june-11-2026>
- Method `sendRichMessage`: <https://core.telegram.org/bots/api#sendrichmessage>
- Method `sendRichMessageDraft`: <https://core.telegram.org/bots/api#sendrichmessagedraft>
- `InputRichMessage` (html/markdown string): <https://core.telegram.org/bots/api#inputrichmessage>
- `RichBlock` union (24 varian): <https://core.telegram.org/bots/api#richblock>
- `RichText` union (24 varian): <https://core.telegram.org/bots/api#richtext>
- Demo bot rich text: <https://t.me/richtextdemobot>
- Fitur rich messages: <https://core.telegram.org/bots/features#rich-messages>

### Titik kode Gezy relevan
- `src/server/channels/telegram.ts:332` — `sendMessage` (tempat rich cabang masuk)
- `src/server/channels/telegram.ts:22` — `splitMessage` (perlu adaptasi split-per-block)
- `src/server/channels/telegram.ts:311` — `sendTypingIndicator`
- `src/server/services/agent-engine.ts:1930` — `deliverChannelResponse` one-shot
- `src/server/services/channels.ts` — `deliverChannelResponse` definition
- `packages/sdk/src/index.ts:361` — `OutboundMessageParams` (tidak diubah Fase 1)
- `packages/sdk/src/index.ts:472` — `ChannelAdapter` contract (diubah Fase 2)
