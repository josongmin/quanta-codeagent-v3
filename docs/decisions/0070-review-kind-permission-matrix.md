# ADR-0070: review-kind × isExecutionBlocking × reason_code 권한 매트릭스 + scoped-allowlist 결정 verb (Cursor HITL gate 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0020(HITL 4-tier — 행위 risk 축), ADR-0029(ReviewerTier 3-tier — 누가 결정하나 축), ADR-0030(mid-turn steering), `cursor-3.2-absorption` 메모(HITL approval gate). 신규 파일 `src/permission/review-kind.ts`.

## 맥락

Cursor의 approval gate는 타입화된 매트릭스를 갖는다: `ReviewKind`(edit/terminal/mcp/web_fetch/plan), 종류별 `isExecutionBlocking()`(특히 **PLAN은 non-blocking**), stop에 실리는 타입화된 `reason_code`(예 `"shell.needs_approval"`), 그리고 allow/deny를 넘어서는 per-gate 결정 verb — `RUN`/`SKIP`/`ALLOWLIST_COMMANDS`/`ALLOWLIST_TOOL`/`ALLOWLIST_DOMAIN`/`REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY`(거절하면서 steering 메시지를 모델로 되돌림). v3 권한 레이어는 allow/ask/deny 3-상태(`PermissionDecision`)와 HITLTier·ReviewerTier 두 축은 있었으나 "무엇을 리뷰하는가" 축과 scoped-allowlist verb는 없었다.

## 결정

순수·가산·default-OFF 신규 모듈 `src/permission/review-kind.ts`:

- `ReviewKind = "edit"|"delete"|"terminal"|"mcp"|"web_fetch"|"web_search"|"plan"` + `ALL_REVIEW_KINDS`.
- `isExecutionBlocking(kind)` — `plan`만 false, 나머지 전부 true. 순수·exhaustive `never` default.
- `ReasonCode` 닫힌 union(`<kind>.needs_approval` ×7) + `reasonCodeFor(kind)` + `ALL_REASON_CODES`.
- `ReviewDecision` discriminated union: `run`/`skip`/`allowlist_commands{commands}`/`allowlist_tool{server,tool}`/`allowlist_domain{domain}`/`reject_and_tell{message}`. `reject_and_tell.message`는 steering seam으로 모델에 되먹임(Cursor REJECT_AND_TELL).
- `stopCategoryFor(kind) → {stopCategory:"needs_user_approval", reasonCode}` — 미래 caller가 타입화된 stop을 emit.
- `isDecisionLegalFor(kind, decision)` — verb×kind 합법성: `allowlist_commands⇒terminal`, `allowlist_tool⇒mcp`, `allowlist_domain⇒web_fetch|web_search`; `run`/`skip`/`reject_and_tell`은 전 kind 합법.

## 근거

- **PLAN non-blocking**: 계획 제시는 advisory — 턴을 멈출 필요가 없다(Cursor의 PLAN gate가 명시적으로 non-blocking). 나머지 종류는 실행을 게이트한다.
- **3축 직교**: HITLTier(risk 형상)·ReviewerTier(누가 결정)·ReviewKind(무엇을 리뷰)는 서로 겹치지 않고 합성된다. 본 모듈은 다른 두 축의 의미를 변경하지 않는다.
- **scoped-allowlist verb**: allow/deny보다 표현력이 높아 "이 명령군/이 MCP 도구/이 도메인만 기억" 같은 좁은 승인을 타입으로 강제. `isDecisionLegalFor`가 verb를 엉뚱한 kind에 붙이는 호출 버그를 컴파일/런타임에서 차단.
- **literal reason_code**: trajectory export가 번역 없이 상호운용.

## 대안

- **inspector.ts에 타입 추가**: 기각 — 신규 파일이 슬라이스 깔끔. (지침이 신규 파일 선호.)
- **PermissionDecision 확장**: 기각 — 기존 결정 경로를 건드려 byte-identical 위반.

## 결과·트레이드오프

- **얻은 것**: 타입화된 review 매트릭스 + scoped verb 표현력. 신규 호출자가 opt-in으로 타입 stop/steering을 emit 가능.
- **비용**: 아직 호출자 없음 — 미래 wiring(loop/dispatch) 필요. 본 PR은 순수 타입+함수+테스트만.

## 한계 (LIMITATIONS)

- (a) 어떤 기존 경로도 본 모듈을 호출하지 않음 — `evaluate`/`evaluateStack`/`reviewAction` 무변경.
- (b) `reject_and_tell.message`의 steering 라우팅은 caller 책임(본 모듈은 운반만).

## 불변식 영향

- **byte-identical default-OFF**: 신규 순수 모듈; 기존 결정 경로 무변경, 기존 권한 테스트 전부 그대로 통과.
- **닫힌 enum**: union-of-literals + `ALL_*` 배열 + exhaustive `never` default(steering.ts `ALL_REJECTION_REASONS` 패턴 미러).
- **no any / no sentinel / no silent catch**; `exactOptionalPropertyTypes` 준수.
- **슬라이스 격리 유지**: `@/permission` leaf — 외부 import 0.
