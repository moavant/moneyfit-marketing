#!/usr/bin/env node
// SUS-230 Phase 2 (P-20) — 인스타·스레드 주간 인사이트 자동 수집
//
// 실행: node scripts/collect-insights.mjs [--week 2026-W32 (--dry-run 전용)] [--dry-run]
// 환경변수:
//   IG_ACCESS_TOKEN        인스타 Graph 토큰 — 기존 자동 게시용 재사용
//   THREADS_ACCESS_TOKEN   스레드 Graph 토큰 — 기존 자동 게시용 재사용
//   SLACK_WEBHOOK_MARKETING (선택) 있으면 요약을 Slack 으로 보낸다. 없으면 건너뛴다(실패 아님).
//
// 🔴 토큰은 Authorization 헤더로만 보낸다. URL·로그·에러 메시지·커밋 JSON 어디에도 남기지 않는다.
//    (회귀 방지 테스트: scripts/__tests__/collect-insights.test.mjs "보안: API 실패 로그·에러…")
// 🔴 "측정 실패" 를 절대 0 으로 보고하지 않는다 — 수집 못 한 것과 실제 0 은 다르다.
//    실패를 0 으로 적으면 "카드뉴스 미발행" 같은 거짓 보고가 공개 레포에 영구 기록된다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const TH_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const SLACK = process.env.SLACK_WEBHOOK_MARKETING;

const IG_GRAPH = 'https://graph.instagram.com';
const IG_VER = 'v21.0';
const TH_GRAPH = 'https://graph.threads.net';
const TH_VER = 'v1.0';

const INSIGHTS_DIR = 'insights';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 주간 범위 (KST 월~일). GitHub Actions 는 UTC 로 도므로 KST 오프셋을 명시 적용한다.
// 월요일 09:00 KST 실행 시 "직전 주(월~일)" 를 집계 대상으로 삼는다.
// ---------------------------------------------------------------------------
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function getWeekRange(now = new Date()) {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const dow = kst.getUTCDay();                 // KST 기준 요일 (0=일)
  const daysSinceMonday = (dow + 6) % 7;       // 월=0 … 일=6
  const thisMonday = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - daysSinceMonday * 86400000;
  const startKst = thisMonday - 7 * 86400000;
  const endKst = thisMonday;                   // 배타적 상한(직전 주 일요일 24:00 KST)

  const startIso = new Date(startKst - KST_OFFSET_MS).toISOString();
  const endIso = new Date(endKst - KST_OFFSET_MS).toISOString();

  // ISO 주차 (목요일 소속 규칙)
  const monday = new Date(startKst);
  const thursday = new Date(startKst + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86400000 / 7) + 1;
  const weekKey = `${year}-W${String(week).padStart(2, '0')}`;

  const last = new Date(endKst - 86400000);
  const label = `${monday.getUTCMonth() + 1}/${monday.getUTCDate()}~${last.getUTCMonth() + 1}/${last.getUTCDate()}`;
  return { startIso, endIso, weekKey, label };
}

// 타임스탬프 비교는 반드시 시각으로 한다. Meta 는 '2026-08-01T12:34:56+0000' 형식을,
// 우리는 '...Z' 형식을 만든다 — 문자열 사전순 비교는 경계에서 조용히 틀린다.
export function inRange(ts, startIso, endIso) {
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= Date.parse(startIso) && t < Date.parse(endIso);
}

// ---------------------------------------------------------------------------
// 지표 하나가 실패해도 전체를 죽이지 않는다.
// ---------------------------------------------------------------------------
export async function safeMetric(fn, what = '') {
  try {
    return await fn();
  } catch (e) {
    console.error(`  · (건너뜀) ${what}: ${String(e?.message || e).slice(0, 200)}`);
    return null;
  }
}

// 레이트리밋은 시간 단위 창이 리셋돼야 풀린다 — 재시도는 쿼터만 더 태운다. 즉시 포기한다.
const RATE_LIMIT_CODES = [4, 17, 32, 613];

export function makeApi(graph, ver, token, label) {
  // 접속키에 개행·공백이 섞이면 Authorization 헤더 생성 단계에서 TypeError 가 나고,
  // 런타임에 따라 그 값이 에러 메시지에 실릴 수 있다. 진입부에서 1회 차단한다(값은 출력 금지).
  const clean = String(token ?? '').trim();
  if (!clean || !/^[\w.\-~+/=]+$/.test(clean)) {
    throw new Error(`${label}: 접속키 형식 오류(공백·개행 포함 여부 확인). 값은 로그에 남기지 않습니다.`);
  }
  return async function api(path, params = {}) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      // 🔴 URL 에는 토큰을 절대 넣지 않는다(Meta 액세스 로그·프록시·실수 로깅 전부 차단).
      const url = new URL(`${graph}/${ver}/${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      let res, json;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${clean}` },
        });
        json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const code = json?.error?.code;
        if (RATE_LIMIT_CODES.includes(code)) {
          throw new Error(`${label} [${path}]: 레이트리밋(code ${code}) — 이번 회차 수집 일부 생략`);
        }
        const transient = res.status >= 500 || [1, 2].includes(code);
        if (attempt < 4 && transient) {
          console.error(`  · ${label} 일시 오류 재시도 ${attempt}/3`);
          await sleep(3000 * attempt);
          continue;
        }
        // 🔴 url 을 넣지 않는다. path 와 API 메시지만.
        throw new Error(`${label} [${path}]: ${json?.error?.message || 'HTTP ' + res.status}`);
      } catch (e) {
        // 프로그래밍 오류(TypeError 전반)까지 재시도하면 헛되게 18초를 태운다 — 네트워크 오류만.
        const isNetwork = e instanceof TypeError
          && /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(`${e.message} ${e.cause?.code ?? ''}`);
        if (attempt < 4 && isNetwork) {
          console.error(`  · ${label} 네트워크 재시도 ${attempt}/3`);
          await sleep(3000 * attempt);
          continue;
        }
        throw e;
      }
    }
  };
}

// Meta 응답: {data:[{name,values:[{value}]}]} 또는 {data:[{name,total_value:{value}}]}
export function pickMetric(insightsJson, name) {
  const row = (insightsJson?.data || []).find((d) => d.name === name);
  if (!row) return null;
  if (row.total_value && typeof row.total_value.value === 'number') return row.total_value.value;
  const v = row.values?.[0]?.value;
  return typeof v === 'number' ? v : null;
}

// Meta 는 콤마 목록 중 하나라도 미지원이면 요청 전체를 400 으로 거부한다.
// 배치가 죽으면 개별로 재시도해 살릴 수 있는 지표만 살린다(정상 시 호출 1회 그대로).
export async function fetchInsights(api, id, metrics, label) {
  let err = null;
  const batch = await api(`${id}/insights`, { metric: metrics.join(',') }).catch((e) => { err = e; return null; });
  if (batch) return batch;
  console.error(`  · (건너뜀) ${label} ${id}: ${String(err?.message || err).slice(0, 200)}`);
  // 🔴 개별 폴백은 "지표 미지원(#100)" 일 때만.
  //    레이트리밋·5xx·네트워크 장애에 요청 수를 지표 개수만큼 곱하면 레이트리밋 방어가 무력해지고
  //    (재시도 곱셈으로) 잡 타임아웃까지 태운다.
  if (!/#100|unsupported|nonexisting|does not support/i.test(String(err?.message ?? ''))) return null;
  const rows = [];
  for (const m of metrics) {
    const one = await safeMetric(() => api(`${id}/insights`, { metric: m }), `${label} ${id}/${m}`);
    if (one?.data) rows.push(...one.data);
  }
  return rows.length ? { data: rows } : null;
}

// 목록을 limit 상한까지 받아왔고 그 마지막 항목이 아직 집계 구간 안이면, 더 있는데 잘렸을 수 있다.
export function warnIfTruncated(rows, sinceIso, label, limit = 50) {
  if (!Array.isArray(rows) || rows.length < limit) return false;
  const last = rows[rows.length - 1]?.timestamp;
  if (last && Date.parse(last) >= Date.parse(sinceIso)) {
    console.error(`  · (경고) ${label} 목록이 ${limit}건에서 잘림 — 집계 누락 가능(limit 상향 필요)`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 인스타그램 — ok/listOk 로 "수집 실패" 와 "실제 0건" 을 구분해 돌려준다.
// ---------------------------------------------------------------------------
export async function fetchInstagram(token, sinceIso, untilIso) {
  const api = makeApi(IG_GRAPH, IG_VER, token, '인스타');
  const out = { ok: false, listOk: false, username: null, accountFollowers: null, mediaCount: null, media: [] };

  // 필수 필드와 부가 필드를 분리한다 — 부가 필드 하나가 폐기돼도 전체가 날아가지 않게.
  const me = await safeMetric(() => api('me', { fields: 'user_id,username' }), '인스타 계정');
  const igid = me?.user_id || me?.id;
  if (!igid) return out;
  out.ok = true;
  out.username = me.username ?? null;

  const counts = await safeMetric(() => api('me', { fields: 'followers_count,media_count' }), '인스타 카운트');
  out.accountFollowers = typeof counts?.followers_count === 'number' ? counts.followers_count : null;
  out.mediaCount = typeof counts?.media_count === 'number' ? counts.media_count : null;

  const list = await safeMetric(
    () => api(`${igid}/media`, { fields: 'id,permalink,timestamp,caption', limit: 50 }),
    '인스타 게시물 목록',
  );
  // HTTP 200 + 비JSON 이면 api() 가 {} 를 돌려줄 수 있다 — truthy 라도 목록이 아니면 실패로 본다.
  if (!Array.isArray(list?.data)) return out;   // listOk=false → "0건" 이라고 말하지 않는다
  out.listOk = true;
  out.truncated = warnIfTruncated(list.data, sinceIso, '인스타');

  for (const m of list.data.filter((x) => inRange(x.timestamp, sinceIso, untilIso))) {
    const ins = await fetchInsights(api, m.id, ['reach', 'saved', 'total_interactions', 'views'], '인스타 인사이트');
    out.media.push({
      id: m.id,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp,
      title: firstLine(m.caption),
      reach: pickMetric(ins, 'reach'),
      views: pickMetric(ins, 'views'),
      saved: pickMetric(ins, 'saved'),
      totalInteractions: pickMetric(ins, 'total_interactions'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 스레드
// ---------------------------------------------------------------------------
export async function fetchThreads(token, sinceIso, untilIso) {
  const api = makeApi(TH_GRAPH, TH_VER, token, '스레드');
  const out = { ok: false, listOk: false, username: null, accountFollowers: null, media: [] };

  const me = await safeMetric(() => api('me', { fields: 'id,username' }), '스레드 계정');
  if (!me?.id) return out;
  out.ok = true;
  out.username = me.username ?? null;

  const acct = await safeMetric(() => api('me/threads_insights', { metric: 'followers_count' }), '스레드 팔로워');
  out.accountFollowers = pickMetric(acct, 'followers_count');

  const list = await safeMetric(
    () => api('me/threads', { fields: 'id,permalink,timestamp,text', limit: 50 }),
    '스레드 게시물 목록',
  );
  if (!Array.isArray(list?.data)) return out;
  out.listOk = true;
  out.truncated = warnIfTruncated(list.data, sinceIso, '스레드');

  for (const m of list.data.filter((x) => inRange(x.timestamp, sinceIso, untilIso))) {
    const ins = await fetchInsights(api, m.id, ['views', 'likes', 'replies', 'reposts', 'quotes'], '스레드 인사이트');
    out.media.push({
      id: m.id,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp,
      title: firstLine(m.text),
      views: pickMetric(ins, 'views'),
      likes: pickMetric(ins, 'likes'),
      replies: pickMetric(ins, 'replies'),
      reposts: pickMetric(ins, 'reposts'),
      quotes: pickMetric(ins, 'quotes'),
    });
  }
  return out;
}

// 게시물 식별용 제목 — 본문 첫 줄 40자(우리 계정이 공개 게시한 홍보 문구. 개인정보 아님).
// 백틱·꺾쇠 제거: Job Summary 코드펜스 깨짐 방지 + Slack `<!channel>` 류 주입 차단.
export function firstLine(text) {
  if (!text) return null;
  const l = String(text).split('\n').find((s) => s.trim()) || '';
  const safe = l.replace(/[`<>]/g, '').trim();
  return safe ? [...safe].slice(0, 40).join('') : null;
}

const sum = (arr, k) => arr.reduce((a, m) => a + (typeof m[k] === 'number' ? m[k] : 0), 0);
const has = (arr, k) => arr.some((m) => typeof m[k] === 'number');
// 지표 전건 미지원이면 0 대신 null — "0" 과 "측정 불가" 를 구분한다.
const agg = (arr, k) => (has(arr, k) ? sum(arr, k) : null);

export function buildReport(range, ig, th) {
  const igOk = !!(ig?.ok && ig?.listOk);
  const thOk = !!(th?.ok && th?.listOk);
  return {
    weekKey: range.weekKey,
    label: range.label,
    rangeStartIso: range.startIso,
    rangeEndIso: range.endIso,
    collectedAtIso: new Date().toISOString(),
    instagram: {
      collected: igOk,
      username: ig?.username ?? null,
      followers: ig?.accountFollowers ?? null,
      posts: igOk ? ig.media.length : null,   // 🔴 수집 실패는 0 이 아니라 null
      reach: agg(ig?.media || [], 'reach'),
      views: agg(ig?.media || [], 'views'),
      saved: agg(ig?.media || [], 'saved'),
      interactions: agg(ig?.media || [], 'totalInteractions'),
      truncated: !!ig?.truncated,
      media: ig?.media ?? [],
    },
    threads: {
      collected: thOk,
      username: th?.username ?? null,
      followers: th?.accountFollowers ?? null,
      posts: thOk ? th.media.length : null,
      views: agg(th?.media || [], 'views'),
      likes: agg(th?.media || [], 'likes'),
      replies: agg(th?.media || [], 'replies'),
      reposts: agg(th?.media || [], 'reposts'),
      quotes: agg(th?.media || [], 'quotes'),
      truncated: !!th?.truncated,
      media: th?.media ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// 요약 (비개발자 기준 — 숫자 + 전주 대비)
// ---------------------------------------------------------------------------
const n = (v) => (typeof v === 'number' ? v.toLocaleString('ko-KR') : '측정 불가');

function delta(cur, prev) {
  if (typeof cur !== 'number' || typeof prev !== 'number') return '';
  const d = cur - prev;
  if (d === 0) return ' (전주와 같음)';
  return ` (전주 ${prev.toLocaleString('ko-KR')} ${d > 0 ? '▲' : '▼'}${Math.abs(d).toLocaleString('ko-KR')})`;
}

const FAIL = '⚠️ 수집 실패 — 접속키 만료 여부를 확인하세요';

export function buildSummary(cur, prev) {
  const best = [...(cur.instagram.media || [])]
    .filter((m) => typeof m.reach === 'number')
    .sort((a, b) => b.reach - a.reach)[0];

  const lines = [
    `📊 SNS 주간 성과 (${cur.weekKey}, ${cur.label})`,
    '',
    cur.instagram.collected
      ? `인스타그램  게시 ${cur.instagram.posts}건 · 도달 ${n(cur.instagram.reach)}${delta(cur.instagram.reach, prev?.instagram?.reach)} · 저장 ${n(cur.instagram.saved)} · 팔로워 ${n(cur.instagram.followers)}`
      : `인스타그램  ${FAIL}`,
    cur.threads.collected
      ? `스레드      게시 ${cur.threads.posts}건 · 조회 ${n(cur.threads.views)}${delta(cur.threads.views, prev?.threads?.views)} · 좋아요 ${n(cur.threads.likes)} · 팔로워 ${n(cur.threads.followers)}`
      : `스레드      ${FAIL}`,
  ];
  if (best) lines.push('', `이번 주 최고 성과: "${best.title || best.id}" (도달 ${n(best.reach)})`);
  // 🔴 "미발행" 단정은 양쪽 다 수집에 성공했을 때만. 실패를 미발행으로 보고하면 거짓말이 된다.
  if (cur.instagram.collected && cur.threads.collected
      && cur.instagram.posts === 0 && cur.threads.posts === 0) {
    lines.push('', '※ 이 주에는 게시물이 없었습니다(카드뉴스 미발행).');
  }
  lines.push('', '※ Play 설치 유입은 Play 콘솔 > 획득 보고서 > 트래픽 소스에서 utm_source 별로 확인');
  return lines.join('\n');
}

async function sendSlack(text) {
  if (!SLACK) {
    console.log('· SLACK_WEBHOOK_MARKETING 미설정 — Slack 전송 건너뜀(실패 아님)');
    return false;
  }
  let hook;
  try { hook = new URL(SLACK); }
  catch { console.log('· SLACK_WEBHOOK_MARKETING 이 URL 형식이 아님 — 전송 건너뜀'); return false; }
  const res = await fetch(hook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack 전송 실패: HTTP ${res.status}`);
  console.log('· Slack 전송 완료');
  return true;
}

export function readPrevious(weekKey, dir = INSIGHTS_DIR) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return null;
  const y0 = Number(m[1]);
  const w0 = Number(m[2]) - 1;
  // 연초 롤오버: 직전 해가 53주인지 52주인지는 해마다 다르므로 둘 다 시도한다.
  const candidates = w0 >= 1 ? [[y0, w0]] : [[y0 - 1, 53], [y0 - 1, 52]];
  for (const [y, w] of candidates) {
    const f = join(dir, `${y}-W${String(w).padStart(2, '0')}.json`);
    if (!existsSync(f)) continue;
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const weekArgIdx = argv.indexOf('--week');
  const forcedWeek = weekArgIdx >= 0 ? argv[weekArgIdx + 1] : null;

  if (!IG_TOKEN && !TH_TOKEN) {
    console.error('✗ IG_ACCESS_TOKEN / THREADS_ACCESS_TOKEN 둘 다 없습니다.');
    process.exit(1);
  }
  // 시크릿 이름 오타 시 조용히 "0건" 이 되는 것을 막는다.
  if (!IG_TOKEN) console.error('⚠️ IG_ACCESS_TOKEN 없음 — 인스타는 "수집 실패" 로 기록됩니다.');
  if (!TH_TOKEN) console.error('⚠️ THREADS_ACCESS_TOKEN 없음 — 스레드는 "수집 실패" 로 기록됩니다.');

  const range = getWeekRange();
  if (forcedWeek) {
    if (!/^\d{4}-W\d{2}$/.test(forcedWeek)) {
      console.error('✗ --week 형식은 YYYY-Www 여야 합니다 (예: 2026-W32)');
      process.exit(1);
    }
    // 파일명만 바꾸면 파일 안의 집계 기간과 어긋난 기록이 남는다 → 저장하지 않는 경우에만 허용.
    if (!dryRun) {
      console.error('✗ --week 는 --dry-run 과만 함께 쓸 수 있습니다(파일명과 집계기간 불일치 방지).');
      process.exit(1);
    }
    range.weekKey = forcedWeek;
  }
  console.log(`수집 주간: ${range.weekKey} (${range.label})  ${range.startIso} ~ ${range.endIso}`);

  const ig = IG_TOKEN
    ? await safeMetric(() => fetchInstagram(IG_TOKEN, range.startIso, range.endIso), '인스타 전체')
    : null;
  const th = TH_TOKEN
    ? await safeMetric(() => fetchThreads(TH_TOKEN, range.startIso, range.endIso), '스레드 전체')
    : null;

  const report = buildReport(range, ig, th);
  const prev = readPrevious(range.weekKey);
  const summary = buildSummary(report, prev);

  console.log('');
  console.log(summary);
  console.log('');

  if (!dryRun) {
    mkdirSync(INSIGHTS_DIR, { recursive: true });
    const f = join(INSIGHTS_DIR, `${range.weekKey}.json`);
    writeFileSync(f, JSON.stringify(report, null, 2) + '\n');
    console.log(`✓ ${f}`);
  }

  // Slack 시크릿이 없어도 결과를 볼 수 있는 경로.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, '~~~~\n' + summary + '\n~~~~\n', { flag: 'a' });
    } catch { /* 요약 실패는 수집 실패가 아니다 */ }
  }

  await safeMetric(() => sendSlack(summary), 'Slack 전송');

  // 🔴 한쪽이라도 수집에 실패했으면 빨간불로 끝낸다(파일·요약은 이미 남겼다).
  //    조용히 성공하면 아무도 접속키 만료를 눈치채지 못한다.
  if (!report.instagram.collected || !report.threads.collected) {
    console.error('✗ 일부 채널 수집 실패 — 위 로그의 "(건너뜀)" 항목과 접속키 만료를 확인하세요.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('collect-insights.mjs')) {
  main().catch((e) => {
    console.error(`✗ ${String(e?.message || e).slice(0, 300)}`);
    process.exit(1);
  });
}
