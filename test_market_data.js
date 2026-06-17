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

    // debug: print raw lines around keywords
    const debugLines = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const keywords = ['S&P 500', 'NASDAQ', 'DJIA', 'US 10-YR'];
      const out = [];
      lines.forEach((line, i) => {
        if (keywords.some(k => line.toUpperCase().includes(k.toUpperCase()))) {
          // แสดง 5 บรรทัดรอบๆ
          for (let j = Math.max(0, i-1); j < Math.min(lines.length, i+6); j++) {
            out.push(`  [${j}] ${lines[j]}`);
          }
          out.push('  ---');
        }
      });
      return out;
    });
    console.log('\n--- DEBUG LINES ---');
    debugLines.forEach(l => console.log(l));

    const result = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // format จริง: "DJIA" บรรทัด N, "51,999.67\t+328.64\t+0.64" บรรทัด N+1
      const findPctAfterTabLine = (keyword) => {
        const idx = lines.findIndex(l => l.toUpperCase() === keyword.toUpperCase());
        if (idx === -1) return '';
        const next = lines[idx + 1] || '';
        // tab-separated: LAST\tCHG\t%CHG
        const parts = next.split('\t');
        if (parts.length >= 3) {
          const pct = parts[parts.length - 1].trim();
          if (/^[+-]?\d+\.?\d*$/.test(pct)) return (parseFloat(pct) >= 0 ? '+' : '') + pct + '%';
        }
        return '';
      };

      // ดึงจาก AMERICAS MARKETS section (Line 188+) ที่มี tab-separated
      const sp500  = findPctAfterTabLine('S&P 500');
      const nasdaq = findPctAfterTabLine('NASDAQ');
      const djia   = findPctAfterTabLine('DJIA');

      // Bond Yield: "US 10-YR" / "4.441\t+0.013" tab-separated บรรทัดถัดไป
      let bondValue = '', bondChange = '';
      const bondIdx = lines.findIndex(l => /^US\s*10-YR$/i.test(l));
      if (bondIdx !== -1) {
        const next = lines[bondIdx + 1] || '';
        const parts = next.split('\t');
        if (parts.length >= 2) {
          bondValue  = parts[0].trim();
          bondChange = parts[1].trim();
        }
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
      const dateMatch = allText.match(/Last Price[^\n]*\n([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/)
        || allText.match(/([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/);
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
      console.log('Worst:', down[0] ? `${down[0].name} ${down[0].change.toFixed(2)}%` : 'N/A');
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
