#!/usr/bin/env node
// 스레드(Threads) 자동 게시 — 카드(card-*.png) + caption-threads.txt(+다운로드 링크) → 캐러셀/단일/텍스트 게시
// 사용: node post-threads.mjs <output/<issue> 디렉터리> <이미지 공개 base URL>
// 환경변수: THREADS_ACCESS_TOKEN (필수) — 절대 로그에 출력하지 않는다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const GRAPH = 'https://graph.threads.net';
const VER = 'v1.0';
const LINK = 'https://moavant.com/mfAd';   // 스레드 본문에 넣는 다운로드 링크
const LIMIT = 500;                          // 스레드 텍스트 글자 제한

const [dir, baseUrl] = process.argv.slice(2);
if (!TOKEN) { console.error('✗ THREADS_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }
if (!dir || !baseUrl) { console.error('사용: node post-threads.mjs <issueDir> <baseUrl>'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const transient = res.status >= 500 || [1, 2, 4].includes(code);
      if (attempt < 4 && transient) {
        console.error(`  · 일시 오류 재시도 ${attempt}/3 (${json?.error?.message || res.status})`);
        await sleep(4000 * attempt);
        continue;
      }
      { const e = json?.error || {}; throw new Error(`API 실패 [${method} ${path}]: ${e.message || ('HTTP ' + res.status)} | code=${e.code ?? ''} subcode=${e.error_subcode ?? ''} | ${e.error_user_title ?? ''} ${e.error_user_msg ?? ''}`); }
    } catch (e) {
      if (attempt < 4 && e.name === 'TypeError') { await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
}

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

// 스레드 컨테이너는 게시 전 처리 시간이 필요(특히 캐러셀) — 상태가 FINISHED 될 때까지 대기
async function waitReady(creationId, maxMs = 120000) {
  const start = Date.now();
  await sleep(5000);
  while (Date.now() - start < maxMs) {
    const s = await api('GET', creationId, { fields: 'status' });
    if (s.status === 'FINISHED') return;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`스레드 미디어 처리 실패(${s.status})`);
    await sleep(4000);
  }
  throw new Error('스레드 미디어 처리 시간 초과');
}

// 1) 스레드 사용자 ID
const me = await api('GET', 'me', { fields: 'id,username' });
const UID = me.id;
if (!UID) throw new Error('스레드 사용자 ID를 가져오지 못했습니다(토큰 권한 확인).');
console.log(`스레드 계정: @${me.username || '?'} (id ${UID})`);

// 2) 본문 = caption-threads.txt + 다운로드 링크 (500자 보호)
let cap = '';
try { cap = readFileSync(join(dir, 'caption-threads.txt'), 'utf-8').trim(); } catch { /* 없으면 링크만 */ }
let text = cap ? `${cap}\n\n${LINK}` : LINK;
if ([...text].length > LIMIT) {
  const room = LIMIT - LINK.length - 2;
  text = `${[...cap].slice(0, Math.max(0, room - 1)).join('').trimEnd()}…\n\n${LINK}`;
}

// 3) 카드 이미지
const cards = readdirSync(dir).filter((f) => /^card-\d+\.png$/.test(f)).sort();
const urls = cards.map((f) => `${baseUrl}/${f}`);
console.log(`카드 ${urls.length}장`);

// 4) 컨테이너 생성
let creationId;
if (urls.length === 0) {
  // 텍스트 전용
  const c = await api('POST', `${UID}/threads`, { media_type: 'TEXT', text });
  creationId = c.id;
} else if (urls.length === 1) {
  await waitForUrl(urls[0]);
  const c = await api('POST', `${UID}/threads`, { media_type: 'IMAGE', image_url: urls[0], text });
  creationId = c.id;
} else {
  await waitForUrl(urls[0]);
  const children = [];
  for (const u of urls) {
    const item = await api('POST', `${UID}/threads`, { media_type: 'IMAGE', image_url: u, is_carousel_item: 'true' });
    children.push(item.id);
    console.log(`  · 캐러셀 아이템 ${children.length}/${urls.length}`);
  }
  // 스레드는 각 아이템이 처리완료(FINISHED) 돼야 캐러셀에 묶을 수 있다
  for (const id of children) await waitReady(id);
  const car = await api('POST', `${UID}/threads`, { media_type: 'CAROUSEL', children: children.join(','), text });
  creationId = car.id;
}

// 5) 처리 완료 대기 후 게시
await waitReady(creationId);
const pub = await api('POST', `${UID}/threads_publish`, { creation_id: creationId });
console.log(`✅ 스레드 게시 완료! id: ${pub.id}`);
