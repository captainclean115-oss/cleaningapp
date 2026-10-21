const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.argv[2] || 'https://captainclean115-oss.github.io/cleaningapp/';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await browser.newPage();

  const consoleMsgs = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack || err.message || String(err));
  });
  page.on('requestfailed', (req) => {
    consoleMsgs.push({ type: 'requestfailed', text: req.url() + ' -- ' + (req.failure() && req.failure().errorText) });
  });

  let navError = null;
  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    navError = e.message;
  }

  await new Promise((r) => setTimeout(r, 2000));

  const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '(no body)');
  const bodyHtmlLen = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0);

  console.log('=== URL ===', URL);
  console.log('=== nav error ===', navError);
  console.log('=== visible body text (first 500 chars) ===');
  console.log(JSON.stringify(bodyText));
  console.log('=== body innerHTML length ===', bodyHtmlLen);
  console.log('=== page errors (uncaught exceptions) ===');
  pageErrors.forEach((e, i) => console.log('--- pageerror ' + i + ' ---\n' + e));
  console.log('=== console messages (errors/warnings only) ===');
  consoleMsgs.filter((m) => m.type === 'error' || m.type === 'warning' || m.type === 'requestfailed')
    .forEach((m, i) => console.log('[' + m.type + '] ' + m.text));

  await browser.close();
})();
