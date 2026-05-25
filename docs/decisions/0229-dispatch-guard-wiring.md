# ADR-0229: Dispatch Guard wiring — single port over 3 already-shipped detectors

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0086 (`gitWriteProtectReason` — git-write protect detector,
  shipped at `src/permission/git-write-guard.ts`), ADR for ci-bot (`decideBranchOnly`
  + `isHostAllowed` shipped at `src/permission/branch-only.ts` and
  `src/runtime/network-allowlist.ts`), ADR-0091 (git-write protection L3 wire —
  this slice is the dispatch-seam follow-up that ADR-0091 §"Wiring is a
  documented follow-up" deferred).
- **References**: `src/agent/dispatch-guard/**`,
  `tests/unit/agent/dispatch-guard-hellgate.test.ts`,
  `src/agent/dispatch.ts` (single 3-line wire site)

## Context

Three pure detectors already live in the repo and have full test batteries,
but are not consulted at dispatch time outside narrow caller-specific paths:

- `gitWriteProtectReason(path)` — `git_hooks` / `git_hooks_dir` / `git_config`
  / `git_attributes` / `editor_config` escape vectors. Wired into
  `ToolContext.gitWriteGuard` for `write`/`edit` tools only; never consulted
  at the dispatch seam for bash / shell / patch tools.
- `decideBranchOnly(cmd, protected, currentBranch)` — denies pushes to
  protected branches, commits on protected branches, etc. Wired only inside
  `ci-bot-policy.ts` mode preset.
- `isHostAllowed(urlOrHost, allowlist)` — propositional outbound host check
  for the ci-bot `network: allowlist` lever. Wired only inside
  `ci-bot-policy.ts`.

Cursor (3.2.16 audit, `cursor-3.2-absorption` memory) actively consults the
analogous primitives at every tool dispatch via a single guard port. Our
detectors are SOTA-quality but inert outside opt-in surfaces — an S-tier
audit gap.

## Decision

Add a **plane-clean leaf slice** at `src/agent/dispatch-guard/` exposing one
closed port that wraps all three detectors with conservative composition:

```ts
type GuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; hardDeny: boolean }
  | { kind: "ask";  reason: string }

interface DispatchGuard {
  check(tool: string, input: unknown): GuardDecision
}
```

- **`defaultDispatchGuard({ protectedBranches?, networkAllowlist?, currentBranch? })`**
  — consults all three detectors and composes the result with **most-conservative
  wins** ordering: `deny` > `ask` > `allow`. `hardDeny` is `true` whenever a
  deny was produced by `gitWriteProtectReason` or `isHostAllowed`.
- **`noOpDispatchGuard`** — frozen `{ check: () => ({ kind: "allow" }) }`, the
  default when no guard is wired (byte-identical to the pre-ADR path).
- Detectors keep their existing signatures and test batteries unchanged. The
  guard is a **sibling composer**, not a replacement (closed-port keep).

### Wire site (single)

`src/agent/dispatch.ts` runs `config.dispatchGuard?.check(call.name, call.input)`
as one of the dispatch pre-flights (sibling to `consultDedupGate` /
`consultLocalizePhase`), BEFORE `runAdmissibilityGate`:

- `deny` with `hardDeny:true` → terminal `deny(call.id, reason, "guard-deny")`
  short-circuit (mirrors the existing HARD_DENY phrasing — no retry).
- `deny` with `hardDeny:false` → terminal `deny(call.id, reason, "guard-deny")`
  (denied, but classified as recoverable for downstream consumers).
- `ask` → terminal `deny(call.id, reason, "guard-ask")` when no HITL is
  wired (conservative); HITL queue routing is deliberately deferred to a
  follow-up so this ADR does not duplicate `runHitlGate` plumbing.
- `allow` → fall through to existing pre-flights + admissibility gate
  (byte-identical to today).

Default-OFF preserved: `config.dispatchGuard` absent ⇒ a single optional-chain
check on a possibly-undefined value, no allocation. Byte-identical to the
pre-ADR dispatch path.

### Detector composition rules

Per-detector input adapter:

- **gitWriteProtectReason** runs on the tool's *target path* when it can be
  derived: `input.path` / `input.file_path` / `input.target` / `input.file` /
  patch-tool `input.patch` parsed for `*** Update File:`/`*** Add File:` is
  out-of-scope for v1 (we only consult the obvious string fields). A null
  return ⇒ no contribution.
- **decideBranchOnly** runs on the tool's *shell command* when one exists:
  `input.command` / `input.cmd` for shell-class tools. `allowed:true` ⇒ no
  contribution; `allowed:false` ⇒ `{ kind: "deny", hardDeny: false }`.
- **isHostAllowed** runs on `input.url` / `input.host` / `input.target_url`
  when present AND when a `networkAllowlist` was supplied. `true` ⇒ no
  contribution; `false` ⇒ `{ kind: "deny", hardDeny: true }`.

Composer truth-table (3 detectors × 3 outcomes): `deny` wins over `ask` wins
over `allow`. `hardDeny` rides along on the winning deny.

## Consequences

- **Default-OFF / byte-identical** — `dispatchGuard` absent ⇒ zero behavior
  change; no allocation. All existing tests stay green.
- **Closed-port preserved** — the three detectors keep their existing
  signatures; nothing imports their concrete sites except this composer.
- **ADR-0091 follow-up closed** — `gitWriteProtectReason` is now reachable
  from the dispatch seam for ALL tools (not just `write`/`edit`), so a
  `bash` call to `chmod` `.git/hooks/pre-commit` (or a `patch` overwriting
  `.git/config`) is denied uniformly.
- **Cursor parity** — the comparison matrix (`agent-loop-4way-comparison`)
  shows Cursor consulting its sandbox sibling at every dispatch; we now
  match that posture WHEN OPTED IN, without losing our "Default-NO-git"
  invariant (ADR-0099).
- **Deferred** — HITL routing of `ask` decisions is a follow-up; this ADR
  keeps the deferral honest by collapsing `ask` to a deny short-circuit
  with a `"guard-ask"` preview tag (so a future ADR can recognise + reroute
  the tag without surface changes).

## Negative invariants (hellgate-locked)

- HELL-DG-01: no-op guard ⇒ every tool `allow`.
- HELL-DG-08: `config.dispatchGuard` absent ⇒ dispatch byte-identical.
- HELL-DG-09: `deny + hardDeny:true` ⇒ no retry seam attempted (terminal
  short-circuit, preview tag `"guard-deny"`).
- HELL-DG-11: `check` is pure — no I/O, no mutation, deterministic across N
  invocations.
