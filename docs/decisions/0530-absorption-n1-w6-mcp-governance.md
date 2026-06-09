# ADR-0530: jun-09/10 흡수 트리오 — 언어 자동감지(N1) · notebook_edit(W6/P17) · MCP 거버넌스 LIVE(§12.4 해소)

- **상태**: Accepted (구현·테스트 완료)
- **날짜**: 2026-06-10
- **슬라이스**: `@/agent/language-detect`(NEW) · `@/tool/notebook-edit`(NEW) · `@/config`(mcp-governance NEW + merge/loader EXTEND) · `apps/cli/internal.ts`(EXTEND)
- **출처**: `docs/backlog/jun-09-remaining-absorption-candidates.md` (결정보드 N1/W6/E2/E1-sub), 코퍼스 `.extracted_source` 2026-06-01 refresh
- **관련**: ADR-0481(ipynb cell-aware read — 본 ADR이 write 절반 완성) · ADR-0497(central-config — 본 ADR이 MCP enforcement 완성) · ADR-0068(persona — N7 false-gap 근거) · ADR-0474(stale-read guard — notebook_edit 패리티)

## Context

경쟁사 재흡수 어딧(Codex 3390/Cursor 3.5.33/CC 2.1.167)에서 후보 ~37개 중 **6건이 false-gap**(이미 구현: /doctor·/rewind·undo·persona·perms/hooks managed-only), **2건이 built-not-wired**(§12.4 central-config MCP resolve가 launcher 미소비 = inert · DXT loader 호출 0)로 판명. 진짜 buildable 3개를 풀사이클(hellgate red→TDD→어딧→보강)로 랜딩.

## Decision

### 1. N1 — 어시스턴트 언어 자동감지 (absorb: Cursor `whichlang`/`assistant-language-tracking`)

`src/agent/language-detect/`: **Unicode-script argmax** 분류기(매직 임계값 없음 — 스크립트별 meaningful-char 카운트 후 순수 다수결). Hangul→ko, kana→ja, Han+kana부재→zh, Cyrillic→ru 등 단일언어 스크립트=high confidence; Latin=en/low(다언어 모호 — 추측 강제 금지). `buildLanguageHint`가 `QUANTA_LANG_DETECT`(strict opt-in) + high-confidence 비영어일 때만 per-turn DYNAMIC slot에 "respond in <lang>" notice 주입 — 영어/모호/게이트OFF ⇒ byte-identical. 배선: `TurnContextInput.languageHint` + `buildDynamicContext` push + context-assembler가 `latestUserTextFromWm` 재사용(tool_result 캐리어 user 메시지는 text 블록 부재 ⇒ undefined ⇒ 안전). 힌트 텍스트는 정적(유저 텍스트 비보간) — reminder-forge 표면 없음.

### 2. W6 — `notebook_edit` 도구 (P17/§16.5 NotebookEdit defer 해소)

`src/tool/notebook-edit/`: pure NEVER-throws `editNotebook`(cell str_replace[유일성 강제/replaceAll]/insert/delete; nbformat `source` string|string[] 왕복; 타 cell+노트북 metadata 보존; malformed/범위밖/미발견 ⇒ typed `{ok:false}`). wrapper는 **edit 도구와 풀 패리티**: 동일 `@/storage` FS jail R/W + atomic write-back(`writeFileAtomic`) + git-write-guard·glob-write 정적 deny + ADR-0474 stale-read guard + per-turn write-budget(exfil rail) + `captureFileHistory`(rewind 가능). 게이트: `QUANTA_NOTEBOOK_EDIT`(strict opt-in) → runtime-config 필드 → agent-arg-builder → `DefaultToolPorts.notebookEdit`(officeAuthoring 패턴) → 조건부 등록; manifest GATED 엔트리(drift 라쳇 통과). 라이브커널 셀 실행은 명시적 별도 defer.

### 3. MCP 거버넌스 LIVE (E2 `deniedServers` + E1-sub `allowManagedMcpServersOnly`, §12.4 built-not-wired 해소)

3층 완성:
- **merge** (`config/merge.ts`): `deniedServers`=TIGHTENING(deny-wins; permission deny처럼 **untrusted repo 레이어에서도 생존** — 좁히기는 항상 안전) · `allowManagedMcpServersOnly`=managed-non-overridable(trusted repo도 추가 불가, `allowManagedHooksOnly` 미러) · resolved에 `mcpDeniedServers` 노출.
- **loader** (`config/loader.ts`): 온디스크 flat 스키마(`root.mcp`)에서 신규 필드 lift. **함정: merge만 고치면 loader가 안 읽어 영원히 inert** — 둘 다 필수.
- **enforcement** (`apps/cli/internal.ts`): `resolveMcpLaunchPolicy`(centralConfig-gated; **비인터랙티브 trust** — trust.json+`QUANTA_TRUSTED_PATHS` 읽기전용, 프롬프트 없음=boot 불차단; fail-soft=설정 fault가 전 MCP를 죽이지 않음, slog) + pure `filterMcpServersByPolicy`(`@/config`, gate-read 없음) + `readMcpConfig` 적용(両 포맷) + `loadFeatures` 주입. 드롭은 전부 `mcp.governance.dropped` slog(관측가능). **no-cliff**: 정책 미설정 ⇒ undefined ⇒ 무필터(central-config만 켜도 기존 `.mcp.json` 서버 유지).

## 테스트 (전부 red-first)

N1: 16(detect 8·hint 5·prompt hellgate 3) · W6: 20(core 12·wrapper hellgate 8 — no-partial-write·stale-guard·file-history 포함) · 거버넌스: 16(filter 5·merge 5·live-wire e2e 6 — gate-OFF byte-identical/denylist+slog/trusted allowlist/untrusted deny생존/managed-only/no-cliff). 인접 회귀(central-config·connector-wire·manifest drift·knob default-off) 그린, src tsc 통과.

## 어딧 기록 (적대 1R + 객관 1R)

- 적대: ① `latestUserTextFromWm` tool_result 캐리어 → text 블록 부재 시 undefined(안전) 확인 ② 헤드리스 `apps/agent`는 MCP 자체 미로드 → enforcement 구멍 없음 ③ **notebook_edit가 edit의 stale-guard/write-budget/file-history 누락 발견 → 패리티 보강**(+2 test) ④ untrusted repo의 `.mcp.json` 자체는 기존 legacy 표면(본 ADR 범위 밖 — denylist/allowlist 설정 시 통제 가능).
- 객관: ADR 부재 발견 → 본 문서. fc 엔트리 3·knob inventory 2·manifest GATED 1 확인.

## Default posture

전부 strict opt-in(`QUANTA_LANG_DETECT`/`QUANTA_NOTEBOOK_EDIT`/`QUANTA_CENTRAL_CONFIG`+settings) — OFF ⇒ byte-identical. 거버넌스 denylist는 게이트 ON+설정 시에만 작동하되 untrusted에도 적용(보안 비대칭 의도).
