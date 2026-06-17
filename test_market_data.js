const { chromium } = require('playwright');
 
async function testMarketData() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
 
  // ─── TEST 1: cnbc.com/markets/ (ดัชนีหลัก + Bond Yield) ─────────────────
  console.log('\n==============================');
  console.log('TEST 1: cnbc.com/markets/');
  console.log('==============================');
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
 
    const result = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
 
      const findPctAfter = (keyword) => {
        const idx = lines.findIndex(l => l.toUpperCase() === keyword.toUpperCase());
        if (idx === -1) return '';
        for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i++) {
          const m = lines[i].match(/^([+-]\d+\.?\d*%)$/);
          if (m) return m[1];
        }
        return '';
      };
 
      const sp500  = findPctAfter('S&P 500');
      const nasdaq = findPctAfter('NASDAQ');
      const djia   = findPctAfter('DJIA');
 
      // Bond Yield: "US 10-YR" / yield บรรทัด+1 / change บรรทัด+2
      let bondValue = '', bondChange = '';
      const bondIdx = lines.findIndex(l => /^US\s*10-YR$/i.test(l));
      if (bondIdx !== -1) {
        if (lines[bondIdx + 1] && /^\d+\.\d+$/.test(lines[bondIdx + 1])) bondValue = lines[bondIdx + 1];
        if (lines[bondIdx + 2] && /^[+-]\d+\.\d+$/.test(lines[bondIdx + 2])) bondChange = lines[bondIdx + 2];
      }
 
      return { sp500, nasdaq, djia, bondValue, bondChange };
    });
 
    console.log('\n--- RESULT ---');
    console.log('S&P 500:  ', result.sp500  || 'NOT FOUND');
    console.log('NASDAQ:   ', result.nasdaq || 'NOT FOUND');
    console.log('DJIA:     ', result.djia   || 'NOT FOUND');
    if (result.bondValue) {
      const bps = result.bondChange ? Math.round(parseFloat(result.bondChange) * 100) : null;
      const bpsStr = bps !== null ? ` | change: ${result.bondChange} (${bps >= 0 ? '+' : ''}${bps} bps) | ${bps >= 0 ? 'เพิ่มขึ้น' : 'ลดลง'}` : '';
      console.log(`US 10-YR: ${result.bondValue}%${bpsStr}`);
    } else {
      console.log('US 10-YR: NOT FOUND');
    }
 
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
    await page.waitForTimeout(3000);
 
    const sectorData = await page.evaluate(() => {
      const sectorMap = {
        'XLK': 'Information Technology', 'XLF': 'Financials', 'XLV': 'Health Care',
        'XLC': 'Communication Services', 'XLY': 'Consumer Discretionary',
        'XLP': 'Consumer Staples', 'XLE': 'Energy', 'XLI': 'Industrials',
        'XLB': 'Materials', 'XLRE': 'Real Estate', 'XLU': 'Utilities',
      };
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const results = [];
 
      // ดึงวันที่ล่าสุดจาก "Last Price ($)" column
      let lastPriceDate = '';
      const allText = document.body.innerText;
      const dateMatch = allText.match(/Last Price[^\n]*\n([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/);
      if (dateMatch) lastPriceDate = dateMatch[1];
 
      lines.forEach((line, i) => {
        const ticker = line.trim();
        if (!sectorMap[ticker]) return;
        const name = sectorMap[ticker];
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const m = lines[j].match(/^([+-]\d+\.\d+)$/);
          if (m) {
            results.push({ name, ticker, change: parseFloat(m[1]) });
            break;
          }
        }
      });
 
      return { sectors: results, lastPriceDate };
    });
 
    const { sectors, lastPriceDate } = sectorData;
    console.log('\n--- RESULT ---');
    console.log('Last Price Date:', lastPriceDate || 'NOT FOUND');
    console.log('Sectors found:', sectors.length);
 
    if (sectors.length > 0) {
      const up   = sectors.filter(s => s.change > 0).sort((a, b) => b.change - a.change);
      const down = sectors.filter(s => s.change < 0).sort((a, b) => a.change - b.change);
      console.log(`\nUp (${up.length}):`)
      up.forEach(s => console.log(`  ${s.ticker} ${s.name}: +${s.change.toFixed(2)}%`));
      console.log(`\nDown (${down.length}):`)
      down.forEach(s => console.log(`  ${s.ticker} ${s.name}: ${s.change.toFixed(2)}%`));
      console.log('\nBest: ', up[0] ? `${up[0].name} +${up[0].change.toFixed(2)}%` : 'N/A');
      console.log('Worst:', down[down.length-1] ? `${down[down.length-1].name} ${down[down.length-1].change.toFixed(2)}%` : 'N/A');
    } else {
      console.log('NO SECTORS FOUND');
    }
 
    await page.close();
  } catch (e) {
    console.error('TEST 2 ERROR:', e.message);
  }
 
  await browser.close();
  console.log('\nDone.');
}
 
testMarketData().catch(console.error);
 
