# GOAL-03 — Read-only verifier runtime and source-evidence reconciliation


> **구현 대조 (2026-08-30, 코드 확인)** — 이 티켓의 **읽기전용 실행 계약 절반이 미구현**이다.
> - `maybeWireObjectiveVerifier`(`src/host/runtime/objective-verifier-wire.ts`)가 `perCallWrap` 없이 runner를 만든다 ⇒ `wrapSandboxArgv`가 통과되어 **샌드박스 없이 spawn**. readable-root allowlist / network deny / 격리 temp / CPU·메모리·fan-out·출력 바이트 캡 전부 없음(벽시계 타임아웃만).
> - 소스 쓰기는 **차단이 아니라 사후 감지**다(`settleRun`의 digest 비교). 실제로 `tests/integration/objective-verifier-real-command-e2e.test.ts`의 변조 커맨드는 성공한다.
> - receipt는 명세한 필드를 commit에서 버린다 — 남는 건 `source/objectiveId/checkId/objectiveRevision/sourceDigest/{exitCode,passed}/verifiedAt`뿐(`src/objective/criteria/model.ts`). `posture` 없음.
> - `sandbox-unavailable`은 `criteria/ports.ts`에 어휘로만 있고 이 경로에서 emit되지 않는다. `/goal stale` 서브커맨드 없음. attempt당 1회 검증 게이트 없음. `freshness-unresolved`는 fail-closed가 아니라 반대로 코딩돼 있다(`objective-settlement.ts`).
> - 이름 변화: `completion-ops`가 아니라 `authority.ts`가 batch를 검증/적용 · 모델 도구는 `objective_verify` · non-git 초과는 `cap-exceeded`.
> - RED 4/12/13/15와 E2E 3번은 존재하지 않는 동작을 기술한다. rail 15 테스트는 제목만 그렇고 본문은 HITL 경로를 만들지 않는다.

**Priority:** P0 · **Depends on:** GOAL-02 · **Owner:** verifier host adapter

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-03.yaml

## Purpose

Execute only immutable stored checks, derive pass/fail from process results, and prevent stale or source-modifying verification from completing a goal.

## Port and owner split

- src/objective/criteria/ports.ts defines ObjectiveCheckRunner, WorkspaceEvidencePort, VerificationBatch, and result types. It imports no runtime/tool slice.
- New src/runtime/run-argv.ts is the common argv-level composition core extracted from existing guarded-spawn.ts, scrubbed-spawn.ts, process-tree.ts, and os-sandbox helpers. It does not duplicate their policy.
- Existing src/runtime/shell.ts delegates to runArgv(["bash","-lc",command]) and retains paired behavior. Extracting is mandatory because shell.ts is near the 900-line cohort ceiling.
- New src/host/runtime/objective-verifier-wire.ts owns workspace resolution, evidence capture, check scheduling, and authority commit.
- src/objective/core-store/completion-ops.ts validates and applies a batch. It does not execute processes or inspect the filesystem.

## Read-only execution contract

- cwd is the session-owned workspace, never model/check input.
- argv is passed as exact elements; no join, shell interpolation, or implicit shell.
- inheritEnv is false; allow only the existing scrubbed environment contract.
- Readable roots are limited to the workspace plus an explicit immutable runtime/toolchain dependency allowlist. Home, credential, socket, and unrelated filesystem reads are denied.
- Network is denied by default.
- Default posture is workspace-write with before/after source-digest invariance (README 결정 기록). A check may write build/test caches inside the workspace; if the canonical manifest digest changes, the batch yields zero receipts and stale-source. Read-only mount is an opt-in stricter profile, never the only path. Temp/cache/output writes outside the workspace are limited to an isolated verifier directory with byte/file-count caps.
- Apply wall-clock, CPU, memory, process/fan-out, open-file, output-byte, temp-byte, and batch limits through existing runtime sandbox/process owners.
- If the platform cannot enforce the read-only boundary, verification fails closed as sandbox-unavailable.
- A check that changes the canonical manifest (tracked/untracked non-ignored files), escapes via symlink/parent traversal outside the workspace, or requests sandbox escalation emits no completion receipt. Ignored paths (`.gitignore`d caches) are outside the manifest by construction.
- There is no unsandboxed verifier fallback. HITL may run an explicitly described weaker diagnostic, but a weaker posture can never mint a trusted completion receipt; receipt posture is recorded and authority admits only the strict verifier profile.

## Evidence contract

For Git workspaces, hash a versioned canonical stream containing:

- HEAD identity
- tracked and untracked non-ignored paths from NUL-delimited Git output
- path length/path bytes, file mode, object kind, symlink target, content digest, and content length
- check-definition digest and verifier/runner version

For non-Git workspaces, WorkspaceEvidencePort builds the same bounded manifest over the configured workspace root with explicit ignore rules. It has maximum file-count and byte-count limits; overflow is source-unavailable. It must not silently reuse validation-contract-missing.

Verification result/receipt stores exit code, timeout flag, duration, stdout/stderr digest and byte length, source digest, check digest, runner version, and capture time. Raw output is never persisted.

## Coordinator

ObjectiveVerificationCoordinator has verify(threadId, criterionIds?) and reconcile(threadId):

1. Read objective and capture before digest.
2. Select immutable stored checked criteria only.
3. Run sequentially with MAX_CHECKS_PER_BATCH=32, per-check timeout <= 10 minutes, and overall batch deadline <= 15 minutes.
4. Capture after digest.
5. On digest mismatch, source write attempt, cancellation, cap, or unavailable sandbox/evidence: emit no passing receipts and use VerifierCommitPort to invalidate the exact objectiveId + check/receipt identities observed.
6. On stable evidence, submit one applyVerificationBatch commit with objectiveId and expectedRevision.
7. Authority recomputes passed from timeout, exit code, and immutable successExitCodes. Any supplied passed field is ignored/rejected.
8. Invalidation uses expected revision and bounded reread/retry. If a concurrent mutation keeps winning, return freshness-unresolved; status/wake/final persistence fail closed until a later reconcile succeeds.

reconcile runs a cheap precheck first (HEAD identity + `git status --porcelain -z` digest); only when the precheck differs from the last full manifest's precheck does it rehash the full manifest.

Do not project current source state from synchronous readDomain. Reconcile at explicit host boundaries: before /goal status or verify, before wake eligibility, after restore, and before final settlement persistence. The cached snapshot may say verification-unknown; it may not claim freshness without reconciliation.

Model requestVerification is a tool action that invokes the coordinator. It is not an ObjectiveMutation policy row. The host allows one verification request per attributed attempt and returns already-verified-this-attempt thereafter.

## RED rails

1. Forged passed:true with exit 1 cannot mark a criterion met.
2. Wrong objectiveId/checkId/criterionId or stale revision rejects the whole batch.
3. Before/after source digest mismatch yields zero passing receipts and stale state.
4. A source write attempt is blocked before damage; source bytes remain unchanged.
5. Editing one file after success becomes stale at the next reconcile and removes completed projection.
6. User/model applyVerificationBatch is denied.
7. runShell and runArgv paired shell invocation have identical argv/env/sandbox behavior.
8. Spaces, quotes, semicolons, and Unicode remain one argv element.
9. Timeout/abort kills the process group and cannot leave a child running.
10. Git symlink/untracked/mode changes alter digest deterministically.
11. Non-Git manifest is deterministic; cap overflow returns source-unavailable.
12. A missing real runArgv call, empty manifest scan, or removed read-only wrapper turns its static/runtime guard red.
13. Outside-workspace credential read, network connect, process fan-out, and temp-volume exhaustion fail with zero trusted receipts.
14. Revision changes between after-digest and invalidation commit trigger reread/retry; repeated contention yields freshness-unresolved and wake 0.
15. A HITL weaker diagnostic cannot be accepted as verifier completion evidence.

## E2E

- Real Git workspace: exit 0 completes; exit 1 remains active; timeout remains active.
- Concurrent source edit returns stale-source and no receipt.
- Source-modifying command is denied and source tree is byte-identical.
- Non-Git workspace verifies under bounds and fails closed over bounds.
- PTY uses /goal check add ... -- argv, /goal verify, then source modification and /goal stale rendering.

## Verification

    bun test tests/unit/runtime tests/unit/objective tests/unit/host/objective-verifier-wire.test.ts
    bun test tests/unit/objective-slice-boundary.test.ts tests/unit/_arch
    bun test tests/integration/objective-verifier-real-command-e2e.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Verification needs a writable source tree or an unsandboxed fallback.
- Freshness is asserted from an old synchronous snapshot.
- A non-Git directory is unboundedly traversed.
- Raw process output enters session/objective persistence.
