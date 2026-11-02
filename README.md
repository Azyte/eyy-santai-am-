<div align="center">

<img src="public/favicon.svg" alt="DKaimono-AM Logo" width="96" height="96" style="border-radius:24px; margin-bottom:12px;">

# ⚡ DKaimono-AM

**Modern & Professional Alight Motion Premium Activation Suite**

*Reverse engineered • No password • No ads • Hosted on Netlify Serverless*

🌐 **Live Website:** [dkaimono.web.id](https://dkaimono.web.id)

[![Status](https://img.shields.io/badge/status-active-success?style=flat-square)](https://dkaimono.web.id)
[![Domain](https://img.shields.io/badge/domain-dkaimono.web.id-10b981?style=flat-square)](https://dkaimono.web.id)
[![Host](https://img.shields.io/badge/hosting-Netlify_Serverless-00C7B7?style=flat-square&logo=netlify)](https://dkaimono.web.id)
[![Node](https://img.shields.io/badge/node-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**Improvised & Maintained by DKaimono**

</div>

---

> ⚠️ **DISCLAIMER:**  
> Proyek ini adalah riset edukasi dan reverse-engineering independen. Tidak berafiliasi, didukung, atau disponsori oleh Alight Creative, Inc. maupun Google LLC. Seluruh merek dagang adalah hak milik dari pemiliknya masing-masing. Gunakan dengan bijak atas risiko sendiri.

---

## 🚀 Fitur & Improvisasi DKaimono-AM

- **✨ Sleek Modern SaaS UI** — Antarmuka web gelap elegan bergaya produk teknologi kelas dunia (*Inter* & *JetBrains Mono*).
- **🎨 Custom Logo & High-Res Favicons** — Dilengkapi logo vektor SVG, PNG, ICO, dan Apple Touch Icon (tanpa logo globe default).
- **🔒 Passwordless Magic Link** — Masuk hanya menggunakan alamat email tanpa perlu kata sandi atau akun Google.
- **📅 Sinkronisasi Tanggal Asli** — Menampilkan masa aktif resmi (3 Juli) yang cocok persis dengan yang ada di profil aplikasi Alight Motion.
- **📲 Quick App Sign-In** — Tombol sekali klik di Step 3 untuk mengirim link login instan ke email HP agar pengguna bisa langsung masuk ke aplikasi.
- **🚀 Deep Link Buka Aplikasi** — Tombol pintasan untuk langsung membuka aplikasi Alight Motion di HP Android.
- **⚡ Sesi Tersimpan & Auto-Renew** — Sesi token tersimpan di browser; perpanjang lisensi kapan saja secara instan tanpa perlu repot verifikasi email lagi.
- **📋 Tempel Cepat (Clipboard Auto-Paste)** — Pengguna HP dapat menempelkan link verifikasi dengan 1x klik.
- **💡 Modal Panduan Salin Link Gmail** — Petunjuk interaktif cara *long-press* dan *copy link URL* dari email.
- **📢 WhatsApp Viral Sharing** — Tombol berbagi cepat ke sesama kreator video via WhatsApp atau Web Share API.
- **🛡️ Anti-Spam Rate Limiter** — Perlindungan API backend dari spamming dan pembatasan kuota Firebase.
- **☁️ Netlify Serverless Ready** — Dikonfigurasi penuh dengan `netlify.toml` dan serverless functions menggunakan `serverless-http`.

---

## 🛠️ Cara Menjalankan

### 1. Menjalankan di Komputer Lokal

```bash
# Clone repository
git clone https://github.com/Azyte/eyy-santai-am-.git
cd eyy-santai-am-

# Install dependensi
npm install

# Jalankan server
npm start
```

Buka peramban di `http://localhost:3300`.

### 2. Menjalankan Uji Otomatis (Tests)

```bash
npm test
```
*Memverifikasi kontrak API `/api/status`, `/api/stats`, `/api/send-link`, `/api/verify-link`, `/api/renew`, dan serverless handler.*

### 3. Deploy ke Netlify

Proyek ini telah dilengkapi [`netlify.toml`](netlify.toml) dan serverless functions di [`netlify/functions/api.js`](netlify/functions/api.js).
1. Hubungkan repository GitHub ini di dashboard [Netlify](https://app.netlify.com).
2. Netlify akan otomatis melakukan build dan deploy saat ada `git push` ke branch `main`.
3. Tambahkan custom domain **`dkaimono.web.id`** di menu *Domain Management* Netlify.

---

## 📂 Struktur Proyek

```text
├── app/
│   └── api/                # Endpoint backend API Express
│       ├── renew/          # Perpanjang lisensi via refresh token
│       ├── send-link/      # Pengiriman magic link email Firebase
│       ├── stats/          # Statistik aktivasi real-time
│       ├── status/         # Pemeriksaan kesehatan server (online/offline)
│       └── verify-link/    # Verifikasi magic link & inject VIP Pro
├── lib/
│   ├── auth.js             # Protokol otentikasi Firebase & endpoint Alight Creative
│   ├── errors.js           # Penanganan pesan error Firebase yang ramah pengguna
│   ├── rate-limit.js       # Middleware pembatas laju request (anti-spam)
│   └── stats.js            # Penyimpanan statistik aktivasi (aman serverless)
├── netlify/
│   └── functions/api.js    # Netlify serverless function wrapper
├── public/
│   ├── index.html          # Web UI responsif DKaimono-AM
│   ├── favicon.svg         # Ikon vektor website
│   ├── favicon.png         # Ikon 32x32
│   ├── favicon.ico         # Ikon search engine
│   └── apple-touch-icon.png# Ikon 192x192 untuk home screen & share preview
├── app.js                  # Modul Express utama
├── netlify.toml            # Konfigurasi build & routing Netlify
├── server.js               # Server lokal Express (port 3300)
├── test-verification.js    # Automated test suite
└── README.md
```

---

<div align="center">

**DKaimono-AM** &copy; 2026 &middot; Re-engineered with modern web standards.  
Apresiasi riset awal: *Ansari &bull; Zenno*

</div>
