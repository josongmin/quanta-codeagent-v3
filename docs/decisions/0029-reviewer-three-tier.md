# ADR-0029 — Reviewer 3-tier enum + 8-state approval outcome

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0020 (HITL 4-tier gate), ADR-0026 (admissibility-gate SSOT),
  ADR-0027 (anti-signals / policy-injection hardening), Codex 메모
  [[codex-feature-catalog-2026-05-21]] §3 (Subagent reviewer enum) +
  [[codex-desktop-build-2867-round-2]] R3-3 (Reviewer 3-tier).

## Context

ADR-0020은 `HITLTier`(`hand-off-required | always-confirm | pre-approval-ok |
none`) 4단계로 액션의 *본질적 위험 형태*를 분류했다. 그러나 "누가 결정을
내릴 것인가"라는 직교 축이 없었다 — 모든 confirm은 단일 `onConfirm` 콜백을
통해 user에게 직접 전달되었다.

Codex Desktop build 2867 (codex-rs 0.130.0) 분석에서 확인된 모델은
다음과 같다:

- `approvalsReviewer: "user" | "auto_review" | "guardian_subagent"` 3-tier
  enum — 결정자를 명시적으로 선택한다.
- `final_approval_outcome` 8-state — 결정의 최종 형태가 닫힌 집합으로
  enumerate된다: `not_needed`, `config_allowed`, `guardian_approved`,
  `guardian_denied`, `user_approved`, `user_approved_for_session`,
  `user_denied`, `user_aborted`.
- `workspace-write` / `on-request` sandbox 프로파일은 기본 reviewer로
  `guardian_subagent`를 사용한다.
- Guardian post-denial precedence: guardian이 한 번 거부한 actionKey는
  세션 잔여 기간 sticky하게 차단된다 (user_aborted는 더 강한 sticky).

기존 binary path(`evaluate` → `onConfirm`)로는 (a) low-risk 자동 통과,
(b) medium-risk 부수 검토(guardian), (c) high-risk 인간 확정이라는
3단계 escalation을 표현할 수 없다.

## Decision

1. `src/permission/types.ts`에 `ReviewerTier` / `ApprovalOutcome` /
   `ApprovalDecision` / `DenialMemory` / `ReviewerPort` / `ReviewContext` /
   `ToolActionKeyed` 타입을 추가한다. 기존 export는 모두 보존한다 — `HITLTier`,
   `PermissionContext`, `PermissionDecision`, `PermissionMode`, `ToolAction`은
   그대로다.
2. `src/permission/outcome.ts` (신규)에 invariant matrix를 enforce하는
   `buildDecision` + `isTerminal` / `isAllowed` / `requiresUserConfirmation`
   truth table을 둔다. `OutcomeInvariantError`로 invalid combo를 throw
   (silent normalization 없음).
3. `src/permission/reviewer.ts` (신규)에 `reviewAction(action, ctx, port)`
   dispatcher를 둔다. 책임:
   - sticky precedence: `user_aborted` > `guardian_denied` > `user_denied`.
   - 3-tier dispatch → `port.userReview` / `port.autoReview` /
     `port.guardianReview` 중 하나.
   - port 결정값을 `buildDecision`으로 재검증.
   - 실패 path는 명시적 named error (`ReviewerUnavailableError`,
     `DenialPrecedenceConflictError`, `OutcomeInvariantError`).
4. `src/permission/index.ts`에서 신규 심볼들을 re-export. 기존 export는
   그대로 유지 (byte-identical).
5. `HITLTier`와 `ReviewerTier`는 **직교 축**이다. HITLTier는 액션의 위험
   형태 (always-confirm vs pre-approval-ok 등)를 분류하고, ReviewerTier는
   confirm이 필요해진 시점에 *누가 결정하는가*를 선택한다. 두 축은 동시에
   존재한다 (schema break 없음).

## Invariant matrix

```
reviewer            ⇒ admissible outcomes
─────────────────────────────────────────────────────────────
user                ⇒ not_needed, user_approved,
                      user_approved_for_session, user_denied,
                      user_aborted
auto_review         ⇒ not_needed, config_allowed
guardian_subagent   ⇒ not_needed, guardian_approved, guardian_denied
```

`auto_review`는 단독으로 거부할 수 없다 (정의상 deterministic clear-only).
거부가 필요하면 호출자가 별도 라운드에서 `guardian_subagent` 또는 `user`로
escalate해야 한다 — 이 책임은 admissibility-gate에 있다 (후속 PR).

## Sticky precedence

`ReviewContext.priorDenials`는 동일 `sessionId`에 대해 누적된
`DenialMemory` 레코드 집합이다. `reviewAction`은 동일 `actionKey`에
대한 sticky 레코드(아래)를 우선 처리한다:

- rank 3: `user_aborted` — 가장 강함 (사용자가 turn 전체를 취소).
- rank 2: `guardian_denied` — guardian 한 번 거부 = 세션 잔여 차단.
- rank 1: `user_denied` — 동일 actionKey 재요청 시 user 재확인.

동일 rank의 서로 다른 (reviewer, outcome) 레코드가 충돌하면
`DenialPrecedenceConflictError`를 throw한다 (silent winner picking 없음).

## Trade-offs

- **복잡도 ↑**: 두 개의 새 enum + invariant matrix + sticky 상태 관리.
- **상쇄**: ReviewerTier는 HITLTier와 직교하므로 기존 4-tier 의미론이
  변하지 않는다. 기존 호출자는 `ReviewerPort`를 주입하지 않으면
  byte-identical 경로를 유지한다 (Migration 참고).
- **deterministic clock**: `decidedAt`는 caller 주입. pure 모듈에서
  `Date.now()` 호출 안 함 → trajectory replay/snapshot 안전.
- **휴리스틱 없음**: outcome 매트릭스는 explicit literal Set으로 인코드.

## Codex reference 매핑

| Codex 구성요소                    | quanta 대응                                          |
|----------------------------------|------------------------------------------------------|
| `approvalsReviewer` enum         | `ReviewerTier` (`types.ts`)                          |
| `final_approval_outcome` 8-state | `ApprovalOutcome` (`types.ts`, `outcome.ts`)         |
| Guardian post-denial precedence  | `DenialMemory` + sticky rank table (`reviewer.ts`)   |
| workspace-write 기본 guardian    | `ReviewContext.configReviewer` (caller-policy)       |
| `user_approved_for_session`      | `ApprovalOutcome` 멤버 + actionKey 동질성 (caller)   |

## Migration

기존 HITL 4-tier 경로는 **변경 없음**. `ReviewerPort`를 주입하지 않는
호출자에게는 `reviewAction`이 노출조차 되지 않는다 — `evaluate` /
`runGates` 경로는 byte-identical로 유지된다. ADR-0020의 `onConfirm` 콜백은
`ReviewerPort.userReview` 구현체로 (후속 PR에서) 자연스럽게 wrap된다.

기본 reviewer가 미정인 호출자는 `user`로 시작하길 권장 (가장 보수적).

## Integration seam (구현 X — 후속 PR)

본 슬라이스는 reviewer 모듈만 SOTA++로 구축하고 단위 테스트로 검증한다.
admissibility-gate와의 결선은 **이번 PR에서 수정하지 않는다**. 다음 PR에서
다음 위치에 결선한다:

- 파일: `src/agent/admissibility-gate.ts`
- 진입 지점: HITL 게이트(`always-confirm` 분기) 직후, mode-policy 진입 직전.
  현 코드에서 `resolveHitlTier` 결과가 `always-confirm`인 분기 내부에
  reviewer dispatch를 삽입한다 (`onConfirm` 호출 자리를 대체).
- 주입 계약:
  - `AgentConfig.hitl`에 `reviewerPort?: ReviewerPort` +
    `defaultReviewer?: ReviewerTier` 옵션 추가 (없으면 legacy `onConfirm`).
  - 세션 단위 `priorDenials` 저장소는 `@/session` 또는 `@/agent` runtime
    state에 둔다 (slice 위반 없이 admissibility-gate 시그니처로 주입).
  - admissibility-gate는 `reviewAction()` 결과의 `isAllowed(outcome)`를
    그대로 사용해 deny/allow를 결정하고, `requiresUserConfirmation`이
    true이면 trajectory event를 발행한다.
- 호환성: `reviewerPort` 미주입 시 dispatch는 **호출되지 않으며**
  legacy onConfirm 경로가 그대로 실행된다. 이로써 기존 1300+ 테스트가
  byte-identical로 통과해야 한다.

상기 결선은 별도 PR (ADR-0029의 후속 wave)에서 처리하며, 본 PR은
reviewer 모듈 + 단위 테스트 + ADR만 포함한다.
