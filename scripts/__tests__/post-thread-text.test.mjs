#!/usr/bin/env node
// 스레드 텍스트 게시·지표 수집 검증 — 순수 함수 단위 테스트.
// 실행: node scripts/__tests__/post-thread-text.test.mjs
// 네트워크·토큰 불필요(API 호출 함수는 대상 아님 — --dry-run 으로 실물 검증).
import assert from 'node:assert/strict';
import {
  sanitizeThreadText, clampLength, parsePostFile, sanitizeLossRatio,
  loadPostedState, savePostedState, LIMIT,
} from '../post-thread-text.mjs';
import {
  kstDateString, pickMetric, pruneOldFiles, fetchInsightsWithFallback, RateLimitError,
} from '../collect-threads-metrics.mjs';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`✅ ${name}`); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

// --- sanitizeThreadText -----------------------------------------------------
await t('sanitize: 해시태그 전용 줄 제거', () => {
  assert.equal(sanitizeThreadText('본문이야\n#머니핏 #가계부'), '본문이야');
});

await t('sanitize: 본문 중간 해시태그는 # 만 제거(줄 보존 — 스레드는 인라인 태그도 렌더됨)', () => {
  assert.equal(sanitizeThreadText('통장에 #텅장 소리 나옴'), '통장에 텅장 소리 나옴');
});

await t('sanitize: "#숫자"·"C#" 등 태그 문법이 아닌 # 는 보존, 줄머리 번호 매김 줄도 보존', () => {
  assert.equal(sanitizeThreadText('#1 원칙: 먼저 저축\n이게 핵심이야'), '#1 원칙: 먼저 저축\n이게 핵심이야');
  assert.equal(sanitizeThreadText('C#처럼 어렵다'), 'C#처럼 어렵다');
});

await t('sanitize: 스토어 CTA 줄 제거 (Google Play / 무료로 시작)', () => {
  assert.equal(sanitizeThreadText("Google Play에서 '머니핏 가계부' 검색\n진짜 본문\n지금 무료로 시작하기"), '진짜 본문');
});

await t('sanitize: URL 만 있는 줄·잔여가 무의미한 줄은 삭제', () => {
  assert.equal(sanitizeThreadText('본문\n다운로드 : https://moavant.com/mfAd/th\nmoavant.com'), '본문');
});

await t('sanitize: 문장 속 URL 은 토큰만 제거하고 문장은 보존', () => {
  assert.equal(
    sanitizeThreadText('자세한 계산은 blog.naver.com/xx 에 정리해뒀는데 요지는 이거야'),
    '자세한 계산은 에 정리해뒀는데 요지는 이거야',
  );
});

await t('sanitize: 스킴 없는 단축 도메인(bit.ly 등)도 잡는다', () => {
  assert.equal(sanitizeThreadText('본문\nbit.ly/abc 여기로'), '본문');
});

await t('sanitize: 연속 빈 줄은 하나로 접힌다', () => {
  assert.equal(sanitizeThreadText('한 줄\n\n\n\n두 줄'), '한 줄\n\n두 줄');
});

// --- clampLength ------------------------------------------------------------
await t('clamp: 500자 이하는 그대로', () => {
  const s = '가'.repeat(LIMIT);
  assert.equal(clampLength(s), s);
});

await t('clamp: 500자 초과는 말줄임(…) 포함 500자 이내', () => {
  const s = '가'.repeat(LIMIT + 50);
  const out = clampLength(s);
  assert.ok([...out].length <= LIMIT);
  assert.ok(out.endsWith('…'));
});

// --- parsePostFile ----------------------------------------------------------
await t('parse: 정상 파일 — text 정화 + 메타데이터 보존', () => {
  const p = parsePostFile(JSON.stringify({ text: '본문\n#태그', topic: '구독료', hook: '질문형' }));
  assert.equal(p.text, '본문');
  assert.equal(p.topic, '구독료');
  assert.equal(p.hook, '질문형');
});

await t('parse: followUp 도 정화되고, 없으면 null', () => {
  const p1 = parsePostFile(JSON.stringify({ text: '본문', followUp: '떡밥\n#태그' }));
  assert.equal(p1.followUp, '떡밥');
  const p2 = parsePostFile(JSON.stringify({ text: '본문' }));
  assert.equal(p2.followUp, null);
  const p3 = parsePostFile(JSON.stringify({ text: '본문', followUp: 'https://only-link.com' }));
  assert.equal(p3.followUp, null);
});

await t('parse: text 없으면 거부', () => {
  assert.throws(() => parsePostFile(JSON.stringify({ topic: 'x' })), /text 필드/);
});

await t('parse: 유효하지 않은 JSON 거부', () => {
  assert.throws(() => parsePostFile('{본문}'), /JSON 파싱 실패/);
});

await t('parse: 정화 후 빈 본문이면 거부(해시태그·링크만 있는 글)', () => {
  assert.throws(() => parsePostFile(JSON.stringify({ text: '#태그만\nhttps://x.com' })), /정화.*비었습니다/);
});

// --- sanitizeLossRatio ------------------------------------------------------
await t('lossRatio: 제거 없음 = 0, 절반 제거 ≈ 0.5', () => {
  assert.equal(sanitizeLossRatio('본문', '본문'), 0);
  const r = sanitizeLossRatio('1234567890', '12345');
  assert.ok(r > 0.4 && r < 0.6);
});

// --- posted state (멱등성) --------------------------------------------------
await t('postedState: 없으면 빈 상태, 저장 → 로드 왕복', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-posted-test-'));
  const f = join(dir, 'state', 'threads-posted.json');
  assert.deepEqual(loadPostedState(f), { posted: {} });
  const s = { posted: { 'threads/posts/a.json': { postId: '123', at: '2026-08-24T00:00:00.000Z' } } };
  savePostedState(s, f);
  assert.deepEqual(loadPostedState(f), s);
});

// --- collect-threads-metrics 순수 함수 --------------------------------------
await t('kstDateString: UTC 15시 = KST 다음날', () => {
  assert.equal(kstDateString(new Date('2026-08-24T15:30:00Z')), '2026-08-25');
});

await t('pickMetric: total_value 우선, 없으면 values[0], 그래도 없으면 null', () => {
  assert.equal(pickMetric({ data: [{ name: 'views', total_value: { value: 42 } }] }, 'views'), 42);
  assert.equal(pickMetric({ data: [{ name: 'likes', values: [{ value: 7 }] }] }, 'likes'), 7);
  assert.equal(pickMetric({ data: [] }, 'views'), null);
  assert.equal(pickMetric(null, 'views'), null);
});

await t('pruneOldFiles: 기준일 지난 YYYY-MM-DD.json 만 삭제, 다른 파일은 보존', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threads-metrics-test-'));
  writeFileSync(join(dir, '2026-01-01.json'), '{}');
  writeFileSync(join(dir, `${kstDateString()}.json`), '{}');
  writeFileSync(join(dir, 'README.md'), 'x');
  const removed = pruneOldFiles(dir, 60);
  assert.deepEqual(removed, ['2026-01-01.json']);
  assert.ok(readdirSync(dir).includes('README.md'));
});

await t('fetchInsightsWithFallback: 배치 성공 시 1회 호출', async () => {
  let calls = 0;
  const api = async () => { calls++; return { data: [{ name: 'views', values: [{ value: 1 }] }] }; };
  const out = await fetchInsightsWithFallback(api, 'id1', ['views', 'likes']);
  assert.equal(calls, 1);
  assert.equal(pickMetric(out, 'views'), 1);
});

await t('fetchInsightsWithFallback: 미지원(#100) 배치 실패 시 개별 폴백으로 살릴 수 있는 지표만 살린다', async () => {
  const api = async (path, params) => {
    if (params.metric.includes(',')) throw new Error('(#100) unsupported metric');
    if (params.metric === 'views') return { data: [{ name: 'views', values: [{ value: 9 }] }] };
    throw new Error('(#100) nonexisting field');
  };
  const out = await fetchInsightsWithFallback(api, 'id1', ['views', 'likes']);
  assert.equal(pickMetric(out, 'views'), 9);
  assert.equal(pickMetric(out, 'likes'), null);
});

await t('fetchInsightsWithFallback: 미지원이 아닌 배치 실패(5xx 등)는 폴백 없이 null', async () => {
  let calls = 0;
  const api = async () => { calls++; throw new Error('HTTP 500'); };
  const out = await fetchInsightsWithFallback(api, 'id1', ['views', 'likes']);
  assert.equal(out, null);
  assert.equal(calls, 1); // 개별 폴백으로 요청 수를 곱하지 않는다
});

await t('fetchInsightsWithFallback: 레이트리밋은 폴백 없이 즉시 재throw (호출 1회)', async () => {
  let calls = 0;
  const api = async () => { calls++; throw new RateLimitError('레이트리밋(code 4)'); };
  await assert.rejects(() => fetchInsightsWithFallback(api, 'id1', ['views', 'likes']), RateLimitError);
  assert.equal(calls, 1); // 개별 폴백으로 쿼터를 더 태우지 않는다
});

console.log(`\n${pass}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
