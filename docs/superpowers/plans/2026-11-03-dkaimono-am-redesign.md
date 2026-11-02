# DKaimono-AM Redesign & Netlify Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the website into the professional, modern "DKaimono-AM" SaaS landing page and activation suite, and configure seamless Netlify hosting without changing backend API logic.

**Architecture:** Express application structured with an exported app instance in `app.js` consumed both locally by `server.js` and serverlessly by `netlify/functions/api.js` via `serverless-http`. Frontend completely elevated in `public/index.html` with vanilla modern HTML5/CSS3/ES6 (zero bloated frontend build toolchain needed), featuring real-time server health checks, live stats counter, an interactive 3-step activation wizard, how-it-works guide, FAQ, and toast feedback.

**Tech Stack:** Node.js, Express, `serverless-http`, Netlify Functions, Modern CSS (CSS custom properties, flexbox/grid, responsive mobile-first), Vanilla JavaScript.

**Spec:** [`docs/superpowers/specs/2026-11-03-dkaimono-am-redesign-design.md`](file:///d:/Daru/Coding/am-reverse-1.0.0/docs/superpowers/specs/2026-11-03-dkaimono-am-redesign-design.md)

## Global Constraints

- Backend API endpoints must maintain exact signatures and response structures:
  - `GET /api/status` -> `{ status: "online", timestamp: string }`
  - `GET /api/stats` -> `{ success: true, total: number, today: number, timestamp: string }`
  - `POST /api/send-link` -> `{ email }` -> `{ success: boolean, message: string }`
  - `POST /api/verify-link` -> `{ email, magicLink }` -> `{ success: boolean, message: string, data: object }`
- Zero changes to Firebase Auth or reverse engineering logic in `lib/auth.js`.
- File writes in `lib/stats.js` must safely handle serverless environments (fallback to `/tmp` if directory write permissions fail).
- Must work standalone both locally (`node server.js` on port 3300) and deployed on Netlify.

## Review Focus

1. **Email input with whitespace / uppercase:** User types ` User@Email.Com ` -> frontend trims and converts to lowercase before submission.
2. **Invalid / Empty Magic Link:** Frontend displays clear inline error alert without breaking wizard state or refreshing page.
3. **Netlify Read-Only Filesystem:** Serverless function incrementing stats doesn't throw unhandled exception if `data/` is non-writable.
4. **Copy Token clipboard permission denial:** Safe fallback using textarea selection if `navigator.clipboard` is restricted.
5. **Mobile Viewport Overflow:** Long JWT tokens and UIDs wrap with `word-break: break-all` preventing horizontal layout breakage on small phone screens.

---

### Task 1: Netlify Hosting Support & Serverless Function Setup

**Files:**
- Create: `netlify.toml`
- Create: `app.js`
- Create: `netlify/functions/api.js`
- Modify: `server.js`
- Modify: `lib/stats.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `app/api/route.js`
- Produces: `app.js` exporting configured Express `app`, `netlify/functions/api.js` exporting serverless handler

- [ ] **Step 1: Install `serverless-http` in `package.json`**

Run: `npm install serverless-http`
Expected: `serverless-http` added to `dependencies`.

- [ ] **Step 2: Harden `lib/stats.js` for serverless environments**

Update `lib/stats.js` so `statsFile` uses `/tmp/stats.json` if running in Netlify/Lambda (`process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME`) or if `dataDir` cannot be created, ensuring safe fallback without crashes.

- [ ] **Step 3: Extract Express setup to `app.js` and update `server.js`**

Create `app.js` exporting `app` with cors, json, static middleware for `public`, and `/api` router.
Update `server.js` to simply import `app` from `./app` and call `app.listen(PORT)`.

- [ ] **Step 4: Create `netlify/functions/api.js` and `netlify.toml`**

`netlify/functions/api.js`:
```javascript
const serverless = require('serverless-http');
const app = require('../../app');
module.exports.handler = serverless(app);
```
`netlify.toml`:
```toml
[build]
  publish = "public"
  functions = "netlify/functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/api/:splat"
  status = 200
```

- [ ] **Step 5: Test local server and endpoints**

Run: `node -e "const app = require('./app'); console.log(typeof app);"`
Expected: `function`

---

### Task 2: Redesign `public/index.html` with DKaimono-AM UI & Theme

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `/api/status`, `/api/stats`, `/api/send-link`, `/api/verify-link`
- Produces: Professional user-facing web interface with responsive layout, live health status, activation wizard, how-it-works, and FAQ.

- [ ] **Step 1: Implement Design System, Theme Variables, and Layout Shell**

Create the HTML shell with:
- Google Font `Inter` preconnect and font-family setup.
- Dark mode design tokens: `--bg: #090d16`, `--surface: #111827`, `--surface-card: #162032`, `--border: #1f293d`, `--primary: #10b981`, `--primary-hover: #059669`, `--text: #f3f4f6`, `--text-muted: #9ca3af`.
- Global responsive reset, typography, and container utilities.

- [ ] **Step 2: Build Navigation Bar & Header**

Include:
- Brand Logo & Name: `DKaimono-AM` with a stylized activation badge.
- Live Server Status badge: `<span class="status-dot"></span> Server Online` (dynamically fetches `/api/status`).
- Quick navigation links: "Cara Kerja", "FAQ", "Mulai Aktivasi".

- [ ] **Step 3: Build Hero Section with Real-Time Counters**

Include:
- Headline: "Alight Motion Premium Activation Hub".
- Tagline: "Aktivasi lisensi resmi tahunan instan via Magic Link tanpa password. Aman, cepat, dan otomatis."
- Live stats grid: "Total Aktivasi" & "Aktivasi Hari Ini" fetched from `/api/stats`.

- [ ] **Step 4: Build Interactive 3-Step Activation Hub**

Include:
- Progress bar / Step chips: Step 1 (Email), Step 2 (Magic Link), Step 3 (VIP Aktif).
- **Step 1 Panel:**
  - Input field for email with auto-trim & validation.
  - Action button: "Kirim Link Aktivasi →" with loading state indicator ("Mengirim...").
  - Clear error / success alert boxes.
- **Step 2 Panel:**
  - Confirmation alert showing target email address.
  - Help text: "Buka email Anda, salin link verifikasi / login yang dikirimkan oleh Alight Motion, lalu tempelkan di sini."
  - Input field for Magic Link / oobCode.
  - Back button ("← Ubah Email") and Submit button ("Verifikasi & Aktifkan Premium →") with loading state ("Memverifikasi...").
- **Step 3 Panel:**
  - Status banner: "🎉 Premium VIP Berhasil Diaktifkan!"
  - Subscription badge: "Yearly VIP License • Active".
  - Detail grid: Email, Account UID, Order ID, Masa Berlaku (*Valid Until*).
  - ID Token section: Token preview box with instant "Salin ID Token" button and toast notification.
  - Button "Aktivasi Akun Lain" to reset wizard.

- [ ] **Step 5: Build How It Works & FAQ Sections**

Include:
- 3 visual steps:
  1. *Kirim Link:* Masukkan email Alight Motion Anda.
  2. *Buka Email:* Cek inbox/spam untuk link verifikasi resmi.
  3. *Verifikasi:* Tempel link dan sistem langsung mengaktifkan status VIP.
- FAQ accordion:
  - *Apakah memerlukan password?* (Tidak, 100% menggunakan otentikasi Firebase Magic Link resmi).
  - *Link tidak muncul di email?* (Periksa folder Spam atau Promosi, atau pastikan email benar).
  - *Berapa lama masa aktif lisensi?* (Lisensi berlaku selama 1 tahun dan dapat diperbarui kapan saja).

- [ ] **Step 6: Build Modern Footer**

Include:
- Disclaimer hukum: "DKaimono-AM adalah proyek riset independen. Tidak berafiliasi dengan Alight Creative atau Google LLC."
- Copyright notice and version.

---

### Task 3: Comprehensive Testing & Verification

**Files:**
- Test all endpoints on running server.
- Verify frontend behavior across viewports.

- [ ] **Step 1: Start local server and test API contracts**

Test `/api/status`:
```powershell
Invoke-RestMethod -Uri "http://localhost:3300/api/status"
```
Expected: `status: online`

Test `/api/stats`:
```powershell
Invoke-RestMethod -Uri "http://localhost:3300/api/stats"
```
Expected: `total` and `today` numbers present.

- [ ] **Step 2: Test frontend assets and UI rendering**

Open `http://localhost:3300/` or fetch HTML to verify correct branding, scripts, styles, and zero missing asset errors.

- [ ] **Step 3: Verify Netlify packaging and deploy-readiness**

Confirm:
- `netlify.toml` points to `public` and `netlify/functions`.
- `netlify/functions/api.js` loads cleanly.
- `package.json` contains `serverless-http`.
