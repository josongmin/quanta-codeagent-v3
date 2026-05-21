# ADR-0046 — Permission stack: per-thread + per-host + post-denial precedence

- **Status**: Accepted
- **Date**: 2026-05-21
- **Related**: ADR-0026 (admissibility-gate SSOT — single entry point that
  consults this stack), ADR-0029 (reviewer 3-tier — post-denial sits AFTER
  reviewer denies), ADR-0027 (anti-signals / policy-injection hardening),
  ADR-0030 (mid-turn steering — the UI surface that consumes the inspector),
  ADR-0047 (HITL 4-tier gate — orthogonal axis, composed in
  `runAdmissibilityGate`),
  [[codex-desktop-build-2867-round-4]] (per-thread + per-host + post-denial
  axes), [[codex-feature-catalog-2026-05-21]] §3 (permission state slices).

## Context

ADR-0026이 정한 admissibility-gate는 단일 축의 `PermissionContext.mode`
(`default | acceptEdits | bypass | auto`)와 정적 `HARD_DENY` 룰만으로 모든
승인 결정을 했다. 이 단일 축으로는 다음 세 가지를 표현할 수 없다:

1. **세션/스레드별 정책** — 사용자가 한 스레드에 `read-only`를, 다른
   스레드에 `danger-full-access`를 부여하고 싶다 (Codex의
   `heartbeat-thread-permissions-by-id`).
2. **호스트별 기본값** — 원격 SSH 호스트에서는 `read-only`, localhost에서는
   `full-access`를 기본으로 잡고 싶다 (Codex의 `agent-mode-by-host-id`).
3. **post-denial 사용자 override** — guardian이 한 번 거부했지만 사용자가
   위험을 명시적으로 본 뒤 재승인한 경우, 룰을 우회해서 그 동작만 허용하고
   싶다 (Codex `guardian-post-denial-precedence`).

Codex Desktop build 2867 (codex-rs 0.130.0) 분석
([[codex-desktop-build-2867-round-4]]) 시 위 3축이 모두 영속 상태 슬라이스로
존재하며, 우선순위 차원이 명확하다:

> `post-denial user override > per-thread > per-host > global default`

v3에 동등한 축을 도입하되, ADR-0026의 admissibility-gate SSOT를 깨지 않는
형태로 통합한다.

## Decision

### 1. 새 슬라이스 모듈 (`src/permission/`)

- **`permission-store.ts`** — 영속 JSON 스토어. `~/.quanta/permission-
  state.json` (override: `QUANTA_PERMISSION_STATE` env). Atomic write
  (`tmp + rename`), debounced flush (200ms), corrupt-JSON quarantine to
  `.corrupt` sidecar. 슬라이스 규칙: `node:` stdlib만 — `@/shared`,
  `@/storage`, `@/memory` 의존 금지.
- **`per-thread-store.ts`** — facade. `getThreadPermission` /
  `setThreadPermission` / `clearThreadPermission` / `threadAllowsMutation`.
- **`per-host-mode.ts`** — facade + `resolveHostId(env)` 결정론적 호스트
  식별자 (`SSH_CONNECTION` 환경변수 존재 시 `${user}@${hostname}`, 아니면
  `localhost`).
- **`post-denial.ts`** — `recordDenial` → `recordRiskSeen` →
  `recordUserOverride` 3-step state machine + `hasPostDenialOverride`
  reader. `actionSignature = sha256(canonicalize({tool, workdir, args}))`
  로 (threadId, action) 단위 격리.

### 2. 우선순위 resolver (`policy.ts::evaluateStack`)

`evaluateStack(action, ctx, stack, opts)` 동기 함수. 우선순위 (highest →
lowest):

1. `HARD_DENY` — 보안 경계. 어떤 override도 통과 불가.
2. `isReadOnly` — read-only 액션은 stack을 우회 (HARD_DENY 제외).
3. **post-denial user override** — (threadId, actionSignature) 키에 완전한
   `denied → seenRisk → override` 시퀀스가 있고 타임스탬프 순서가 유효
   (`deniedAt ≤ seenRiskAt ≤ userOverrideAt`) ⇒ allow.
4. **per-thread permission** — 스레드 레코드가 있으면 `sandboxPolicy`로
   결정. `workspace-write` + `writableRoots`인 경우 `workdir`이 어느 root
   하위인지 검사.
5. **per-host agent mode** — `read-only`/`full-access`/`custom`. `custom`은
   "다른 곳에 정책 정의" 신호로, fall-through.
6. **글로벌 default** — 기존 `evaluate(action, ctx)` (mode-policy)로 위임.

### 3. admissibility-gate 통합

`runAdmissibilityGate`에 `opts.permissionStore?` 인자를 추가한다 (테스트
격리용). `AgentConfig.permissionStack?: { enabled?: boolean; hostId?: string }`
opt-in flag — 부재 시 기존 동작과 byte-identical:

- `enabled: true` 이고 `sessionId`가 있으면 **plan-mode block + HITL gate
  다음, mode-policy 앞**에서 stack을 한 번 consult.
- stack이 `allow` ⇒ mode-policy 건너뛰고 `pre_tool_use` hook으로 직진.
- stack이 `deny` ⇒ 즉시 `deny()` short-circuit.
- stack이 의견 없음 (`ask`) ⇒ 기존 mode-policy로 fall-through.

`sessionId`가 없으면 fabricate 하지 않고 stack 자체를 건너뛴다 (UI가
설정한 thread record와 매치되지 않는 가짜 ID가 침묵 실패를 일으키는 것을
방지).

### 4. actionSignature

`computeActionSignature({tool, workdir, args})` —
`sha256(JSON.stringify(canonicalize(...)))` 의 hex 32자 (128 bit). 키 순서
무관 (canonicalization), tool/workdir/args 중 하나만 달라도 다른
signature. 프로세스 간 재현 가능 (해시 입력이 순수 함수).

## Consequences

### Positive

- **세션 격리**: 한 스레드의 권한 변경이 다른 스레드 / 글로벌 default에
  영향 없음 ([[codex-feature-catalog-2026-05-21]] §3 슬라이스 격리와 동등).
- **post-denial UX**: guardian 거부 후 사용자가 "이 한 번만"이라는 의도를
  명확히 표현할 수 있는 경로 (ADR-0029 reviewer tier와 결합).
- **byte-identical 보존**: opt-in flag 부재 시 기존 동작 100% 동일 — 기존
  테스트 회귀 없음.
- **단일 스토어 + 단일 파일**: SQLite/Postgres 미도입, 부팅 의존성 최소.

### Negative / Trade-offs

- **JSON-파일 동시성**: 다중 프로세스가 같은 파일을 쓰면 마지막 쓰기 승리
  (atomic write로 torn-write는 막지만 race는 잔존). v3는 현재 단일
  프로세스 가정 (singleton store) ⇒ 수용 가능. 다중 프로세스 surface가
  생기면 추후 lock-file ADR.
- **store singleton**: 프로세스 전역 상태가 늘어남. 테스트에서는
  `createPermissionStore({filePath})`로 격리 + `opts.permissionStore`
  주입 가능 — singleton 사용 금지 (`__resetDefaultPermissionStore` 만
  exception path).
- **actionSignature 충돌**: 128-bit truncation은 (thread, action) 범위에선
  충분하지만 cross-thread bug bounty 시나리오에선 이론적 충돌 가능. 위협
  모델 외 — actionSignature는 보안 토큰이 아니라 매칭 키일 뿐.

### Risks

1. **"seenRisk" 자동-설정 익스플로잇** — 악의적 프롬프트가 UI를
   우회해서 `recordRiskSeen` + `recordUserOverride`를 한 번에 호출하면
   순서는 만족하지만 사용자는 위험을 본 적이 없다. **Mitigation**:
   `recordRiskSeen`은 명시적 UI surface (CLI confirm prompt / Tauri
   dialog acknowledgement) **외부에선 호출 금지**. 코드 import 경로를
   `noRestrictedImports`로 권한 슬라이스 외부에서 차단할 것 (후속
   commit). 또한 reviewer port (ADR-0029)가 일관된 단일 surface가
   되도록 라우팅.
2. **시계 조작** — 사용자가 시스템 시계를 조작하면 ordering invariant가
   거짓-만족될 수 있다. **Mitigation**: `now()`는 store 생성자에 inject
   가능 (테스트용)이고 프로덕션은 `Date.now()` 단조 가정. monotonic clock
   는 후속 hardening (불필요한 의존성을 피하기 위해 v1에선 미도입).
3. **잠금 없는 파일 동시 쓰기** — flushDebounced가 같은 파일을 동시에 두
   프로세스에서 호출하면 한쪽이 손실 가능. **Mitigation**: atomic
   `tmp + rename`으로 torn-write만 방지. 단일 프로세스 가정이 깨지면
   ADR.
4. **`actionSignature` 인수 정규화 누락** — 캐노니컬 JSON은 키 순서만
   정렬, 의미적으로 같지만 형태가 다른 args(`"foo"` vs `"foo "`)는 다른
   signature ⇒ post-denial override가 "조용히" 매치 실패할 수 있다.
   **Mitigation**: tool-level argument schema가 이미 trimming/normalize를
   강제 (Zod). action signature는 도구 호출 그대로의 결과이므로 사용자
   기대와 일치.

## Alternatives considered

- **SQLite 단일 테이블 3개 슬라이스** — 더 무겁고, 슬라이스 isolation
  invariant (`@/permission`이 `@/storage`에 의존 금지)를 깬다. JSON 파일은
  소형 + slice-pure.
- **`evaluate()` 시그니처 자체에 `stack` 추가** — 기존 호출자 N개 전부
  손봐야 함. `evaluateStack`을 별도 export로 두면 점진적 도입 가능.
- **post-denial을 reviewer port 안에 흡수** — ADR-0029 reviewer는 turn
  스코프; post-denial은 thread 스코프 + 영속. 두 모델이 직교 ⇒ 분리 유지.
- **`agentMode` 단일 enum (sandbox + approval 통합)** — Codex Desktop은
  `agent-mode-by-host-id`를 `full-access | read-only | custom`로 단순화.
  v3는 per-thread에서 `ThreadPermission`로 더 표현적이지만, per-host는
  같은 단순한 enum을 채택.

## References

- [[codex-desktop-build-2867-round-4]] — 영속 슬라이스 3축 + 우선순위.
- [[codex-feature-catalog-2026-05-21]] §3 — Codex의 permission state
  slices.
- ADR-0026 — admissibility-gate SSOT (이 stack은 그 단일 진입점에서만
  consult됨).
- ADR-0029 — reviewer 3-tier; post-denial override는 reviewer 결정 이후의
  사후 단계.
- ADR-0027 — anti-signals; "seenRisk" 자동 설정 익스플로잇은 본 ADR의
  Risks §1과 ADR-0027의 inject 방지 원칙이 결합되어 차단.

## Implementation

- `src/permission/permission-store.ts` — 스토어 + signature.
- `src/permission/per-thread-store.ts` — facade.
- `src/permission/per-host-mode.ts` — facade + hostId 해결.
- `src/permission/post-denial.ts` — 3-step state machine.
- `src/permission/policy.ts` — `evaluateStack`.
- `src/permission/inspector.ts` — `getPermissionInspector()` 프로그래밍 surface
  (3-pass polish 후속, CLI/Tauri 대시보드 seam).
- `src/permission/index.ts` — 새 export.
- `src/agent/admissibility-gate.ts` — opt-in stack consultation
  (`runPermissionStack` 내부 함수가 `evaluateStack`을 호출).
- `src/agent/types.ts` — `AgentConfig.permissionStack`.
- `src/observability/vocabulary.ts` — `quanta.permission.stack.*` OTel
  attribute keys (`source`, `verdict`, `action_signature`, `thread_id`,
  `host_id`, `post_denial.event`).

## Naming convention

- **Public**: `evaluateStack` (sync precedence resolver), `getPermissionInspector`
  (read-only programmatic surface).
- **Internal seam**: `runPermissionStack` (in admissibility-gate; wraps
  `evaluateStack` with the gate's `DispatchResult` shape).
- Avoid `consultPermissionStack` / other synonyms — keeps `grep` deterministic.

## Tests

- `tests/unit/permission-per-thread.test.ts` — set/get round-trip, host
  round-trip, precedence ordering, signature 결정성, persistence round-trip,
  corrupt-JSON quarantine.
- `tests/unit/permission-post-denial.test.ts` — 3-step state machine,
  ordering enforcement, (thread, action) 격리, re-denial 리셋.
- `tests/integration/permission-stack-gate-e2e.test.ts` — gate × stack
  end-to-end 8 시나리오 (disabled, per-thread deny, per-host deny,
  precedence inversion, post-denial override, HARD_DENY 우선, no
  sessionId, read-only bypass).
