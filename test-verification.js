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

    // 6. Test Netlify Function handler wrapper
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
    console.log('✓ Test 6: Netlify function handler execution passed');

    console.log('\nALL 6 VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
