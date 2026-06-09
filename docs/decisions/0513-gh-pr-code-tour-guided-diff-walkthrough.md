# ADR-0513: `gh_pr_code_tour` — guided PR-diff walkthrough (Cursor code-tour / Codex review-stops 흡수)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련 ADRs**: ADR-0103(`gh_pr_blame` — review-thread blame, 같은 gh-tool slice), ADR-0104(gh PR typed tools — review-diff/auto-merge/draft), Cursor `StreamCodeTour`, Codex review-stops
- **참조**:
  - `src/tool/gh/pr-code-tour.ts` (`ghPrCodeTourTool`, `parseDiffToTour`, `TourStop`)
  - `src/tool/gh/index.ts` (`opts.codeTour` 게이트로 등록)
  - `src/tool/surface/manifest.ts:788`(BASE/GATED 매니페스트 엔트리, gate `QUANTA_GH_CODE_TOUR`)
  - `src/apps/agent/mode-presets/ci-bot.ts:216` (`buildCiBotWiring` 합성 루트)
  - `tests/unit/gh-pr-code-tour.test.ts`, `tests/integration/longtail-new-tools-e2e.test.ts`(HELLGATE §5.4)

## 맥락

`gh_pr_review_diff`(ADR-0104)는 PR의 raw unified diff를 그대로 반환한다. Cursor `StreamCodeTour` / Codex review-stops는 그 위에 한 단계 더 — diff를 그냥 쏟아내지 않고 **순서가 있는 walkthrough**("tour stops")로 제시한다: 변경된 파일마다, 그 안의 hunk마다, reviewer/agent가 점프할 수 있는 안정적인 앵커(파일 + new-side 라인 범위)와 stop별 add/del 카운트를 붙여서 "어디에 살이 붙었나"를 모델이 바로 알 수 있게 한다.

기존 우리 surface에선 agent가 `gh_pr_review_diff`의 `@@` 헤더 벽을 직접 재파싱해야 했다 — 결정적 itinerary 부재.

## 결정

`src/tool/gh/pr-code-tour.ts`에 `gh_pr_code_tour` 도구를 추가한다.

- 입력: `pr`(number 또는 URL), optional `maxStops`(default 40, hard max 200 — hunk 수백 개짜리 PR이 프롬프트 예산을 터뜨리지 않도록 bounded output).
- 호출: `gh pr diff <ref>` — 다른 모든 gh 도구와 **동일한 spawn 경계 + ref-injection 가드**(`normalizeRef`/`refRejected`, leading-`-` 거부)를 통과.
- 파싱: `parseDiffToTour`(exported pure fn)이 unified diff를 순서 있는 STOP으로 변환 — hunk당 하나. 각 stop은 파일 경로(new side, 삭제는 old side), `@@ -a,b +c,d @@`에서 읽은 new-side 라인 범위 `c..c+d-1`, 두 번째 `@@` 뒤의 enclosing-symbol context, added/removed 카운트를 담는다. 라인 범위는 `@@` 헤더에서 **verbatim**으로 읽는다 — 튜닝된 휴리스틱/임계값 없음.
- 출력: 번호 매긴 itinerary; `maxStops`로 cap, total과 표시된 수를 헤더에 명시.

**READ-ONLY** (`isReadOnly: () => true`, `isConcurrencySafe: () => true`, `hitlTier: () => "none"`). **NO-THROW**: 잘못된 ref / `gh` 실패 / 파싱 불가 diff 모두 graceful `ok:false`로 collapse — never throws. `parseDiffToTour`는 인식 못 한 라인을 스킵한다(빈 입력/노이즈 → `[]`).

**등록 posture (default-OFF)**: `ghTools(runner, opts)`는 `opts.codeTour === true`일 때만 이 도구를 append한다. 합성 루트는 `buildCiBotWiring`(`src/apps/agent/mode-presets/ci-bot.ts`)에서 `gateOn(env, "QUANTA_GH_CODE_TOUR")`로 flip한다 — 게이트 부재/false ⇒ 도구 부재, byte-identical legacy gh 도구 세트. ci-bot은 read-only gh 도구만 쓰므로 이 read-only 도구는 필터를 통과한다.

## 결과

- §5.4 long-tail Cursor/Codex PR-review parity: agent가 raw `@@` 벽 대신 결정적 itinerary를 받는다.
- 매니페스트 GATED 엔트리(`QUANTA_GH_CODE_TOUR`)로 도구-surface SSOT에 등록 — 양방향 drift 가드 충족.
- 테스트: `tests/unit/gh-pr-code-tour.test.ts`(`parseDiffToTour` 멀티-hunk/단일-라인-hunk/삭제 dev-null/빈+노이즈 입력, tool wrapper argv 정확성·maxStops cap·ref 거부·gh-failure envelope·read-only 분류, DEFAULT-OFF byte-identity 2건); `tests/integration/longtail-new-tools-e2e.test.ts`(REAL `ghTools(opts.codeTour)` 팩토리+레지스트리 dispatch, gate ON/OFF, ci-bot read-only 필터 생존).

## 한계 / 대안

- **현재 라이브 consumer는 ci-bot 모드 한정**. 인터랙티브 CLI 루프는 gh 도구를 `codeTour` 없이 빌드한다 — 도구는 ci-bot 모드(`runMode`)에서, 그것도 `QUANTA_GH_CODE_TOUR` 게이트가 켜져야만 등록된다. 인터랙티브 surface로의 승격 경로는 인터랙티브 gh-tool 빌드 사이트에 동일 게이트를 추가하는 것.
- 대안 (1) review-diff를 그냥 그대로 반환하고 agent가 파싱 — 기각: 재파싱 비결정성/토큰 낭비.
- 대안 (2) stop마다 diff body까지 인라인 — 기각: 프롬프트 예산. itinerary는 앵커만 주고 body는 `gh_pr_review_diff`로 fetch하는 분업이 cap 친화적.
- new-side가 `/dev/null`인 순수 삭제는 old-side 파일명으로 fallback; 둘 다 없으면 `(deleted)`/`(unknown)`. file-level(라인 앵커 없는) 코멘트와의 매핑은 이 도구 범위 밖(blame 도구 ADR-0103 소관).
