const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  HeadingLevel, LevelFormat, BorderStyle, ExternalHyperlink,
} = require('docx');

// ─── 1. Playwright: ดึง article list + trending จาก cnbc.com/latest/ ─────────

async function getArticleList(browser) {
  const page = await browser.newPage();
  await page.goto('https://www.cnbc.com/latest/', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // scroll 4 รอบเพื่อโหลดข่าวเพิ่ม
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  const articles = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    // ดึงจาก latest list
    document.querySelectorAll('a[href]').forEach(a => {
      const url = a.href;
      if (!url.match(/cnbc\.com\/202\d\/\d{2}\/\d{2}\//)) return;
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

    // ดึงจาก trending section แยกต่างหาก
    const trendingUrls = new Set();
    document.querySelectorAll('[class*="trending"] a, [class*="Trending"] a, [class*="TrendingNow"] a').forEach(a => {
      if (a.href && a.href.match(/cnbc\.com\/202\d\/\d{2}\/\d{2}\//)) {
        trendingUrls.add(a.href);
      }
    });
    // fallback: หา parent ที่มี "trending" class
    document.querySelectorAll('a').forEach(a => {
      const p = a.closest('[class*="trending"],[class*="Trending"]');
      if (p && a.href && a.href.match(/cnbc\.com\/202\d\/\d{2}\/\d{2}\//)) {
        trendingUrls.add(a.href);
      }
    });

    // เพิ่ม trending URL ที่ยังไม่มีใน list
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

async function getArticleContent(browser, article) {
  const page = await browser.newPage();
  try {
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const result = await page.evaluate(() => {
      // ดึง timestamp จาก meta tag (UTC แม่นยำ)
      const metaTime = document.querySelector('meta[property="article:published_time"]')?.content
        || document.querySelector('time[datetime]')?.getAttribute('datetime')
        || '';

      // ตรวจ Pro paywall
      const bodyText = document.body.innerText;
      if (bodyText.length < 400 && /subscri|sign.?in|premium/i.test(bodyText)) {
        return { isPro: true, content: '', publishedTime: metaTime, headline: '' };
      }

      // ดึง headline จริงของบทความ
      const headline = document.querySelector('h1')?.textContent.trim() || '';

      // ดึง article body
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
    return { ...article, isPro: false, content: '', publishedTime: '', headline: '' };
  } finally {
    await page.close();
  }
}

// ดึง content แบบ parallel (4 tabs พร้อมกัน)
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
- ตัดออกเฉพาะ: Sports, Lifestyle (แฟชั่น ท่องเที่ยว cooking), Entertainment (ดนตรี ภาพยนตร์ celebrity), Mad Money, Cramer Lightning Round, Trade Alerts, CNBC Pro (ไม่มี body)
- เก็บทั้งหมดที่เหลือโดยไม่มีข้อยกเว้น ห้ามตัดเพราะคิดว่าไม่สำคัญพอหรือซ้ำกับวันก่อน

## กฎการรวมข่าว
- รวมได้เฉพาะ same actor + same event เท่านั้น
- เมื่อรวม ให้ระบุ timestamp แยกกันในช่อง time และรวม URL ทั้งหมดไว้ใน urls
- ถ้าบทความที่รวมเป็น escalation หรือเหตุการณ์ต่อเนื่อง ให้เรียง context ตามลำดับเวลาจากเก่าไปใหม่เสมอ ห้ามกระโดดไปเหตุการณ์ล่าสุดโดยไม่ให้ context ก่อน
- บทความที่มี update ให้ใช้ version update เป็นหลัก timestamp ใช้ของ update นั้น

## กฎการ categorize
กำหนด category 1 อันที่ตรงกับ main focus:
- "market": ดัชนี (Dow/S&P/Nasdaq/SET), sector rotation, commodities, crypto, currency, Fed funds rate outlook
- "company": earnings, M&A, IPO, CEO/management, product launch, layoffs, legal/regulatory ของบริษัทเฉพาะ
- "economy": GDP, CPI, jobs report, PMI, trade data, นโยบาย central bank, geopolitics ที่กระทบ macro

Tie-break: Fed ปรับ rate → economy, Apple earnings → company, Nasdaq ดิ่ง 3% → market

เรียงภายใน category จากใหม่สุดขึ้นก่อน (UTC+7)
ลำดับ section ตายตัว: market → company → economy

## กฎการเขียน
- ภาษาไทย เขียนเหมือนอัปเดตงานให้ผู้ใหญ่ฟัง กระชับ ตรงประเด็น
- 3 bullets ต่อข่าว ห้ามขึ้นต้น bullet ด้วย label เช่น "ใจความสำคัญ:" ให้เขียนเนื้อหาตรงๆ
  - bullet 1: เกิดอะไรขึ้น ใคร ทำอะไร ตัวเลขคืออะไร
  - bullet 2: บริบทหรือที่มาที่ช่วยให้เข้าใจ
  - bullet 3: ผลกระทบ — ต้องมาจากบทความเท่านั้น (ปฏิกิริยาตลาด, ความเห็นนักวิเคราะห์ที่อ้างในบทความ) ห้าม inference เอง
- รวม 3 bullets ไม่เกิน 250 คำต่อข่าว
- ห้ามใช้ - เป็น connector ให้ใช้ "โดย / ขณะที่ / ส่งผลให้" แทน
- ใส่วงเล็บอธิบายเฉพาะ acronym และศัพท์เฉพาะทางที่คนทั่วไปไม่รู้จัก เช่น USDA (กระทรวงเกษตรสหรัฐฯ) ไม่ต้องใส่คำทั่วไปอย่างเงินเฟ้อ อัตราดอกเบี้ย หรือชื่อบริษัท/ดัชนี proper noun
- หัวข้อข่าว: แปล Headline เป็นภาษาไทย แต่ใช้ศัพท์ Technical ได้
- URLs label: ใช้ headline จริงของบทความ ห้ามแต่งเอง
- ภาพรวม 2-3 ประโยค ต้องระบุตัวเลขและชื่อหุ้นเฉพาะ เช่น "Dow ดิ่ง 620 จุดหลัง Iran โจมตี Kuwait"

ตอบเป็น JSON ล้วน ไม่มี markdown backticks:
{
  "date_th": "วันX ที่X เดือน พ.ศ.",
  "date_slug": "YYYY-MM-DD",
  "overview": "ภาพรวม 2-3 ประโยค",
  "news": [{
    "category": "market|company|economy",
    "title": "headline จริงจาก CNBC และเปลเป็นภาษาไทย",
    "time": "X มิ.ย. 256X (HH:MM UTC = HH:MM น. ไทย)",
    "bullets": ["bullet1", "bullet2", "bullet3"],
    "urls": [{ "url": "https://...", "label": "headline จริงของบทความ" }]
  }]
}`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: articlesText }],
  });

  const text = msg.content[0].text.trim().replace(/^```json|```$/g, '').trim();
  try {
    return JSON.parse(text);
  } catch(e) {
    // ถ้า JSON ไม่สมบูรณ์ให้ retry ด้วย max_tokens มากขึ้น
    const msg2 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,
      system,
      messages: [{ role: 'user', content: articlesText }],
    });
    const text2 = msg2.content[0].text.trim().replace(/^```json|```$/g, '').trim();
    return JSON.parse(text2);
  }

}

// ─── 4. สร้าง .docx พร้อม section headers ───────────────────────────────────

function buildDocx(data) {
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

  // Build grouped body
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
        new Paragraph({ spacing: { before: 160, after: 60 }, children: [new TextRun({ text: 'ภาพรวม', bold: true, size: 26, color: BLUE, font: 'TH Sarabun New' })] }),
        new Paragraph({ spacing: { before: 0, after: 60 }, children: [new TextRun({ text: data.overview, size: 22, font: 'TH Sarabun New' })] }),
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    console.log('Step 1: Opening cnbc.com/latest/...');
    const articleList = await getArticleList(browser);
    console.log(`Found ${articleList.length} articles (latest + trending)`);

    // fetch ทุกบทความก่อน ห้ามกรองจาก headline
    const nonPro = articleList.filter(a => !a.isPro);
    console.log(`Step 2-3: Fetching ${nonPro.length} articles...`);
    const articles = await fetchArticlesParallel(browser, nonPro);

    // กรอง Pro และ empty content ออกหลัง fetch
    const valid = articles.filter(a => !a.isPro && a.content && a.content.length > 100);
    console.log(`Valid articles after fetch: ${valid.length}`);

    const articlesText = valid.map(a =>
      `URL: ${a.url}\nHeadline: ${a.headline || a.title}\nPublished (UTC): ${a.publishedTime || a.time}\n\n${a.content}`
    ).join('\n\n---\n\n');

    console.log('Step 4: Summarizing with Claude...');
    const briefData = await summarizeWithClaude(articlesText);
    console.log(`Got ${briefData.news.length} news items`);

    console.log('Step 5: Building .docx...');
    const doc = buildDocx(briefData);
    const buffer = await Packer.toBuffer(doc);

    console.log('Sending email...');
    await sendEmail(briefData.date_slug, briefData.date_th, buffer);

    console.log('Done!');
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
