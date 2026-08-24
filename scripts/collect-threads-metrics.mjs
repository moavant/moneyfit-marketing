#!/usr/bin/env node
// 스레드 일간 지표 수집 — 자율 발행 루틴의 "학습 데이터"를 만든다.
//
// 클라우드 발행 루틴은 GitHub Secrets(THREADS_ACCESS_TOKEN)에 접근할 수 없으므로,
// 이 스크립트를 GitHub Actions(threads-metrics.yml)가 매일 돌려 최근 게시물 지표를
// threads/metrics/YYYY-MM-DD.json 으로 레포에 커밋한다 → 루틴은 이 파일들을 읽고 학습한다.
// (주간 집계 social-insights.yml 과 별개 — 이쪽은 게시물 단위 일간 스냅샷.)
//
// 실행: node scripts/collect-threads-metrics.mjs [--dry-run]
// 환경변수: THREADS_ACCESS_TOKEN (필수)
//
// 🔴 실패 원칙(collect-insights.mjs 와 동일):
//   - 레이트리밋(code 4/17/32/613)은 재시도·계속 진행 금지 — 즉시 전체 중단하고 파일을 쓰지 않는다
//     (전건 null 스냅샷이 "학습 데이터"로 커밋되는 것을 막는다. 잡이 빨간불 = 커밋 스텝 자동 스킵).
//   - 게시물별 insights 실패는 insightsOk:false 로 기록해 "수집 실패"와 "값 없음"을 구분한다.
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'threads', 'metrics');
const GRAPH = 'https://graph.threads.net';
const VER = 'v1.0';
const POST_LIMIT = 25;        // 최근 게시물 N건의 지표를 스냅샷
const KEEP_DAYS = 60;         // 이보다 오래된 지표 파일은 삭제(레포 비대화 방지)
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];
const RATE_LIMIT_CODES = [4, 17, 32, 613]; // 재시도해도 쿼터만 태운다 — 즉시 포기

export class RateLimitError extends Error {}

// KST 날짜 문자열 (실행 환경 TZ 와 무관하게 고정)
export function kstDateString(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 지표 응답에서 특정 metric 값 추출 — 없으면 null (0 과 구분)
export function pickMetric(ins, name) {
  const row = (ins?.data || []).find((d) => d.name === name);
  if (!row) return null;
  if (row.total_value && typeof row.total_value.value === 'number') return row.total_value.value;
  const v = row.values?.[0]?.value;
  return typeof v === 'number' ? v : null;
}

// 오래된 지표 파일 정리 — 파일명 YYYY-MM-DD.json 기준(zero-pad 고정폭 → 사전순 = 시간순)
export function pruneOldFiles(dir, keepDays, today = new Date()) {
  const cutoff = kstDateString(new Date(today.getTime() - keepDays * 86400 * 1000));
  const removed = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const f of names) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < cutoff) { unlinkSync(join(dir, f)); removed.push(f); }
  }
  return removed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(token) {
  const clean = String(token ?? '').trim();
  if (!clean || !/^[\w.\-~+/=]+$/.test(clean)) {
    throw new Error('THREADS_ACCESS_TOKEN 형식 오류(공백·개행 포함 여부 확인). 값은 로그에 남기지 않습니다.');
  }
  return async function api(path, params = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const url = new URL(`${GRAPH}/${VER}/${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      let res, json;
      try {
        // 🔴 토큰은 Authorization 헤더로만 — URL·에러 메시지에 노출하지 않는다.
        res = await fetch(url, { headers: { authorization: `Bearer ${clean}` } });
        json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const code = json?.error?.code;
        if (RATE_LIMIT_CODES.includes(code)) {
          throw new RateLimitError(`레이트리밋(code ${code}) [${path}] — 이번 회차 수집 전체 중단`);
        }
        if (attempt < 3 && res.status >= 500) { await sleep(3000 * attempt); continue; }
        const e = json?.error || {};
        throw new Error(`API 실패 [${path}]: ${e.message || ('HTTP ' + res.status)} | code=${e.code ?? ''}`);
      } catch (e) {
        const isNetwork = e instanceof TypeError
          && /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(`${e.message} ${e.cause?.code ?? ''}`);
        if (attempt < 3 && isNetwork) { await sleep(3000 * attempt); continue; }
        throw e;
      }
    }
  };
}

// Meta 는 metric 콤마 목록 중 하나라도 미지원이면 요청 전체를 400 으로 거부한다(collect-insights.mjs 실증).
// 배치가 죽으면 "지표 미지원(#100)"일 때만 개별 재시도로 살릴 수 있는 지표만 살린다.
export async function fetchInsightsWithFallback(api, id, metrics) {
  let err = null;
  const batch = await api(`${id}/insights`, { metric: metrics.join(',') }).catch((e) => { err = e; return null; });
  if (batch) return batch;
  if (err instanceof RateLimitError) throw err; // 레이트리밋은 폴백 금지 — 요청 수를 곱하면 방어가 무력해진다
  console.error(`  · (배치 실패) ${id}: ${String(err?.message || err).slice(0, 200)}`);
  if (!/#100|unsupported|nonexisting|does not support/i.test(String(err?.message ?? ''))) return null;
  const rows = [];
  for (const m of metrics) {
    try {
      const one = await api(`${id}/insights`, { metric: m });
      if (one?.data) rows.push(...one.data);
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      console.error(`  · (건너뜀) ${id}/${m}: ${String(e.message).slice(0, 120)}`);
    }
  }
  return rows.length ? { data: rows } : null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const TOKEN = process.env.THREADS_ACCESS_TOKEN;
  if (!TOKEN) { console.error('✗ THREADS_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }
  const api = makeApi(TOKEN);

  const me = await api('me', { fields: 'id,username' });
  if (!me.id) throw new Error('스레드 사용자 ID를 가져오지 못했습니다(토큰 권한 확인).');
  console.log(`스레드 계정: @${me.username || '?'}`);

  // 팔로워 수 — 실패해도 게시물 지표 수집은 계속한다(레이트리밋 제외)
  let followers = null;
  try {
    const f = await api('me/threads_insights', { metric: 'followers_count' });
    followers = pickMetric(f, 'followers_count');
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.error(`  · 팔로워 수 수집 실패(계속 진행): ${e.message}`);
  }

  // is_reply 로 본글/자기 댓글(followUp)을 구분해 지표가 섞이지 않게 한다.
  // 필드 미지원으로 400 이 나면 기본 필드로 폴백(isReply: null).
  const BASE_FIELDS = 'id,permalink,timestamp,text';
  let list;
  try {
    list = await api('me/threads', { fields: `${BASE_FIELDS},is_reply`, limit: String(POST_LIMIT) });
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.error(`  · is_reply 필드 미지원 추정 — 기본 필드로 재시도: ${String(e.message).slice(0, 120)}`);
    list = await api('me/threads', { fields: BASE_FIELDS, limit: String(POST_LIMIT) });
  }
  const rows = list?.data || [];
  if (rows.length >= POST_LIMIT) {
    console.error(`  · (경고) 목록이 ${POST_LIMIT}건에서 잘림 — 관측 창이 좁아졌을 수 있음(limit 상향 검토)`);
  }

  const posts = [];
  for (const m of rows) {
    let ins = null; let insightsOk = false;
    try {
      ins = await fetchInsightsWithFallback(api, m.id, METRICS);
      insightsOk = Array.isArray(ins?.data) && ins.data.length > 0; // 200+빈 응답도 '실패'로 분류
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      console.error(`  · 게시물 ${m.id} 지표 실패(계속 진행): ${e.message}`);
    }
    posts.push({
      id: m.id,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? null,
      isReply: typeof m.is_reply === 'boolean' ? m.is_reply : null, // 필드가 조용히 누락되면 false 아닌 null
      text: [...(m.text || '')].slice(0, 300).join(''), // 코드포인트 기준 — 이모지 절단 방지
      insightsOk, // 🔴 false = "수집 실패" (null 지표와 "값 0"을 구분하는 근거)
      views: pickMetric(ins, 'views'),
      likes: pickMetric(ins, 'likes'),
      replies: pickMetric(ins, 'replies'),
      reposts: pickMetric(ins, 'reposts'),
      quotes: pickMetric(ins, 'quotes'),
    });
    await sleep(300); // 게시물별 insights 호출 사이 살짝 간격(레이트리밋 예방)
  }

  const failed = posts.filter((p) => !p.insightsOk).length;
  if (posts.length && failed === posts.length) {
    // 전건 실패 스냅샷은 학습 데이터로서 무가치 — 쓰지 않고 빨간불로 끝낸다(커밋 스텝 자동 스킵)
    throw new Error(`게시물 ${posts.length}건 전건 지표 수집 실패 — 파일을 쓰지 않고 중단(토큰·권한·쿼터 확인)`);
  }

  const report = { collectedAt: new Date().toISOString(), username: me.username ?? null, followers, posts };
  const outFile = join(OUT_DIR, `${kstDateString()}.json`);

  if (dryRun) {
    console.log('--- dry-run: 파일 저장 없음 ---');
    console.log(JSON.stringify(report, null, 2).slice(0, 2000));
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`✅ 저장: ${outFile} (게시물 ${posts.length}건${failed ? `, 지표 실패 ${failed}건` : ''}, 팔로워 ${followers ?? '?'})`);
  try {
    const removed = pruneOldFiles(OUT_DIR, KEEP_DAYS);
    if (removed.length) console.log(`  · ${KEEP_DAYS}일 지난 지표 파일 ${removed.length}개 정리`);
  } catch (e) {
    console.error(`  · (경고) 오래된 파일 정리 실패 — 오늘 수집분은 무사: ${e.message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('collect-threads-metrics.mjs')) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
