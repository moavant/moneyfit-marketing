#!/usr/bin/env node
// SUS-230 Phase 2 (P-20) 검증 — 순수 함수 단위 테스트.
// 실행: node scripts/__tests__/collect-insights.test.mjs
// 네트워크·토큰 불필요(API 호출 함수는 대상 아님 — 워크플로 dry-run 으로 실물 검증).
import assert from 'node:assert/strict';
import {
  getWeekRange, safeMetric, pickMetric, firstLine, buildReport, buildSummary,
  makeApi, inRange, fetchInsights, readPrevious, warnIfTruncated,
} from '../collect-insights.mjs';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`✅ ${name}`); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

// --- getWeekRange: KST 월~일, 직전 주 -------------------------------------
await t('getWeekRange: 월요일 09:00 KST 실행 → 직전 주 월~일', () => {
  // 2026-08-03(월) 00:00 UTC = 09:00 KST
  const r = getWeekRange(new Date('2026-08-03T00:00:00Z'));
  assert.equal(r.startIso, '2026-07-26T15:00:00.000Z'); // 7/27(월) 00:00 KST
  assert.equal(r.endIso, '2026-08-02T15:00:00.000Z');   // 8/3(월) 00:00 KST
  assert.equal(r.label, '7/27~8/2');
});

await t('getWeekRange: 주중(수) 실행도 같은 직전 주를 가리킨다', () => {
  const mon = getWeekRange(new Date('2026-08-03T00:00:00Z'));
  const wed = getWeekRange(new Date('2026-08-05T05:00:00Z'));
  assert.equal(wed.startIso, mon.startIso);
  assert.equal(wed.endIso, mon.endIso);
});

await t('getWeekRange: 일요일 23:00 KST 는 아직 그 주가 안 끝났으므로 직전 주', () => {
  // 2026-08-02(일) 14:00 UTC = 23:00 KST
  const r = getWeekRange(new Date('2026-08-02T14:00:00Z'));
  assert.equal(r.startIso, '2026-07-19T15:00:00.000Z'); // 7/20(월)
  assert.equal(r.endIso, '2026-07-26T15:00:00.000Z');   // 7/27(월)
});

await t('getWeekRange: weekKey 형식 YYYY-Www', () => {
  const r = getWeekRange(new Date('2026-08-03T00:00:00Z'));
  assert.match(r.weekKey, /^\d{4}-W\d{2}$/);
});

await t('getWeekRange: UTC 자정 직후(KST 오전 9시 이전)에도 날짜가 밀리지 않는다', () => {
  // 2026-08-02T23:30Z = 2026-08-03 08:30 KST (월요일) → 직전 주여야 한다
  const r = getWeekRange(new Date('2026-08-02T23:30:00Z'));
  assert.equal(r.startIso, '2026-07-26T15:00:00.000Z');
});

// --- safeMetric ------------------------------------------------------------
await t('safeMetric: 성공값 통과', async () => {
  assert.equal(await safeMetric(async () => 7), 7);
});

await t('safeMetric: 실패 시 null 반환(throw 안 함)', async () => {
  assert.equal(await safeMetric(async () => { throw new Error('metric deprecated'); }), null);
});

await t('safeMetric: 에러 메시지에 토큰이 섞여도 200자 절단 + 그대로 던지지 않음', async () => {
  const r = await safeMetric(async () => { throw new Error('x'.repeat(500)); });
  assert.equal(r, null);
});

// --- pickMetric: Meta 응답 두 가지 형태 -----------------------------------
await t('pickMetric: values[0].value 형태', () => {
  assert.equal(pickMetric({ data: [{ name: 'reach', values: [{ value: 41 }] }] }, 'reach'), 41);
});

await t('pickMetric: total_value 형태', () => {
  assert.equal(pickMetric({ data: [{ name: 'views', total_value: { value: 128 } }] }, 'views'), 128);
});

await t('pickMetric: 없는 지표 → null (폐기 지표 내성)', () => {
  assert.equal(pickMetric({ data: [{ name: 'reach', values: [{ value: 1 }] }] }, 'impressions'), null);
});

await t('pickMetric: null 응답 → null', () => {
  assert.equal(pickMetric(null, 'reach'), null);
});

await t('pickMetric: 값이 숫자가 아니면 null', () => {
  assert.equal(pickMetric({ data: [{ name: 'reach', values: [{ value: 'many' }] }] }, 'reach'), null);
});

// --- firstLine -------------------------------------------------------------
await t('firstLine: 첫 비어있지 않은 줄 40자', () => {
  assert.equal(firstLine('\n\n구독 3개만 정리해도 월 3만원\n둘째 줄'), '구독 3개만 정리해도 월 3만원');
});

await t('firstLine: 40자 초과 절단', () => {
  assert.equal([...firstLine('가'.repeat(80))].length, 40);
});

await t('firstLine: null/빈 문자열 → null', () => {
  assert.equal(firstLine(null), null);
  assert.equal(firstLine(''), null);
});

// --- buildReport: 집계 · 측정불가 구분 ------------------------------------
const range = getWeekRange(new Date('2026-08-03T00:00:00Z'));

await t('buildReport: 합산 정상', () => {
  const r = buildReport(range,
    { ok: true, listOk: true, username: 'moneyfit.moavant', accountFollowers: 12, media: [
      { id: 'a', reach: 20, views: 30, saved: 1, totalInteractions: 3 },
      { id: 'b', reach: 21, views: 33, saved: 0, totalInteractions: 2 },
    ] },
    { ok: true, listOk: true, accountFollowers: 5, media: [{ id: 'c', views: 128, likes: 4, replies: 0, reposts: 1 }] });
  assert.equal(r.instagram.posts, 2);
  assert.equal(r.instagram.reach, 41);
  assert.equal(r.instagram.saved, 1);
  assert.equal(r.threads.views, 128);
  assert.equal(r.weekKey, range.weekKey);
});

await t('buildReport: 지표 전건 미지원이면 0 이 아니라 null (0 과 측정불가 구분)', () => {
  const r = buildReport(range, { ok: true, listOk: true, media: [{ id: 'a', reach: null, saved: null }] }, null);
  assert.equal(r.instagram.reach, null);
  assert.equal(r.instagram.saved, null);
  assert.equal(r.threads.posts, 0);
});

await t('buildReport: 일부만 측정되면 측정된 것만 합산', () => {
  const r = buildReport(range, { ok: true, listOk: true, media: [{ id: 'a', reach: 10 }, { id: 'b', reach: null }] }, null);
  assert.equal(r.instagram.reach, 10);
});

await t('buildReport: 실제 0건(수집 성공)은 posts=0', () => {
  const r = buildReport(range, { ok: true, listOk: true, media: [] }, { ok: true, listOk: true, media: [] });
  assert.equal(r.instagram.posts, 0);
  assert.equal(r.instagram.collected, true);
  assert.equal(r.instagram.reach, null);
});

// --- buildSummary ----------------------------------------------------------
const cur = buildReport(range,
  { ok: true, listOk: true, username: 'moneyfit.moavant', accountFollowers: 12, media: [
    { id: 'a', title: '구독 3개만 정리해도 월 3만원', reach: 22, saved: 1 },
    { id: 'b', title: '무지출 챌린지', reach: 19, saved: 0 },
  ] },
  { ok: true, listOk: true, accountFollowers: 5, media: [{ id: 'c', views: 128, likes: 4 }] });

await t('buildSummary: 전주 없으면 증감 표기 없음', () => {
  const s = buildSummary(cur, null);
  assert.ok(s.includes('도달 41'));
  assert.ok(!s.includes('전주'));
});

await t('buildSummary: 전주 대비 증가 ▲', () => {
  const prev = { instagram: { reach: 39 }, threads: { views: 100 } };
  const s = buildSummary(cur, prev);
  assert.ok(s.includes('전주 39 ▲2'), s);
});

await t('buildSummary: 전주 대비 감소 ▼', () => {
  const s = buildSummary(cur, { instagram: { reach: 50 }, threads: {} });
  assert.ok(s.includes('▼9'), s);
});

await t('buildSummary: 동일하면 "전주와 같음"', () => {
  const s = buildSummary(cur, { instagram: { reach: 41 }, threads: {} });
  assert.ok(s.includes('전주와 같음'), s);
});

await t('buildSummary: 측정 불가 지표는 "측정 불가" 로 표기(0 으로 오독 금지)', () => {
  const r = buildReport(range, { ok: true, listOk: true, media: [{ id: 'a', reach: null }] }, null);
  const s = buildSummary(r, null);
  assert.ok(s.includes('측정 불가'), s);
});

await t('buildSummary: 최고 성과 게시물 선정', () => {
  const s = buildSummary(cur, null);
  assert.ok(s.includes('구독 3개만 정리해도 월 3만원'), s);
});

await t('buildSummary: 게시물 0건이면 미발행 안내', () => {
  const s = buildSummary(buildReport(range, { ok: true, listOk: true, media: [] }, { ok: true, listOk: true, media: [] }), null);
  assert.ok(s.includes('카드뉴스 미발행'), s);
});

await t('buildSummary: Play 콘솔 안내 문구 항상 포함', () => {
  assert.ok(buildSummary(cur, null).includes('utm_source'));
});

// --- 보안: 요약·리포트에 토큰이 실릴 여지가 없다 --------------------------
await t('보안: 리포트 JSON 에 access_token 키가 없다', () => {
  const j = JSON.stringify(buildReport(range, { ok: true, listOk: true, media: [{ id: 'a', reach: 1 }] }, null));
  assert.ok(!/access_token/i.test(j));
  assert.ok(!/token/i.test(j));
});

// --- H-1 회귀: 수집 실패를 0 건으로 보고하지 않는다 (보안검토 HIGH) ----------
await t('H-1: 인스타 수집 실패 → posts=0 이 아니라 null, collected=false', () => {
  const r = buildReport(range, { ok: false, listOk: false, media: [] }, { ok: true, listOk: true, media: [] });
  assert.equal(r.instagram.posts, null);
  assert.equal(r.instagram.collected, false);
});

await t('H-1: 목록 조회만 실패해도 0건이라 말하지 않는다', () => {
  const r = buildReport(range, { ok: true, listOk: false, media: [] }, { ok: true, listOk: true, media: [] });
  assert.equal(r.instagram.posts, null);
});

await t('H-1: 수집 실패 시 요약에 "수집 실패" 경고가 뜬다', () => {
  const s = buildSummary(buildReport(range, { ok: false, listOk: false, media: [] }, { ok: true, listOk: true, media: [] }), null);
  assert.ok(s.includes('수집 실패'), s);
  assert.ok(s.includes('접속키'), s);
});

await t('H-1: 🔴 수집 실패를 "카드뉴스 미발행" 으로 단정하지 않는다 (거짓 보고 방지)', () => {
  const s = buildSummary(buildReport(range, { ok: false, listOk: false, media: [] }, { ok: false, listOk: false, media: [] }), null);
  assert.ok(!s.includes('미발행'), '수집 실패인데 미발행이라고 보고함: ' + s);
});

await t('H-1: 양쪽 모두 수집 성공 + 실제 0건일 때만 미발행 안내', () => {
  const s = buildSummary(buildReport(range, { ok: true, listOk: true, media: [] }, { ok: true, listOk: true, media: [] }), null);
  assert.ok(s.includes('미발행'), s);
});

// --- 보안(O-1): 실제 유출 경로 검증 — 토큰이 로그·에러에 절대 안 섞인다 ------
await t('보안: API 실패 로그·에러·스택 어디에도 토큰이 없다', async () => {
  const TOKEN = 'IGQVSUPERSECRET1234567890';
  const logs = [];
  const origErr = console.error;
  const origFetch = globalThis.fetch;
  console.error = (...a) => logs.push(a.join(' '));
  globalThis.fetch = async () => ({
    ok: false, status: 400,
    json: async () => ({ error: { message: 'Invalid OAuth access token', code: 190 } }),
  });
  try {
    const api = makeApi('https://graph.example', 'v1', TOKEN, '테스트');
    const err = await api('me', { fields: 'id' }).catch((e) => e);
    const all = logs.join('\n') + '\n' + String(err?.message) + '\n' + String(err?.stack);
    assert.ok(!all.includes(TOKEN), '토큰이 로그/에러에 노출됨');
    assert.ok(!/access_token/i.test(all), 'access_token 파라미터가 노출됨');
  } finally {
    console.error = origErr;
    globalThis.fetch = origFetch;
  }
});

await t('보안: 토큰은 URL 이 아니라 Authorization 헤더로 나간다', async () => {
  const TOKEN = 'THSECRET999';
  let seenUrl = '', seenHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, opt) => {
    seenUrl = String(u); seenHeaders = opt?.headers;
    return { ok: true, status: 200, json: async () => ({ id: '1' }) };
  };
  try {
    await makeApi('https://graph.example', 'v1', TOKEN, 'T')('me', { fields: 'id' });
    assert.ok(!seenUrl.includes(TOKEN), 'URL 에 토큰이 실림: ' + seenUrl);
    assert.ok(!/access_token/.test(seenUrl), 'URL 에 access_token 파라미터가 실림');
    assert.equal(seenHeaders?.authorization, `Bearer ${TOKEN}`);
  } finally { globalThis.fetch = origFetch; }
});

// --- 레이트리밋: 재시도하지 않고 즉시 포기 (M-3) -----------------------------
await t('M-3: 레이트리밋(code 4/613) 은 재시도하지 않는다 (쿼터 악화 방지)', async () => {
  for (const code of [4, 17, 32, 613]) {
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({ error: { message: 'rate', code } }) };
    };
    try {
      const err = await makeApi('https://x', 'v1', 't', 'T')('me').catch((e) => e);
      assert.equal(calls, 1, `code ${code} 에서 ${calls}회 호출됨(1회여야 함)`);
      assert.ok(String(err.message).includes('레이트리밋'), String(err.message));
    } finally { globalThis.fetch = origFetch; }
  }
});

// --- fetchInsights: 배치 실패 시 개별 폴백 (M-1) -----------------------------
await t('M-1: 배치 지표 요청이 죽으면 개별 요청으로 살릴 수 있는 것만 살린다', async () => {
  const api = async (path, params) => {
    if (String(params.metric).includes(',')) throw new Error('(#100) unsupported metric: saved');
    if (params.metric === 'saved') throw new Error('(#100) unsupported metric: saved');
    return { data: [{ name: params.metric, values: [{ value: 5 }] }] };
  };
  const out = await fetchInsights(api, 'm1', ['reach', 'saved', 'views'], 'T');
  assert.equal(pickMetric(out, 'reach'), 5);
  assert.equal(pickMetric(out, 'views'), 5);
  assert.equal(pickMetric(out, 'saved'), null);   // 이것만 null
});

await t('M-1: 배치 성공 시 개별 재시도 없이 1회로 끝난다', async () => {
  let calls = 0;
  const api = async (path, params) => { calls++; return { data: [{ name: 'reach', values: [{ value: 3 }] }] }; };
  await fetchInsights(api, 'm1', ['reach', 'views'], 'T');
  assert.equal(calls, 1);
});

// --- inRange: 오프셋 표기 타임스탬프 (M-5) -----------------------------------
await t('M-5: Meta 의 +0000 오프셋 표기도 정확히 비교한다', () => {
  const a = '2026-07-26T15:00:00.000Z', b = '2026-08-02T15:00:00.000Z';
  assert.equal(inRange('2026-07-28T12:00:00+0000', a, b), true);
  assert.equal(inRange('2026-07-26T14:59:59+0000', a, b), false);  // 범위 직전
  assert.equal(inRange('2026-08-02T15:00:00+0000', a, b), false);  // 상한 배타
  assert.equal(inRange('2026-07-28T23:00:00+0900', a, b), true);   // KST 오프셋 표기
});

await t('M-5: 파싱 불가 타임스탬프는 제외', () => {
  assert.equal(inRange('not-a-date', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), false);
});

// --- firstLine 위생 (O-2) ----------------------------------------------------
await t('O-2: 백틱·꺾쇠 제거 (코드펜스 깨짐·Slack 멘션 주입 차단)', () => {
  assert.equal(firstLine('```위험``` <!channel> 문구'), '위험 !channel 문구');
});

// --- readPrevious ------------------------------------------------------------
await t('readPrevious: 파일 없으면 null', () => {
  assert.equal(readPrevious('2026-W32', '/tmp/__no_such_dir__'), null);
});

await t('readPrevious: 형식 틀리면 null', () => {
  assert.equal(readPrevious('nonsense'), null);
});

// --- 2차 검토 반영 회귀 (R-1 / R-3 / R-5 / R-6 / R-8) ------------------------
await t('R-1: 레이트리밋으로 배치가 죽으면 개별 폴백을 하지 않는다(호출 1회)', async () => {
  let calls = 0;
  const api = async () => { calls++; throw new Error('스레드 [x/insights]: 레이트리밋(code 613) — 생략'); };
  const out = await fetchInsights(api, 'm1', ['a', 'b', 'c', 'd', 'e'], 'T');
  assert.equal(out, null);
  assert.equal(calls, 1, `레이트리밋인데 ${calls}회 호출됨(1회여야 함)`);
});

await t('R-1: 5xx·네트워크 장애도 개별 폴백 안 함(재시도 곱셈·타임아웃 방지)', async () => {
  let calls = 0;
  const api = async () => { calls++; throw new Error('인스타 [x/insights]: HTTP 500'); };
  assert.equal(await fetchInsights(api, 'm1', ['a', 'b', 'c'], 'T'), null);
  assert.equal(calls, 1);
});

await t('R-1: 지표 미지원(#100)일 때만 개별 폴백', async () => {
  let calls = 0;
  const api = async (path, params) => {
    calls++;
    if (String(params.metric).includes(',')) throw new Error('(#100) unsupported metric: saved');
    if (params.metric === 'saved') throw new Error('(#100) unsupported metric: saved');
    return { data: [{ name: params.metric, values: [{ value: 5 }] }] };
  };
  const out = await fetchInsights(api, 'm1', ['reach', 'saved', 'views'], 'T');
  assert.equal(pickMetric(out, 'reach'), 5);
  assert.equal(pickMetric(out, 'saved'), null);
  assert.equal(calls, 4); // 배치 1 + 개별 3
});

await t('R-3: HTTP 200 + 비목록 응답이면 "0건" 이라 말하지 않는다', () => {
  // fetch* 는 네트워크가 필요하므로 buildReport 계약으로 검증:
  //   listOk=false 이면 posts 는 반드시 null 이어야 한다.
  const r = buildReport(range, { ok: true, listOk: false, media: [] }, { ok: true, listOk: false, media: [] });
  assert.equal(r.instagram.posts, null);
  assert.equal(r.threads.posts, null);
  const s = buildSummary(r, null);
  assert.ok(!s.includes('미발행'), s);
});

await t('R-5: 접속키에 개행·공백이 있으면 값 없이 즉시 거부', () => {
  for (const bad of ['tok\nen', 'tok en', ' ', '', 'tok\ren']) {
    assert.throws(() => makeApi('https://x', 'v1', bad, 'T'), (e) => {
      assert.ok(/접속키 형식 오류/.test(e.message), e.message);
      assert.ok(!e.message.includes('tok'), '에러 메시지에 접속키 값이 노출됨: ' + e.message);
      return true;
    });
  }
});

await t('R-5: 정상 접속키는 통과', () => {
  assert.equal(typeof makeApi('https://x', 'v1', 'IGQVJ-abc_123.def~xyz+/=', 'T'), 'function');
});

await t('R-6: 네트워크 아닌 TypeError 는 재시도하지 않는다', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new TypeError("Cannot read properties of undefined"); };
  try {
    await makeApi('https://x', 'v1', 'tok', 'T')('me').catch(() => {});
    assert.equal(calls, 1, `프로그래밍 오류인데 ${calls}회 재시도됨`);
  } finally { globalThis.fetch = origFetch; }
});

await t('R-6: 실제 네트워크 오류는 재시도한다', async () => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  try {
    await makeApi('https://x', 'v1', 'tok', 'T')('me').catch(() => {});
    assert.equal(calls, 4, `네트워크 오류인데 ${calls}회만 시도됨(4회여야 함)`);
  } finally { globalThis.fetch = origFetch; }
});

await t('R-8: 목록이 limit 에서 잘리면 경고 + truncated=true', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ timestamp: '2026-07-28T00:00:00+0000' }));
  const origErr = console.error; const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(warnIfTruncated(rows, '2026-07-26T15:00:00.000Z', '인스타'), true);
    assert.ok(logs.join('\n').includes('잘림'));
  } finally { console.error = origErr; }
});

await t('R-8: 50건 미만이면 경고 없음', () => {
  assert.equal(warnIfTruncated([{ timestamp: '2026-07-28T00:00:00+0000' }], '2026-07-26T15:00:00.000Z', 'T'), false);
});

await t('R-8: 50건이지만 마지막이 구간 밖이면 잘린 게 아님', () => {
  const rows = Array.from({ length: 50 }, () => ({ timestamp: '2026-01-01T00:00:00+0000' }));
  assert.equal(warnIfTruncated(rows, '2026-07-26T15:00:00.000Z', 'T'), false);
});

console.log(`\n${pass}개 통과`);
