# Update Image Docker di VPS

Setelah GitHub Actions selesai (hijau), jalankan di VPS untuk deploy image terbaru.

## Langkah

```bash
docker compose pull
docker compose up -d --force-recreate gezy
```

Best Practice untuk Production:
```bash
# Lebih aman dengan timeout graceful shutdown
docker compose pull gezy
docker compose up -d --force-recreate --remove-orphans gezy
```

# Atau satu baris (pull + up sekaligus)
```bash
docker compose up -d --force-recreate --pull always gezy
```

| Perintah | Fungsi |
|---|---|
| `docker compose pull` | Download image `latest` terbaru dari GHCR |
| `docker compose up -d --force-recreate gezy` | Destroy container lama + buat baru pakai image yang baru di-pull (konfigurasi env/port/volume dari `docker-compose.yml` tetap dipakai) |

## Verifikasi

```bash
docker exec gezy grep -c 'streamDraft' /app/src/server/channels/telegram.ts
docker exec gezy grep -c 'tg-math' /app/src/server/channels/telegram-rich.ts
```

Kedua angka harus > 0. Kalau 0, berarti image belum berisi kode baru.

## Catatan penting

- **Jangan pakai `docker restart`** — itu hanya restart container dengan image lama yang masih di disk, tidak mengambil image baru.
- Kalau `docker compose pull` bilang **"Image is up to date"** padahal Actions baru saja selesai, berarti tag `latest` belum ter-update di GHCR. Cek tab **Actions** di GitHub — pastikan workflow build image benar-benar sudah selesai (bukan masih running). Tunggu sampai hijau, lalu `pull` lagi.
