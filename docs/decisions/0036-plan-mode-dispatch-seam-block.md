# ADR-0036: Plan vs Default collaboration mode — dispatch-seam mutating block

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2(SOTA++), ADR-0018(mode enum), Codex `codex-collaboration-mode-pattern` 흡수, Cluster D Feature 1

## 맥락

기존 v3의 `AgentMode` (default/plan/review/audit, ADR-0018)는 4-mode posture
enum으로 prompt + dispatch에서 공유된다. plan-mode mutating 차단은
`isMutatingToolBlockedInMode(mode, action)`이 처리하지만 입력은 ToolAction
(`isReadOnly` 필드)이고 — 즉 **각 도구가 자기 self-reporting하는 isReadOnly**
에 의존한다. 새 도구 추가 시 isReadOnly()=true 실수 한 줄이면 plan 모드 우회.

Codex `codex-collaboration-mode-pattern`은 이를 명시적 per-tool 테이블로
해결한다: dispatch seam에서 BEFORE-tool-run 단계에 **이름 lookup → mutating
kind 분류 → 미등록 시 throw**. self-reporting 제로.

또한 collaboration mode 전환은 sticky — 모델이 "now I'll plan"이라고 말한다고
바뀌지 않고, **developer-channel 메시지의 `mode=plan` / `mode=default`
directive**만 인정한다. 무성 drift 봉쇄.

## 결정

### Part 1 — 새 `CollaborationMode` 2-mode enum (add-only)

`src/agent/mode.ts`에 add-only 확장 (기존 `AgentMode` / `MUTATING_MODES` /
`isMutatingToolBlockedInMode` / `modeBlockReason` 미변경):

- `CollaborationMode = "default" | "plan"` — 4-mode `AgentMode`와 별개 필드.
  단어 overlap("default", "plan")만 공유.
- `MutatingToolKind` enum 5종: `write_filesystem` / `bash_mutating` /
  `git_mutating` / `network_write` / `working_state_write`. 각 kind는
  doc-comment에서 어떤 도구가 어떤 mutating effect를 갖는지 명시.
- `MUTATING_TOOL_TABLE` — **v3 registry의 모든 도구명에 대해 명시적 mapping**.
  read-only는 `null`, mutating은 kind. 18개 도구 모두 등록.
- `isMutatingTool(name)`: 미등록 ⇒ `UnknownToolError` throw. silent-allow 봉쇄.
- `assertNotMutatingInPlanMode(mode, name)`: default 모드 short-circuit;
  plan 모드 + mutating ⇒ `PlanModeMutatingBlockedError`.
- `applyDeveloperModeTransition(currentMode, devMessage)`: 정규식
  `^\s*mode\s*=\s*([a-z_]+)\s*$`. `plan` / `default`만 인정, 그 외 ⇒
  `InvalidModeTransitionError`; directive 부재 ⇒ no-op (currentMode 반환);
  identical-mode ⇒ no-op (sticky-set 의미).

### Part 2 — 새 `dispatch-seam-guard.ts` 모듈 (standalone)

`checkDispatchAllowed(turnState, toolCall): { ok:true } | { ok:false, reason }`
— 순수 함수, throw 안 함, tagged result. 향후 `loop.ts` 통합 시
import-and-call 한 줄 패치.

### Part 3 — 회귀 테스트

`mode-mutating-table.test.ts` — registry × table cross-check (drift CI fail).
`mode-plan-block.test.ts` — combinatorial plan×{mutating,read-only,unknown}×
모든 도구 (≥27 cell). `mode-transition.test.ts` — 정규식 strict edge.

## 근거

- **per-tool 테이블 vs isReadOnly self-report**: self-report은 도구 추가 시
  실수로 mutating을 read-only로 mark하면 plan-모드 우회. 외부 테이블은
  cross-check 테스트가 drift를 잡는다.
- **unknown ⇒ throw (silent allow 아님)**: 신규 도구를 잊은 채 출시하면
  테스트 단계에서 fail. plan-모드 안전성 침해 0.
- **mode 전환을 developer-message로 한정**: LLM이 자기 모드를 바꾸지 못함 →
  user-intent SSOT. RFC §1.2 ladder의 L2(developer) 권한 일관.

## 대안

- **기존 `isMutatingToolBlockedInMode` 그대로 확장**: 기각 — self-report
  의존성 + AgentMode 4-mode와 collaboration의 2-mode 의미 혼동.
- **2-mode를 AgentMode에 통합**: 기각 — AgentMode는 prompt-posture(L5),
  CollaborationMode는 dispatch-permission(L2). 서로 다른 ladder 층 → 분리.
- **LLM이 mode 전환 가능**: 기각 — L2 권한 침해 + injection 공격면 확장.

## 결과·트레이드오프

- **얻은 것**: plan 모드에서 mutating 도구가 dispatch seam BEFORE 단계에서
  차단됨. 신규 도구 추가 시 mutating kind 분류를 강제(CI fail). 외부 enum
  은 검증 가능한 SSOT. 73 unit assertion green, regress 0.
- **비용**: `MUTATING_TOOL_TABLE` 유지 비용 — 도구 추가/제거 시 한 줄 갱신
  필요. cross-check 테스트가 누락을 즉시 잡아주므로 비용 최소.

## 한계 (LIMITATIONS)

- **(a) loop 통합 follow-up**: `checkDispatchAllowed`는 standalone-callable
  — 실제 `loop.ts` / `dispatch.ts` 호출 wiring은 follow-up. 이번 클러스터는
  in-flight modified files 회피로 standalone 모듈만 출시.
- **(b) `git_mutating` / `network_write` kind는 reserved**: 해당 도구 없음.
  미래 도구 추가 시 enum 변경 없이 분류 가능.

## 불변식 영향

- **슬라이스 격리 유지**: `@/agent/mode.ts` 자기 슬라이스 내 확장.
- **RFC/ADR 동기**: RFC §1.2 ladder L2 권한 강화.
- **신규 npm dep 0**.
- **byte-identical default-OFF**: dispatch-seam-guard는 loop에 통합 전이라
  registry 호출 경로 byte-identical (호출 사이트 미존재).
