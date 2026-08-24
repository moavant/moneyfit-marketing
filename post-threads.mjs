#!/usr/bin/env node
// 스레드(Threads) 자동 게시 — caption-threads.txt(+다운로드 링크) → 텍스트 전용 게시
// 🔴 스레드는 카드 이미지를 첨부하지 않는다(의도적). 이미지 캐러셀은 인스타 전용 —
//    같은 정보라도 스레드 문화(반말, 참여 유도)에 맞춰 텍스트로 재구성해 올린다.
// 사용: node post-threads.mjs <output/<issue> 디렉터리> [이미지 공개 base URL — 더 이상 사용 안 함, 호출부 호환용]
// 환경변수: THREADS_ACCESS_TOKEN (필수) — 절대 로그에 출력하지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const GRAPH = 'https://graph.threads.net';
const VER = 'v1.0';
// SUS-230(P-19): 채널별 유입 계측 — /mfAd/th 는 Play 설치 referrer 에 utm_source=threads 를 실어 보낸다.
//   (moavant.com 리다이렉트에서 부여. 기존 /mfAd 도 계속 동작하므로 과거 게시물 링크는 무영향.)
//   아래 `text.includes('moavant.com/mfAd')` 는 접두사 매칭이라 그대로 유효하다.
const DL_LINE = '다운로드 링크(Android) : https://moavant.com/mfAd/th'; // 스레드 본문 CTA(스레드는 링크가 클릭됨)
const LIMIT = 500;                          // 스레드 텍스트 글자 제한

// 'Google Play 검색' CTA 줄 및 '무료로 시작' 줄 제거 (다운로드 링크는 붙이지 않음)
function replaceStoreCTA(t = '') {
  const lines = t.split('\n').filter((l) => !/Google\s*Play/i.test(l) && !/무료로\s*시작/.test(l));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 해시태그 줄 제거 (스레드 전용)
function stripHashtags(t = '') {
  return t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const [dir] = process.argv.slice(2);
if (!TOKEN) { console.error('✗ THREADS_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }
if (!dir) { console.error('사용: node post-threads.mjs <issueDir>'); process.exit(1); }

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

// 스레드 컨테이너는 게시 전 처리 시간이 필요 — 상태가 FINISHED 될 때까지 대기
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

// 2) 본문 = caption-threads.txt → CTA를 다운로드 링크로 치환 + 해시태그 제거
let cap = '';
try { cap = readFileSync(join(dir, 'caption-threads.txt'), 'utf-8').trim(); } catch { /* 없으면 링크만 */ }
let text = stripHashtags(replaceStoreCTA(cap));
if ([...text].length > LIMIT) {   // 거의 안 일어나지만 안전장치: 500자 초과 시 말줄임 처리
  text = `${[...text].slice(0, LIMIT - 1).join('').trimEnd()}…`;
}

// 3) 컨테이너 생성 — 항상 텍스트 전용(이미지 미첨부)
console.log('이미지 첨부 없음 — 텍스트 전용 게시');
const c = await api('POST', `${UID}/threads`, { media_type: 'TEXT', text });
const creationId = c.id;

// 4) 처리 완료 대기 후 게시
await waitReady(creationId);
const pub = await api('POST', `${UID}/threads_publish`, { creation_id: creationId });
console.log(`✅ 스레드 게시 완료! id: ${pub.id}`);
