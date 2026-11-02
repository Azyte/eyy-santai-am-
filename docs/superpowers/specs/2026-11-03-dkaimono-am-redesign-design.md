# Design Spec: DKaimono-AM Web Interface Redesign

## 1. Intent & Context
Mengubah tampilan antarmuka web aktivator Alight Motion dari antarmuka terminal/monospace sederhana menjadi antarmuka web profesional modern bernama **DKaimono-AM**, dengan tetap mempertahankan 100% alur kerja backend dan kontrak API yang sudah ada.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Branding & Identitas:** Mengusung nama resmi **DKaimono-AM** dengan identitas visual yang profesional, bersih, dan terpercaya.
- **Modern Single-Page SaaS UI:**
  - **Navbar:** Logo DKaimono-AM, indikator status server real-time (*Live/Online* via `/api/status`), tautan cepat (Panduan, FAQ, Status).
  - **Hero & Live Counter:** Headline jelas, deskripsi produk, kartu statistik dinamis (*Total Aktivasi* & *Hari Ini* via `/api/stats`).
  - **Interactive Activation Hub (Core Wizard):**
    - Step 1: Input Email (validasi format, loading state "Mengirim link...", penanganan pesan error/sukses).
    - Step 2: Input Magic Link (instruksi jelas, preview email tujuan, tombol kembali, loading state "Memverifikasi...").
    - Step 3: Kartu Hasil Aktivasi (Badge VIP Active, detail akun email & UID, masa berlaku lisensi, Order ID, ID Token dengan *copy-to-clipboard* instan + feedback toast, dan tombol aktivasi akun lain).
  - **Panduan Penggunaan (How It Works):** 3 langkah visual yang ringkas dan jelas.
  - **FAQ & Troubleshooting:** Akordeon tanya jawab terkait pengiriman email, folder spam, dan link expired.
  - **Footer:** Disclaimer keamanan, copyright DKaimono-AM, dan informasi versi.
- **Responsivitas & Performa:** Mobile-first, fluid pada layar smartphone hingga desktop, zero-dependency tambahan (pure modern CSS & clean vanilla JS).

### Non-Goals
- Tidak mengubah file backend (`server.js`, `app/api/*`, `lib/*`).
- Tidak mengubah skema data request/response API.
- Tidak menambahkan framework berat (seperti React/Vue/Next.js) yang memerlukan build step rumit, tetap menggunakan arsitektur static file Express yang ringan dan cepat.

### Anti-Goals
- Tidak menghilangkan satupun fungsionalitas yang ada (copy token, link refresh, error display).
- Tidak merusak kompatibilitas browser mobile.

---

## 3. Constraints
- Alur backend tidak boleh diubah:
  - `GET /api/stats`
  - `GET /api/status`
  - `POST /api/send-link` (`{ email }`)
  - `POST /api/verify-link` (`{ email, magicLink }`)
- Harus disajikan langsung dari folder `public/index.html` (atau file aset statis pendukung di `public/`).

---

## 4. Approaches Considered
1. **Pendekatan 1: Modern Single-Page SaaS & Activation Suite (Dipilih)**
   - Menggabungkan elemen landing page profesional dan wizard aktivasi terintegrasi.
   - Memberikan impresi produk resmi/terpercaya yang sangat mudah digunakan bagi semua kalangan.
2. **Pendekatan 2: Minimalist Cloud Console / Focused Web App**
   - Hanya berupa kotak dialog di tengah layar tanpa penjelasan pendukung.
   - Ditolak karena kurang memberikan impresi "website profesional" yang lengkap.

---

## 5. Visual System & Tokens
- **Tema:** Dark mode premium (Deep Slate `#090d16`, Surface `#111827`, Border `#1f2937`).
- **Aksen:** Emerald/Mint Green (`#10b981` / `#059669`) melambangkan status aktif, keamanan, dan sukses.
- **Tipografi:** System sans-serif modern (`Inter`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`) untuk teks utama, dan `ui-monospace` hanya untuk ID token / UID.
- **Feedback & State:** Loading spinner bawaan CSS, alert message dengan transisi halus, badge status berdenyut (*pulse indicator*).
