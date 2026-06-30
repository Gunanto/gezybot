# Bot gagal kirim file ke Telegram — Audit + Fix RC-1

> Tanggal: 2026-06-30 · Status: **RC-1 FIXED (lokal, belum deploy)**.

## Laporan kegagalan

Dua bot Gezy (beda agent + beda channel, app yang sama) gagal kirim file docx/PDF ke Telegram setelah "banyak perubahan". Gejala:
- User minta file → bot bilang "sudah saya lampirkan" tapi file gak nyampe sama sekali.
- Bot kirim share URL `http://localhost:3000/s/...` yang unreachable, atau habis-habisan berhalusinasi "file 11357 bytes sudah ada di sistem saya".

## Audit — 3 root cause

### RC-1 (UTAMA, REGRESI) — Streaming-draft path menjatuhkan attachment
`agent-engine.ts` (Fase 2 streaming draft Commit `ada37e8a`): setiap turn channel yang adapter-nya support `streamDraft` (Telegram support, telegram.ts:469) → buka draft. Saat commit, attachment yang di-stage via `attach_file` **diabaikan** — kode lama:
```
channelDraftStream.commit()
  .then((result) => recordChannelDraftCommitted(..., result))
  .then(() => { if (stagedFiles.length > 0) log.debug('...not sent') })   // DIJATUHKAN
```
Baris `deliverChannelResponse(...stagedFiles)` cuma jalan kalau `commit()` throw. Karena hampir semua reply Telegram lewat streaming draft sekarang, **setiap attachment di-attach_file pasti hilang**. Inilah regresi: sebelum Fase 2 (one-shot) file terkirim via `sendDocument`, sesudah Fase 2 → hilang.

### RC-2 — Instruksi prompt bertabrakan + URL `localhost` (sekunder)
- Prompt bilang dua hal: "kirim file ke platform pakai `attach_file()`" vs "store_file/generate_pdf → share URL ke user". Model sering pilih jalur URL.
- `store_file`/`generate_pdf` return `${config.publicUrl}/s/<token>`. Default `config.publicUrl` = `http://localhost:3000` (config.ts:759) → link unreachable dari HP.
- Catatan: di VPS user, `PUBLIC_URL` SUDAH diset `https://aios.gezytech.web.id`. Jadi link `localhost` di log yefia = **berhalusinasi** (model ngarang URL), BUKAN hasil store_file beneran.

### RC-3 — File-storage file susah di-attach ulang (sekunder)
`store_file`/`generate_pdf` simpan ke `data/file-storage/<agent>/...` dan kasih Agent **URL `/s/<token>`**. Tapi `attach_file` (attach-file-tool.ts:85-97) cuma kenali path `/api/uploads/...` dan `/api/file-storage/...`, BUKAN `/s/<token>`. Jadi URL itu gak bisa langsung dipakai `attach_file`. Harus rantai `download_stored_file` → workspace → `attach_file`. Jarang Agent ingat.

## Fix yang diterapkan (RC-1)

`src/server/services/channels.ts` — helper baru `deliverChannelAttachments(meta, attachments)`: kirim attachment TANPA text (content='') lewat `adapter.sendMessage` (Telegram: `sendDocument`/`sendPhoto`). Gak catat `channel_message_links` baru (text message sudah di-link via `recordChannelDraftCommitted`; paritas dengan one-shot path).

`src/server/services/agent-engine.ts` (blok streaming-draft commit, ~L1978): ganti `log.debug('not sent')` jadi panggil `deliverChannelAttachments(channelDraftMeta!, stagedFiles)` saat `stagedFiles.length>0`. One-shot path tetap (sudah benar). Fallback `deliverChannelResponse(...stagedFiles)` kalau `commit()` throw tetap utuh.

Validasi: typecheck clean (exit 0), full suite 4174 pass / 0 fail.

## Yang BELUM dikerjakan (RC-2/RC-3) — optional, bisa bareng

| RC | Fix | Effort |
|---|---|---|
| RC-2a | Pastikan `PUBLIC_URL` set di VPS (sudah: `https://aios.gezytech.web.id`). | ops done |
| RC-2b | Update prompt channel-context: "kirim file ke platform HANYA via `attach_file()`; URL store_file/generate_pdf itu untuk WEB, jangan tempel di Telegram." | 0.25 hari |
| RC-3 | `attach_file` kenali URL `/s/<token>` → resolve token → file-storage row → local path. Atau satu tool terpadu. | 0.5–1 hari |

## Catatan deploy (penting, terkait tapi bedaIssue)
Saat audit, commit `95ba355` (generate_pdf) **BELUM live** di container `gezy` — file `document-render.ts` gak ada, semua file build `Jun 29 22:18`. CI "Deploy Sites" cuma deploy static site, BUKAN recreate backend container. Harus `docker compose pull && docker compose up -d --force-recreate` biar 95ba355 (dan fix RC-1 ini) live.

## Verifikasi pasca-deploy (RC-1)
1. Recreate container (pull image baru).
2. Minta bot buat + kirim file docx/PDF (lewat tool yang nge-stage `attach_file`).
3. File harus muncul di chat Telegram sebagai dokumen (bukan link, bukan teks).
4. Log server: cari `Channel attachments delivered after streaming-draft commit` → konfirmasi helper kepanggil. Kalau masih ada lama `<log debug 'not sent'>`, berarti image lama (recreate belum jalan).
5. Kalau file gak muncul tapi log helper kepanggil → cek `sendTelegramFile` error (mungkin blob/path, atau ukuran melebihi batas Telegram sendDocument ~50MB untuk bot via server).

## Estimasi total RC-1 fix: ~0.5 hari (audit + implement + validasi).