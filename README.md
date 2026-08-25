# moneyfit-marketing

머니핏 가계부 **SNS 마케팅** 레포. 채널은 둘로 완전히 분리되어 있습니다(2026-08-24):

- **인스타그램** = 카드뉴스(이미지 캐러셀). 돈 관리·경제 상식 카드뉴스를 HTML/CSS로 만들어 자동 게시.
- **스레드** = 참여형 텍스트 전용(이미지 없음). 별도 클라우드 루틴이 글을 쓰고, 이 레포의 워크플로가 게시·지표수집·답글응답을 담당.

> **이미지는 깃에 올리지 않습니다.** 깃엔 템플릿(코드)과 글(콘텐츠)만 — 항상 가볍습니다. 완성 이미지는 자동 렌더링해 다운로드로 받습니다.

## 구조
```
content/        주차별 카드뉴스 내용 (JSON — 인스타 전용)
threads/posts/  스레드 게시물 (JSON — 텍스트 전용, 클라우드 루틴이 생성)
threads/metrics/ 스레드 일간 지표 스냅샷 (자동 생성 — 발행 루틴의 학습 데이터)
render.mjs HTML/CSS → 1080×1350 PNG 카드 렌더러 (Playwright)
templates/ (선택) 별도 템플릿 파일
output/    렌더 결과 PNG (깃 제외, 자동 생성)
state/     스레드 자동화 상태 기록 — 댓글 자동응답 처리분 + 게시 멱등성(threads-posted.json) (자동 생성)
.github/workflows/render.yml                content 추가 시 자동 렌더 → 아티팩트 업로드
.github/workflows/publish-instagram.yml     인스타 카드뉴스 자동 게시 (스레드 게시 없음)
.github/workflows/publish-threads.yml       스레드 참여형 텍스트 게시 (threads/posts/ 추가 시)
.github/workflows/threads-metrics.yml       스레드 일간 지표 수집 (매일 10:30 KST)
.github/workflows/reply-threads-comments.yml 스레드 댓글 자동응답(15분마다)
```

## 카드뉴스 만드는 법

### 방법 A — GitHub에서 자동 (코드 불필요)
1. `content/` 에 새 JSON 파일 추가(아래 형식) 후 커밋·푸시.
2. Actions 탭 → "카드뉴스 렌더" 실행 완료 대기.
3. 실행 결과 하단 **Artifacts → `cards`** 다운로드 → PNG 카드 묶음.
4. 인스타그램엔 PNG 카드를 캐러셀로 업로드. (스레드는 카드뉴스와 무관 — 아래 "스레드 파이프라인" 참고.)

### 방법 B — 로컬에서
```bash
npm install            # 최초 1회 (Playwright + Chromium)
node render.mjs content/2026-W26-구독다이어트.json
# → output/2026-W26-구독다이어트/card-01.png ...
```

## 콘텐츠 JSON 형식
```jsonc
{
  "issue": "2026-W26-구독다이어트",     // 파일/폴더 이름
  "label": "머니핏 머니 클래스",          // 하단 브랜드 라벨
  "caption": "인스타 본문 + 해시태그 (붙여넣기용)",   // → output/<issue>/caption.txt
  // captionThreads 는 폐지됨(2026-08-24 채널 분리) — 스레드 글은 threads/posts/ 에서 별도 운영. 있어도 무시된다.
  "cards": [
    { "type": "cover", "title": "줄바꿈은 |, 강조는 {텅}", "sub": "...", "footL": "...", "badge": "밀어서 보기 →" },
    { "type": "stat",  "num": "01", "title": "...", "rows": [["항목","값"],["합계","값","total"]], "note": "..." },
    { "type": "list",  "num": "02", "title": "...", "items": ["...","..."], "tip": "💡 ..." },
    { "type": "cta",   "title": "...", "sub": "...", "features": ["...","..."], "cta": "지금 무료로 시작하기", "store": "Google Play에서 ‘머니핏 가계부’ 검색" }
  ]
}
```
- 텍스트 안에서 `|` = 줄바꿈, `{...}` = 강조(밝은 파랑).
- 카드 타입: `cover`(표지) / `stat`(숫자·표) / `list`(체크리스트+팁) / `cta`(머니핏 홍보). 순서·개수 자유.
- **마지막은 `cta` 카드**로 머니핏 노출 권장.

## 스레드 파이프라인 (참여형 텍스트 — 카드뉴스와 완전 분리)

> 2026-08-24 채널 분리. 스레드는 이미지·카드뉴스 없이 **텍스트 게시물**만 올린다.
> 글 작성·소재 선정은 별도 클라우드 루틴(매일 12:00·21:00 KST)이 담당하고, 운영 원칙·콘텐츠 가이드는 **내부(비공개) 문서**가 정본이다 — 공개 레포인 여기엔 게시 파이프라인(코드)만 둔다.

**게시 흐름:**

1. 클라우드 루틴이 `threads/posts/YYYY-MM-DD-{slug}.json` 을 main 에 push.
2. `publish-threads.yml` 이 신규 추가분만 감지해 `scripts/post-thread-text.mjs` 로 텍스트 전용 게시.
3. JSON 에 `followUp` 필드가 있으면 본글 게시 직후 자기 댓글 1개를 이어서 단다(선택).
4. `threads-metrics.yml` 이 매일 10:30 KST 에 최근 게시물 지표를 `threads/metrics/` 에 커밋 → 다음 회차 루틴이 읽고 학습.

**게시물 JSON 형식** (`threads/posts/*.json`):
```jsonc
{
  "text": "본문 — 반말, 500자 이내. 링크·해시태그·스토어 CTA 금지",
  "followUp": "(선택) 본글 게시 직후 이어서 달 자기 댓글"
}
// 이 두 필드 외의 다른 키는 두지 않는다(운영 기록은 내부 문서에서 관리).
```

**기계적 안전장치** — `post-thread-text.mjs` 가 게시 전 강제 제거: 해시태그 줄, `Google Play`/`무료로 시작` CTA 줄, URL(앱 다운로드 유도는 프로필 링크 `moavant.com/mfAd/th` 가 담당 — 아래 "다운로드 링크 규칙" 참고). 정화 후 본문이 비면 게시 자체를 거부한다. 수정된 파일은 재게시되지 않는다(`--diff-filter=A`).

**수동 테스트**: Actions → "스레드 참여형 텍스트 게시" → Run workflow → `file` 지정 + `dry_run: true`.

## 스레드 댓글 자동응답

`.github/workflows/reply-threads-comments.yml` 이 **15분마다** 우리 스레드 게시물에 달린 새 답글을
확인해, Claude로 위 브랜드 보이스(반말)에 맞는 대댓글을 만들어 **사람 승인 없이 바로 게시**한다.
실행 파일은 `scripts/reply-comments.mjs`.

- 🔴 **완전 자동 게시로 운영하기로 결정했다** — 답글 초안을 사람이 승인하는 단계는 없다. 대신
  브랜드 리스크를 아래로 최소화한다:
  - **중복 방지**: 처리한(응답했거나 스킵한) 답글 id 를 `state/threads-replies.json` 에 남겨
    같은 답글에 두 번 응답하지 않는다. 60일 지난 기록은 자동 정리.
  - **스킵 판단**: 스팸·욕설·혐오·명백한 광고·게시물과 무관한 내용은 Claude가 판단해 응답하지
    않는다(브랜드 보이스 프롬프트는 `scripts/reply-comments.mjs`의 `SYSTEM_PROMPT` 참고).
  - **답글에는 CTA·링크를 넣지 않는다** — 매 답글마다 다운로드 유도를 넣으면 봇처럼 보이고
    광고 남발이 된다. 머니핏 언급은 자연스러운 맥락일 때만 아주 짧게, 선택적으로.
  - **1회 실행 게시 상한**(`REPLY_MAX_PER_RUN`, 기본 20건) — 버그로 인한 폭주를 막는 안전장치.
  - **응답 대상은 우리 게시물의 1단계(직접) 답글까지만.** 답글에 달린 답글(2단계 이상)은
    이번 버전 범위 밖 — 필요해지면 별도로 확장한다.
  - **수기로 먼저 답변한 답글은 건너뛴다.** 사장님이 앱에서 직접 답글을 달아둔 게 있으면
    자동응답이 또 답글을 달지 않는다(`hasOwnReply` — 대상 답글 밑에 우리 계정 답글이 이미
    있는지 확인 후 스킵).

**필요한 설정(직접 해야 함 — 자동화 불가):**

### 1. `ANTHROPIC_API_KEY` 시크릿 등록
1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**로 키 발급.
2. 이 저장소 **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `ANTHROPIC_API_KEY`, Value: 방금 발급한 키.

### 2. `THREADS_ACCESS_TOKEN` 재발급 (스코프 추가)
기존 토큰(자동 게시용)은 `threads_basic`·`threads_content_publish` 스코프로만 발급됐을 가능성이
높다. 답글을 **읽으려면 `threads_read_replies`**, **답글을 달려면 `threads_manage_replies`** 가
추가로 필요하다 — 둘 다 없으면 403 으로 막힌다. `refresh-ig-token.yml` 은 만료만 늦출 뿐 스코프를
추가해주지 않으므로, 아래 재인가를 **한 번만** 수동으로 해줘야 한다.

1. **인가 URL을 브라우저로 연다** (기존 Meta 앱의 `CLIENT_ID`·`REDIRECT_URI`를 그대로 쓰되, `scope`에
   기존 스코프 + 새 스코프를 모두 콤마로 나열):
   ```
   https://threads.net/oauth/authorize?client_id=<CLIENT_ID>&redirect_uri=<REDIRECT_URI>&scope=threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies&response_type=code
   ```
   로그인·권한 승인 후 `REDIRECT_URI?code=...` 로 리다이렉트된다 — 이 `code` 값을 복사.
2. **`code` → 단기 토큰 교환** (1시간 유효):
   ```bash
   curl -X POST https://graph.threads.net/oauth/access_token \
     -F client_id=<CLIENT_ID> \
     -F client_secret=<CLIENT_SECRET> \
     -F grant_type=authorization_code \
     -F redirect_uri=<REDIRECT_URI> \
     -F code=<위에서 받은 code>
   ```
3. **단기 토큰 → 장기 토큰 교환** (60일 유효 — 이게 실제로 쓸 값):
   ```bash
   curl -i -X GET "https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=<CLIENT_SECRET>&access_token=<단기 토큰>"
   ```
4. 응답의 `access_token` 값을 저장소 **Settings → Secrets and variables → Actions**에서
   기존 `THREADS_ACCESS_TOKEN` 시크릿의 **Update**로 교체. 이후엔 `refresh-ig-token.yml`이 매월
   자동으로 만료 전 갱신해준다(스코프는 그대로 유지됨).

> `CLIENT_ID`·`CLIENT_SECRET`·`REDIRECT_URI`는 [developers.facebook.com/apps](https://developers.facebook.com/apps) 의
> 기존 앱 → Threads 제품 설정에서 확인 가능(원래 토큰 발급 때 썼던 값 그대로 재사용).

**동작 방식**: `GET me/threads`(최근 `REPLY_LOOKBACK_DAYS`일, 기본 30일) 로 답글 달린 우리 게시물을
찾고 → 게시물별 `GET {id}/replies` 로 답글 목록을 가져와 → 상태 파일에 없고 우리 계정 자신이 아니며
숨김 처리되지 않은 답글만 → Claude(`claude-opus-5`, structured output)에 판단을 맡겨 → `reply`면
`reply_to_id` 로 답글 컨테이너를 만들어 게시하고, `skip`이면 사유와 함께 상태 파일에만 기록한다.

**수동 확인**: Actions 탭 → "스레드 댓글 자동응답" → Run workflow → `dry_run: true` 로 실행하면
실제 게시·상태 저장 없이 판단 로그만 볼 수 있다.

## 디자인
브랜드 색 `#1A73E8`(머니핏 앱 primary). 규격 1080×1350(인스타 4:5 캐러셀). 폰트 Pretendard/Apple SD Gothic Neo. 색·폰트·레이아웃은 `render.mjs` 상단 `STYLE` 에서 수정.

## SNS 주간 지표 자동 수집 (SUS-230 / P-20)

`.github/workflows/social-insights.yml` 이 **매주 월 09:00 KST** 에 직전 주(월~일) 인스타·스레드 지표를
모아 `insights/YYYY-Www.json` 으로 커밋하고, 요약을 Actions 요약 패널(+Slack, 선택)에 남긴다.

- 실행: `node scripts/collect-insights.mjs [--dry-run]` · 테스트: `node scripts/__tests__/collect-insights.test.mjs`
- 접속키는 자동 게시용 `IG_ACCESS_TOKEN`·`THREADS_ACCESS_TOKEN` **재사용**(신규 권한 없음).
  **Slack 은 선택** — `SLACK_WEBHOOK_MARKETING` 시크릿을 등록하면 요약이 Slack 으로도 간다(없으면 건너뜀).
- 🔴 **수집 실패를 절대 0 으로 보고하지 않는다.** 실패한 채널은 `posts: null` + "⚠️ 수집 실패" 로 표시되고
  잡이 빨간불로 끝난다. 접속키 만료를 조용히 지나치지 않기 위한 설계다(실패해도 그 주 파일은 보존).
- ⚠️ **이 레포는 공개다.** `insights/*.json` · Actions 로그 · 요약 패널 모두 누구나 볼 수 있다.
  개인정보는 담지 않지만(우리 계정 집계 수치 + 우리가 공개 게시한 문구 첫 줄만) **성과 수치는 공개된다.**
- ⚠️ 공개 레포의 예약 워크플로는 레포에 60일간 활동이 없으면 GitHub 이 자동으로 끈다. 카드뉴스 발행이
  멈추면 지표 수집도 조용히 멈추므로, 장기 미발행 시 Actions 탭에서 활성 상태를 확인할 것.

## 다운로드 링크 규칙 (SUS-230 / P-19 — 채널별 유입 계측)

**캡션에 Play 스토어 URL 을 직접 쓰지 않는다.** 반드시 `moavant.com/mfAd/*` 리다이렉트를 거쳐야
Play 설치 referrer 에 채널 꼬리표(utm_source)가 실린다. 직접 URL 을 쓰면 그 유입은 집계에서 사라진다.

| 채널 | 링크 | 누가 넣나 |
|---|---|---|
| 스레드 | `moavant.com/mfAd/th` (`utm_source=threads`) | **수동** — 2026-08-19 사장님 지시로 캡션 본문에는 더 이상 넣지 않는다(과도한 홍보 지양). 대신 인스타 프로필과 똑같은 방식으로, **스레드 앱 프로필의 링크 항목**에 이 주소를 걸어 채널을 구분한다(사장님이 스레드 앱에서 직접 설정 — 코드가 건드릴 수 없는 영역). |
| 인스타 프로필 | `moavant.com/mfAd/bio` (`utm_source=linkinbio`) | **자동** — `post-instagram.mjs` 가 해시태그 앞에 "프로필 링크를 누르면…" 한 줄 보강. 프로필 링크 자체는 인스타 앱에서 이 주소로 설정돼 있음 |
| 인스타 스토리·광고 | `moavant.com/mfAd/ig` (`utm_source=instagram`) | 예약 — 자동 게시 경로에서는 쓰지 않음 |
| 기타·레거시 | `moavant.com/mfAd` (`utm_source=direct`) | 과거 게시물이 쓰던 주소. 계속 동작하나 채널 구분은 안 됨 |

- 🔴 **`caption`(인스타그램 본문)의 "Google Play에서 '머니핏 가계부' 검색" CTA 는 계속 유지한다.** Play 검색 유입이
  2026-08-30 스토어 문안 효과 측정의 판정 지표라, 없애면 측정이 무너진다. 이번에 뺀 건 **스레드 캡션**뿐이다.
- 인스타·스레드 모두 캡션 본문에는 주소를 적지 않는다(둘 다 프로필 링크로 유도 — 스레드는 `mfAd/th`, 인스타는 `mfAd/bio`로 프로필에서부터 채널이 갈린다).
- 이미 게시된 콘텐츠 JSON 을 수정해도 **재게시되지 않는다**(워크플로가 `--diff-filter=A` = 신규 추가분만 게시).

## 머니핏 가계부
- Google Play: https://play.google.com/store/apps/details?id=com.moavant.moneyfit *(참조용 — 캡션에는 위 규칙대로 `mfAd/*` 를 쓴다)*
