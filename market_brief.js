const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  HeadingLevel, LevelFormat, BorderStyle, ExternalHyperlink,
} = require('docx');

// ─── 0. Playwright: ดึง Market Data จาก 3 แหล่ง ────────────────────────────

async function getMarketData(browser) {
  const result = {
    sp500: '', nasdaq: '', dow: '',
    yield10y: { value: '', change: '', direction: '' },
    sectors: { upCount: 0, upList: '', best: '', worst: '' },
  };

  // 0.1 ดัชนีหลัก — cnbc.com/markets/
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const indices = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('[class*="QuoteStrip"], [class*="marketData"], [class*="market-data"], [class*="summary-stock"]').forEach(el => {
        const text = el.innerText;
        const sp = text.match(/S&P\s*500[^\d-+]*([+-]?\d+\.?\d*%)/i);
        const nq = text.match(/Nasdaq[^\d-+]*([+-]?\d+\.?\d*%)/i);
        const dj = text.match(/Dow[^\d-+]*([+-]?\d+\.?\d*%)/i);
        if (sp) out.sp500 = sp[1];
        if (nq) out.nasdaq = nq[1];
        if (dj) out.dow = dj[1];
      });
      // fallback: scan all text
      if (!out.sp500) {
        const body = document.body.innerText;
        const sp = body.match(/S&P\s*500[^%\n]{0,30}([+-]\d+\.?\d*%)/i);
        const nq = body.match(/Nasdaq[^%\n]{0,30}([+-]\d+\.?\d*%)/i);
        const dj = body.match(/Dow[^%\n]{0,30}([+-]\d+\.?\d*%)/i);
        if (sp) out.sp500 = sp[1];
        if (nq) out.nasdaq = nq[1];
        if (dj) out.dow = dj[1];
      }
      return out;
    });
    Object.assign(result, indices);
    await page.close();
    console.log('Market indices:', result.sp500, result.nasdaq, result.dow);
  } catch (e) {
    console.error('getMarketData indices error:', e.message);
  }

  // 0.2 Bond Yield — cnbc.com/markets/bonds/
  try {
    const page = await browser.newPage();
    await page.goto('https://www.cnbc.com/markets/bonds/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const bond = await page.evaluate(() => {
      const body = document.body.innerText;
      // หา 10-Year yield value
      const yieldMatch = body.match(/10[- ]?Year[^%\n]{0,50}?(\d+\.\d+)%/i)
        || body.match(/US\s*10[- ]?Y[^%\n]{0,30}?(\d+\.\d+)%/i);
      // หา bps change
      const bpsMatch = body.match(/([+-]?\d+\.?\d*)\s*bps/i)
        || body.match(/([+-]?\d+\.?\d*)\s*basis/i);
      return {
        value: yieldMatch ? yieldMatch[1] + '%' : '',
        change: bpsMatch ? bpsMatch[1] : '',
      };
    });
    result.yield10y.value = bond.value;
    if (bond.change) {
      const bps = parseFloat(bond.change);
      result.yield10y.change = Math.abs(bps) + ' bps';
      result.yield10y.direction = bps >= 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    }
    await page.close();
    console.log('Bond yield:', result.yield10y);
  } catch (e) {
    console.error('getMarketData bond error:', e.message);
  }

  // 0.3 Sector Performance — ssga.com sector-tracker
  try {
    const page = await browser.newPage();
    await page.goto('https://www.ssga.com/us/en/intermediary/resources/sector-tracker', {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await page.waitForTimeout(3000);
    const sectors = await page.evaluate(() => {
      const sectorMap = {
        'XLK': 'Technology', 'XLF': 'Financials', 'XLV': 'Health Care',
        'XLC': 'Communication Services', 'XLY': 'Consumer Discretionary',
        'XLP': 'Consumer Staples', 'XLE': 'Energy', 'XLI': 'Industrials',
        'XLB': 'Materials', 'XLRE': 'Real Estate', 'XLU': 'Utilities',
      };
      const results = [];
      // พยายามดึงจาก table หรือ card elements
      document.querySelectorAll('[class*="sector"], [class*="Sector"], tr, [class*="card"]').forEach(el => {
        const text = el.innerText || '';
        // หา ticker + % change pattern
        Object.entries(sectorMap).forEach(([ticker, name]) => {
          if (text.includes(ticker)) {
            const pct = text.match(/([+-]?\d+\.\d+)%/);
            if (pct) {
              results.push({ name, ticker, change: parseFloat(pct[1]) });
            }
          }
        });
      });
      // fallback: scan body text
      if (results.length === 0) {
        const body = document.body.innerText;
        Object.entries(sectorMap).forEach(([ticker, name]) => {
          const re = new RegExp(ticker + '[^%\\n]{0,30}([+-]?\\d+\\.\\d+)%', 'i');
          const m = body.match(re);
          if (m) results.push({ name, ticker, change: parseFloat(m[1]) });
        });
      }
      return results;
    });

    if (sectors.length > 0) {
      const up = sectors.filter(s => s.change > 0).sort((a, b) => b.change - a.change);
      const down = sectors.filter(s => s.change < 0).sort((a, b) => a.change - b.change);
      const best = up[0] ? `${up[0].name} ${up[0].change > 0 ? '+' : ''}${up[0].change.toFixed(2)}%` : '';
      const worst = down[0] ? `${down[0].name} ${down[0].change.toFixed(2)}%` : '';
      const upList = up.map(s => `${s.name} +${s.change.toFixed(2)}%`).join(', ');
      result.sectors = { upCount: up.length, upList, best, worst };
    }
    await page.close();
    console.log('Sectors:', result.sectors);
  } catch (e) {
    console.error('getMarketData sector error:', e.message);
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
      if (p && a.href && a.href.match(/cnbc\.com\/202\d\/\d{2}\/\d{2}\//)) {
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

async function getArticleContent(browser, article, retries = 1) {
  const page = await browser.newPage();
  try {
    await page.goto(article.url, { waitUntil: 'networkidle', timeout: 30000 });

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
- ต้องเขียนสรุปบทความที่ได้รับทุกบทความ ไม่มีข้อยกเว้น จำนวน news items ใน output JSON ต้องเท่ากับจำนวนบทความที่ได้รับ
ยกเว้นเฉพาะ: Sports, Lifestyle ล้วนๆ, Entertainment ล้วนๆ, Mad Money/Cramer/CNBC Pro/CNBC Club
- ทุกอย่างนอกจาก 4 ประเภทนี้ → เก็บทั้งหมด ห้ามตัดเพราะคิดเองว่าไม่สำคัญ ไม่เกี่ยวการเงิน หรือเป็น opinion
- opinion ของนักวิเคราะห์สามารถอยู่ใน bullets ได้ แต่ต้องเป็นส่วนประกอบของข่าวจริง

## กฎการรวมข่าว
- รวมได้เฉพาะ same actor + same event เท่านั้น
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
  "date_slug": "YYYY-MM-DD",
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
  const indexText = [
    marketData.sp500 ? `ดัชนี S&P 500 ${marketData.sp500}` : '',
    marketData.nasdaq ? `ดัชนี Nasdaq ${marketData.nasdaq}` : '',
    marketData.dow ? `ดัชนี Dow Jones ${marketData.dow}` : '',
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
  const sectorText = marketData.sectors.upList
    ? `หุ้น ${marketData.sectors.upCount} จาก 11 กลุ่มปรับตัวเพิ่มขึ้น ได้แก่ ${marketData.sectors.upList} โดยกลุ่มที่ปรับตัวเพิ่มขึ้นมากที่สุด คือ ${marketData.sectors.best} ส่วนกลุ่มที่ปรับตัวลดลงมากที่สุด คือ ${marketData.sectors.worst}`
    : '(ไม่สามารถดึงข้อมูลได้)';
  overviewBlocks.push(bodyText(sectorText));

  // สรุปภาพรวมข่าว
  overviewBlocks.push(subHeader('สรุปภาพรวมข่าว'));
  overviewBlocks.push(bodyText(data.overview_news || data.overview || ''));

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
      children: [new TextRun({ text: `${index + 1}.  ${item.title}`, bold: true, size: 24, color: BLUE, font: 'TH Sarabun New' })],
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
      children: [new TextRun({ text: b, size: 21, font: 'TH Sarabun New' })],
    })));
    const linkLabel = new TextRun({ text: 'ลิงก์: ', size: 18, color: GRAY, font: 'TH Sarabun New', bold: true });
    if (item.urls.length === 1) {
      blocks.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [linkLabel, new ExternalHyperlink({
          link: item.urls[0].url,
          children: [new TextRun({ text: item.urls[0].label, size: 18, color: '1A73E8', underline: {}, font: 'TH Sarabun New' })],
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
            children: [new TextRun({ text: u.label, size: 18, color: '1A73E8', underline: {}, font: 'TH Sarabun New' })],
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
    const articles = await fetchArticlesParallel(browser, nonPro);
    articles.forEach(a => console.log(a.url, '|', a.publishedTime));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
