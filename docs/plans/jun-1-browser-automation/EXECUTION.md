# Browser Automation — Execution Plan

> Companion to [README.md](README.md). README는 **무엇·왜**(설계·강화·사양). 이 문서는 **어떻게 랜딩**하는지 — 웨이브 순서, 파일 소유권, 증명 게이트, 방법론 가드레일.
> Baseline: repo HEAD `0802ba65`. 매 웨이브 디스패치 전 HEAD 재확인 (§G1).

## Pre-flight (착수 전 1회)

- [ ] ADR 번호 채번 — 현재 max `0426`, 후보 `0427-browser-automation.md`. 병렬 co-dev로 충돌 가능 → 디스패치 직전 `ls docs/decisions/ | tail` 재확인, 충돌 시 [adr-collision-policy](user-deference renumber)대로 우리 것을 next-free로.
- [ ] `src/browser/` 신규 디렉토리 — 기존 코드 mutate 0 → conflict-free 신규 슬라이스. slice-fence 스캐너 scope에 `src/browser/` 추가 필요 여부 확인.
- [ ] 시스템 크롬 확인 — 개발 머신에 `Google Chrome`/`chromium` 존재 확인(`availability()` 실측 대상). 없으면 e2e는 headless-stub로만, cdp-adapter는 단위 레벨.

## 웨이브 순서

신규 슬라이스라 의존성 적지만, **port → adapter/stub → tool → wire** 순서는 load-bearing(하위가 main에 있어야 상위가 로컬 재구현 안 함).

### Wave 1 — port + 순수 코어 (어댑터 무관, 100% 결정적)
- `src/browser/types.ts` — BrowserError closed union, BrowserHandle, PageSnapshot, SnapshotNode
- `src/browser/port.ts` — BrowserPort 인터페이스 (no-throw Result, @/shared만 import)
- `src/browser/snapshot.ts` — `buildSnapshot(domModel) → YAML` 순수 함수 + ref 단조 발급
- `src/browser/cdp-allowlist.ts` — ★ 강화#1: 허용 메서드 closed Set + `isCdpMethodAllowed(method)`
- **proof**: `browser-snapshot-hellgate` (byte-stable + ref 단조) + `browser-cdp-allowlist-hellgate` (허용7/위험전수)
- 게이트 통과 → main cherry-pick → Wave 2 시작

### Wave 2 — 어댑터 (프로덕션 + 결정적 stub)
- `src/browser/headless-stub.ts` — `createHeadlessBrowser({pages, clock})` 결정적
- `src/browser/cdp-adapter.ts` — `createCdpBrowser(spawner)`: 크롬 spawn(`--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>`) + DevToolsActivePort 파싱 + ws CDP + `availability()` probe + `close()`(kill + 임시 프로필 rm, idempotent)
- `src/browser/index.ts` — barrel
- **proof**: headless-stub 단위(Result exhaustive) + cdp-adapter availability/spawn/close 단위(실크롬 있으면 smoke)

### Wave 3 — 도구 + wire
- `src/tool/browser/schemas.ts` + `src/tool/browser/index.ts` — `makeBrowserTool(port, fs)` MVP 6 verb
  - SSRF preflight(강화#2) + escapeReminderBoundary 출력(강화#3) + hitlTier 차등(강화#5)
- `src/agent/tier1/browser.ts` — `buildBrowserBlock(config)` (config.browser?.port 있으면 Tool[]) + env-gate `QUANTA_BROWSER_TOOL=1`
- composition root에 disposer 등록(강화#5, [search-pipeline](../../../src/runner/assemble/search-pipeline.ts) 패턴)
- `docs/decisions/0427-browser-automation.md` + 비교 카탈로그 row 갱신
- **proof**: `browser-injection-jail-hell-e2e` (navigate SSRF × 페이지 위조 × 다운로드 jail 조합)

### Wave 4 (Phase 2, 후속) — 잔여 verb + 다운로드 jail(#4) + tabs/drag/cdp/mouse_xy

## 증명 게이트 (매 웨이브 main 진입 조건)

```
bun run typecheck          # src tsc 0 errors (슬라이스 한정)
bun run lint               # biome 0 errors wrt 슬라이스
bun test tests/unit/browser-*          # 해당 웨이브 hellgate green
bun test tests/integration/browser-*   # Wave 3+
```
(정확한 커맨드는 [verify-workflow] 메모리의 로컬 toolchain 기준 — installs blocked, `~/.bun/bin/bun` 사용)

웨이브는 **이전 웨이브가 main에 cherry-pick + green** 되기 전엔 시작 안 함.

## 파일 소유권 (병렬 디스패치 시 deconflict)

전부 **신규 파일** → 기존 코드 충돌 0. 단 두 군데만 기존 파일 touch:
1. `src/agent/tier1/index.ts` (또는 composition root) — `buildBrowserBlock` 등록 1줄
2. slice-fence 스캐너 config — `src/browser/` scope 추가 (필요 시)
3. 비교 카탈로그 YAML row + `bun fc build`

→ 이 3개만 단일 에이전트/순차 처리, 나머지는 병렬 가능.

## 방법론 가드레일

- **G1 staleness** — worktree-isolated 에이전트 디스패치 시 prompt에 [staleness preamble](feedback-worktree-staleness-pattern)(git HEAD vs main + ff 강제) + port shape verbatim 박기. W-B 3회 연속 인시던트 선례.
- **G2 TDD-first** — hellgate 먼저(red) → 구현(green). snapshot/allowlist는 순수라 특히 TDD 잘 맞음.
- **G3 default-OFF dead-code 안전판** — env-gate + availability 이중 게이트라 wire 전엔 byte-identical. 회귀 위험 0.
- **G4 no 휴리스틱** — SSRF prefix/CDP allowlist는 [ssrfDeny](../../../src/tool/web/fetch.ts) 실증 목록 + Cursor 추출 목록 기반. 임의 임계값 금지([no-heuristics-only-validated]).
- **G5 worktree node_modules** — [worktree-node-modules-hazard] 주의, 원인 검증 없이 사용자 탓 금지.

## 미해결 (착수 중 결정)

- **spawn 임시 프로필 위치** — `.quanta/browser/<id>/` (fs-jail 안) 권장. dispose에서 rm.
- **ws CDP 클라이언트** — 의존성 없이 Bun `WebSocket`로 직접 구현 vs 최소 헬퍼. installs blocked라 자체 구현 우선.
- **snapshot DOM 모델 획득** — cdp-adapter가 `Runtime.evaluate`로 페이지 내 a11y 수집 스크립트 주입 → 직렬화된 DOM 모델을 순수 `buildSnapshot`에 전달 (수집=어댑터, 변환=순수함수 분리).
