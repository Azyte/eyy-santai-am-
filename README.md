# DKaimono-AM

Studio aktivasi lisensi tahunan Alight Motion Pro berbasis web dan Netlify Serverless, dilengkapi sistem kuota harian, kode voucher satu arah (one-way hashed), pemesanan via WhatsApp Admin, dan Panel Admin terpadu.

- **Website Utama:** https://dkaimono.web.id
- **Panel Admin:** https://dkaimono.web.id/admin

---

## Fitur Utama

1. **Aktivasi Tanpa Kata Sandi Akun Alight Motion**
   Menggunakan alur autentikasi resmi Google Firebase Magic Link dan validasi struk tahunan dengan dukungan rotasi multi-token cadangan.
2. **Sistem Kuota, Kunci Perangkat (1 Perangkat = 1 Akun), & Reset Pukul 00:00 WIB**
   - **Mode Gratis:** 3 aktivasi/hari dengan jeda tunggu 10 menit per jaringan `/24` & perangkat.
   - **Premium Pass:** 10 aktivasi/hari tanpa jeda + akses **Bulk Grosir** (maksimal 10 akun setiap 7 hari).
   - **Reseller Pass:** 25 aktivasi/hari tanpa jeda + akses **Bulk Grosir** setiap hari.
3. **Katalog & Order Voucher via WhatsApp**
   Pengunjung dapat memilih paket langsung dari modal **Beli Voucher** yang terhubung ke WhatsApp Admin dengan format pesan otomatis.
4. **Panel Admin (`/admin`)**
   - Generator kode voucher sekali pakai maupun multi-pakai (satuan atau massal hingga 50 kode sekaligus) dengan salin format chat WhatsApp instan.
   - Manajemen pengguna: reset kunci perangkat jika pembeli ganti HP, tambah masa aktif manual, reset jeda Bulk, atau ganti password.
   - Pengaturan live nomor WhatsApp Admin, harga paket katalog, dan password Admin tanpa perlu mengubah kode sumber.

---

## Konfigurasi Environment Variables (`.env` / Netlify)

Salin `.env.example` menjadi `.env` untuk server lokal, atau masukkan variabel berikut pada **Netlify Dashboard -> Site configuration -> Environment variables**:

```ini
DATABASE_URL=postgresql://user:password@ep-example.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
SESSION_SECRET=string_acak_minimal_32_karakter
VOUCHER_PEPPER=string_acak_minimal_32_karakter
ADMIN_PASSWORD=password_kuat_untuk_halaman_admin
```

Variabel opsional:
- `ADMIN_WHATSAPP`: Nomor WhatsApp Admin default (format `628...`, dapat diubah kapan saja lewat `/admin`).
- `AM_PURCHASE_TOKENS`: Daftar token struk Google Play dipisah koma untuk fallback otomatis.

---

## Menjalankan Secara Lokal

```bash
npm install
npm test
npm start
```

Server berjalan di `http://localhost:3300` (halaman utama) dan `http://localhost:3300/admin` (panel admin).
