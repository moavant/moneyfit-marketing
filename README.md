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
  "captionThreads": "스레드용 짧은 본문 (500자 이내)", // → output/<issue>/caption-threads.txt
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

## 디자인
브랜드 색 `#1A73E8`(머니핏 앱 primary). 규격 1080×1350(인스타 4:5 캐러셀). 폰트 Pretendard/Apple SD Gothic Neo. 색·폰트·레이아웃은 `render.mjs` 상단 `STYLE` 에서 수정.

## 머니핏 가계부
- Google Play: https://play.google.com/store/apps/details?id=com.moavant.moneyfit
