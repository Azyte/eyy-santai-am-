const fs = require('fs');
const path = require('path');
const http = require('http');
const app = require('./app');
const netlifyFn = require('./netlify/functions/api');

async function runTests() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    // 1. Static Index HTML & Admin HTML
    const resHome = await fetch(`${baseUrl}/`);
    const homeHtml = await resHome.text();
    console.assert(resHome.status === 200, `Index status expected 200, got ${resHome.status}`);
    for (const needle of [
      'DKaimono-AM',
      'dkaimono.web.id',
      'id="activation-hub"',
      'id="btn-send-link"',
      'id="btn-verify"',
      'id="saved-session-banner"',
      'id="btn-paste-clipboard"',
      'id="btn-send-app-login"',
      'id="btn-open-app"',
      'id="btn-share-wa"',
      'id="guide-modal"',
      'id="btn-toggle-drawer"',
      'id="menu-drawer"',
      'id="drawer-accounts-list"',
      'id="quota-bar"',
      'id="tab-mode-bulk"',
      'id="store-modal"'
    ]) {
      if (!homeHtml.includes(needle)) {
        throw new Error(`Missing required element in index.html: ${needle}`);
      }
    }

    const resAdminPage = await fetch(`${baseUrl}/admin`);
    const adminHtml = await resAdminPage.text();
    if (resAdminPage.status !== 200 || !adminHtml.includes('DKaimono-AM Admin')) {
      throw new Error('Admin page /admin failed to render');
    }
    console.log('✓ Test 1: Static Home & Admin HTML serving passed');

    // 2. Security Audit: Ensure lib/db.js contains zero hardcoded Neon credentials
    const dbSource = fs.readFileSync(path.join(__dirname, 'lib', 'db.js'), 'utf8');
    if (dbSource.includes('npg_') || dbSource.includes('neondb_owner:')) {
      throw new Error('Security failure: Hardcoded database password found in lib/db.js');
    }
    console.log('✓ Test 2: Zero hardcoded DB credentials in source code passed');

    // 3. /api/status & /api/stats
    const resStatus = await fetch(`${baseUrl}/api/status`);
    const dataStatus = await resStatus.json();
    if (resStatus.status !== 200 || dataStatus.status !== 'online') {
      throw new Error('/api/status failed');
    }

    const resStats = await fetch(`${baseUrl}/api/stats`);
    const dataStats = await resStats.json();
    if (resStats.status !== 200 || dataStats.success !== true || typeof dataStats.total !== 'number') {
      throw new Error('/api/stats failed');
    }
    console.log('✓ Test 3: /api/status and /api/stats passed');

    // 4. Input validations on /api/send-link, /api/verify-link, /api/renew
    const resSendInvalid = await fetch(`${baseUrl}/api/send-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invalid-email' })
    });
    if (resSendInvalid.status !== 400) throw new Error('/api/send-link validation failed');

    const resVerifyEmpty = await fetch(`${baseUrl}/api/verify-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', magicLink: '' })
    });
    if (resVerifyEmpty.status !== 400) throw new Error('/api/verify-link validation failed');

    const resRenewEmpty = await fetch(`${baseUrl}/api/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: '' })
    });
    if (resRenewEmpty.status !== 400) throw new Error('/api/renew validation failed');
    console.log('✓ Test 4: Core endpoint validations passed');

    // 5. Netlify Function handler wrapper
    const fnResult = await netlifyFn.handler({
      httpMethod: 'GET',
      path: '/api/status',
      headers: {},
      queryStringParameters: {}
    }, {});
    if (fnResult.statusCode !== 200) throw new Error('Netlify handler failed');
    console.log('✓ Test 5: Netlify serverless wrapper passed');

    // 6. /api/bulk tier protection
    const resBulkFree = await fetch(`${baseUrl}/api/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-links', emails: ['a@b.com'] })
    });
    if (resBulkFree.status !== 403) throw new Error('/api/bulk should block free users with 403');
    console.log('✓ Test 6: /api/bulk tier protection passed');

    // 7. Database-backed end-to-end tests: Hardware Lock, Admin Voucher Mint, Single-Use Claim & Device Reset
    const { getSql } = require('./lib/db');
    const sql = getSql();
    if (sql) {
      const testFp1 = 'fp2_unit_hw1_test99';
      const testFp2 = 'fp2_unit_hw2_test99';
      const testFpNewPhone = 'fp2_unit_newphone_99';
      const testEmail1 = 'unittest_u1@dkaimono.web.id';
      const testEmail2 = 'unittest_u2@dkaimono.web.id';

      await sql`DELETE FROM app_users WHERE email IN (${testEmail1}, ${testEmail2}) OR device_fingerprint IN (${testFp1}, ${testFp2}, ${testFpNewPhone})`;
      await sql`DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'reg:%' OR bucket_key LIKE 'login:%' OR bucket_key LIKE 'admin-login:%'`;

      // Register User 1 on Device 1
      const reg1 = await fetch(`${baseUrl}/api/quota/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFp1 },
        body: JSON.stringify({ email: testEmail1, password: 'password123', fingerprint: testFp1 })
      });
      const reg1Data = await reg1.json();
      if (reg1.status !== 200 || !reg1Data.success) throw new Error('User 1 registration failed: ' + JSON.stringify(reg1Data));

      // Attempt 2nd account on SAME Device 1 -> 403
      const regDupFp = await fetch(`${baseUrl}/api/quota/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFp1 },
        body: JSON.stringify({ email: testEmail2, password: 'password123', fingerprint: testFp1 })
      });
      if (regDupFp.status !== 403) throw new Error('Expected 403 on duplicate device registration');

      // Register User 2 on Device 2
      const reg2 = await fetch(`${baseUrl}/api/quota/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFp2 },
        body: JSON.stringify({ email: testEmail2, password: 'password123', fingerprint: testFp2 })
      });
      const reg2Data = await reg2.json();
      if (reg2.status !== 200 || !reg2Data.success) throw new Error('User 2 registration failed');

      // Login User 1 from a DIFFERENT device -> 403
      const loginMismatch = await fetch(`${baseUrl}/api/quota/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFpNewPhone },
        body: JSON.stringify({ email: testEmail1, password: 'password123', fingerprint: testFpNewPhone })
      });
      if (loginMismatch.status !== 403) throw new Error('Expected 403 when logging in from another device');
      console.log('✓ Test 7: 1 Device = 1 Account hardware lock passed');

      // Admin Login + Mint Single-Use Voucher + Single-Use Enforcement + Device Reset
      if (process.env.ADMIN_PASSWORD) {
        const admLogin = await fetch(`${baseUrl}/api/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
        });
        const admData = await admLogin.json();
        if (admLogin.status !== 200 || !admData.token) throw new Error('Admin login failed');

        // Mint 1 single-use voucher
        const mintRes = await fetch(`${baseUrl}/api/admin/vouchers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': admData.token },
          body: JSON.stringify({ count: 1, maxUses: 1, durationDays: 30, dailyLimit: 10, planLabel: 'Unit Test Pass', note: 'unit-test' })
        });
        const mintData = await mintRes.json();
        if (!mintData.success || !mintData.created?.length) throw new Error('Admin voucher mint failed');
        const plainVoucher = mintData.created[0].plainCode;
        const voucherId = mintData.created[0].id;

        // User 1 claims single-use voucher -> 200 OK
        const claim1 = await fetch(`${baseUrl}/api/quota/voucher`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-fingerprint': testFp1,
            'x-auth-token': reg1Data.token
          },
          body: JSON.stringify({ voucherCode: plainVoucher })
        });
        const claim1Data = await claim1.json();
        if (claim1.status !== 200 || !claim1Data.quota?.isPremium) {
          throw new Error('User 1 voucher claim failed: ' + JSON.stringify(claim1Data));
        }

        // User 2 tries to claim the SAME single-use voucher -> must fail with 410 Gone
        const claim2 = await fetch(`${baseUrl}/api/quota/voucher`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-fingerprint': testFp2,
            'x-auth-token': reg2Data.token
          },
          body: JSON.stringify({ voucherCode: plainVoucher })
        });
        if (claim2.status !== 410) {
          throw new Error(`Expected 410 Gone on reused single-use voucher, got ${claim2.status}`);
        }

        // Admin resets User 1's device lock -> User 1 can now log in from testFpNewPhone!
        const resetDev = await fetch(`${baseUrl}/api/admin/users/${reg1Data.user.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': admData.token },
          body: JSON.stringify({ action: 'reset-device' })
        });
        if (resetDev.status !== 200) throw new Error('Admin reset-device failed');

        const loginAfterReset = await fetch(`${baseUrl}/api/quota/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFpNewPhone },
          body: JSON.stringify({ email: testEmail1, password: 'password123', fingerprint: testFpNewPhone })
        });
        if (loginAfterReset.status !== 200) throw new Error('Login on new phone after admin reset failed');

        // Cleanup test voucher
        await fetch(`${baseUrl}/api/admin/vouchers/${voucherId}`, {
          method: 'DELETE',
          headers: { 'x-admin-token': admData.token }
        });
        console.log('✓ Test 8: Admin Dashboard API, Single-Use Voucher & Device Reset passed');
      }

      await sql`DELETE FROM app_users WHERE email IN (${testEmail1}, ${testEmail2}) OR device_fingerprint IN (${testFp1}, ${testFp2}, ${testFpNewPhone})`;
    }

    console.log('\nALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
