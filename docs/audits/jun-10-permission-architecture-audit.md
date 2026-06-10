# Permission / authority architecture — audit + SOTA++ proposal (jun-10)

Triggered by an adversarial e2e finding: the web daemon's `bypass` mode auto-runs a
`hand-off-required` tool (no safety rails), unlike the CLI. This audit traces the
whole permission stack, the per-surface wiring, the DX of gating a new tool,
compares Codex / Claude Code / Cursor, and proposes SOTA++ improvements.

---

## 1. The decision pipeline (how ONE tool dispatch is decided)

| # | Layer | Where | Semantics |
|---|---|---|---|
| 0 | **HARD_DENY** | `evaluate` → `hardDeny(action)` ([policy.ts](../../src/permission/policy.ts)) | shell-command denylist (`rm -rf /`, …). **Always wins, every surface, every mode.** ✅ universal |
| 1 | **Permission MODE** | `permission.mode` (`default\|acceptEdits\|bypass\|auto`, [types.ts:48](../../src/permission/types.ts#L48)); live getter/setter proxy in CLI/bootstrap + (jun-10) web daemon | operator posture; read per-turn |
| 2 | **HITL TIER** (per-tool) | `inferToolTier` ([policy.ts:204](../../src/permission/policy.ts#L204)): explicit `tool.hitlTier(input)` wins, else read-only⇒`none`, mutating⇒**`always-confirm`** (fail-closed) | `hand-off-required \| always-confirm \| pre-approval-ok \| none` |
| 3 | **ADMISSIBILITY GATE** | `runAdmissibilityGate` ([admissibility-gate.ts:1867](../../src/agent/admissibility-gate.ts#L1867)) | composes mode × tier × rules × reviewer. **Overlay: hand-off-required⇒deny (no mode authorizes), always-confirm⇒ask (cannot be skipped by bypass/acceptEdits)** (doc lines 15-21) |
| 4 | **RULES** (glob) | `.cursor`/`.quanta` allow/ask/deny (`@/rules`, ADR-0098+) | per-path allow/ask/deny, precedence into the gate |
| 5 | **SKILL SCOPE** | `skill-gate.ts` (ADR-0512) | availability ⟂ permission 2-axis; out-of-scope ⇒ escalation card |
| 6 | **HOOKS** | `pre_tool_use` (canUseTool-equivalent) | can rewrite input / force allow-deny-ask |
| 7 | **onConfirm** (touchpoint) | `ConfirmDecision` (allow/deny/deny_and_steer + scope, ADR-0076/0512) | the human ask |

**Two decision code paths exist** and they are NOT equivalent:
- `evaluate` ([policy.ts](../../src/permission/policy.ts)) — the BASIC synchronous gate: read-only allow, HARD_DENY, else `bypass`/`acceptEdits`⇒allow, `default`⇒ask. **Has NO tier overlay** (no hand-off-required / always-confirm enforcement).
- `runAdmissibilityGate` ([admissibility-gate.ts](../../src/agent/admissibility-gate.ts)) — the FULL gate WITH the tier overlay + rules + reviewer.

A surface that uses only the basic path silently loses the tier rails.

---

## 2. Surface × Layer matrix (who wires what) — the headline

| Surface | HARD_DENY | mode proxy | **Admissibility gate (tier rails)** | rules | skill-scope | hooks |
|---|---|---|---|---|---|---|
| **apps/cli** | ✅ | ✅ | ✅ `buildAdmissibility` ([runtime-context-compose.ts:177-200](../../src/apps/cli/repl/runtime-context-compose.ts#L177)) | ✅ | ✅ | ✅ |
| **apps/web-daemon** | ✅ (in `evaluate`) | ✅ (jun-10) | ❌ **NONE** ([runtime-factory.ts](../../src/apps/web-daemon/runtime-factory.ts) — no admissibility) | ❌ | ✅ | ⚠️ |
| **apps/agent** (unified) | ✅ | ⚠️ | ❌ **NONE** found | ❌ | ✅ | ⚠️ |
| **apps/bench / headless** | ✅ | ⚠️ | ❌ **NONE** (real path; `fake-deps` only in tests) | ❌ | ✅ | ⚠️ |

The shared assemble layer SUPPORTS admissibility (`@/runner/assemble/config.ts:126` `admissibility?` — **optional**), but **only the CLI provides it**. Every other surface falls back to the basic `evaluate` ⇒ under `bypass`/`acceptEdits` they blanket-allow everything except HARD_DENY-shell — so **`hand-off-required` tools (no mode should authorize) and `always-confirm` tools (git push / deploy) run UNPROTECTED on web/agent/bench**.

> Proven: [tests/integration/permission-mode-adversarial-e2e.test.ts](../../tests/integration/permission-mode-adversarial-e2e.test.ts) — on the web-daemon runtime, `bypass` auto-runs a `hand-off-required` tool and skips an `always-confirm` ask (currently RED — they assert the SECURE behavior the gap violates).

---

## 3. Findings

- **F1 🔴 STRUCTURAL (root cause): the security gate is surface-OPT-IN, not runtime-default.** The admissibility tier-overlay is composed in `apps/cli`, so a new surface inherits NO rails unless it re-wires it — and web/agent/bench didn't. This is **default-OPEN**: a missing wire = allow, not deny. The web `bypass` exposure is a symptom; the disease is that nothing forces every surface through the same gate.
- **F2 🟡 no OS-level SANDBOX.** Enforcement is in-process (approval + HARD_DENY denylist). An approved/bypassed tool runs with FULL process privileges. Codex (seatbelt + landlock) and Cursor (`cursorsandbox`) add an OS jail BELOW approval. quanta is single-layer.
- **F3 🟢 good parts.** `inferToolTier` is fail-closed (mutating⇒always-confirm). HARD_DENY is universal. Skill-scope 2-axis (ADR-0512) is SOTA-aligned. The live permission proxy (jun-10) is correct.
- **F4 🟡 DX gap.** A dev gating a tool sets `hitlTier` (optional; safe default) — but whether the tool is ACTUALLY gated depends on the SURFACE wiring the gate, which the tool author can't see. No single "this tool needs X" spec all surfaces honor; no ratchet that every surface wires the gate.
- **F5 🟡 two decision paths** (`evaluate` vs `runAdmissibilityGate`) with different semantics ⇒ SSOT violation; the basic path silently drops the tier rails.

---

## 4. Competitor comparison (from `.extracted_source`)

| Dimension | Claude Code | Codex | Cursor |
|---|---|---|---|
| **Modes** | `default / acceptEdits / plan / bypassPermissions` | `approval_policy` (on-request / on-failure / never) | allow/ask/deny lists + auto-run toggle |
| **Decision point** | `canUseTool` → `{behavior:"allow"\|"deny"\|"ask", updatedInput?, message?}` (IDE spec §4, `extension.js:43113`) — single callback, can REWRITE input | per-command `sandbox_policy` + `permission_profile` + approval | rule match + auto-run allowlist |
| **OS SANDBOX** | (host-mediated) | ✅ **seatbelt (macOS) + landlock (linux)** (`sandboxing/src/{seatbelt,landlock}.rs`), `workspace-write` / `danger-full-access` templates, `writable_roots`, network `allowed_domains/denied_domains` | ✅ `cursorsandbox` Mach-O helper + electron-sandbox |
| **Config DX** | `.claude/settings` permissions + hooks (PreToolUse) | `active_permission_profile`, `permissions.filesystem/network` profiles | `.cursorrules` / `.mdc` rules |
| **Hard rails** | plan-mode blocks edits; bypass still respects hooks | sandbox is the hard floor even under `never` approval | sandbox + denylist |

**Key SOTA patterns quanta lacks:** (a) an **OS sandbox layer** below approval (Codex/Cursor) — the hard floor that survives `bypass`; (b) a **single canUseTool-style decision SSOT** with input-rewrite (Claude); (c) **named permission profiles** with declarative fs/network constraints (Codex `permission_profile`).

---

## 5. SOTA++ proposal (prioritized)

- **P1 — make the gate SECURE-BY-DEFAULT (closes F1, F5). [do first]** Move the tier-overlay (hand-off-required⇒deny, always-confirm⇒ask) into the **shared runtime default** (`@/runner/assemble` or `@/host/runtime`), so EVERY surface inherits it; a surface opts OUT explicitly (never silently). Unify `evaluate` to apply the overlay (one decision SSOT). **+ a ratchet test**: every composition root (`apps/**` runtime factory) must wire the gate — a new surface that doesn't fails the gate. This single change closes the web/agent/bench exposure AND prevents recurrence. *Engineering pattern: "secure by default / opt-out, not opt-in" + fail-closed + a structural ratchet (cf. ADR-0512's drift-ratchet, the no-throw/MUTATING_TABLE permanent guards).*
- **P2 — OS sandbox layer (closes F2). [roadmap]** Add a sandbox below approval: `sandbox-exec`/seatbelt on macOS, landlock/bubblewrap on linux. Even an approved/bypassed tool runs in a fs/network jail (`writable_roots`, network deny). Absorb Codex's `codex-seatbelt-sandbox-profile` (already cataloged in `.extracted_source/codex/INVENTORY.md`). Defense-in-depth: approval = "should we" / sandbox = "can it even".
- **P3 — declarative per-tool permission SPEC (closes F4).** Each tool declares a capability spec (fs-write / network / shell / spawn + its tier) as a first-class field; ALL surfaces honor it via the shared gate; a `fc`/ratchet asserts every tool has a reviewed spec. Makes "is this gated?" answerable and drift-guarded (cf. `tool-surface-ssot` manifest pattern).
- **P4 — named permission profiles + provenance (Codex parity).** Promote the scattered mode/rules/tier into named profiles (`read-only`, `workspace-write`, `full-access`) with declarative fs/network constraints; surfaces select a profile. Pairs with P2 (a profile = a sandbox template).
- **P5 — decision audit log.** Persist allow/ask/deny decisions (who/what/why) — the web is multi-client and `bypass` is consequential. `decisionEmitter` exists ([context-binding.ts](../../src/host/runtime/internal/context-binding.ts)) but isn't a persistent, queryable audit.

## 6. Immediate next step
P1 is the fix that follows this audit: make the admissibility tier-overlay a runtime default + ratchet, turning the RED adversarial e2e green AND closing web/agent/bench in one structural change. P2-P5 are the SOTA++ roadmap. (In flight: a concurrent change wires `hitl: { enabled: true }` into the web-daemon factory + a `web-daemon-hitl-enabled` source guard — the P1 "web" slice.)

---

## 7. Architecture opinion — how I'd modularize this for elegance + safe internal management

The current layers are individually GOOD (fail-closed tiers, universal HARD_DENY, 2-axis skill-scope). The problem is **composition**: the decision is assembled ad-hoc per surface, split across two code paths, and the tool→permission relationship is inferred-in-code rather than declared. Here's the model I'd move toward.

### 7.1 PDP / PEP split (the OPA / XACML / Zanzibar pattern)
Separate the **decision** from the **enforcement**:
- **PDP — Policy Decision Point** (`@/permission/policy`): a PURE engine. `decide(action, context, policy) → Decision`. No IO, no surface, no terminal. Fully testable in isolation; the SSOT for "what is allowed".
- **PEP — Policy Enforcement Point**: the SINGLE dispatch chokepoint in the loop (`@/agent/loop` dispatch seam) that calls the PDP and enforces the verdict (allow ⇒ run, ask ⇒ onConfirm, deny ⇒ recoverable tool_result).
- Surfaces supply **context as DATA** (mode, profile, rules source) — never decision logic.

> Why it's the fix for F1/F5: when the PEP is the ONE place that calls the PDP, a surface *cannot* "forget the gate" — there's nothing to forget; the loop always routes through the PEP. Today the gate is opt-in *because the decision is composed in the surface*. Invert it.

### 7.2 An ordered pipeline of pure "deciders" (chain-of-responsibility + fixed precedence)
The PDP is a fixed, documented precedence ladder of small pure functions, each returning `allow | ask | deny | abstain`:
```
HARD_DENY → hitl-tier (hand-off-required/always-confirm) → rules(glob) → skill-scope → mode → reviewer
```
Adding a new layer = write a decider + slot it in the ladder, in ONE file, with a precedence test. No surface touches it. (Today `evaluate` and `runAdmissibilityGate` are two ladders with different rungs — collapse to one.)

### 7.3 Permissions as DATA: a declarative per-tool capability spec
A tool DECLARES what it needs, not how it's gated:
```ts
capability: { effects: ("fs-write"|"network"|"shell"|"spawn"|"fs-read")[], tier: HITLTier, dangerClass?: ... }
```
The PDP reads the spec; a **ratchet** asserts every registered tool has a *reviewed* spec (cf. the `tool-surface-ssot` manifest + the no-throw/MUTATING_TABLE permanent guards). This turns "is this tool correctly gated?" from "read the code on every surface" into "read one reviewable manifest" — and a new tool with no spec fails the ratchet (fail-closed at authoring time, not runtime).

### 7.4 Decision carries OBLIGATIONS (the XACML obligation / Claude `updatedInput` pattern)
`Decision = { verdict, obligations }` where obligations unify today's scattered side-channels: `rewriteInput` (Claude's `updatedInput` — hooks), `steer` (deny_and_steer), `log`, `runInSandbox(profile)`. The PEP applies obligations. One return type instead of N seams.

### 7.5 Two-layer enforcement (defense-in-depth rings)
- **Ring A — policy/approval** (PDP): "*should* we".
- **Ring B — OS sandbox** (`@/permission/sandbox`, port → seatbelt/landlock adapters): "*can it even*". Independent; even a PDP-allow runs jailed (writable_roots, network deny).
A profile (§P4) = one declaration that fixes BOTH rings (e.g. `workspace-write` ⇒ ask-policy + fs-jail to repo). This is the Codex model and the missing floor under `bypass`.

### 7.6 Grants & audit as first-class (generalize the approval LEASE)
The ADR-0512 approval **lease** (opaque, single-use, turn-scoped) is already the right primitive — generalize it to a **capability-grant ledger**: every grant is `{ who, what, scope, expiry, reason }`, queryable. The decision **audit log** (P5) then falls out for free, and `bypass` becomes "a session-scoped grant", not a global mode flag (revocable, logged).

### 7.7 Internal management / introspection
- `/permission explain <action>` runs the PDP in **describe mode** (no side effect) and prints which decider fired + the precedence — generalize today's `inspect.ts` matrix from "tool meta" to "this exact action under this context".
- A `fc` axis `permission_spec` tracking every tool's reviewed capability spec + every surface's PEP wiring (the ratchet's data).

### 7.8 Current vs proposed — at a glance
| Concern | Current | Proposed |
|---|---|---|
| Decision location | composed per-surface (opt-in) | one PDP; PEP is the only caller (secure-by-default) |
| Decision paths | two (`evaluate` ⊥ `runAdmissibilityGate`) | one precedence ladder of pure deciders |
| Tool→permission | inferred in code (`inferToolTier`) | declared capability spec + ratchet |
| Side-channels | scattered (steer / hook rewrite / decisionEmitter) | one `Decision.obligations` |
| Enforcement rings | 1 (in-process approval + denylist) | 2 (approval + OS sandbox) |
| Grants | boolean lease (approval only) | capability-grant ledger + audit |
| Introspection | `inspect.ts` (tool matrix) | PDP describe-mode `/permission explain <action>` |

**Migration is incremental and non-breaking:** P1 (collapse to one PDP + make the PEP the only caller + ratchet) is the keystone and the biggest safety win; §7.3 (capability spec) and §7.5 (sandbox) layer on without re-touching surfaces; §7.6 generalizes an existing primitive. None requires a big-bang rewrite — each step is a slice behind the existing seams.

---

## §8 Phase-2 ticket status (jun-10)

- **hand-off-required universal floor — ✅ LANDED.** Enforced on every surface
  regardless of `hitl.enabled`, via `runHitlReviewGate` routed through
  `runHitlGate` (telemetry-preserving). 16-cell matrix ratchet in
  `tests/integration/hand-off-required-universal-e2e.test.ts`.
- **P2-T2 (A3) — ✅ LANDED.** `runHandoffFloorGate` pulls hand-off-required to
  HARD_DENY-level precedence (before pattern-grant + rules DSL); no grant / rule /
  `permissionAllowDangerous` can unlock it. Tests in `admissibility-gate.test.ts`
  (`hand-off-required tier CANNOT be overridden`).
- **P2-T3 first decider (PDP capability spec) — ✅ LANDED.** The audit's
  capability-spec is real: `ToolCapability` (in `@/shared`, no cycle) + the pure
  `decideFloor` decider (`@/permission/pdp`, exhaustive truth-table test). The
  admissibility gate now asks the PDP "does this tier apply universally?" instead
  of reading the raw tier. The SSOT skeleton for the security floor; the full
  PDP/PEP migration (single-PEP fence, obligations, grant ledger) stays in
  `docs/plans/permission-pdp-pep-keystone.md`.
- **P2-T1 (always-confirm secure-by-default) — ✅ UN-BLOCKED, seam LIVE.** The
  capability spec splits the two reasons a tool is `always-confirm`: declaring
  `capability.confirm: "sensitive"` (git push / deploy) joins the UNIVERSAL floor
  (every surface, even bypass, no HITL opt-in); `needs-sandbox` (bash without a
  profile) DEFERS — so the ~89 shell tests do NOT break (measured: 0 regressions).
  Hellgate GREEN + un-skipped: `tests/integration/always-confirm-secure-by-default-e2e.test.ts`
  (incl. a capability-LESS-defers regression guard). `hitl.autoApprove` =
  autonomous opt-out.
- **Real sensitive tools classified — ✅ 5 external-write tools.** `git_push`,
  `gh_pr_open`, `gh_pr_create`, `gh_pr_comment`, `gh_pr_auto_merge` all declare
  `capability.confirm: "sensitive"` (externally-visible, hard-to-reverse) ⇒ they
  now confirm on EVERY surface even under bypass, not just when HITL is opted in.
  0 regressions (directive/tool unit tests + ci-bot/bench/headless don't dispatch
  these through the agent-loop gate; an autonomous surface that did would DENY
  them — secure default). Gate hellgate: `admissibility-gate.test.ts`
  (`real sensitive tools are universal-floor gated`). **Governance ratchet** pins
  the set: `tests/unit/permission/sensitive-tool-capability-ratchet.test.ts` (RED
  if a tool drops its capability; add new external-write tools there).
  **Follow-on:** make the capability spec the FULL replacement for `inferToolTier`
  + an authoring ratchet that every tool carries a reviewed spec.
