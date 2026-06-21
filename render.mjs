#!/usr/bin/env node
// 머니핏 카드뉴스 렌더러 — content JSON → 1080x1350 PNG 카드
// 사용: node render.mjs content/<issue>.json   (없으면 content/ 전체 렌더)
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { chromium } from 'playwright';

const W = 1080, H = 1350;

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "a|b{c}d" → 줄바꿈(|) + 강조({}) 처리
const rich = (s = '') =>
  esc(s).replace(/\|/g, '<br>').replace(/\{([^}]+)\}/g, '<span class="hl">$1</span>');

const STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px}
body{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
     display:flex;flex-direction:column;justify-content:space-between;padding:96px 88px}
.hl{color:#7FB8FF}
/* cover / cta = dark */
body.cover{background:linear-gradient(150deg,#0B1F33 0%,#123A6B 55%,#1A73E8 100%);color:#fff}
body.cta{background:linear-gradient(160deg,#1A73E8 0%,#0B1F33 100%);color:#fff}
.top{display:flex;align-items:center;gap:16px;font-size:30px;font-weight:700;opacity:.9}
.dot{width:18px;height:18px;border-radius:50%;background:#4A9EFF}
.cover h1{font-size:104px;line-height:1.18;font-weight:800;letter-spacing:-2px}
.cover p{margin-top:40px;font-size:42px;line-height:1.5;font-weight:500;opacity:.92}
.bottom{display:flex;justify-content:space-between;align-items:flex-end;font-size:30px;opacity:.85}
.badge{border:2px solid rgba(255,255,255,.5);border-radius:999px;padding:14px 30px;font-weight:700}
/* stat / list = light */
body.stat,body.list{background:#F2F6FC;color:#0B1F33}
.num{font-size:40px;font-weight:800;color:#1A73E8}
h2{font-size:78px;line-height:1.2;font-weight:800;letter-spacing:-1.5px;margin-top:18px}
.box{background:#fff;border-radius:36px;padding:56px;margin-top:56px;box-shadow:0 24px 60px rgba(11,31,51,.10)}
.row{display:flex;justify-content:space-between;align-items:baseline;padding:26px 0;border-bottom:1px solid #E6EDF6;font-size:40px;font-weight:600}
.row:last-child{border-bottom:0}.row .v{font-weight:800}.row .total{color:#DC2626}
.note{margin-top:44px;font-size:38px;line-height:1.55;color:#5B6B7B;font-weight:500}
ul{margin-top:40px;list-style:none}
li{display:flex;gap:24px;align-items:flex-start;font-size:42px;line-height:1.45;font-weight:500;margin-bottom:30px}
li .x{flex:none;width:52px;height:52px;border-radius:50%;background:#FDE8E8;color:#DC2626;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:34px}
.tip{background:#1A73E8;color:#fff;border-radius:36px;padding:48px 52px;font-size:44px;line-height:1.45;font-weight:700;margin-top:8px}
.foot{font-size:28px;color:#9AA8B6;font-weight:600}
.cta body,.logo{display:flex;align-items:center;gap:18px;font-size:38px;font-weight:800}
.logo .mark{width:64px;height:64px;border-radius:18px;background:#fff;color:#1A73E8;font-size:40px;font-weight:900;display:flex;align-items:center;justify-content:center}
.cta h1{font-size:96px;line-height:1.18;font-weight:800;letter-spacing:-2px}
.cta .sub{margin-top:36px;font-size:44px;line-height:1.5;font-weight:500;opacity:.92}
.fcard{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:32px;padding:44px 48px;margin-top:8px;display:flex;flex-direction:column;gap:18px}
.fcard .line{display:flex;align-items:center;gap:20px;font-size:40px;font-weight:600}
.check{color:#5BE7A9;font-weight:900}
.btn{background:#fff;color:#1A73E8;border-radius:999px;padding:34px;text-align:center;font-size:46px;font-weight:800;margin-top:36px}
.url{margin-top:26px;text-align:center;font-size:30px;opacity:.85}
`;

function body(card, meta) {
  switch (card.type) {
    case 'cover':
      return `<div class="top"><span class="dot"></span> ${esc(meta.label)}</div>
        <div><h1>${rich(card.title)}</h1><p>${rich(card.sub)}</p></div>
        <div class="bottom"><span>${esc(card.footL || '')}</span><span class="badge">${esc(card.badge || '밀어서 보기 →')}</span></div>`;
    case 'stat': {
      const rows = (card.rows || []).map(r =>
        `<div class="row"><span>${esc(r[0])}</span><span class="v ${r[2] === 'total' ? 'total' : ''}">${esc(r[1])}</span></div>`).join('');
      return `<div><div class="num">${esc(card.num)}</div><h2>${rich(card.title)}</h2>
        <div class="box">${rows}</div>${card.note ? `<p class="note">${rich(card.note)}</p>` : ''}</div>
        <div class="foot">${esc(meta.label)} · ${meta.n}/${meta.total}</div>`;
    }
    case 'list': {
      const items = (card.items || []).map(t => `<li><span class="x">✕</span><span>${esc(t)}</span></li>`).join('');
      return `<div><div class="num">${esc(card.num)}</div><h2>${rich(card.title)}</h2>
        <ul>${items}</ul>${card.tip ? `<div class="tip">${rich(card.tip)}</div>` : ''}</div>
        <div class="foot">${esc(meta.label)} · ${meta.n}/${meta.total}</div>`;
    }
    case 'cta': {
      const feats = (card.features || []).map(f => `<div class="line"><span class="check">✓</span> ${esc(f)}</div>`).join('');
      return `<div class="logo"><span class="mark">₩</span> ${esc(card.brand || '머니핏 가계부')}</div>
        <div><h1>${rich(card.title)}</h1><p class="sub">${rich(card.sub)}</p></div>
        <div class="fcard">${feats}</div>
        <div><div class="btn">${esc(card.cta || '지금 무료로 시작하기 →')}</div><div class="url">${esc(card.url || '')}</div></div>`;
    }
    default:
      throw new Error(`Unknown card type: ${card.type}`);
  }
}

const html = (card, meta) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${STYLE}</style></head>` +
  `<body class="${card.type}">${body(card, meta)}</body></html>`;

async function renderFile(jsonPath, browser) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const issue = data.issue || basename(jsonPath, '.json');
  const outDir = join('output', issue);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const total = data.cards.length;
  for (let i = 0; i < total; i++) {
    const meta = { label: data.label || '머니핏 머니 클래스', n: i + 1, total };
    await page.setContent(html(data.cards[i], meta), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const file = join(outDir, `card-${String(i + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: file });
    console.log('✓', file);
  }
  await page.close();
  return { issue, total };
}

const arg = process.argv[2];
const files = arg
  ? [arg]
  : readdirSync('content').filter(f => f.endsWith('.json')).map(f => join('content', f));
if (!files.length) { console.error('No content JSON found.'); process.exit(1); }

const browser = await chromium.launch();
for (const f of files) await renderFile(f, browser);
await browser.close();
console.log('Done.');
