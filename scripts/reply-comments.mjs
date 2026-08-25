#!/usr/bin/env node
// 스레드 댓글(답글) 자동 응답 — 우리 게시물에 달린 새 답글을 찾아 Claude로 반말 답글을 만들어 게시한다.
//
// 실행: node scripts/reply-comments.mjs [--dry-run]
// 환경변수:
//   THREADS_ACCESS_TOKEN   스레드 Graph 토큰 — 기존 자동 게시용 토큰 재사용.
//                          🔴 threads_read_replies(조회) + threads_manage_replies(게시) 스코프가
//                          둘 다 없으면 403 으로 막힌다. 기존 토큰에 없다면 Meta 앱에서 두 스코프를
//                          포함해 재인가해서 다시 발급받아야 한다(README "스레드 댓글 자동응답" 참고)
//                          — refresh-ig-token.yml 은 만료만 늦출 뿐 스코프를 추가하지 않는다.
//   ANTHROPIC_API_KEY      Claude API 키 — 답글 생성/스킵 판단에 사용.
//   ANTHROPIC_MODEL        (선택) 기본 claude-opus-5.
//   REPLY_LOOKBACK_DAYS    (선택) 답글을 확인할 우리 게시물 범위(기본 30일).
//   REPLY_MAX_PER_RUN      (선택) 1회 실행당 최대 게시 답글 수 안전장치(기본 20).
//
// 🔴 완전 자동 게시(사람 승인 없음) — 브랜드 리스크를 아래로 최소화한다:
//   - state/threads-replies.json 에 처리한 답글 id 를 남겨 절대 같은 답글에 두 번 응답하지 않는다.
//   - 스팸·욕설·무관한 내용·이미 답변된 것으로 보이는 답글은 Claude 판단으로 건너뛴다(광고성 남발 금지).
//   - 1회 실행당 게시 개수 상한(REPLY_MAX_PER_RUN)으로 버그로 인한 폭주를 막는다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'state', 'threads-replies.json');

const TH_GRAPH = 'https://graph.threads.net';
const TH_VER = 'v1.0';
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const LOOKBACK_DAYS = Number(process.env.REPLY_LOOKBACK_DAYS || 30);
const MAX_PER_RUN = Number(process.env.REPLY_MAX_PER_RUN || 20);
const STATE_MAX_AGE_DAYS = 60; // 이보다 오래된 처리 기록은 정리한다(파일이 무한히 안 커지게).
const REPLY_LIMIT = 500; // 스레드 답글 글자 제한(게시글과 동일)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Threads Graph API — collect-insights.mjs 와 동일한 관례(Authorization 헤더,
// 레이트리밋 코드는 즉시 포기, 5xx/네트워크만 재시도, URL·에러에 토큰 미노출).
// ---------------------------------------------------------------------------
const RATE_LIMIT_CODES = [4, 17, 32, 613];

export function makeApi(token) {
  const clean = String(token ?? '').trim();
  if (!clean || !/^[\w.\-~+/=]+$/.test(clean)) {
    throw new Error('THREADS_ACCESS_TOKEN 형식 오류(공백·개행 포함 여부 확인). 값은 로그에 남기지 않습니다.');
  }
  async function call(method, path, params = {}) {
    // 🔴 next 페이지네이션 URL 은 Meta 가 access_token 을 실어 돌려줄 수 있다 —
    //    에러 메시지엔 절대 원본 path 를 그대로 쓰지 않고 pathname 만 남긴 안전한 라벨을 쓴다.
    const safePath = path.startsWith('http') ? new URL(path).pathname : path;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const url = new URL(path.startsWith('http') ? path : `${TH_GRAPH}/${TH_VER}/${path}`);
      const form = new URLSearchParams(params);
      let res, json;
      try {
        if (method === 'GET') {
          for (const [k, v] of form) url.searchParams.set(k, v);
          res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${clean}` } });
        } else {
          res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${clean}` }, body: form });
        }
        json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const code = json?.error?.code;
        if (RATE_LIMIT_CODES.includes(code)) {
          throw new Error(`레이트리밋(code ${code}) [${method} ${safePath}] — 이번 회차 생략`);
        }
        const transient = res.status >= 500 || [1, 2].includes(code);
        if (attempt < 4 && transient) { await sleep(3000 * attempt); continue; }
        throw new Error(`API 실패 [${method} ${safePath}]: ${json?.error?.message || 'HTTP ' + res.status}`);
      } catch (e) {
        const isNetwork = e instanceof TypeError
          && /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(`${e.message} ${e.cause?.code ?? ''}`);
        if (attempt < 4 && isNetwork) { await sleep(3000 * attempt); continue; }
        throw e;
      }
    }
  }
  return { get: (path, params) => call('GET', path, params), post: (path, params) => call('POST', path, params) };
}

// 목록 endpoint 를 최대 maxPages 까지 따라가며 모은다(과금·레이트리밋 방어를 위한 상한).
async function paginate(api, path, params, maxPages) {
  const rows = [];
  let next = null;
  for (let page = 1; page <= maxPages; page++) {
    const json = next ? await api.get(next) : await api.get(path, params);
    rows.push(...(json?.data || []));
    next = json?.paging?.next || null;
    if (!next) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// ---------------------------------------------------------------------------
// 상태 파일 — 이미 처리한(응답했거나 스킵한) 답글 id 를 기록해 중복 응답을 막는다.
// ---------------------------------------------------------------------------
export function loadState(path = STATE_FILE) {
  if (!existsSync(path)) return { processed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed.processed === 'object' ? parsed : { processed: {} };
  } catch {
    return { processed: {} };
  }
}

export function saveState(state, path = STATE_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

// 오래된 처리 기록은 정리한다 — 파일이 무한히 안 커지고 git diff 도 가볍게 유지된다.
export function pruneState(state, maxAgeDays = STATE_MAX_AGE_DAYS, now = Date.now()) {
  const cutoff = now - maxAgeDays * 86400000;
  const processed = {};
  for (const [id, entry] of Object.entries(state.processed || {})) {
    const at = Date.parse(entry?.at);
    if (Number.isFinite(at) && at < cutoff) continue;
    processed[id] = entry;
  }
  return { ...state, processed };
}

// ---------------------------------------------------------------------------
// 응답 대상 필터 — 우리 자신의 답글, 이미 처리한 답글, 숨김 처리된 답글은 제외.
// ---------------------------------------------------------------------------
export function filterRepliesToProcess(replies, state, myUsername) {
  const processed = state.processed || {};
  return (replies || []).filter((r) => {
    if (!r?.id || !r?.text) return false;
    if (processed[r.id]) return false;
    if (myUsername && r.username === myUsername) return false;
    // 🔴 스레드 API 의 "숨김 아님" 값은 NOT_HIDDEN 이 아니라 NOT_HUSHED 다(실 응답으로 확인,
    //    2026-08-25). 예전엔 NOT_HIDDEN 과 비교해서 정상 답글까지 전부 걸러졌었다.
    if (r.hide_status && r.hide_status !== 'NOT_HUSHED') return false;
    return true;
  });
}

// 이 답글 밑에 이미 우리 계정(수기 포함) 답글이 달려있는지 확인한다 — 사장님이 앱에서
// 직접 먼저 답글을 단 경우, 자동응답이 또 답글을 달아 중복되는 걸 막기 위함.
export function hasOwnReply(children, myUsername) {
  return (children || []).some((c) => c?.username === myUsername);
}

// 코드포인트 단위로 안전하게 자른다(모델 출력 길이를 절대 그대로 믿지 않는다).
export function enforceLength(text, limit = REPLY_LIMIT) {
  const s = String(text ?? '').trim();
  const chars = [...s];
  if (chars.length <= limit) return s;
  return chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Claude — 답글을 달지 스킵할지 판단하고, 달 경우 머니핏 스레드 브랜드 보이스로 문안을 만든다.
// ---------------------------------------------------------------------------
const DecisionSchema = z.object({
  action: z.enum(['reply', 'skip']),
  reply_text: z.string().max(480).nullable(),
  skip_reason: z.string().nullable(),
});

const SYSTEM_PROMPT = `너는 머니핏 가계부(금융 관리 앱) 스레드(Threads) 계정의 댓글 담당자야.
우리 게시물에 달린 답글 하나를 보고, 우리 계정이 그 답글에 대댓글을 달지 말지 판단하고, 달기로 했으면 문안을 써.

브랜드 보이스(스레드 전용 — 인스타 캡션과 다름):
- 전체 반말. "습니다/이에요/해요" 절대 금지. "야/이야/해/됨/있어/해봐" 같은 구어체.
- 실제 사람이 댓글 다는 것처럼 짧고 자연스럽게(1~3문장). 광고 문구·홍보 티 나는 말투 금지.
- 상대 답글 내용에 구체적으로 반응해라(복붙한 것 같은 뻔한 말 금지). 공감하거나, 짧게 되묻거나,
  숫자·팁을 하나 보태서 대화가 이어지게 해라.
- 머니핏 앱 이야기는 자연스러운 맥락일 때만 아주 짧게 언급 가능(선택) — 매 답글마다 넣지 마라.
  링크나 "다운로드", "검색" 같은 CTA 문구는 절대 넣지 마라(답글에서는 광고처럼 보인다).
- 500자 이내. 보통은 훨씬 짧게(50~150자 정도).

스킵(action: "skip") 조건 — 아래 중 하나라도 해당하면 답글을 달지 마라:
- 스팸, 도배, 욕설·혐오·비하, 명백한 광고/홍보 답글
- 게시물과 전혀 무관한 내용
- 단순 이모지·감탄사뿐이라 딱히 반응할 내용이 없는 경우
- 이미 답변이 필요 없어 보이는 경우(예: 단순 동의 표시)

애매하면 skip 보다는 짧게라도 반응하는 쪽을 택해라(참여 유도가 목표) — 다만 위 스킵 조건에
명백히 해당하면 반드시 skip 해라.`;

export function buildUserPrompt({ postText, replyText, replyUsername }) {
  return [
    `[우리 원글]\n${postText || '(본문 없음)'}`,
    `[답글 작성자] @${replyUsername || '알수없음'}`,
    `[답글 내용]\n${replyText}`,
    '위 답글에 대응할지 판단하고, action/reply_text/skip_reason 을 채워라.',
  ].join('\n\n');
}

export async function decideReply(client, { postText, replyText, replyUsername }) {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: { format: zodOutputFormat(DecisionSchema), effort: 'low' },
    messages: [{ role: 'user', content: buildUserPrompt({ postText, replyText, replyUsername }) }],
  });
  const out = response.parsed_output;
  if (!out) throw new Error('Claude 응답 파싱 실패(parsed_output 없음)');
  if (out.action === 'reply' && !out.reply_text) throw new Error('action=reply 인데 reply_text 가 비어있음');
  return out.action === 'reply'
    ? { action: 'reply', text: enforceLength(out.reply_text) }
    : { action: 'skip', reason: out.skip_reason || '(사유 없음)' };
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------
async function postThreadsReply(api, uid, text, replyToId) {
  const container = await api.post(`${uid}/threads`, { media_type: 'TEXT', text, reply_to_id: replyToId });
  const start = Date.now();
  await sleep(5000);
  let status = null;
  while (Date.now() - start < 120000) {
    const s = await api.get(container.id, { fields: 'status' });
    status = s.status;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`답글 미디어 처리 실패(${status})`);
    await sleep(4000);
  }
  if (status !== 'FINISHED') throw new Error('답글 처리 시간 초과');
  return api.post(`${uid}/threads_publish`, { creation_id: container.id });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!TOKEN) { console.error('✗ THREADS_ACCESS_TOKEN 환경변수가 없습니다.'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('✗ ANTHROPIC_API_KEY 환경변수가 없습니다.'); process.exit(1); }

  const api = makeApi(TOKEN);
  const client = new Anthropic();

  const me = await api.get('me', { fields: 'id,username' });
  if (!me?.id) throw new Error('스레드 사용자 ID를 가져오지 못했습니다(토큰 권한 확인 — threads_read_replies·threads_manage_replies 스코프 필요).');
  console.log(`스레드 계정: @${me.username || '?'} (id ${me.id})`);

  const since = Date.now() - LOOKBACK_DAYS * 86400000;
  const { rows: posts, truncated: postsTruncated } = await paginate(
    api, 'me/threads', { fields: 'id,text,timestamp,has_replies', limit: 50 }, 3,
  );
  if (postsTruncated) console.error(`  · (경고) 게시물 목록이 페이지 상한에서 잘림 — 오래된 게시물 답글은 이번 회차에서 누락될 수 있음`);
  const targets = posts.filter((p) => p.has_replies && Date.parse(p.timestamp) >= since);
  console.log(`최근 ${LOOKBACK_DAYS}일 내 답글 있는 게시물 ${targets.length}건`);

  let state = pruneState(loadState());
  let repliedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  outer:
  for (const post of targets) {
    const { rows: replies, truncated: repliesTruncated } = await paginate(
      api, `${post.id}/replies`, { fields: 'id,text,username,timestamp,hide_status,has_replies' }, 2,
    );
    if (repliesTruncated) console.error(`  · (경고) 게시물 ${post.id} 답글이 페이지 상한에서 잘림`);

    const candidates = filterRepliesToProcess(replies, state, me.username);
    // 🔴 진단용 — 왜 후보가 0건인지 원인(API가 애초에 안 돌려줬는지 vs 필터가 걸렀는지)을
    //    로그 없이는 알 수 없어서 추가. 답글이 하나라도 있는데 후보가 0건이면 답글별 제외 사유를 남긴다.
    console.log(`  · 게시물 ${post.id}: 원본 답글 ${replies.length}건 조회 · 신규 후보 ${candidates.length}건`);
    if (replies.length > 0 && candidates.length === 0) {
      for (const r of replies) {
        const reasons = [];
        if (!r?.id || !r?.text) reasons.push('본문없음');
        if (r?.id && state.processed?.[r.id]) reasons.push('이미처리');
        if (me.username && r?.username === me.username) reasons.push('자기답글');
        if (r?.hide_status && r.hide_status !== 'NOT_HUSHED') reasons.push(`숨김(${r.hide_status})`);
        console.log(`    - @${r?.username || '?'} (id ${r?.id || '?'}) 제외 사유: ${reasons.join(', ') || '(불명 — 필터 로직 확인 필요)'}`);
      }
    }
    for (const reply of candidates) {
      if (repliedCount >= MAX_PER_RUN) {
        console.error(`  · (경고) 1회 실행 게시 상한(${MAX_PER_RUN}건) 도달 — 나머지는 다음 회차로 미룸`);
        break outer;
      }
      if (reply.has_replies) {
        const { rows: children } = await paginate(api, `${reply.id}/replies`, { fields: 'id,username' }, 1);
        if (hasOwnReply(children, me.username)) {
          console.log(`  · 스킵(수기 답변 있음) @${reply.username}`);
          skippedCount++;
          if (!dryRun) { state.processed[reply.id] = { action: 'skip', at: new Date().toISOString(), reason: '수기 답변 있음' }; saveState(state); }
          continue;
        }
      }

      let decision;
      try {
        decision = await decideReply(client, { postText: post.text, replyText: reply.text, replyUsername: reply.username });
      } catch (e) {
        console.error(`  · (건너뜀·오류) 답글 ${reply.id} 판단 실패: ${String(e?.message || e).slice(0, 200)}`);
        errorCount++;
        continue; // 상태 미기록 — 다음 회차에 재시도
      }

      if (decision.action === 'skip') {
        console.log(`  · 스킵 @${reply.username}: ${decision.reason}`);
        skippedCount++;
        if (!dryRun) { state.processed[reply.id] = { action: 'skip', at: new Date().toISOString(), reason: decision.reason }; saveState(state); }
        continue;
      }

      console.log(`  · 답글 예정 @${reply.username} → "${decision.text.slice(0, 60)}${decision.text.length > 60 ? '…' : ''}"`);
      if (dryRun) { console.log('    (dry-run — 실제 게시 생략)'); repliedCount++; continue; }
      try {
        const pub = await postThreadsReply(api, me.id, decision.text, reply.id);
        state.processed[reply.id] = { action: 'replied', at: new Date().toISOString(), ourReplyId: pub.id };
        saveState(state);
        repliedCount++;
        await sleep(2000); // 연속 게시 사이 여유
      } catch (e) {
        console.error(`  · (오류) 답글 ${reply.id} 게시 실패: ${String(e?.message || e).slice(0, 200)}`);
        errorCount++;
        // 상태 미기록 — 게시 실패는 다음 회차에 재시도(중복 게시보다 누락이 안전)
      }
    }
  }

  console.log('');
  console.log(`✓ 완료 — 답글 ${repliedCount}건${dryRun ? '(dry-run)' : ''} · 스킵 ${skippedCount}건 · 오류 ${errorCount}건`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY,
        `~~~~\n스레드 댓글 자동응답: 답글 ${repliedCount}건 · 스킵 ${skippedCount}건 · 오류 ${errorCount}건\n~~~~\n`,
        { flag: 'a' });
    } catch { /* 요약 실패는 실행 실패가 아니다 */ }
  }
  if (errorCount > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('reply-comments.mjs')) {
  main().catch((e) => {
    console.error(`✗ ${String(e?.message || e).slice(0, 300)}`);
    process.exit(1);
  });
}
