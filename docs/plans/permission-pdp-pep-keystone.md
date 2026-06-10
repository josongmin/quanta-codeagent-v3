# Permission PDP/PEP keystone — design ticket (P2-T3)

Status: **DESIGN** (not implemented — security-core refactor, behavior-e2e-driven, do when the area is quiet)
Origin: `docs/audits/jun-10-permission-architecture-audit.md` §7 + jun-10 Phase-2 work.

## Why this exists

The jun-10 audit found the structural root cause behind the web-bypass hole: the
permission decision is **assembled per-surface (opt-in)**, the decision logic
lives in **two paths** (`evaluate` ⊥ `runAdmissibilityGate`), and the
tool↔permission relationship is **code-inferred** (`inferToolTier`) rather than
declared. Symptoms keep recurring because "a surface that doesn't wire the gate"
defaults to **allow**, not deny.

Two Phase-2 tickets LANDED on top of the existing gate without this refactor:

- **P2-T2 (A3) ✅** — `hand-off-required` pulled to HARD_DENY-level precedence
  (`runHandoffFloorGate`, before pattern-grant + rules DSL). No operator grant /
  rule can unlock the hardest tier. Universal, telemetry-preserving.
- **hand-off-required universal floor ✅** (jun-10 keystone) — enforced on every
  surface regardless of the `hitl.enabled` opt-in.

One ticket is **BLOCKED** and is the reason this redesign is needed:

- **P2-T1 (always-confirm secure-by-default) 🔴 BLOCKED** — universalizing
  `always-confirm` at the gate level breaks ~89 integration tests because **`bash`
  without a sandbox profile self-reports `always-confirm` for ALL commands**. The
  tier cannot distinguish that "needs-sandbox" signal from an **inherently
  sensitive** tool (git push, deploy). See
  `tests/integration/always-confirm-secure-by-default-e2e.test.ts` (skipped).

That conflation is exactly what a declarative capability layer fixes.

## The design (PDP / PEP)

**Separate decision from enforcement** (OPA/XACML/Zanzibar shape):

1. **PDP — pure decision engine.** `decide(action, ctx, policy) → Decision`. Zero
   IO, zero surface coupling. The SSOT. Exposes BOTH a sync `decide()` (for the
   `/permission explain` inspector + the mode matrix — no reviewer obligations)
   and the async enforce path (resolves reviewer obligations). This unifies the
   two current paths (`evaluate` ⊥ `runAdmissibilityGate`) behind one SSOT with
   two entry points (inspect vs enforce). *(Audit refinement #2.)*

2. **PEP — single enforcement point.** ONE chokepoint in the loop dispatch calls
   the PDP and enforces. Surfaces supply `ctx` as **data only**; they never
   assemble decision logic. This is the real fix for the opt-in recurrence: if
   the PEP is the only call site, a surface *cannot* forget to wire the
   gate — there is nothing to wire. **The hard part is proving there is no second
   dispatch path** (main loop / side-conversation / subagent / batch / fork). The
   migration ratchet is therefore "**no tool executes except via the PEP**" (a
   structural fence), not "every surface wired the gate". *(Audit refinement #1.)*

3. **Ordered pipeline of pure deciders** with fixed precedence:
   `HARD_DENY → hand-off-floor → rules → skill-scope → mode → reviewer`. A new
   security concern = one new decider + a precedence test. Surface-agnostic.
   (Consolidates today's two ladders into one.)

4. **Permissions as DATA — the capability spec (unblocks P2-T1).** Each tool
   declares `capability: { effects, tier, dangerClass, needsSandbox }`. The PDP
   reads it. Crucially this **splits the two reasons a tool is `always-confirm`**:
   - `tier: "always-confirm"` because **inherently sensitive** (git push) ⇒ joins
     the UNIVERSAL floor (the P2-T1 target).
   - `needsSandbox: true` with no profile (bash) ⇒ defers to the **sandbox**
     layer, NOT a blanket confirm. With a profile wired, bash is gated by the
     profile, not the conservative always-confirm fallback.
   A ratchet forces every tool to carry a reviewed spec (mirror of the
   `tool-surface-ssot` manifest pattern); a spec-less new tool is RED at authoring
   time. The spec **REPLACES** `inferToolTier` — it is not added alongside it (no
   parallel system / drift; cf. the knob-3-system anti-pattern). *(Audit
   refinement #3.)*

5. **Decision carries OBLIGATIONS** (XACML obligation / Claude `updatedInput`):
   `{ verdict, obligations }` unifies today's scattered side-channels
   (`rewriteInput` / `steer` / `log` / `runInSandbox`) into one return type. Ship
   the type in this keystone with `runInSandbox` **defined but no-op** so the
   OS-sandbox layer (P2 roadmap) lands later without re-plumbing surfaces.

6. **Two-ring enforcement** (defense in depth): Ring A = approval (*should we*),
   Ring B = OS sandbox (*can it even* — seatbelt/landlock). Independent: a
   PDP-allow still runs inside the jail. A single named profile pins both rings
   (`workspace-write` ⇒ ask-policy + fs-jail). This is the missing floor under
   `bypass`. **Roadmap** (platform-specific; scope a `SandboxPort` with a no-op
   default + a macOS seatbelt impl first). *(Audit refinement on scope.)*

7. **Grant / audit as first-class.** Generalize the ADR-0512 approval lease
   (opaque, single-use, turn-scoped) into a capability-grant ledger
   `{ who, what, scope, expiry, reason }` → audit log falls out for free. `bypass`
   becomes a **session-scoped, revocable, logged grant**, not a global flag.
   **Preserve** the turn-scoped single-use property for the existing approval
   scope — support both scopes, don't collapse them. *(Audit refinement #4.)*

## Migration (non-destructive, incremental, behavior-e2e-driven)

Each step is a slice behind an existing seam — NOT a big-bang rewrite.

1. **PEP single-call audit + fence** (keystone, biggest safety win): prove ONE
   dispatch chokepoint; add the "no tool executes except via the PEP" ratchet.
   - ✅ **LANDED (jun-10)**: `dispatchTool` proven singular (codemode + subagents
     re-enter it). Structural fence `single-pep-fence-hellgate.test.ts` (allowlist
     of 4 `tool.execute()` sites, anti-vacuous teeth) + behavioral
     `codemode-dispatch-gated-hellgate.test.ts` (codemode path is gated).
2. **PDP extraction**: lift the decider ladder behind `decide()` (sync) + enforce;
   keep behavior byte-identical (existing tests are the net).
3. **Capability spec** replaces `inferToolTier`; ratchet every tool. **This
   un-skips P2-T1** — `always-confirm` universalizes for inherently-sensitive
   tools while bash defers to its sandbox profile.
   - ✅ **First decider LANDED (jun-10)**: `ToolCapability` (`@/shared`) + the pure
     `decideFloor` (`@/permission/pdp`); the gate consults it for the floor
     question. T1 un-blocked, 0 regressions. REMAINING: classify real tools +
     make the spec the FULL replacement for `inferToolTier` + the authoring ratchet.
4. **Obligations type** (with `runInSandbox` no-op).
5. **Grant ledger** generalizes the lease (preserve turn-scoped single-use).
6. **OS sandbox** (Ring B) behind the obligation seam.

## Internal management / observability

- `/permission explain <action>` → PDP describe-mode (which decider fired + why).
- `fc` gains a `permission_spec` axis; the capability manifest is the dashboard.
- One `PERMISSION.md` SSOT doc for the governance layer.

## Do-NOT (lessons banked)

- Don't flip `always-confirm` at the gate level (the bash conflation — 89 RED).
- Don't add the capability spec ALONGSIDE `inferToolTier` (drift / parallel system).
- Don't refactor the security core amid concurrent churn — behavior-e2e-driven,
  area-quiet only.
