# moneyfit-marketing

머니핏 가계부 **카드뉴스 마케팅** 레포. 돈 관리·경제 상식·금융 지식 카드뉴스를 HTML/CSS로 만들고, 마지막 카드에 머니핏 가계부를 자연스럽게 노출합니다.

> **이미지는 깃에 올리지 않습니다.** 깃엔 템플릿(코드)과 글(콘텐츠)만 — 항상 가볍습니다. 완성 이미지는 자동 렌더링해 다운로드로 받습니다.

## 구조
```
content/   주차별 카드뉴스 내용 (JSON, 텍스트 — 가벼움)
render.mjs HTML/CSS → 1080×1350 PNG 카드 렌더러 (Playwright)
templates/ (선택) 별도 템플릿 파일
output/    렌더 결과 PNG (깃 제외, 자동 생성)
.github/workflows/render.yml  content 추가 시 자동 렌더 → 아티팩트 업로드
```

## 카드뉴스 만드는 법

### 방법 A — GitHub에서 자동 (코드 불필요)
1. `content/` 에 새 JSON 파일 추가(아래 형식) 후 커밋·푸시.
2. Actions 탭 → "카드뉴스 렌더" 실행 완료 대기.
3. 실행 결과 하단 **Artifacts → `cards`** 다운로드 → PNG 카드 묶음.
4. 인스타그램·스레드에 캐러셀로 업로드.

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
  "captionThreads": "스레드 전용 본문 — 반말, 후킹 질문 시작, 500자 이내 (아래 작성 규칙 참고)", // → output/<issue>/caption-threads.txt
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

## Threads 본문 작성 규칙 (`captionThreads`)

> **인스타(`caption`)와 별도 규칙.** Threads는 반말 문화이므로 전체 반말로 쓰고, 댓글을 유도하는 후킹 질문을 서두에 넣는다.

**구조 (순서 고정):**

1. **후킹 질문** (1줄, 반말) — 독자가 자신의 상황을 댓글로 공유하고 싶어지는 질문. 주제와 직결되어야 한다.
   - 예시: "이번 달 고정지출 얼마야?", "연금저축 지금 넣고 있어?", "카드값 나올 때 얼마인지 알고 있어?"
2. **핵심 내용** (2~4줄, 반말) — 카드 내용에서 가장 임팩트 있는 수치나 팁을 압축. 존댓말·나열형 금지.
3. **머니핏 연결** (1줄, 반말) — 앱의 와우모먼트(자동기록·구독감지)와 주제를 자연스럽게 연결.
4. **CTA** — 반드시 `Google Play에서 '머니핏 가계부' 검색` 줄을 포함 (post-threads.mjs가 자동으로 다운로드 링크로 치환).
5. **해시태그** (3개 이내) — post-threads.mjs가 자동 제거하므로 작성은 하되 링크·주제 태그만.

**작성 규칙:**
- 전체 반말. "습니다/이에요/해요" 금지. "야/이야/해/됨/있어/해봐" 등 구어체 사용.
- 500자 이내 (해시태그 포함).
- 후킹 질문은 Yes/No 형이 아닌 **수치·상황 공유형**으로 ("~하고 있어?", "~얼마야?", "~알고 있었어?").
- 인스타 caption과 내용은 같되 문체와 구조는 완전히 다르게 작성.

**예시:**
```
연금저축 지금 넣고 있어?

연금저축 + IRP 합산 연 900만 원까지 세액공제 되고, 총급여 5,500만 원 이하면 최대 약 148만 원 돌려받을 수 있어.
월 5만 원 소액으로 시작해도 혜택 생겨. 꼭 한도 다 안 채워도 돼.

카드 결제 오면 머니핏이 자동으로 기록해줌. 지출 파악하고 연금 여력 찾아봐.
Google Play에서 '머니핏 가계부' 검색

#연금저축 #IRP #머니핏
```

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
| 스레드 | `moavant.com/mfAd/th` (`utm_source=threads`) | **자동** — `post-threads.mjs` 가 `captionThreads` 의 'Google Play' 줄을 이 링크로 치환(줄이 없으면 끝에 추가) |
| 인스타 프로필 | `moavant.com/mfAd/bio` (`utm_source=linkinbio`) | **자동** — `post-instagram.mjs` 가 해시태그 앞에 "프로필 링크를 누르면…" 한 줄 보강. 프로필 링크 자체는 인스타 앱에서 이 주소로 설정돼 있음 |
| 인스타 스토리·광고 | `moavant.com/mfAd/ig` (`utm_source=instagram`) | 예약 — 자동 게시 경로에서는 쓰지 않음 |
| 기타·레거시 | `moavant.com/mfAd` (`utm_source=direct`) | 과거 게시물이 쓰던 주소. 계속 동작하나 채널 구분은 안 됨 |

- 🔴 **`caption` 의 "Google Play에서 '머니핏 가계부' 검색" CTA 는 지우지 말 것.** Play 검색 유입이
  2026-08-30 스토어 문안 효과 측정의 판정 지표라, 없애면 측정이 무너진다. 프로필 링크 안내는 이와 **병행**한다.
- 인스타 캡션은 URL 이 클릭되지 않으므로 본문에 주소를 적지 않는다(프로필 링크로 유도).
- 이미 게시된 콘텐츠 JSON 을 수정해도 **재게시되지 않는다**(워크플로가 `--diff-filter=A` = 신규 추가분만 게시).

## 머니핏 가계부
- Google Play: https://play.google.com/store/apps/details?id=com.moavant.moneyfit *(참조용 — 캡션에는 위 규칙대로 `mfAd/*` 를 쓴다)*
