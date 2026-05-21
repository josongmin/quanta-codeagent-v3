# ADR-0038: External-agent import 4-stage lifecycle

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2(SOTA++), Codex `codex-desktop-build-2867-round-2` fact 8 흡수, Cluster D Feature 4

## 맥락

v3 외부에 사용자가 이미 다른 코딩 agent (Claude Code, Cursor, Aider)로
작업한 세션/skill이 있을 수 있다. 마이그레이션 없이 v3로 옮길 방법이
없으면 onboard 마찰 ↑. Codex는 외부 agent 가져오기를 **4-stage 명시
lifecycle**로 처리한다:

```
detect_finished
   ↓
provider_stage_finished
   ↓
session_completion_finished
   ↓
import_finished
```

각 stage는 단일 success XOR failure 이벤트를 emit하고, 어느 단계라도
실패하면 `import_finished{ok:false}`로 즉시 halt — partial-success silent
path 없음.

또한 외부 agent 감지는 **엄격 marker-based** (`.claude/auth.json`+`projects/`
모두 존재 시에만 claude_code; "maybe-claude" 추측 금지). 'unknown' provider
는 enum에 존재하지만 importer는 명시적으로 reject (silent fallback 봉쇄).

## 결정

### Part 1 — 새 슬라이스 `@/migration`

- `src/migration/{index,types,detector,importer,persistence}.ts`.
- `tsconfig.json`에 `@/migration` path alias 추가.
- Biome override: `@/migration`은 `@/shared`만 의존 (다른 lib 슬라이스 X).
- `@/agent`만 향후 `@/migration`을 import 가능 (slice rule 추가 시).

### Part 2 — types

- `ImportStage` 4-value enum.
- `ImportEvent` discriminated union — stage별 success/failure payload.
- `ExternalAgentProvider = "claude_code" | "cursor" | "aider" | "unknown"`.
- `ImportResult`, `DetectedAgent`, `ImportLog`, `ImportLogEntry`.

### Part 3 — detector

`detectExternalAgents(homeDir)` — provider별 **marker-file ANDed set**
확인. claude_code: `auth.json` + `projects/`; cursor: `sessions.json`;
aider: `history.json`. 한 marker라도 없으면 detected에 미포함 (no maybe).

### Part 4 — importer

`runImport(provider, opts, emit)` — 4-stage 순차 실행, halt-on-error.
provider='unknown' ⇒ `UnknownProviderRejectedError` throw (이 enum 값은
caller-driven probing용; importer는 거부).

### Part 5 — persistence

`appendImportLog(homeDir, entry)`:
- Sidecar lock file (`...json.lock`, `flag:'wx'`) — 충돌 ⇒
  `ImportLogBusyError`.
- Read-modify-write 후 `tmp → rename` atomic.
- Log path: `~/.quanta/external_agent_session_imports.json` (Codex 1:1).

### Part 6 — 회귀 (29 unit + 3 integration)

- `migration-detector.test.ts` (11 cases): positive + 다양 negative.
- `migration-stages.test.ts` (7 cases): 4-stage sequence + halt-on-error +
  exactly-once delivery.
- `migration-persistence.test.ts` (7 cases): round-trip + lock 충돌 + 잘못
  된 version 거부.
- `migration-claude-code-fixture.test.ts` (3 cases): tmpdir에 진짜
  `~/.claude/`-shaped 픽스처 + 전체 runImport + 로그 round-trip.

## 근거

- **marker-based strict 감지**: heuristic guess는 false-positive로 다른
  agent의 데이터를 v3에 importing → 데이터 corruption.
- **'unknown' enum + importer reject**: type-level에서 enum value를 두면
  caller가 명시적으로 'unknown' 처리 가능; importer는 거부함으로써 silent
  path 차단.
- **halt-on-error vs continue**: 부분 import는 사용자 입장에서 "성공인지
  실패인지" 모호. 명시적 halt가 디버그 가능.
- **lock file (wx flag)**: OS-level atomic 보장; 충돌 시 caller에게
  명시적 BusyError → retry vs abort 결정.

## 대안

- **best-effort heuristic 감지 + unknown 보고**: 기각 — 사용자 데이터
  corruption 위험.
- **partial-success 허용**: 기각 — UX 모호 + log scanning 비용.
- **JSON merge (lock 없음)**: 기각 — race로 entries 손실 가능.

## 결과·트레이드오프

- **얻은 것**: 외부 agent 데이터 가져오기 위한 4-stage 정형 lifecycle.
  `@/migration` 슬라이스 (분리) + 29 unit + 3 integration green. 마커
  기반 감지로 false-positive 차단.
- **비용**: 신규 슬라이스 추가 → biome rule 1개 추가. claude_code/cursor/
  aider 외 provider는 새 contract 추가 필요.

## 한계 (LIMITATIONS)

- **(a) 실제 provider session 파싱은 fixture만**: 본 ADR은 lifecycle
  shape + 세션 파일 카운트. Claude Code session JSON을 v3 메시지로
  변환하는 per-provider translator는 follow-up
  (`src/migration/providers/<provider>.ts`).
- **(b) skills import는 file 카운트만**: skill 내용 검증/import는 별도.
- **(c) CLI front-end 미구현**: `runImport`를 호출하는 사용자 명령어
  ("quanta migrate-from claude_code")는 별도.

## 불변식 영향

- **슬라이스 격리 유지**: `@/migration`은 `@/shared`만 import. Biome
  override가 cross-slice import block.
- **RFC/ADR 동기**: RFC §1.2 외부 agent 가져오기 lifecycle.
- **신규 npm dep 0**: node:fs/promises + node:path만 사용.
- **byte-identical default-OFF**: importer는 caller-driven; 미호출 시
  v3 동작 변화 0.
