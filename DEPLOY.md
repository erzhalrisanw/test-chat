# Deploy ke Render + Turso (Gratis)

Panduan deploy aplikasi Simple Chat ini menggunakan **Render** (hosting) dan **Turso** (database SQLite cloud). Keduanya punya free tier permanen.

## Ringkasan

| Layanan | Fungsi | Free tier |
|---|---|---|
| **Turso** | Database (libSQL/SQLite cloud) | 9 GB storage, 500 DB |
| **Render** | Hosting Node.js + WebSocket | 750 jam/bulan, sleep saat idle |

---

## 1. Setup Turso (Database)

Daftar dulu di [turso.tech](https://turso.tech).

### Install Turso CLI

**macOS / Linux:**
```bash
curl -sSfL https://get.tur.so/install.sh | bash
```

**Windows:** lihat dokumentasi [docs.turso.tech](https://docs.turso.tech).

### Login & buat database

```bash
turso auth login
turso db create simple-chat
```

### Ambil kredensial

```bash
# URL database
turso db show simple-chat --url

# Auth token
turso db tokens create simple-chat
```

Simpan kedua nilai ini:
- `TURSO_DATABASE_URL` — diawali `libsql://...`
- `TURSO_AUTH_TOKEN` — string panjang

---

## 2. Push Code ke GitHub

```bash
cd "/Users/erzhal/Project/test chat"
git init
git add .
git commit -m "Initial simple chat"
```

Buat repo kosong di [github.com](https://github.com/new), lalu:

```bash
git remote add origin https://github.com/USERNAME/simple-chat.git
git branch -M main
git push -u origin main
```

> Ganti `USERNAME` dengan username GitHub Anda.

---

## 3. Deploy ke Render

1. Daftar / login di [render.com](https://render.com) (pakai akun GitHub paling mudah)
2. Klik **New +** → **Web Service**
3. Pilih repo `simple-chat` dari daftar
4. Render otomatis baca `render.yaml`. Konfirmasi:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Buka tab **Environment** → tambahkan **2 environment variable**:

   | Key | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | URL dari Turso (langkah 1) |
   | `TURSO_AUTH_TOKEN` | Token dari Turso (langkah 1) |

6. Klik **Create Web Service**

Tunggu 2-3 menit. Setelah selesai, app live di:

```
https://simple-chat-xxxx.onrender.com
```

---

## 4. Tes Aplikasi

Buka URL di 2 browser/tab berbeda, login dengan akun demo:

| Username |
|---|
| occupatus |
| mutatio |

Kirim pesan dari satu tab — tab lain harus terima real-time. Refresh browser — history pesan harus tetap muncul.

---

## File Konfigurasi yang Sudah Disiapkan

- **`server.js`** — pakai `@libsql/client`, fallback ke file lokal (`file:chat.db`) saat development
- **`.gitignore`** — exclude `node_modules`, `chat.db`, `.env`
- **`render.yaml`** — auto-konfigurasi Render (free plan, Node 20)
- **`package.json`** — `engines.node >= 18`

---

## Development Lokal

Tidak perlu Turso saat development lokal:

```bash
npm install
npm start
```

Aplikasi akan jalan di `http://localhost:3000` dan otomatis pakai file `chat.db` lokal.

Untuk mencoba pakai Turso secara lokal:

```bash
export TURSO_DATABASE_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
npm start
```

---

## Catatan Penting Free Tier Render

- **Sleep saat idle:** Service akan sleep setelah 15 menit tanpa traffic
- **Cold start:** Request pertama setelah sleep butuh ~30 detik untuk wake up
- **Pesan tetap aman:** Karena database di Turso (eksternal), riwayat chat tidak hilang meski Render restart
- **750 jam/bulan:** Cukup untuk 1 service jalan terus 24/7

---

## Troubleshooting

**Build gagal di Render:**
- Pastikan `package.json` ada di root repo
- Cek log build di dashboard Render

**Chat connect error setelah deploy:**
- Cek env var `TURSO_DATABASE_URL` & `TURSO_AUTH_TOKEN` sudah benar
- Lihat **Logs** di Render dashboard untuk error message

**History kosong padahal sudah kirim pesan:**
- Cek koneksi Turso: jalankan `turso db shell simple-chat` lalu `SELECT * FROM messages;`

**WebSocket tidak connect:**
- Render free tier mendukung WebSocket secara native, tidak perlu konfigurasi tambahan
- Pastikan client connect ke URL `https://` (bukan `http://`)

---

## Update Deployment

Setiap kali push ke `main`, Render otomatis re-deploy:

```bash
git add .
git commit -m "Update fitur X"
git push
```
