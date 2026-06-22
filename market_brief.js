const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  HeadingLevel, LevelFormat, BorderStyle, ExternalHyperlink,
  Table, TableRow, TableCell, WidthType, ShadingType,
} = require('docx');

// ─── 0. Playwright: ดึง Market Data จาก 2 แหล่ง ────────────────────────────

async function getMarketData(browser) {
  // บันทึก timestamp ตอนเริ่ม getMarketData() (เวลาไทย)
  const _now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const _thM = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const _fetchedAt = `${_now.getUTCDate()} ${_thM[_now.getUTCMonth()]} ${_now.getUTCFullYear() + 543} เวลา ${String(_now.getUTCHours()).padStart(2,'0')}:${String(_now.getUTCMinutes()).padStart(2,'0')} น.`;

  const result = {
    sp500: '', nasdaq: '', dow: '',
    fetchedAt: _fetchedAt, // timestamp ตอนเริ่มดึงข้อมูล
    yield10y: { value: '', change: '', direction: '' },
    sectors: { upCount: 0, upList: '', best: '', worst: '', dateTh: '', table: [] },
    // table: [{ name, daily, weekly }] เรียงตาม daily change
  };

  // 0.1 ดัชนีหลัก + Bond Yield — cnbc.com/markets/
  // format จริง: ชื่อ / LAST / CHG / %CHG แต่ละบรรทัดแยกกัน
  // US 10-YR / "4.439\t+0.011" tab-separated บรรทัดถัดไป
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const marketAll = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // ── ดัชนีหลัก: ชื่อ/LAST/CHG/%CHG คนละบรรทัด offset +1/+2/+3 ──
      const getIndexData = (keyword) => {
        const idx = lines.findIndex(l => l.toUpperCase() === keyword.toUpperCase());
        if (idx === -1) return null;
        const last   = (lines[idx + 1] || '').trim();
        const chg    = (lines[idx + 2] || '').trim();
        const pctRaw = (lines[idx + 3] || '').trim();
        const m = pctRaw.match(/^([+-]?\d+\.?\d*)$/);
        if (!m) return null;
        const num  = parseFloat(m[1]);
        const sign = pctRaw.startsWith('+') || pctRaw.startsWith('-') ? '' : (num >= 0 ? '+' : '');
        return { last, chg, pct: sign + pctRaw + '%' };
      };

      const sp500  = getIndexData('S&P 500');
      const nasdaq = getIndexData('NASDAQ');
      const djia   = getIndexData('DJIA');

      // ── Bond Yield: "US 10-YR" / "4.439\t+0.011" tab-separated ──
      let bondValue = '', bondChange = '';
      const bondIdx = lines.findIndex(l => /^US\s*10-YR$/i.test(l));
      if (bondIdx !== -1) {
        const parts = (lines[bondIdx + 1] || '').split('\t');
        if (parts.length >= 2) {
          bondValue  = parts[0].trim();
          bondChange = parts[1].trim();
        }
      }

      return { sp500, nasdaq, djia, bondValue, bondChange };
    });

    // เก็บ object เต็ม { last, chg, pct } สำหรับใช้ใน docx
    result.sp500  = marketAll.sp500  || null;
    result.nasdaq = marketAll.nasdaq || null;
    result.dow    = marketAll.djia   || null;
    result.yield10y.value = marketAll.bondValue ? marketAll.bondValue + '%' : '';
    if (marketAll.bondChange) {
      const raw = parseFloat(marketAll.bondChange);
      const bps = raw * 100;
      // ป้องกัน ++ กรณี bondChange มี + อยู่แล้ว
      const changeStr = marketAll.bondChange.startsWith('+') || marketAll.bondChange.startsWith('-')
        ? marketAll.bondChange
        : (raw >= 0 ? '+' : '') + marketAll.bondChange;
      result.yield10y.change    = `${changeStr} (${bps % 1 === 0 ? bps : bps.toFixed(1)} bps)`;
      result.yield10y.direction = raw >= 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    }
    await page.close();
    console.log('S&P 500:', marketAll.sp500  ? `${marketAll.sp500.last} | change: ${marketAll.sp500.chg} (${marketAll.sp500.pct})`   : 'NOT FOUND');
    console.log('NASDAQ :', marketAll.nasdaq ? `${marketAll.nasdaq.last} | change: ${marketAll.nasdaq.chg} (${marketAll.nasdaq.pct})` : 'NOT FOUND');
    console.log('DJIA   :', marketAll.djia   ? `${marketAll.djia.last} | change: ${marketAll.djia.chg} (${marketAll.djia.pct})`     : 'NOT FOUND');
    console.log('Bond yield:', result.yield10y);
  } catch (e) {
    console.error('getMarketData indices+bond error:', e.message);
  }

  // 0.2 Sector Performance — ssga.com sector-tracker
  // format จริง (คนละบรรทัด):
  // XLK
  // Information Technology\t191.79\t184.80\t+6.99
  // +3.78
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

      // ดึงวันที่ล่าสุดจาก "Last Price ($)" column เช่น "Jun 15 2026"
      let lastPriceDate = '';
      const allText = document.body.innerText;
      const dateMatch = allText.match(/Last Price[^\n]*\n([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/)
        || allText.match(/([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/);
      if (dateMatch) lastPriceDate = dateMatch[1];

      lines.forEach((line, i) => {
        const ticker = line.trim();
        if (!sectorMap[ticker]) return;
        const name = sectorMap[ticker];
        // format: XLK / "Information Technology\t191.79\t184.80\t+6.99" / "+3.78"
        // last price อยู่บรรทัด i+1 หลัง tab แรก
        let lastPrice = '';
        const nextLine = lines[i + 1] || '';
        const parts = nextLine.split('\t');
        if (parts.length >= 2) lastPrice = parts[1].trim(); // index 1 = Last Price
        // หา % change ใน 3 บรรทัดถัดไป รูปแบบ "+3.78" หรือ "-3.48"
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const m = lines[j].match(/^([+-]\d+\.\d+)$/);
          if (m) {
            results.push({ name, ticker, change: parseFloat(m[1]), lastPrice });
            break;
          }
        }
      });

      return { sectors: results, lastPriceDate };
    });

    const { sectors, lastPriceDate } = sectorData;
    if (sectors.length > 0) {
      const up   = sectors.filter(s => s.change > 0).sort((a, b) => b.change - a.change);
      const down = sectors.filter(s => s.change < 0).sort((a, b) => a.change - b.change);
      const best  = up[0]   ? `${up[0].name} +${up[0].change.toFixed(2)}%`   : '';
      const worst = down[0] ? `${down[0].name} ${down[0].change.toFixed(2)}%` : '';
      const upList = up.map(s => `${s.name} +${s.change.toFixed(2)}%`).join(', ');
      // แปลงวันที่เป็นภาษาไทย เช่น "Jun 15 2026" → "15 มิ.ย. 2569"
      const thMonths = {Jan:'ม.ค.',Feb:'ก.พ.',Mar:'มี.ค.',Apr:'เม.ย.',May:'พ.ค.',Jun:'มิ.ย.',
                        Jul:'ก.ค.',Aug:'ส.ค.',Sep:'ก.ย.',Oct:'ต.ค.',Nov:'พ.ย.',Dec:'ธ.ค.'};
      let sectorDateTh = '';
      if (lastPriceDate) {
        const [mon, day, year] = lastPriceDate.split(' ');
        sectorDateTh = `${parseInt(day)} ${thMonths[mon] || mon} ${parseInt(year) + 543}`;
      }
      // เก็บ weeklyMap ไว้สำหรับ merge กับ CNBC daily ทีหลัง
      const weeklyMap = {};
      sectors.forEach(s => { weeklyMap[s.name] = { change: s.change, last: s.lastPrice || '' }; });
      result.sectors = { upCount: up.length, upList, best, worst, dateTh: sectorDateTh, weeklyMap, table: [] };
    }
    await page.close();
    console.log('Sectors (weekly):', result.sectors.upCount, 'up,', result.sectors.best, '/', result.sectors.worst);
  } catch (e) {
    console.error('getMarketData sector error:', e.message);
  }

  // 0.3 Sector Daily — cnbc.com/markets/sectors/
  // format: "TECHNOLOGY" / "6742.74\t-160.23\t-2.32\t..." tab-separated
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/sectors/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const cnbcSectors = await page.evaluate(() => {
      const cnbcSectorMap = {
        'TECHNOLOGY':        { name: 'Information Technology', etf: 'XLK' },
        'ENERGY':            { name: 'Energy',                 etf: 'XLE' },
        'FINANCIALS':        { name: 'Financials',             etf: 'XLF' },
        'UTILITIES':         { name: 'Utilities',              etf: 'XLU' },
        'INDUSTRIALS':       { name: 'Industrials',            etf: 'XLI' },
        'MATERIALS':         { name: 'Materials',              etf: 'XLB' },
        'HEALTH':            { name: 'Health Care',            etf: 'XLV' },
        'CONS STPL':         { name: 'Consumer Staples',       etf: 'XLP' },
        'CONS DISC':         { name: 'Consumer Discretionary', etf: 'XLY' },
        'COMMUNICATION SVS': { name: 'Communication Services', etf: 'XLC' },
        'REAL ESTATE':       { name: 'Real Estate',            etf: 'XLRE' },
      };
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const results = [];
      lines.forEach((line, i) => {
        const sector = cnbcSectorMap[line.trim().toUpperCase()];
        if (!sector) return;
        const parts = (lines[i + 1] || '').split('\t');
        if (parts.length >= 3) {
          const m = parts[2].trim().match(/^([+-]?\d+\.?\d*)$/);
          if (m) results.push({ name: sector.name, ticker: sector.etf, daily: parseFloat(m[1]), last: parts[0].trim() });
        }
      });
      return results;
    });
    await page.close();

    // merge daily + weekly เข้า table เรียงตาม daily
    if (cnbcSectors.length > 0) {
      // ใช้ weeklyMap ที่เก็บไว้ใน result.sectors.weeklyMap โดยตรง
      const weeklyMap = result.sectors.weeklyMap || {};

      const upDaily   = cnbcSectors.filter(s => s.daily > 0).sort((a, b) => b.daily - a.daily);
      const downDaily = cnbcSectors.filter(s => s.daily <= 0).sort((a, b) => a.daily - b.daily);
      const allSorted = [...upDaily, ...downDaily];

      result.sectors.table    = allSorted.map(s => {
        const w = weeklyMap[s.name];
        const dailySign = s.daily > 0 ? '+' : '';
        return {
          sector:  `${s.name} (${s.ticker})`,
          daily:   `${s.last} (${dailySign}${s.daily.toFixed(2)}%)`,
          weekly:  w ? `${w.last} (${w.change > 0 ? '+' : ''}${w.change.toFixed(2)}%)` : '-',
        };
      });
      result.sectors.upCount  = upDaily.length;
      result.sectors.best     = upDaily[0]   ? upDaily[0].name   + ' ' + (upDaily[0].daily > 0 ? '+' : '')   + upDaily[0].daily.toFixed(2)   + '%' : '';
      result.sectors.worst    = downDaily[0] ? downDaily[0].name + ' ' + downDaily[0].daily.toFixed(2) + '%' : '';
      console.log('Sectors (daily): up', upDaily.length, '| best:', result.sectors.best, '| worst:', result.sectors.worst);
    }
  } catch (e) {
    console.error('getMarketData cnbc sectors error:', e.message);
  }

  return result;
}

// ─── 1. Playwright: ดึง article list + trending จาก cnbc.com/latest/ ─────────

async function getArticleList(browser) {
  const page = await browser.newPage();
  await page.goto('https://www.cnbc.com/latest/', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  const articles = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    document.querySelectorAll('a[href]').forEach(a => {
      const url = a.href;
      if (!url.match(/cnbc\.com\/202[56]\/\d{2}\/\d{2}\//)) return;
      if (seen.has(url)) return;
      seen.add(url);

      const title = (a.textContent || '').trim();
      if (title.length < 15) return;

      let container = a;
      for (let i = 0; i < 6; i++) {
        container = container.parentElement;
        if (!container) break;
        if (container.querySelector('time') ||
            /\d+ (min|hour|day)s? ago|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(container.textContent)) {
          break;
        }
      }
      const timeEl = container?.querySelector('time');
      const timeText = timeEl?.getAttribute('datetime') || timeEl?.textContent.trim() || '';
      const isPro = /\bPRO\b/.test(container?.textContent || '');

      results.push({ url, title, time: timeText, isPro, source: 'latest' });
    });

    const trendingUrls = new Set();
    document.querySelectorAll('[class*="trending"] a, [class*="Trending"] a, [class*="TrendingNow"] a').forEach(a => {
      if (a.href && a.href.match(/cnbc\.com\/202\d\/\d{2}\/\d{2}\//)) {
        trendingUrls.add(a.href);
      }
    });
    document.querySelectorAll('a').forEach(a => {
      const p = a.closest('[class*="trending"],[class*="Trending"]');
      if (p && a.href && a.href.match(/cnbc\.com\/20\d{2}\/\d{2}\/\d{2}\//)) {
        trendingUrls.add(a.href);
      }
    });

    trendingUrls.forEach(url => {
      if (!seen.has(url)) {
        seen.add(url);
        results.push({ url, title: '', time: '', isPro: false, source: 'trending' });
      }
    });

    return results;
  });

  await page.close();
  return articles;
}

// ─── 2. Playwright: ดึง content + UTC timestamp ของแต่ละบทความ ───────────────

async function getArticleContent(browser, article, retries) {
  if (retries === undefined) retries = article._retries ?? 1;
  const page = await browser.newPage();
  const isLiveUpdate = /live.update|live-update/i.test(article.url);
  try {
    // live update pages ต้องรอนานขึ้นเพราะ content โหลดช้า
    await page.goto(article.url, { waitUntil: 'networkidle', timeout: isLiveUpdate ? 45000 : 30000 });
    if (isLiveUpdate) await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const metaTime = document.querySelector('meta[property="article:published_time"]')?.content
        || document.querySelector('time[datetime]')?.getAttribute('datetime')
        || '';

      const bodyText = document.body.innerText;
      if (bodyText.length < 200 && /subscri|sign.?in|premium/i.test(bodyText)) {
        return { isPro: true, content: '', publishedTime: metaTime, headline: '' };
      }

      const headline = document.querySelector('h1')?.textContent.trim() || '';

      const articleEl =
        document.querySelector('[class*="ArticleBody"]') ||
        document.querySelector('article') ||
        document.querySelector('.article-body') ||
        document.querySelector('main');

      const content = (articleEl || document.body).innerText;
      return { isPro: false, content: content.substring(0, 3500), publishedTime: metaTime, headline };
    });

    return { ...article, ...result };
  } catch (e) {
    await page.close();
    if (retries > 0) {
      return getArticleContent(browser, article, retries - 1);
    }
    return { ...article, isPro: false, content: '', publishedTime: '', headline: '' };
  } finally {
    await page.close();
  }
}

async function fetchArticlesParallel(browser, articles, concurrency = 4) {
  const results = [];
  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(a => getArticleContent(browser, a)));
    results.push(...batchResults);
  }
  return results;
}

// ─── 3. Claude API: สรุป + categorize เป็น JSON ────────────────────────────

async function summarizeWithClaude(articlesText) {
  const client = new Anthropic();

  const system = `คุณคือนักวิเคราะห์การเงินที่สรุปข่าวตลาดเป็นภาษาไทย

## กฎการกรอง
- รับเฉพาะบทความที่เผยแพร่ภายใน 24 ชั่วโมงก่อนรัน บทความเก่ากว่านั้นตัดออก
- ต้องเขียนสรุปบทความที่ได้รับทุกบทความ ยกเว้นเฉพาะ: Sports, Lifestyle ล้วนๆ, Entertainment ล้วนๆ, Mad Money/Cramer/CNBC Pro/CNBC Club
- ทุกอย่างนอกจาก 4 ประเภทนี้ → เก็บทั้งหมด ห้ามตัดเพราะคิดเองว่าไม่สำคัญ ไม่เกี่ยวการเงิน หรือเป็น opinion
- บทความที่รวมกันได้ตามกฎการรวมข่าว → นับเป็น 1 ข่าว (จำนวน news items อาจน้อยกว่าจำนวนบทความที่รับมา)
- opinion ของนักวิเคราะห์สามารถอยู่ใน bullets ได้ แต่ต้องเป็นส่วนประกอบของข่าวจริง

## กฎการรวมข่าว
- รวมได้เฉพาะ same actor + same event เท่านั้น
- ห้ามรวมข่าว central bank policy (Fed, BOJ, ECB ฯลฯ) กับข่าวตลาด (ดัชนี, หุ้น) แม้จะเกิดวันเดียวกัน เพราะเป็นคนละ actor และคนละ event — ต้องแยกเป็นคนละข่าวเสมอ
- เมื่อรวม ให้ระบุ timestamp แยกกันในช่อง time และรวม URL ทั้งหมดไว้ใน urls
- ถ้าบทความที่รวมเป็น escalation หรือเหตุการณ์ต่อเนื่อง ให้เรียง context ตามลำดับเวลาจากเก่าไปใหม่เสมอ
- บทความที่มี update ให้ใช้ version update เป็นหลัก timestamp ใช้ของ update นั้น

## กฎการ categorize
กำหนด category 1 อันที่ตรงกับ main focus:
- "market": ดัชนี (Dow/S&P/Nasdaq/SET), sector rotation, commodities, crypto, currency, Fed funds rate outlook
- "company": earnings, M&A, IPO, CEO/management, product launch, layoffs, legal/regulatory ของบริษัทเฉพาะ
- "economy": GDP, CPI, jobs report, PMI, trade data, นโยบาย central bank, geopolitics ที่กระทบ macro

## กฎการเขียน

- ภาษาไทย เขียนเหมือนอัปเดตงานให้ผู้ใหญ่ฟัง กระชับ ตรงประเด็น
- 3 bullets ต่อข่าว ห้ามขึ้นต้น bullet ด้วย label
  - bullet 1: เกิดอะไรขึ้น ใคร ทำอะไร ตัวเลขคืออะไร
  - bullet 2: บริบทหรือที่มาที่ช่วยให้เข้าใจ
  - bullet 3: ผลกระทบ — ต้องมาจากบทความเท่านั้น ห้าม inference เอง
- รวม 3 bullets ไม่เกิน 250 คำต่อข่าว
- ห้ามใช้ - เป็น connector ให้ใช้ "โดย / ขณะที่ / ส่งผลให้" แทน
- ใส่วงเล็บอธิบายเฉพาะ acronym และศัพท์เฉพาะทางที่คนทั่วไปไม่รู้จัก
- หัวข้อข่าว: แปลเป็นภาษาไทยทั้งหมด ยกเว้นคำเฉพาะเช่นชื่อบริษัท ชื่อหุ้น
- URLs label: ใช้ headline จริงของบทความ ห้ามแต่งเอง
- ภาพรวมข่าว 2-3 ประโยค ต้องระบุตัวเลขและชื่อหุ้นเฉพาะ (ส่วนนี้คือสรุปข่าวเด่นเท่านั้น ไม่ต้องรวม market data)
- เวลาที่แสดงใน time field ให้ใช้ค่า "Published (Thai)" ที่ส่งมาให้ตรงๆ ห้ามคำนวณหรือแปลงเองเด็ดขาด
- ลำดับ section ตายตัว: market → economy → company

ตอบเป็น JSON ล้วน ไม่มี markdown backticks:
{
  "date_th": "วันX ที่X เดือน พ.ศ.",
  "date_slug": "YYYY-MM-DD (ปี Gregorian เช่น 2026-06-21 ห้ามใช้ปี พ.ศ.)",
  "overview_news": "สรุปข่าวเด่น 2-3 ประโยค ระบุตัวเลขและชื่อหุ้นเฉพาะ",
  "news": [{
    "category": "market|company|economy",
    "title": "headline แปลเป็นภาษาไทย",
    "time": "X มิ.ย. 256X (HH:MM UTC = HH:MM น. ไทย)",
    "bullets": ["bullet1", "bullet2", "bullet3"],
    "urls": [{ "url": "https://...", "label": "headline จริงของบทความภาษาอังกฤษ" }]
  }]
}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    temperature: 0,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: articlesText }],
  });

  const text = msg.content[0].text.trim().replace(/^```json|```$/g, '').trim();
  try {
    return JSON.parse(text);
  } catch(e) {
    const msg2 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: articlesText }],
    });
    const text2 = msg2.content[0].text.trim().replace(/^```json|```$/g, '').trim();
    return JSON.parse(text2);
  }
}

// ─── helper: sanitize text กรองอักขระที่ font TH Sarabun New ไม่รองรับ ──────
function sanitize(text) {
  if (!text) return '';
  // เก็บเฉพาะ: ไทย, ASCII (อังกฤษ/ตัวเลข/เครื่องหมาย), และ whitespace
  return text.replace(/[^ -฀-๿\s]/g, '');
}

// ─── 4. สร้าง .docx ──────────────────────────────────────────────────────────

function buildDocx(data, marketData) {
  const BLUE = '1F3864', GRAY = '5F6368', SECTION_BG = 'EAF0FB';

  const hline = () => new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DADCE0', space: 1 } },
    spacing: { before: 60, after: 0 }, children: [],
  });

  const sectionHeader = (label) => new Paragraph({
    spacing: { before: 280, after: 100 },
    shading: { fill: SECTION_BG, type: 'clear', color: 'auto' },
    children: [new TextRun({ text: label, bold: true, size: 30, color: BLUE, font: 'TH Sarabun New' })],
  });

  const subHeader = (label) => new Paragraph({
    spacing: { before: 120, after: 40 },
    children: [new TextRun({ text: label, bold: true, size: 22, color: BLUE, font: 'TH Sarabun New' })],
  });

  const bodyText = (text) => new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [new TextRun({ text, size: 22, font: 'TH Sarabun New' })],
  });

  // ─── สร้าง Overview blocks ───────────────────────────────────────────────
  const overviewBlocks = [];

  // ดัชนีหลัก
  overviewBlocks.push(subHeader('ดัชนีหลัก'));
  const fmtIndex = (label, d) => d ? `ดัชนี ${label} ${d.last} (${d.pct})` : '';
  const indexText = [
    fmtIndex('S&P 500',   marketData.sp500),
    fmtIndex('Nasdaq',    marketData.nasdaq),
    fmtIndex('Dow Jones', marketData.dow),
  ].filter(Boolean).join(', ');
  overviewBlocks.push(bodyText(indexText || '(ไม่สามารถดึงข้อมูลได้)'));

  // อัตราผลตอบแทนพันธบัตร
  overviewBlocks.push(subHeader('อัตราผลตอบแทนพันธบัตร'));
  const yieldText = marketData.yield10y.value
    ? `อัตราผลตอบแทนพันธบัตรรัฐบาลสหรัฐฯ อายุ 10 ปี ปรับตัว${marketData.yield10y.direction} ${marketData.yield10y.change} อยู่ที่ระดับ ${marketData.yield10y.value}`
    : '(ไม่สามารถดึงข้อมูลได้)';
  overviewBlocks.push(bodyText(yieldText));

  // ผลตอบแทนรายกลุ่ม
  overviewBlocks.push(subHeader('ผลตอบแทนรายกลุ่ม'));

  if (marketData.sectors.table && marketData.sectors.table.length > 0) {
    // สรุป 1 ประโยค
    const summaryText = sanitize(`หุ้น ${marketData.sectors.upCount} จาก 11 กลุ่มปรับตัวเพิ่มขึ้น โดยกลุ่มที่ปรับตัวเพิ่มขึ้นมากที่สุด คือ ${marketData.sectors.best} ส่วนกลุ่มที่ปรับตัวลดลงมากที่สุด คือ ${marketData.sectors.worst}`);
    overviewBlocks.push(bodyText(summaryText));

    // ตาราง sector
    // A4 content width = 11906 - 1417 (left) - 1134 (right) = 9355 DXA
    // col widths: Sector 55%, วันนี้ 22.5%, สัปดาห์ 22.5%
    const COL1 = 5145, COL2 = 2105, COL3 = 2105;
    const border = { style: BorderStyle.SINGLE, size: 1, color: 'DADCE0' };
    const borders = { top: border, bottom: border, left: border, right: border };

    const makeCell = (text, isHeader, isUp) => {
      const color = isHeader ? BLUE : (isUp === true ? '1A7340' : isUp === false ? 'C0392B' : '333333');
      const fill  = isHeader ? 'EAF0FB' : 'FFFFFF';
      const colW  = arguments[3] || COL1;
      return new TableCell({
        width: { size: colW, type: WidthType.DXA },
        borders,
        shading: { fill, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: String(text), bold: isHeader, size: 18, color, font: 'TH Sarabun New' })],
        })],
      });
    };

    const weeklyHeader = `สัปดาห์${marketData.sectors.dateTh ? ' (ณ ' + marketData.sectors.dateTh + ')' : ''}`;

    const sectorTable = new Table({
      width: { size: COL1 + COL2 + COL3, type: WidthType.DXA },
      columnWidths: [COL1, COL2, COL3],
      rows: [
        new TableRow({ children: [
          makeCell('Sector',       true, null, COL1),
          makeCell('วันนี้ (CNBC)', true, null, COL2),
          makeCell(weeklyHeader,   true, null, COL3),
        ]}),
        ...marketData.sectors.table.map(s => {
          const isUpDaily  = s.daily.includes('(+');
          const isUpWeekly = s.weekly !== '-' && s.weekly.includes('(+');
          return new TableRow({ children: [
            makeCell(s.sector, false, null, COL1),
            makeCell(s.daily,  false, isUpDaily,        COL2),
            makeCell(s.weekly, false, s.weekly === '-' ? null : isUpWeekly, COL3),
          ]});
        }),
      ],
    });
    overviewBlocks.push(sectorTable);
    overviewBlocks.push(new Paragraph({ spacing: { before: 60, after: 0 }, children: [] }));
    if (marketData.fetchedAt) {
      overviewBlocks.push(new Paragraph({
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: `(ดึงข้อมูล ณ ${marketData.fetchedAt})`, size: 18, color: GRAY, italics: true, font: 'TH Sarabun New' })],
      }));
    }
  } else {
    overviewBlocks.push(bodyText('(ไม่สามารถดึงข้อมูลได้)'));
  }

  // สรุปภาพรวมข่าว
  overviewBlocks.push(subHeader('สรุปภาพรวมข่าว'));
  overviewBlocks.push(bodyText(sanitize(data.overview_news || data.overview || '')));

  // ─── News blocks ─────────────────────────────────────────────────────────
  const SECTIONS = [
    { key: 'market',  label: 'ตลาด' },
    { key: 'company', label: 'บริษัท' },
    { key: 'economy', label: 'ตัวเลขเศรษฐกิจ' },
  ];

  const newsBlock = (item, index) => {
    const blocks = [];
    blocks.push(new Paragraph({
      heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 60 },
      children: [new TextRun({ text: `${index + 1}.  ${sanitize(item.title)}`, bold: true, size: 24, color: BLUE, font: 'TH Sarabun New' })],
    }));
    blocks.push(new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: 'แหล่ง: ', bold: true, size: 18, color: GRAY, font: 'TH Sarabun New' }),
        new TextRun({ text: `CNBC   |   ${item.time}`, size: 18, color: GRAY, font: 'TH Sarabun New' }),
      ],
    }));
    item.bullets.forEach(b => blocks.push(new Paragraph({
      numbering: { reference: 'bullets', level: 0 }, spacing: { before: 40, after: 40 },
      children: [new TextRun({ text: sanitize(b), size: 21, font: 'TH Sarabun New' })],
    })));
    const linkLabel = new TextRun({ text: 'ลิงก์: ', size: 18, color: GRAY, font: 'TH Sarabun New', bold: true });
    if (item.urls.length === 1) {
      blocks.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [linkLabel, new ExternalHyperlink({
          link: item.urls[0].url,
          children: [new TextRun({ text: sanitize(item.urls[0].label), size: 18, color: '1A73E8', underline: {}, font: 'TH Sarabun New' })],
        })],
      }));
    } else {
      blocks.push(new Paragraph({ spacing: { before: 60, after: 20 }, children: [linkLabel] }));
      item.urls.forEach(u => blocks.push(new Paragraph({
        spacing: { before: 0, after: 20 },
        children: [
          new TextRun({ text: '   - ', size: 18, color: GRAY, font: 'TH Sarabun New' }),
          new ExternalHyperlink({
            link: u.url,
            children: [new TextRun({ text: sanitize(u.label), size: 18, color: '1A73E8', underline: {}, font: 'TH Sarabun New' })],
          }),
        ],
      })));
      blocks.push(new Paragraph({ spacing: { before: 0, after: 40 }, children: [] }));
    }
    return blocks;
  };

  let globalIndex = 0;
  const groupedBlocks = [];
  SECTIONS.forEach(({ key, label }) => {
    const items = data.news.filter(n => n.category === key);
    if (items.length === 0) return;
    groupedBlocks.push(sectionHeader(label));
    items.forEach(item => {
      groupedBlocks.push(...newsBlock(item, globalIndex));
      globalIndex++;
    });
    groupedBlocks.push(hline());
  });

  return new Document({
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '-', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 240 } } } }] }] },
    styles: {
      default: { document: { run: { font: 'TH Sarabun New', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 40, bold: true, font: 'TH Sarabun New', color: BLUE }, paragraph: { spacing: { before: 0, after: 100 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: 'TH Sarabun New', color: BLUE }, paragraph: { spacing: { before: 220, after: 60 }, outlineLevel: 1 } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1417 } } },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Daily Market Brief', bold: true, size: 40, color: BLUE, font: 'TH Sarabun New' })] }),
        new Paragraph({ spacing: { before: 0, after: 80 }, children: [new TextRun({ text: data.date_th, size: 21, color: GRAY, font: 'TH Sarabun New' })] }),
        hline(),
        new Paragraph({ spacing: { before: 160, after: 80 }, children: [new TextRun({ text: 'ภาพรวม', bold: true, size: 26, color: BLUE, font: 'TH Sarabun New' })] }),
        ...overviewBlocks,
        hline(),
        new Paragraph({ spacing: { before: 160, after: 100 }, children: [new TextRun({ text: 'ข่าวสำคัญประจำวัน', bold: true, size: 28, color: BLUE, font: 'TH Sarabun New' })] }),
        ...groupedBlocks,
        new Paragraph({ spacing: { before: 120 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'ข้อมูลอ้างอิงจาก CNBC ณ วันที่จัดทำ — ไม่ใช่คำแนะนำการลงทุน', size: 16, color: GRAY, italics: true, font: 'TH Sarabun New' })] }),
      ],
    }],
  });
}

// ─── 5. ส่ง Gmail ────────────────────────────────────────────────────────────

async function sendEmail(dateSlug, dateTh, docxBuffer) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const [year, month, day] = dateSlug.split('-');
  const buddhistYear = parseInt(year) + 543;
  const shortDate = `${parseInt(day)} ${months[parseInt(month)-1]} ${buddhistYear}`;
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.GMAIL_TO,
    subject: `Daily Market Brief ประจำวันที่ ${shortDate}`,
    text: `สวัสดีค่ะพี่อรรถ\n\nขออนุญาตส่ง Daily Market Brief ประจำวันที่ ${shortDate} ค่ะ\n\nขอบคุณค่ะ\nนันท์`,
    attachments: [{ filename: `Market_Brief_${dateSlug}.docx`, content: docxBuffer }],
  });
  console.log(`Sent: Market_Brief_${dateSlug}.docx`);
}

// ─── Helper: UTC → เวลาไทย ───────────────────────────────────────────────────

function utcToThaiTime(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  if (isNaN(d)) return '';
  const thai = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const day = thai.getUTCDate();
  const mon = months[thai.getUTCMonth()];
  const year = thai.getUTCFullYear() + 543;
  const hh = String(thai.getUTCHours()).padStart(2, '0');
  const mm = String(thai.getUTCMinutes()).padStart(2, '0');
  const utcHH = String(d.getUTCHours()).padStart(2, '0');
  const utcMM = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${year} (${utcHH}:${utcMM} UTC = ${hh}:${mm} น. ไทย)`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    console.log('Step 0: Fetching market data...');
    const marketData = await getMarketData(browser);

    console.log('Step 1: Opening cnbc.com/latest/...');
    const articleList = await getArticleList(browser);
    console.log(`Found ${articleList.length} articles (latest + trending)`);

    const nonPro = articleList.filter(a => !a.isPro).slice(0, 40);
    console.log('Step 2-3: Fetching ' + nonPro.length + ' articles...');
    // live update pages ได้ retries เพิ่มเป็น 2 ครั้ง
    const articles = await fetchArticlesParallel(browser, nonPro.map(a => ({
      ...a,
      _retries: /live.update|live-update/i.test(a.url) ? 2 : 1,
    })));
    articles.forEach(a => console.log(a.url, '|', a.publishedTime));

    const oneDayAgo = new Date(Date.now() - 36 * 60 * 60 * 1000); // 36h เผื่อข่าววันหยุดสุดสัปดาห์
    const valid = articles
      .filter(a => {
        if (a.isPro) { console.log('SKIP isPro:', a.url); return false; }
        if (!a.content || a.content.length <= 100) {
          console.log('SKIP short content:', a.url, 'length:', a.content?.length ?? 0);
          return false;
        }
        return true;
      })
      .filter(a => {
        if (!a.publishedTime) return true;
        const date = new Date(a.publishedTime);
        if (isNaN(date)) return true;
        if (date <= oneDayAgo) { console.log('SKIP old:', a.url, a.publishedTime); return false; }
        return true;
      })
      .sort((a, b) => new Date(b.publishedTime) - new Date(a.publishedTime));
    console.log(`Valid articles after fetch: ${valid.length}`);

    const todayTh = new Date().toLocaleDateString('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    const articlesText = `วันที่ปัจจุบัน (ไทย): ${todayTh}\n\n` + valid.map(a =>
      `URL: ${a.url}\nHeadline: ${a.headline || a.title}\nPublished (UTC): ${a.publishedTime || a.time}\nPublished (Thai): ${utcToThaiTime(a.publishedTime)}\n\n${a.content}`
    ).join('\n\n---\n\n');

    console.log('Step 4: Summarizing with Claude...');
    const briefData = await summarizeWithClaude(articlesText);
    console.log(`Got ${briefData.news.length} news items`);

    console.log('Step 5: Building .docx...');
    const doc = buildDocx(briefData, marketData);
    const buffer = await Packer.toBuffer(doc);

    console.log('Sending email...');
    await sendEmail(briefData.date_slug, briefData.date_th, buffer);

    console.log('Done!');
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
