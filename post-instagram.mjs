#!/usr/bin/env node
// 인스타그램 자동 게시 — 렌더된 카드(card-*.png) + caption.txt → 캐러셀(또는 단일) 게시
// 사용: node post-instagram.mjs <output/<issue> 디렉터리> <이미지 공개 base URL>
// 환경변수: IG_ACCESS_TOKEN (필수) — 절대 로그에 출력하지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.IG_ACCESS_TOKEN;
const GRAPH = 'https://graph.instagram.com';
const VER = 'v21.0';

const [dir, baseUrl] = process.argv.slice(2);
if (!TOKEN) { console.error('✗ IG_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }
if (!dir || !baseUrl) { console.error('사용: node post-instagram.mjs <issueDir> <baseUrl>'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// access_token 은 항상 query/body 에만 넣고, 응답 본문만 출력한다(토큰 노출 방지).
async function api(method, path, params = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const url = new URL(`${GRAPH}/${VER}/${path}`);
    const form = new URLSearchParams({ ...params, access_token: TOKEN });
    let res, json;
    try {
      if (method === 'GET') {
        for (const [k, v] of form) url.searchParams.set(k, v);
        res = await fetch(url, { method: 'GET' });
      } else {
        res = await fetch(url, { method: 'POST', body: form });
      }
      json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const code = json?.error?.code;
      const transient = res.status >= 500 || [1, 2, 4, 613].includes(code);
      if (attempt < 4 && transient) {
        console.error(`  · 일시 오류 재시도 ${attempt}/3 (${json?.error?.message || res.status})`);
        await sleep(4000 * attempt);
        continue;
      }
      throw new Error(`API 실패 [${method} ${path}]: ${json?.error?.message || ('HTTP ' + res.status)}`);
    } catch (e) {
      if (attempt < 4 && e.name === 'TypeError') { // 네트워크 오류
        console.error(`  · 네트워크 재시도 ${attempt}/3`);
        await sleep(4000 * attempt);
        continue;
      }
      throw e;
    }
  }
}

// 이미지 공개 URL 이 실제로 200(image/*)으로 뜰 때까지 대기 (raw CDN 전파 대기)
async function waitForUrl(u, maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(u, { method: 'GET' });
      if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) return;
    } catch { /* 재시도 */ }
    await sleep(3000);
  }
  throw new Error(`이미지 공개 URL이 뜨지 않습니다: ${u}`);
}

// 컨테이너 처리 완료 대기 (이미지는 보통 즉시 FINISHED)
async function waitReady(creationId, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await api('GET', creationId, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') throw new Error('미디어 처리 실패(ERROR)');
    await sleep(3000);
  }
  throw new Error('미디어 처리 시간 초과');
}

// 1) 인스타 사용자 ID
const me = await api('GET', 'me', { fields: 'user_id,username' });
const IGID = me.user_id || me.id;
if (!IGID) throw new Error('인스타 사용자 ID를 가져오지 못했습니다(토큰 권한 확인).');
console.log(`인스타 계정: @${me.username || '?'} (id ${IGID})`);

// 2) 카드 이미지 목록 (card-01.png, card-02.png ...)
const cards = readdirSync(dir).filter((f) => /^card-\d+\.png$/.test(f)).sort();
if (!cards.length) { console.error(`✗ ${dir} 에 card-*.png 가 없습니다.`); process.exit(1); }
const urls = cards.map((f) => `${baseUrl}/${f}`);
console.log(`카드 ${urls.length}장`);

// 3) 캡션(본문 + 해시태그)
let caption = '';
try { caption = readFileSync(join(dir, 'caption.txt'), 'utf-8').trim(); } catch { /* 캡션 없으면 빈 본문 */ }

// 4) 첫 이미지가 공개로 뜰 때까지 대기
await waitForUrl(urls[0]);

// 5) 컨테이너 생성
let creationId;
if (urls.length === 1) {
  const c = await api('POST', `${IGID}/media`, { image_url: urls[0], caption });
  creationId = c.id;
} else {
  const children = [];
  for (const u of urls) {
    const item = await api('POST', `${IGID}/media`, { image_url: u, is_carousel_item: 'true' });
    children.push(item.id);
    console.log(`  · 캐러셀 아이템 ${children.length}/${urls.length}`);
  }
  const car = await api('POST', `${IGID}/media`, {
    media_type: 'CAROUSEL', children: children.join(','), caption,
  });
  creationId = car.id;
}

// 6) 처리 완료 대기 후 게시
await waitReady(creationId);
const pub = await api('POST', `${IGID}/media_publish`, { creation_id: creationId });
console.log(`✅ 인스타 게시 완료! media id: ${pub.id}`);
