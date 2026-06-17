const { chromium } = require('playwright');

async function testMarketData() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // ─── TEST 1: cnbc.com/markets/ ───────────────────────────────────────────
  console.log('\n==============================');
  console.log('TEST 1: cnbc.com/markets/');
  console.log('==============================');
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const raw = await page.evaluate(() => document.body.innerText);

    // แสดง 3000 ตัวอักษรแรก
    console.log('\n--- RAW TEXT (first 3000 chars) ---');
    console.log(raw.substring(0, 3000));

    // หาบรรทัดที่มี S&P, NASDAQ, DJIA, Dow, 10-YR
    console.log('\n--- LINES containing keywords ---');
    const lines = raw.split('\n');
    lines.forEach((line, i) => {
      if (/S&P|NASDAQ|DJIA|Dow|10.YR|10-YR/i.test(line)) {
        console.log(`Line ${i}: [${line.trim()}]`);
      }
    });

    await page.close();
  } catch (e) {
    console.error('TEST 1 ERROR:', e.message);
  }

  // ─── TEST 2: ssga.com/sector-tracker ─────────────────────────────────────
  console.log('\n==============================');
  console.log('TEST 2: ssga.com/sector-tracker');
  console.log('==============================');
  try {
    const page = await browser.newPage();
    await page.goto('https://www.ssga.com/us/en/intermediary/resources/sector-tracker', {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await page.waitForTimeout(5000);

    const raw = await page.evaluate(() => document.body.innerText);

    console.log('\n--- RAW TEXT (first 3000 chars) ---');
    console.log(raw.substring(0, 3000));

    // หาบรรทัดที่มี sector names หรือ %
    console.log('\n--- LINES containing % or sector names ---');
    const lines = raw.split('\n');
    lines.forEach((line, i) => {
      if (/%|XLK|XLF|XLV|XLC|XLY|XLP|XLE|XLI|XLB|XLRE|XLU|Technology|Energy|Financials/i.test(line)) {
        console.log(`Line ${i}: [${line.trim()}]`);
      }
    });

    await page.close();
  } catch (e) {
    console.error('TEST 2 ERROR:', e.message);
  }

  await browser.close();
  console.log('\nDone.');
}

testMarketData().catch(console.error);
