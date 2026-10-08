// End-to-end check of the extension against test/mock-server.js.
// Usage: node test/e2e.js   (needs playwright-core and a Chromium build)
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8080;
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareExtension() {
  // Copy the extension; the test only adds a stub service worker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listdl-ext-'));
  fs.cpSync(path.join(ROOT, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.background = { service_worker: 'test-sw.js' }; // only so the test can find the extension id
  fs.writeFileSync(path.join(dir, 'test-sw.js'), '');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

(async () => {
  // Self-signed certificate for the mock https server.
  const tls = fs.mkdtempSync(path.join(os.tmpdir(), 'listdl-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tls}/key.pem`,
    '-out', `${tls}/cert.pem`, '-days', '2', '-subj', '/CN=www.scribd.com'], { stdio: 'ignore' });
  const server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
    env: { ...process.env, PORT, PAGE_DELAY_MS: 2000, TLS_KEY: `${tls}/key.pem`, TLS_CERT: `${tls}/cert.pem` },
  });
  await sleep(500);
  const ext = prepareExtension();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'listdl-profile-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listdl-downloads-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false },
  }));
  // Launch Chrome ourselves and attach over CDP: Playwright's own launcher
  // takes over downloads, which would hide the extension's file naming.
  const chrome = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=9333',
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    '--host-resolver-rules=MAP www.scribd.com 127.0.0.1', '--no-proxy-server',
    '--no-first-run', '--no-sandbox',
    '--ignore-certificate-errors', // the mock server's certificate is self-signed
    'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2500);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  // Hand download handling back to Chrome (and so to the extension).
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  let failures = 0;
  const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const list = await ctx.newPage();
    await list.goto(`https://www.scribd.com:${PORT}/list`);

    const mgr = await ctx.newPage();
    await mgr.goto(`chrome-extension://${extId}/manager.html`);
    const tabId = await mgr.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url && t.url.includes('/list')).id;
    });
    await mgr.goto(`chrome-extension://${extId}/manager.html?scanTab=${tabId}`);
    await mgr.waitForFunction(() => /Found|No document|failed/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
    const job = await mgr.evaluate(async () => (await chrome.storage.local.get('job')).job);
    check(job.items.length === 12, `scan found ${job.items.length}/12 documents (load-more + scrolling)`);
    check(job.listTitle === 'My Test List', `list title "${job.listTitle}"`);
    check(job.items[0].title === 'Mock Document 1001', `kept the descriptive title "${job.items[0].title}"`);
    check(job.skippedNonDocuments.length === 1, 'book link reported as skipped');

    await mgr.fill('#delay', '0');
    await mgr.fill('#parallel', process.env.PARALLEL || '3');
    const started = Date.now();
    await mgr.click('#start');
    await mgr.waitForFunction(() => /Finished|Paused/.test(document.getElementById('status').textContent), null, { timeout: 300000 });
    console.log(`  run took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await sleep(2000);
    const after = await mgr.evaluate(async () => (await chrome.storage.local.get('job')).job.items);
    const byId = Object.fromEntries(after.map((i) => [i.id, i]));
    for (const i of after) console.log(`  ${i.id} ${i.status.padEnd(12)} ${i.detail}`);
    check(byId['1003'].status === 'no-download', 'document without a Download button is skipped, not scraped');
    check(byId['1002'].status === 'done', 'direct Download link works');
    check(byId['1001'].status === 'done', 'dialog flow (choose PDF, then Download) works');
    check(after.filter((i) => i.status === 'done').length === 11, '11 of 12 downloaded');
    const saved = fs.readdirSync(path.join(downloadDir, 'ListDL', 'My Test List')).sort();
    console.log('  saved files:', saved);
    check(saved.length === 11 && saved.includes('Mock Document 1001.pdf'), 'files saved as Downloads/ListDL/<list>/<title>.pdf');
    // With several documents in flight, each file must still carry its own document's name.
    const mismatched = saved.filter((f) => {
      const id = f.match(/(\d+)\.pdf$/)[1];
      return !fs.readFileSync(path.join(downloadDir, 'ListDL', 'My Test List', f), 'utf8').includes(`mock ${id}`);
    });
    check(mismatched.length === 0, `every file matches its document (${mismatched.length} mismatched)`);
    const openTabs = await mgr.evaluate(async () => (await chrome.tabs.query({})).filter((t) => /\/document\//.test(t.url)).length);
    check(openTabs === 0, 'document tabs closed afterwards');
  } finally {
    await browser.close().catch(() => {});
    chrome.kill();
    server.kill();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
