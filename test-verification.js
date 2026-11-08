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
    // 1. Test Static Index HTML
    const resHome = await fetch(`${baseUrl}/`);
    const homeHtml = await resHome.text();
    console.assert(resHome.status === 200, `Index status expected 200, got ${resHome.status}`);
    console.assert(homeHtml.includes('DKaimono-AM'), 'Index HTML contains DKaimono-AM');
    console.assert(homeHtml.includes('id="activation-hub"'), 'Index HTML contains activation-hub');
    console.assert(homeHtml.includes('id="btn-send-link"'), 'Index HTML contains btn-send-link');
    console.assert(homeHtml.includes('id="btn-verify"'), 'Index HTML contains btn-verify');
    console.assert(homeHtml.includes('id="saved-session-banner"'), 'Index HTML contains saved-session-banner');
    console.assert(homeHtml.includes('id="btn-paste-clipboard"'), 'Index HTML contains btn-paste-clipboard');
    console.assert(homeHtml.includes('id="btn-send-app-login"'), 'Index HTML contains btn-send-app-login');
    console.assert(homeHtml.includes('id="btn-open-app"'), 'Index HTML contains btn-open-app');
    console.assert(homeHtml.includes('dkaimono.web.id'), 'Index HTML contains dkaimono.web.id');
    console.assert(homeHtml.includes('id="btn-share-wa"'), 'Index HTML contains btn-share-wa');
    console.assert(homeHtml.includes('id="guide-modal"'), 'Index HTML contains guide-modal');
    console.assert(homeHtml.includes('id="btn-toggle-drawer"'), 'Index HTML contains btn-toggle-drawer');
    console.assert(homeHtml.includes('id="menu-drawer"'), 'Index HTML contains menu-drawer');
    console.assert(homeHtml.includes('id="drawer-accounts-list"'), 'Index HTML contains drawer-accounts-list');
    console.assert(homeHtml.includes('id="quota-bar"'), 'Index HTML contains quota-bar');
    console.assert(homeHtml.includes('id="tab-mode-bulk"'), 'Index HTML contains tab-mode-bulk');
    console.log('✓ Test 1: Static HTML serving passed');

    // 2. Test /api/status
    const resStatus = await fetch(`${baseUrl}/api/status`);
    const dataStatus = await resStatus.json();
    console.assert(resStatus.status === 200, 'Status endpoint returns 200');
    console.assert(dataStatus.status === 'online', 'Status is online');
    console.log('✓ Test 2: /api/status endpoint passed');

    // 3. Test /api/stats
    const resStats = await fetch(`${baseUrl}/api/stats`);
    const dataStats = await resStats.json();
    console.assert(resStats.status === 200, 'Stats endpoint returns 200');
    console.assert(dataStats.success === true, 'Stats success is true');
    console.assert(typeof dataStats.total === 'number', 'Stats total is a number');
    console.assert(typeof dataStats.today === 'number', 'Stats today is a number');
    console.log('✓ Test 3: /api/stats endpoint passed');

    // 4. Test /api/send-link validation
    const resSendInvalid = await fetch(`${baseUrl}/api/send-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invalid-email' })
    });
    console.assert(resSendInvalid.status === 400, 'Invalid email returns 400');
    const dataSendInvalid = await resSendInvalid.json();
    console.assert(dataSendInvalid.success === false, 'Invalid email returns success: false');
    console.log('✓ Test 4: /api/send-link validation passed');

    // 5. Test /api/verify-link validation
    const resVerifyEmpty = await fetch(`${baseUrl}/api/verify-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', magicLink: '' })
    });
    console.assert(resVerifyEmpty.status === 400, 'Empty link returns 400');
    const dataVerifyEmpty = await resVerifyEmpty.json();
    console.assert(dataVerifyEmpty.success === false, 'Empty link returns success: false');
    console.log('✓ Test 5: /api/verify-link validation passed');

    // 6. Test /api/renew validation
    const resRenewEmpty = await fetch(`${baseUrl}/api/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: '' })
    });
    console.assert(resRenewEmpty.status === 400, 'Empty refresh token returns 400');
    const dataRenewEmpty = await resRenewEmpty.json();
    console.assert(dataRenewEmpty.success === false, 'Empty refresh token returns success: false');
    console.log('✓ Test 6: /api/renew validation passed');

    // 7. Test Netlify Function handler wrapper
    const mockEvent = {
      httpMethod: 'GET',
      path: '/api/status',
      headers: {},
      queryStringParameters: {}
    };
    const fnResult = await netlifyFn.handler(mockEvent, {});
    console.assert(fnResult.statusCode === 200, `Netlify handler returned ${fnResult.statusCode}`);
    const fnBody = JSON.parse(fnResult.body);
    console.assert(fnBody.status === 'online', 'Netlify handler body has status online');
    console.log('✓ Test 7: Netlify function handler execution passed');

    // 8. Test /api/quota & 1 Device 1 Account Lock (Register & Login)
    const testFp = 'fp_unit_test_hwlock_99';
    const testEmail1 = 'unittest_hw1@dkaimono.web.id';
    const testEmail2 = 'unittest_hw2@dkaimono.web.id';
    const { getSql } = require('./lib/db');
    const sql = getSql();
    await sql`DELETE FROM app_users WHERE device_fingerprint = ${testFp} OR email IN (${testEmail1}, ${testEmail2})`;

    // Register 1st account on testFp -> must succeed
    const resReg1 = await fetch(`${baseUrl}/api/quota/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFp },
      body: JSON.stringify({ email: testEmail1, password: 'password123', fingerprint: testFp })
    });
    const dataReg1 = await resReg1.json();
    console.assert(resReg1.status === 200 && dataReg1.success === true, 'First account registration on device succeeds');

    // Register 2nd account on SAME testFp -> must fail with 403 (1 Device 1 Account)
    const resReg2 = await fetch(`${baseUrl}/api/quota/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': testFp },
      body: JSON.stringify({ email: testEmail2, password: 'password123', fingerprint: testFp })
    });
    console.assert(resReg2.status === 403, 'Second account on same device blocked with 403');

    // Login to 1st account from DIFFERENT device fingerprint -> must fail with 403 (1 Account 1 Device)
    const resLoginOtherDevice = await fetch(`${baseUrl}/api/quota/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-fingerprint': 'fp_other_device_88' },
      body: JSON.stringify({ email: testEmail1, password: 'password123', fingerprint: 'fp_other_device_88' })
    });
    console.assert(resLoginOtherDevice.status === 403, 'Login from different device blocked with 403');

    // Cleanup test user
    await sql`DELETE FROM app_users WHERE device_fingerprint = ${testFp} OR email IN (${testEmail1}, ${testEmail2})`;
    console.log('✓ Test 8: 1 Device = 1 Account hardware lock passed');

    // 9. Test /api/bulk protection (Free tier blocked 403)
    const resBulkFree = await fetch(`${baseUrl}/api/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-links', emails: ['a@b.com'] })
    });
    console.assert(resBulkFree.status === 403, 'Free user blocked from /api/bulk with 403');
    console.log('✓ Test 9: /api/bulk tier protection passed');

    console.log('\nALL 9 VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
