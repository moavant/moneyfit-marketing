#!/usr/bin/env node
// 스레드 댓글 자동응답 검증 — 순수 함수 단위 테스트.
// 실행: node scripts/__tests__/reply-comments.test.mjs
// 네트워크·토큰·Claude 호출 불필요(API 호출 함수는 대상 아님 — --dry-run 으로 실물 검증).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, pruneState, filterRepliesToProcess, hasOwnReply, enforceLength, buildUserPrompt,
} from '../reply-comments.mjs';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`✅ ${name}`); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const tmpDir = mkdtempSync(join(tmpdir(), 'reply-comments-test-'));
const statePath = join(tmpDir, 'state', 'threads-replies.json');

// --- loadState / saveState --------------------------------------------------
await t('loadState: 파일이 없으면 빈 processed 를 돌려준다', () => {
  const s = loadState(join(tmpDir, 'nope.json'));
  assert.deepEqual(s, { processed: {} });
});

await t('saveState → loadState 왕복', () => {
  const s = { processed: { abc: { action: 'replied', at: '2026-08-01T00:00:00.000Z' } } };
  saveState(s, statePath);
  assert.deepEqual(loadState(statePath), s);
});

await t('loadState: 손상된 JSON 이면 빈 processed 로 안전하게 복구', () => {
  const badPath = join(tmpDir, 'bad', 'bad.json');
  mkdirSync(join(tmpDir, 'bad'), { recursive: true });
  writeFileSync(badPath, '{not json');
  assert.deepEqual(loadState(badPath), { processed: {} });
});

// --- pruneState --------------------------------------------------------------
await t('pruneState: 기준일보다 오래된 기록은 제거한다', () => {
  const now = Date.parse('2026-08-22T00:00:00Z');
  const s = {
    processed: {
      old: { action: 'skip', at: '2026-06-01T00:00:00Z' },      // 82일 전 → 제거
      recent: { action: 'replied', at: '2026-08-01T00:00:00Z' }, // 21일 전 → 유지
    },
  };
  const pruned = pruneState(s, 60, now);
  assert.deepEqual(Object.keys(pruned.processed), ['recent']);
});

await t('pruneState: at 이 없거나 파싱 불가면 보수적으로 유지한다', () => {
  const now = Date.parse('2026-08-22T00:00:00Z');
  const s = { processed: { weird: { action: 'skip', at: 'not-a-date' } } };
  const pruned = pruneState(s, 60, now);
  assert.deepEqual(Object.keys(pruned.processed), ['weird']);
});

// --- filterRepliesToProcess ---------------------------------------------------
await t('filterRepliesToProcess: 이미 처리한 답글은 제외', () => {
  const replies = [{ id: '1', text: '안녕', username: 'user1' }, { id: '2', text: '반가워', username: 'user2' }];
  const state = { processed: { 1: { action: 'replied', at: '2026-08-01T00:00:00Z' } } };
  const out = filterRepliesToProcess(replies, state, 'moneyfit_official');
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

await t('filterRepliesToProcess: 우리 계정 자신의 답글은 제외', () => {
  const replies = [{ id: '1', text: '고마워요', username: 'moneyfit_official' }, { id: '2', text: '오 신기하다', username: 'someone' }];
  const out = filterRepliesToProcess(replies, { processed: {} }, 'moneyfit_official');
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

await t('filterRepliesToProcess: 숨김 처리된 답글은 제외', () => {
  const replies = [
    { id: '1', text: '스팸입니다', username: 'spammer', hide_status: 'HIDDEN' },
    { id: '2', text: '정상 답글', username: 'someone', hide_status: 'NOT_HUSHED' },
  ];
  const out = filterRepliesToProcess(replies, { processed: {} }, 'moneyfit_official');
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

await t('filterRepliesToProcess: 본문 없는 답글(이미지 전용 등)은 제외', () => {
  const replies = [{ id: '1', username: 'someone' }, { id: '2', text: '텍스트 있음', username: 'someone' }];
  const out = filterRepliesToProcess(replies, { processed: {} }, 'moneyfit_official');
  assert.deepEqual(out.map((r) => r.id), ['2']);
});

// --- hasOwnReply -------------------------------------------------------------
await t('hasOwnReply: 우리 계정 답글(수기 포함)이 있으면 true', () => {
  const children = [{ id: 'c1', username: 'someone' }, { id: 'c2', username: 'moneyfit_official' }];
  assert.equal(hasOwnReply(children, 'moneyfit_official'), true);
});

await t('hasOwnReply: 우리 계정 답글이 없으면 false', () => {
  const children = [{ id: 'c1', username: 'someone' }];
  assert.equal(hasOwnReply(children, 'moneyfit_official'), false);
});

await t('hasOwnReply: children 이 비어있거나 없으면 false', () => {
  assert.equal(hasOwnReply([], 'moneyfit_official'), false);
  assert.equal(hasOwnReply(undefined, 'moneyfit_official'), false);
});

// --- enforceLength -------------------------------------------------------------
await t('enforceLength: 제한 이내면 그대로', () => {
  assert.equal(enforceLength('짧은 답글', 500), '짧은 답글');
});

await t('enforceLength: 제한 초과면 코드포인트 단위로 자르고 … 를 붙인다', () => {
  const long = '가'.repeat(600);
  const out = enforceLength(long, 500);
  assert.equal([...out].length, 500);
  assert.ok(out.endsWith('…'));
});

await t('enforceLength: 이모지(서로게이트 쌍) 중간을 끊지 않는다', () => {
  const text = '👍'.repeat(600); // 각 이모지 1 코드포인트로 카운트
  const out = enforceLength(text, 500);
  assert.equal([...out].length, 500);
});

// --- buildUserPrompt -------------------------------------------------------------
await t('buildUserPrompt: 원글·작성자·답글 내용을 모두 포함한다', () => {
  const p = buildUserPrompt({ postText: '연금저축 얘기', replyText: '나도 궁금해', replyUsername: 'user1' });
  assert.ok(p.includes('연금저축 얘기'));
  assert.ok(p.includes('@user1'));
  assert.ok(p.includes('나도 궁금해'));
});

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed`);
if (process.exitCode) process.exit(process.exitCode);
