# RFC — Sandbox-block → escalation-retry loop (`denialReason:"sandbox-blocked"` + HITL escape hatch)

> **Status: ✅ IMPLEMENTED (jun-06)** — Phase 1 (discriminant + classifier +
> `sandbox_blocked` LLMError arm + knobs) LANDED & LIVE-pure; Phase 2 (the
> escalation loop machine) LANDED as a fully-injected, hellgate-proven pure
> orchestrator (`src/agent/sandbox-escalation/`); the bash hot-path *call site*
> is the one deliberate hold (see As-built). Phase 3 (flip `QUANTA_SANDBOX`
> default-ON) is OUT OF SCOPE (separate decision).
> Date: 2026-06-06
> Slice: TOUCH `src/runtime/os-sandbox/*` + `src/permission/post-denial.ts` + `src/tool/bash/*` (new escalation seam)
> Default posture: OFF (byte-identical when the knob is unset)
> Feature axis: sandbox-usability (the missing escape hatch that unlocks a DEFAULT-ON sandbox)

---

## 1. 요약

quanta has a real, multi-backend OS sandbox (Seatbelt / bwrap / native Landlock+seccomp / Windows restricted-token) wired behind `QUANTA_SANDBOX` (`src/apps/cli/sandbox-wire.ts`). It can ENFORCE a policy. What it **cannot** do today is tell the difference between two utterly different outcomes:

1. **The sandbox WORKED and BLOCKED a syscall** — the command ran *inside* an applied sandbox and Seatbelt/Landlock denied (e.g.) a write outside the workspace. The command failed *because the sandbox did its job*. This is a legitimate, recoverable event: the model may genuinely need that write, and the right move is to ask the user "run this unsandboxed?".
2. **A normal command failure** — `grep` found nothing, `npm` errored, a file was missing. Nothing to do with the sandbox.

Codex 0.135 (`core/src/tools/runtimes/shell/unix_escalation.rs`, `with_escalated_permissions: true` + `justification` + `ExecPolicyAmendmentExhausted`) detects case (1) **specifically** and gives the model a clean escape hatch: re-request the SAME command escalated, routed to user approval, run UNSANDBOXED with a model-supplied justification, retries capped. **This is precisely what makes a DEFAULT-ON sandbox usable** — without it, a legitimately-needed blocked command fails opaquely and the agent has no recovery except giving up or hallucinating a workaround.

quanta has NEITHER half: (a) no `denialReason:"sandbox-blocked"` discriminant on `SandboxedSpawnResult` — a sandbox block surfaces as a plain nonzero exit + stderr, byte-indistinguishable from a normal failure; (b) no loop from an OS-sandbox block → escalation prompt — `post-denial.ts` closes the loop only for a *permission-gate* denial, never for an *OS-sandbox* block. This RFC adds both, default-OFF, and is honest about the one genuinely hard part: **the detection heuristic's false-positive risk** (§4.1, §8).

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 Codex 0.135 — `unix_escalation.rs` + `with_escalated_permissions` (verified round-5)

The candidate, restated from the round-5 finding:

- **`with_escalated_permissions: true`** — a *tool-call argument* the model sets to re-request a command it previously saw blocked. The shell tool's input schema carries this flag plus a **`justification`** string the model must supply ("why do I need to run this unsandboxed?").
- **`unix_escalation.rs`** — the Unix-specific path that, when a command runs INSIDE the sandbox and Seatbelt (macOS) / Landlock (Linux) blocks a syscall, detects the **SANDBOX-DENIAL SPECIFICALLY** (distinct from a normal nonzero exit). The signal is platform-specific: Seatbelt denials surface a recognisable failure mode, Landlock/seccomp denials surface `EPERM`/`EACCES` / a SIGSYS-class exit; the runtime correlates "sandbox was applied" + "this failure shape" → "sandbox blocked it".
- On a detected sandbox-denial, the model MAY re-request the same command escalated → the request is **routed to user approval** to run **UNSANDBOXED**, carrying the model's justification.
- **`ExecPolicyAmendmentExhausted`** — a typed cap. Escalation-retries per turn/exec are bounded; once exhausted, no further amendments are accepted (anti-spam: a model cannot loop "escalate → deny → escalate" forever).
- **Security invariant (Codex):** escalation NEVER auto-grants. It is always a *request* routed to the approval surface. Default posture stays deny; the user is the only thing that can flip a specific command to unsandboxed.

**What it actually does (summary):** the sandbox can be DEFAULT-ON because a blocked-but-legitimate command has a *clean, audited, user-gated escape hatch* instead of an opaque failure. The model is told "this was BLOCKED BY THE SANDBOX (not just failed)", it supplies a justification, the user decides, retries are capped. That is the whole feature.

### 2.2 Why this maps cleanly onto quanta's existing seams

quanta already has the three pieces this design composes:

- A typed sandbox result (`SandboxedSpawnResult`, `src/runtime/os-sandbox/types.ts`) with a `sandboxApplied: boolean` flag — the exact precondition the detection heuristic needs (we only call something a "sandbox-block" when `sandboxApplied === true`).
- A post-denial → re-approval precedence machine (`src/permission/post-denial.ts`, ADR-0046) with the `recordDenial → recordRiskSeen → recordUserOverride` 3-step sequence and `hasPostDenialOverride` consumed by the admissibility-gate as the highest-precedence allow signal.
- A 4-tier HITL gate (`src/agent/hitl-tier-registry.ts`, ADR-0047) with an escalate-only ratchet and `hand-off-required` as the last-line boundary.

The escalation loop is "connect the sandbox-block discriminant into post-denial's existing re-approval machine, re-run WITHOUT the sandbox wrapper, capped." No new approval primitive — we reuse the one Codex's "guardian post-denial precedence" already inspired (ADR-0046).

---

## 3. 현재 quanta 상태 (grep-verified) — RE-AUDIT VERDICT: ABSENT

The round-5 finding is confirmed. quanta does **not** detect sandbox-blocks and does **not** offer escalation-retry. Evidence:

### 3.1 `SandboxedSpawnResult` has NO sandbox-block discriminant

`src/runtime/os-sandbox/types.ts:73-82` — the result carries `exitCode`, `stdout`, `stderr`, `sandboxApplied: boolean`, and `degradeReason?: string`. There is **no `denialReason` / `sandboxBlocked` / `blocked` field**. The doc-comment on `degradeReason` is explicit: it is "Reason for **degradation**. Present iff `sandboxApplied===false` …" — i.e. `degradeReason` answers "why could the host NOT enforce the sandbox", the polar opposite of "the sandbox enforced and blocked a syscall". A successfully-applied sandbox that blocks a command returns `sandboxApplied: true` + a nonzero `exitCode` + stderr, and **nothing distinguishes it from a normal command that exited nonzero**.

### 3.2 `llm-error-bridge.ts` fires ONLY on sandbox-DEGRADED, never on sandbox-BLOCK

`src/runtime/os-sandbox/llm-error-bridge.ts` — `isSandboxDegradedFailure(r)` (lines 88-93) returns true **iff `!r.sandboxApplied` AND `degradeReason` present**. The file-level doc spells it out: it fires "whenever a `spawn()` call returns a result with `sandboxApplied: false` AND a non-empty `degradeReason` (i.e. the sandbox was REQUESTED … but the host could not enforce it)" and (lines 47-48) "`sandboxApplied: true` ⇒ **never fires (success)**". So the one bridge that converts a sandbox outcome to a typed `LLMError` is wired to the *couldn't-enforce* case and deliberately treats *enforced-and-blocked* as a plain success result. There is no `sandbox_blocked` LLM-error kind.

### 3.3 `post-denial.ts` closes the loop only for a PERMISSION-GATE denial

`src/permission/post-denial.ts` — the `recordDenial`/`recordRiskSeen`/`recordUserOverride`/`hasPostDenialOverride` machine is keyed on `PostDenialAction = { threadId, tool, workdir, args }` and is invoked from "the gate's deny path" (line 47 doc). It has **no input channel from an OS-sandbox block** — nothing in `src/runtime/os-sandbox/*` calls it, and it has no concept of "re-run this command unsandboxed". It closes the loop from a *permission classifier / admissibility-gate* denial, not from a *Seatbelt/Landlock* block.

### 3.4 No escalation surface anywhere

`grep -rn "escalat|with_escalated|sandbox.denied|sandbox-blocked|sandboxBlocked|denialReason|unsandboxed" src/runtime/ src/permission/ src/tool/bash/ src/apps/cli/`:

- Every `escalat` hit is unrelated: `escalatingKill` (SIGTERM→SIGKILL grace-window in `guarded-spawn.ts`) or *permission-tier* escalation (`classifier.ts`, `hitl-tier-registry.ts` "escalate-only ratchet"). None is a sandbox-block escape hatch.
- The one `denialReason` symbol (`src/runtime/network-allowlist.ts:76`) is a **network-egress** allowlist string builder — unrelated to sandbox spawn.
- `unsandboxed` hits in `src/runtime/shell.ts` describe the *degraded / no-slot-installed* passthrough (the sandbox was never applied), not a deliberate escalation re-run.
- `grep "EPERM|exit-126|126"` over `src/runtime/os-sandbox/` → **zero hits**. No platform-specific block-detection exists.

### 3.5 The call path today (where the gap lives)

- `src/tool/bash/per-call-factory.ts` → `defaultPerCallSandbox(profile)` builds a `PerCallSandboxPort` whose `wrap(argv, cwd)` returns a `WrappedShellArgv` (sandbox-prefixed argv + optional `degradeReason`). The wrapped argv is spawned through `runShell`. The bash tool reads `availability()` to fail-closed on an *unavailable backend*, but once the command runs, a nonzero exit is just a nonzero exit.
- `src/apps/cli/sandbox-wire.ts` resolves `QUANTA_SANDBOX` to a session-wide slot; `wrapLinuxShellArgv` / `wrapShellArgv` set `sandboxApplied: true` when the wrap is built but never inspect the *result* for a block.

**Verdict: BUILD IT.** Both halves — the `sandbox-blocked` discriminant and the escalation-retry loop — are absent. This RFC adds them.

---

## 4. 설계

### 4.1 Detect a sandbox-denial SPECIFICALLY (the hard part — be honest)

Add a discriminated arm to the result. `SandboxedSpawnResult` (`types.ts`) gains:

```ts
export interface SandboxedSpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly sandboxApplied: boolean
  readonly degradeReason?: string          // unchanged — "couldn't enforce"
  /** NEW. Present iff `sandboxApplied === true` AND the heuristic
   *  classified this nonzero exit as an OS-sandbox SYSCALL DENIAL (vs a
   *  normal command failure). Mutually informative with degradeReason —
   *  `degradeReason` = "sandbox didn't run"; `denialReason` = "sandbox ran
   *  AND blocked something". The two are never both present. */
  readonly denialReason?: SandboxDenial
}

export interface SandboxDenial {
  readonly kind: "sandbox-blocked"
  /** Best-effort, platform-specific signal that triggered the classification
   *  — for the justification prompt + OTel, NEVER for an auto-grant. */
  readonly signal: "seatbelt-deny" | "landlock-eperm" | "seccomp-sigsys" | "exit-126" | "heuristic"
  /** The confidence tier (see below). Low-confidence is surfaced to the
   *  user as a *suggestion* ("this MIGHT be a sandbox block") — never a
   *  silent escalation. */
  readonly confidence: "high" | "low"
}
```

**The detection heuristic, per platform — and its honest false-positive risk.** This is the genuinely hard part. There is NO universal "the sandbox blocked me" exit code; a command that legitimately fails with `EPERM` for non-sandbox reasons (e.g. `chmod` on a root-owned file, a real permission error unrelated to the jail) looks identical at the exitCode level. We therefore gate EVERY detection on `sandboxApplied === true` and split into **high-** and **low-confidence** tiers, and we NEVER auto-act on a detection — it only ever *offers* an escalation prompt the user must approve (§4.3). False-positive cost is therefore bounded to "the user is occasionally asked an escalation question they could just decline" — never a silent unsandboxed run.

- **macOS / Seatbelt (high-confidence when present).** `sandbox-exec` writes a recognisable diagnostic to stderr on a policy denial (`deny … `, `Sandbox: … deny(1) …`, the operation name like `file-write-data`). When `sandboxApplied === true` AND stderr matches the Seatbelt-deny shape, classify `signal:"seatbelt-deny", confidence:"high"`. This is a deliberate, narrow stderr match — NOT a generic "stderr contains 'denied'" (which would catch app-level errors). False-positive risk: a *command* that itself prints a Seatbelt-style line to stderr. Mitigated by requiring the exact `sandbox-exec`/kernel prefix, not a substring.
- **Linux / Landlock+seccomp (mixed).** Landlock denials surface as `EPERM`/`EACCES` on the blocked filesystem op; a seccomp `strict`-mode kill surfaces as a SIGSYS-class termination (exit code 128+`SIGSYS`). When `sandboxApplied === true` AND (exit indicates SIGSYS) → `signal:"seccomp-sigsys", confidence:"high"` (a SIGSYS under our seccomp filter is unambiguously the sandbox). When `sandboxApplied === true` AND exit==126 (shell "cannot execute" — a denied `process-exec`) → `signal:"exit-126", confidence:"high"`. A bare `EPERM` in stderr with a normal nonzero exit → `signal:"landlock-eperm", confidence:"low"` — **explicitly low-confidence**, because a real non-sandbox `EPERM` is indistinguishable. Low-confidence is surfaced as a *suggestion* the user can decline, never an auto-escalation.
- **bwrap (Phase-2 external).** bwrap reports setup failures distinctly (its own stderr prefix); an in-sandbox FS denial is the same `EPERM`/`exit-126` story → same `confidence:"low"`/`high` split as Landlock.
- **Windows restricted-token (ADR-0441).** Access-denied surfaces as `ERROR_ACCESS_DENIED` (exit 5) under the restricted token → `signal:"heuristic", confidence:"low"`.
- **Default / unrecognised:** no `denialReason` emitted (a nonzero exit with no recognised block-signal is treated as a plain command failure — the safe default; we under-detect rather than over-escalate).

The classifier is a **pure function** `classifySandboxDenial(result, backend): SandboxDenial | undefined` in a new `src/runtime/os-sandbox/denial-classify.ts`, fully hellgate-tested (§6), with the false-positive guard as a first-class test (a normal `EPERM` failure with `sandboxApplied:true` but no high-confidence signal MUST NOT be classified high, and a `sandboxApplied:false` result MUST NEVER be classified at all).

### 4.2 Surface the block as a typed signal (mirror the existing bridge)

Extend the existing `llm-error-bridge.ts` discipline with a SIBLING converter (NOT a reuse of `isSandboxDegradedFailure`, which is the opposite case). A new pure `sandboxBlockToLlmError(r)` builds `new LLMError("sandbox blocked …", { kind: "sandbox_blocked", cause: { result } })` — a NEW `LLMErrorKind` arm (`sandbox_blocked`, distinct from the existing `sandbox_error` = degraded). The recovery router can route `sandbox_blocked` to the escalation prompt (vs `sandbox_error` → `hitl_handoff` for "inspect the host"). Default-OFF: emitted only when the escalation knob is on; OFF ⇒ the block is just a nonzero result, byte-identical to today.

### 4.3 The escalation loop (reuse `post-denial.ts`, run UNSANDBOXED through the gate)

When a `denialReason:"sandbox-blocked"` reaches the bash tool's result handling AND the escalation knob is on:

1. **Record the block as a denial.** Call `recordDenial({ threadId, tool:"bash", workdir, args }, "sandbox-blocked: <signal>", { store })` — the SAME post-denial store the admissibility-gate already consults. This seeds the 3-step re-approval sequence (ADR-0046) for THIS exact `(threadId, actionSignature)`.
2. **Tell the model it was a SANDBOX block (not a generic fail).** The tool result carries a structured field: `{ blockedBySandbox: true, signal, confidence }` + a human line ("command X was blocked by the OS sandbox; to run it unsandboxed, re-request with `escalate: true` and a `justification`"). The model SEES this is recoverable.
3. **Model re-requests escalated.** The bash tool input schema gains `escalate?: boolean` + `justification?: string` (mirrors Codex `with_escalated_permissions` + `justification`). On `escalate:true`:
   - `recordRiskSeen(action, { store })` is fired when the UI/HITL surface shows the user the concrete risk ("this command was sandboxed-blocked; running it unsandboxed grants it FS/network access outside the workspace: <justification>").
   - The escalation request is routed through the **normal permission gate + HITL 4-tier** (`hitl-tier-registry.ts`). Escalation does NOT bypass the gate — it is a request like any other, and the gate may itself classify it `hand-off-required` (last-line boundary, cannot be downgraded).
   - On user approve → `recordUserOverride(action, { store })`; `hasPostDenialOverride` now returns true for this exact `(threadId, actionSignature)`; the bash tool **re-runs the SAME command WITHOUT the sandbox wrapper** (profile forced `off` for this one call — through `runShell` with no per-call sandbox, NOT a session-wide flip).
   - On user deny → no override recorded; the command stays blocked; the result tells the model "escalation denied".
4. **Same command only.** The override is keyed on `computeActionSignature({ tool, workdir, args })` (already in `post-denial.ts`). An escalation approval for command X does NOT carry to command Y — the unsandboxed re-run is the byte-same argv that was blocked.

**Security invariant (the whole point):** escalation NEVER auto-grants. The `recordRiskSeen` BEFORE `recordUserOverride` ordering (enforced by the store via timestamps, ADR-0046 §Risks) is exactly what stops a malicious prompt from fabricating an override. Default-deny posture: absent a complete, ordered, user-driven 3-step sequence, `hasPostDenialOverride` is false and the command stays sandboxed. The model's `justification` is *input to the human decision*, never a grant.

### 4.4 Amendment cap (`ExecPolicyAmendmentExhausted` analog)

A per-turn escalation-retry counter, keyed `(threadId, turnId)`, capped at `QUANTA_SANDBOX_ESCALATION_MAX` (default e.g. 3). Each `escalate:true` request increments it BEFORE routing to the user. Past the cap, the tool returns a typed `escalation-exhausted` result (analog of `ExecPolicyAmendmentExhausted`) and refuses to fire another prompt — the model cannot spam "escalate → deny → escalate". The counter lives in a small `src/agent/sandbox-escalation/cap.ts` (pure, injectable clock/store; resets per turn). This is a SEPARATE cap from the loop-breaker — it bounds *escalation requests*, not tool calls.

### 4.5 Composition with existing precedence

The escalation override is just the existing post-denial override, so it slots into the admissibility-gate's documented precedence (`admissibility-gate.ts:1827`): "post-denial override → per-thread → per-host → fall through." A sandbox escalation that the user approved is the HIGHEST-precedence allow for that one `(thread, action)` — identical to a user re-approving a classifier-denied action. No new precedence rule; the sandbox-block simply becomes a new *source* of a post-denial denial record.

---

## 5. 통합

### 5.1 Config knob (default-OFF, byte-identical)

- `sandboxEscalation: boolean` on `RuntimeConfig`, parsed `env["QUANTA_SANDBOX_ESCALATION"] === "1"` (strict, mirroring `imageGen`). Default `false`.
- `sandboxEscalationMax: number` (`QUANTA_SANDBOX_ESCALATION_MAX`, default 3) — the amendment cap.
- **OFF ⇒** `classifySandboxDenial` is never consulted (no `denialReason` ever set), `sandboxBlockToLlmError` never wired, the bash tool's `escalate`/`justification` inputs are inert, post-denial sees no sandbox-sourced records. A nonzero exit from a sandboxed command is byte-identical to today (plain failure). Proven by an OFF hellgate case (a sandbox-blocked command with the knob off → NO `denialReason`, NO escalation prompt, identical `ToolResult`).

### 5.2 Tool input + surface manifest

- `src/tool/bash/*` input schema gains optional `escalate?: boolean` + `justification?: string` (default absent ⇒ no escalation). Gated on `sandboxEscalation`; when off, the fields are stripped/ignored (no behavior change). The bash tool's `hitlTier` for an `escalate:true` call is annotated at MINIMUM `always-confirm` (never `pre-approval-ok`) — an unsandboxed re-run always confronts the user.
- No NEW model-facing tool (escalation is an argument on the existing `bash`, exactly as Codex puts `with_escalated_permissions` on its shell tool). The tool-surface manifest gets a note on the gated `escalate` field, not a new BASE/GATED tool row.

### 5.3 Feature-catalog entry

Add `tools/feature-catalog/features/0X-runtime/sandbox-escalation.yaml`: `subsystem: OS sandbox usability`, `maturity: L2` (seam) → `L3` once the bash re-run path is wired, `labels:[surface:cli, category:sandbox, security, default-off]`, `depends_on:[os-sandbox, post-denial-precedence, hitl-tier-registry]`, `config_refs.env:[QUANTA_SANDBOX_ESCALATION, QUANTA_SANDBOX_ESCALATION_MAX]`, evidence.code listing the new + touched files.

### 5.4 OTel / audit

The `justification` and the escalation decision are logged via the existing post-denial recorder (`emitPostDenialEvent`, `src/permission/recorder.ts`) extended with a `decidedBy:"sandbox-escalation"` source + a `sandbox.escalation.*` OTel span (mirrors the `codex.tool.*` attribute vocabulary). SECURITY: per the existing recorder discipline (`post-denial.ts:65-68`), only the hashed `actionSignature` + the *decision* reach the metric layer; the free-form `justification` goes to the AUDIT log only (it may quote the offending command), never to telemetry funnels.

---

## 6. 테스트 계획

### 6.1 Hellgate (adversarial) — `tests/unit/sandbox-escalation-hellgate.test.ts`

- **Discriminant — block vs degrade vs normal:**
  - `sandboxApplied:true` + Seatbelt-deny stderr → `denialReason:{signal:"seatbelt-deny", confidence:"high"}`, NO `degradeReason`.
  - `sandboxApplied:true` + SIGSYS exit → `seccomp-sigsys, high`.
  - `sandboxApplied:true` + exit-126 → `exit-126, high`.
  - `sandboxApplied:false` + `degradeReason` set → `denialReason` ABSENT (degrade, not block — the two are mutually exclusive).
- **FALSE-POSITIVE GUARD (the hardest case):** `sandboxApplied:true` + a normal `EPERM` in stderr from a non-sandbox cause (e.g. `chmod` on a root file) with NO high-confidence signal → classified `confidence:"low"` (a SUGGESTION) or NOT classified — MUST NOT auto-escalate, MUST NOT be `high`. A `sandboxApplied:false` result MUST NEVER be classified as a block regardless of stderr content (a command that itself prints "Sandbox: deny" must not be mis-detected when the sandbox wasn't even applied).
- **Escalation loop:** sandbox-blocked → `recordDenial` seeded → model `escalate:true` + `justification` → `recordRiskSeen` → user APPROVE → `recordUserOverride` → `hasPostDenialOverride` true → command re-runs UNSANDBOXED (assert the re-run argv has NO sandbox prefix) → still passes through the gate (assert the gate was consulted, not bypassed).
- **Deny path:** model `escalate:true` → user DENY → no `recordUserOverride` → `hasPostDenialOverride` false → command stays blocked, NO unsandboxed re-run.
- **Same-command only:** approve escalation for command X → command Y (different argv) does NOT inherit the override (different `actionSignature`).
- **Cap exhaustion (`ExecPolicyAmendmentExhausted` analog):** `escalate:true` past `QUANTA_SANDBOX_ESCALATION_MAX` within one turn → typed `escalation-exhausted`, NO further prompt fired; counter resets next turn.
- **NEVER-auto invariant:** an `escalate:true` with a fabricated/missing risk-seen step (out-of-order: override before risk-seen) → `hasPostDenialOverride` stays false (ADR-0046 ordering holds for the sandbox source too).
- **Justification logged, not leaked:** justification reaches the AUDIT recorder; the OTel/metric funnel receives only the hashed signature + decision (assert the free-form string never hits the metric emit).
- **Determinism:** injected clock; no `Date.now()`/`Math.random()` in prose or impl.

### 6.2 OFF byte-identical — same file

- `QUANTA_SANDBOX_ESCALATION` unset: a sandbox-blocked command produces the IDENTICAL `ToolResult` as a plain nonzero exit (no `denialReason`, no escalation field, no post-denial record, no prompt). The classifier is never invoked.

---

## 7. 단계

- **Phase 1 — discriminant seam (default-OFF).** `src/runtime/os-sandbox/denial-classify.ts` (`classifySandboxDenial` pure fn + `SandboxDenial` type), `denialReason` field on `SandboxedSpawnResult`, `sandboxBlockToLlmError` + `sandbox_blocked` `LLMErrorKind` arm, runtime-config knobs, hellgate §6.1 discriminant + false-positive cases, feature-catalog yaml. NO bash change, NO escalation prompt. Pure detection, fully tested in isolation. The platform classifiers are wired into the existing result-mapping points (`mapNapiResult` in `landlock-native.ts`, the Seatbelt result path, `wrapLinuxShellArgv`) so each backend can SET `denialReason` — but only when the knob is on.
- **Phase 2 — the loop.** Bash input `escalate`/`justification`; wire `denialReason` → `recordDenial` → HITL prompt → `recordRiskSeen`/`recordUserOverride` → unsandboxed re-run through the gate; the per-turn amendment cap (`src/agent/sandbox-escalation/cap.ts`); hellgate §6.1 loop/deny/cap/never-auto cases. This is the hot-path surgery — one bash-tool-result branch — so it lands behind the knob and is regression-verified against the existing bash tests.
- **Phase 3 — flip the default.** Once Phase 1+2 are proven, the escape hatch exists, so `QUANTA_SANDBOX` can move toward a SAFE default-ON posture (a blocked-but-legitimate command now recovers via escalation instead of failing opaquely). This is a SEPARATE decision/RFC — this RFC only builds the *prerequisite*. Default-ON is NOT flipped here.

---

## 8. 리스크 / 대안 / 비결정

- **Detection false-positive — the hardest part, stated honestly.** There is no portable "the sandbox blocked me" exit code. A real non-sandbox `EPERM`/`EACCES` (a genuine permission error unrelated to the jail) is byte-identical to a Landlock FS denial at the exitCode level. Our mitigation is layered, not magic: (a) NEVER classify unless `sandboxApplied === true` (a degraded/unapplied sandbox can never produce a "block"); (b) split high-confidence (SIGSYS under our seccomp filter, exit-126 denied-exec, the exact Seatbelt-deny kernel/`sandbox-exec` stderr prefix — these are unambiguous) from low-confidence (a bare `EPERM` — which we surface as a *suggestion the user can decline*, never an auto-escalation); (c) **under-detect rather than over-escalate** — an unrecognised nonzero exit is treated as a plain failure (no prompt). The residual cost of a false-positive is bounded to "the user is occasionally offered an escalation question they decline" — NEVER a silent unsandboxed run, because §4.3's NEVER-auto invariant routes every escalation through the user. The Seatbelt stderr match is the riskiest signal (a command could print a Seatbelt-shaped line itself); mitigated by requiring the exact kernel/`sandbox-exec` prefix, not a substring, and by `confidence:"high"` still requiring user approval to act.
- **Why reuse `post-denial.ts` rather than a new approval primitive.** post-denial already encodes the EXACT security property we need — a 3-step, timestamp-ordered, per-`(thread, action)` re-approval that a malicious prompt cannot fabricate (ADR-0046 §Risks). A sandbox-block is just a NEW *source* of a denial record; the re-approval machine is identical to a classifier denial the user overrides. Building a parallel "sandbox approval" primitive would duplicate the ordering invariant and risk diverging from it. The only addition is the unsandboxed *re-run* mechanic (force profile `off` for one call) — which is a bash-tool concern, not an approval-machine concern.
- **Unsandboxed re-run scope.** The re-run drops the sandbox for ONE call (the byte-same blocked argv, keyed on `actionSignature`), NOT the session. A session-wide flip would be a far larger blast radius. Risk: the re-run command spawns children that are also unsandboxed — accepted, because that is exactly what "run this unsandboxed" means and the user approved THIS command after seeing the risk. The override does NOT persist past the turn (post-denial records are per-thread but the bash re-run consults `hasPostDenialOverride` only for the immediate retry).
- **Cap value (3) is a guess.** Per the no-heuristics discipline, `QUANTA_SANDBOX_ESCALATION_MAX` is a KNOB, not a baked constant; default 3 mirrors a "two retries then stop" posture but is operator-tunable. Risk: too low frustrates a legitimate multi-step escalation; too high re-opens spam. Tunable, measured before any change.
- **Low-confidence UX.** Surfacing a `confidence:"low"` `EPERM` as "this MIGHT be a sandbox block — escalate?" risks prompt-fatigue (false positives the user keeps declining). Mitigation: low-confidence suggestions can be globally suppressed via a sub-knob (`QUANTA_SANDBOX_ESCALATION_LOW_CONF=0`), defaulting to ON only because under-detecting a real block is the worse failure for a default-ON sandbox. Revisit with real corpus data.
- **Default-ON flip is explicitly OUT of scope.** This RFC builds the escape hatch (the prerequisite). Whether/when to flip `QUANTA_SANDBOX` to default-ON is a separate decision gated on Phase 1+2 being proven AND a corpus measurement of false-positive rate — NOT decided here.

---

## 9. 코드 위치 요약

**Create:**
- `src/runtime/os-sandbox/denial-classify.ts` — `classifySandboxDenial(result, backend): SandboxDenial | undefined` (pure, per-platform high/low-confidence heuristic) + `SandboxDenial` type.
- `src/agent/sandbox-escalation/cap.ts` (Phase 2) — per-turn escalation-retry counter (`ExecPolicyAmendmentExhausted` analog), injectable clock/store.
- `tools/feature-catalog/features/0X-runtime/sandbox-escalation.yaml`.
- `tests/unit/sandbox-escalation-hellgate.test.ts`.

**Touch:**
- `src/runtime/os-sandbox/types.ts` — add `denialReason?: SandboxDenial` to `SandboxedSpawnResult` (mutually exclusive with `degradeReason`).
- `src/runtime/os-sandbox/llm-error-bridge.ts` — add `sandboxBlockToLlmError` + `sandbox_blocked` `LLMErrorKind` arm (sibling to the existing degrade path; default-OFF emit).
- `src/runtime/os-sandbox/{seatbelt,landlock-native}.ts` + `src/apps/cli/sandbox-wire.ts` (`wrapLinuxShellArgv`) — set `denialReason` from `classifySandboxDenial` at the result-mapping points (gated).
- `src/permission/post-denial.ts` + `src/permission/recorder.ts` — accept a `"sandbox-escalation"` denial source (`decidedBy`); audit-only justification.
- `src/tool/bash/*` (Phase 2) — `escalate?`/`justification?` inputs; block→`recordDenial`→prompt→re-run-unsandboxed-through-gate; `always-confirm` tier annotation for `escalate:true`; cap enforcement.
- `src/shared/runtime-config.ts` — `sandboxEscalation` / `sandboxEscalationMax` (+ env parse).
- `src/tool/surface/manifest.ts` — gated `escalate` field note + drift-guard update.
