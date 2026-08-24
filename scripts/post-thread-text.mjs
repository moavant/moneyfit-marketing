#!/usr/bin/env node
// 스레드(Threads) 참여형 텍스트 게시 — threads/posts/*.json 1건을 텍스트 전용으로 게시한다.
// 카드뉴스 파이프라인(post-instagram.mjs)과 완전 분리 — 스레드는 이미지 없이 텍스트만 올린다.
// 콘텐츠 작성 규칙·운영 원칙은 내부(비공개) 문서가 정본이며 이 스크립트는 게시 기계 장치만 담당한다.
//
// 실행: node scripts/post-thread-text.mjs <threads/posts/파일.json> [--dry-run]
// 환경변수: THREADS_ACCESS_TOKEN (필수) — 절대 로그에 출력하지 않는다.
//
// 게시 전 강제 정화(sanitize) — 파일에 섞여 들어와도 게시물에는 절대 안 나가는 것들:
//   ① 해시태그(줄 전체가 태그면 줄 삭제, 본문 중간 태그는 # 만 제거)
//   ② 'Google Play'/'무료로 시작' 스토어 CTA 줄  ③ URL(토큰 단위 제거, 잔여가 무의미하면 줄 삭제)
//   (스레드 본문에는 링크·해시태그·스토어 CTA 를 싣지 않는 것이 운영 원칙 — 2026-08-19 결정)
//
// 멱등성: 게시 성공 시 state/threads-posted.json 에 {파일경로: {postId, at}} 를 기록하고,
//   이미 기록된 파일은 다시 게시하지 않는다(워크플로 재실행 시 공개 계정 중복 게시 방지).
//   상태 파일 커밋은 워크플로(publish-threads.yml)가 담당한다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_FILE = join(REPO_ROOT, 'state', 'threads-posted.json');
const GRAPH = 'https://graph.threads.net';
const VER = 'v1.0';
export const LIMIT = 500; // 스레드 텍스트 글자 제한

// URL 토큰: 스킴 있는 것 + 스킴 없는 흔한 도메인 (bit.ly/xx, blog.naver.com/xx 류)
const URL_TOKEN = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|kr|co|ly|be|me|app|dev|shop|site)(?:\/\S*)?/gi;

// 게시 금지 요소 제거
export function sanitizeThreadText(t = '') {
  const out = [];
  for (let line of String(t).split('\n')) {
    // 스토어 CTA 줄은 통째로 제거
    if (/Google\s*Play/i.test(line) || /무료로\s*시작/.test(line)) continue;
    // 해시태그로만 이뤄진 줄(#태그 #태그 …)만 통째로 제거 — "#1 원칙: …" 같은 본문 줄은 보존
    if (/^\s*#\S+(?:\s+#\S+)*\s*$/.test(line)) continue; // 선형 패턴(백트래킹 폭발 없음)
    // URL 은 토큰 단위 제거 — 잔여 텍스트가 무의미하면(8자 미만 또는 구두점뿐) 줄 삭제
    if (URL_TOKEN.test(line)) {
      URL_TOKEN.lastIndex = 0;
      const stripped = line.replace(URL_TOKEN, '').replace(/\s{2,}/g, ' ');
      const meat = stripped.replace(/[\s:;\-–—>·,.()[\]]+/g, '');
      if ([...meat].length < 8) continue;
      line = stripped;
    }
    URL_TOKEN.lastIndex = 0;
    // 본문 중간 해시태그는 # 만 제거(스레드는 인라인 #단어 도 태그로 렌더한다)
    // — 공백/줄머리 뒤 + 문자·한글로 시작하는 것만(태그 문법). "C#처럼"·"#1" 은 태그가 아니므로 보존.
    line = line.replace(/(?<=^|\s)#(?=[가-힣A-Za-z_])/g, '');
    out.push(line);
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 500자 초과 시 말줄임 (코드포인트 기준 — 이모지 절단 방지)
export function clampLength(t = '', limit = LIMIT) {
  const cp = [...t];
  if (cp.length <= limit) return t;
  return `${cp.slice(0, limit - 1).join('').trimEnd()}…`;
}

// 콘텐츠 파일 검증 — text 필수, followUp(본글 직후 이어 달 자기 댓글)은 선택
export function parsePostFile(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('JSON 파싱 실패 — 유효한 JSON 이 아닙니다.'); }
  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('text 필드가 없거나 비었습니다.');
  }
  const text = clampLength(sanitizeThreadText(data.text));
  if (!text) throw new Error('정화(sanitize) 후 본문이 비었습니다 — 해시태그·링크·CTA만으로 이뤄진 글은 게시하지 않습니다.');
  const followUp = typeof data.followUp === 'string'
    ? clampLength(sanitizeThreadText(data.followUp)) || null
    : null;
  return { ...data, text, followUp };
}

// 정화로 얼마나 잘려나갔는지 — 루틴이 쓴 글과 게시본이 조용히 달라지는 것을 로그로 드러낸다
export function sanitizeLossRatio(original = '', sanitized = '') {
  const a = [...String(original).trim()].length;
  if (!a) return 0;
  return Math.max(0, 1 - [...sanitized].length / a);
}

export function loadPostedState(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return { posted: {} }; }
}

export function savePostedState(state, file = STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(token) {
  const clean = String(token ?? '').trim();
  if (!clean || !/^[\w.\-~+/=]+$/.test(clean)) {
    throw new Error('THREADS_ACCESS_TOKEN 형식 오류(공백·개행 포함 여부 확인). 값은 로그에 남기지 않습니다.');
  }
  return async function api(method, path, params = {}) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const url = new URL(`${GRAPH}/${VER}/${path}`);
      const form = new URLSearchParams(params);
      let res, json;
      try {
        // 🔴 토큰은 Authorization 헤더로만 — URL·로그에 노출하지 않는다(reply-comments.mjs 관례).
        const headers = { authorization: `Bearer ${clean}` };
        if (method === 'GET') {
          for (const [k, v] of form) url.searchParams.set(k, v);
          res = await fetch(url, { method: 'GET', headers });
        } else {
          res = await fetch(url, { method: 'POST', body: form, headers });
        }
        json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const code = json?.error?.code;
        const transient = res.status >= 500 || [1, 2].includes(code);
        if (attempt < 4 && transient) {
          console.error(`  · 일시 오류 재시도 ${attempt}/3 (${json?.error?.message || res.status})`);
          await sleep(4000 * attempt);
          continue;
        }
        const e = json?.error || {};
        throw new Error(`API 실패 [${method} ${path}]: ${e.message || ('HTTP ' + res.status)} | code=${e.code ?? ''} subcode=${e.error_subcode ?? ''}`);
      } catch (e) {
        // 프로그래밍 오류(TypeError 전반)까지 재시도하면 헛되게 시간을 태운다 — 네트워크 오류만(collect-insights.mjs 관례).
        const isNetwork = e instanceof TypeError
          && /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(`${e.message} ${e.cause?.code ?? ''}`);
        if (attempt < 4 && isNetwork) { await sleep(4000 * attempt); continue; }
        throw e;
      }
    }
  };
}

// 스레드 컨테이너는 게시 전 처리 시간이 필요 — FINISHED 까지 대기
async function waitReady(api, creationId, maxMs = 120000) {
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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  const TOKEN = process.env.THREADS_ACCESS_TOKEN;
  if (!file) { console.error('사용: node scripts/post-thread-text.mjs <threads/posts/파일.json> [--dry-run]'); process.exit(1); }

  // 멱등성 — 상태 파일 키는 레포 루트 기준 상대경로로 통일
  const key = relative(REPO_ROOT, join(process.cwd(), file)).replace(/\\/g, '/');
  const state = loadPostedState();
  if (state.posted?.[key]) {
    console.log(`↩︎ 이미 게시된 파일(${key} → ${state.posted[key].postId}) — 건너뜀 (중복 게시 방지)`);
    return;
  }

  const raw = readFileSync(file, 'utf-8');
  const post = parsePostFile(raw);
  // 손실률은 "정화" 단계만 측정(길이 초과 말줄임과 원인을 섞지 않는다 — 경보 오귀인 방지)
  const originalText = JSON.parse(raw).text;
  const sanitizedOnly = sanitizeThreadText(originalText);
  const loss = sanitizeLossRatio(originalText, sanitizedOnly);
  console.log(`▶ 게시 준비: ${file} (${[...post.text].length}자)`);
  if (loss > 0) {
    const msg = `정화로 본문의 ${(loss * 100).toFixed(0)}% 가 제거됨 — 원문에 링크·해시태그·CTA 가 섞여 있었음`;
    if (loss > 0.2) console.error(`::warning::${msg} (원문 점검 필요)`); else console.log(`  · ${msg}`);
  }
  if ([...sanitizedOnly].length > LIMIT) {
    console.log(`  · 본문이 ${LIMIT}자를 넘어 말줄임 처리됨 (정화와 무관한 길이 초과)`);
  }

  if (dryRun) {
    console.log('--- dry-run: 실제 게시 없음. 게시될 본문 ---');
    console.log(post.text);
    if (post.followUp) { console.log('--- followUp(자기 댓글) ---'); console.log(post.followUp); }
    return;
  }
  if (!TOKEN) { console.error('✗ THREADS_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }

  const api = makeApi(TOKEN);
  const me = await api('GET', 'me', { fields: 'id,username' });
  if (!me.id) throw new Error('스레드 사용자 ID를 가져오지 못했습니다(토큰 권한 확인).');
  console.log(`스레드 계정: @${me.username || '?'} (id ${me.id})`);

  const c = await api('POST', `${me.id}/threads`, { media_type: 'TEXT', text: post.text });
  await waitReady(api, c.id);
  const pub = await api('POST', `${me.id}/threads_publish`, { creation_id: c.id });
  console.log(`✅ 스레드 게시 완료! id: ${pub.id}`);

  // 🔴 본글 성공 즉시 상태 기록 — followUp 실패·중단으로 재실행돼도 본글이 중복되지 않게.
  state.posted = state.posted || {};
  state.posted[key] = { postId: pub.id, at: new Date().toISOString() };
  savePostedState(state);

  // followUp: 본글 게시 직후 이어서 다는 자기 댓글(선택).
  // 실패해도 본글 게시는 이미 성공이므로 경고만 남기고 정상 종료한다.
  if (post.followUp) {
    try {
      await sleep(20000); // 본글이 피드에 잡힌 뒤 달리도록 잠깐 대기
      const rc = await api('POST', `${me.id}/threads`, { media_type: 'TEXT', text: post.followUp, reply_to_id: pub.id });
      await waitReady(api, rc.id);
      const rpub = await api('POST', `${me.id}/threads_publish`, { creation_id: rc.id });
      console.log(`✅ followUp 자기 댓글 게시 완료! id: ${rpub.id}`);
      state.posted[key].followUpId = rpub.id;
      savePostedState(state);
    } catch (e) {
      console.error(`⚠️ followUp 댓글 게시 실패(본글은 성공): ${e.message}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('post-thread-text.mjs')) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
