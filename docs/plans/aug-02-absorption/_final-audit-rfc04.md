# RFC-04 Guardian Risk-Tier — FINAL code-grounded audit (HEAD c46c60f4e)

## VERDICT: **DROP** (parity-theater; the "binary" claim is scoped to one helper, and the tier is advisory-only with no graded consumer).

## R1 — What tiers exist / reachability / advisory-vs-gating

- **The domain risk type is already 3-tier, NOT binary.** Everywhere the vocabulary is
  `"low" | "medium" | "high"`:
  - `src/permission/types.ts:169` — `readonly riskLevel: "low" | "medium" | "high"`
  - `src/permission/outcome.ts:161` — `riskLevel: "low" | "medium" | "high"` (buildDecision)
  - `src/permission/recorder.ts:80` — `type PermissionRiskLevel = "low" | "medium" | "high"`
  - `src/observability/attrs.ts:166` — `type RiskLevel = "low" | "medium" | "high"`
- **`medium` IS reachable** — produced on multiple live paths:
  - `src/permission/policy.ts:132-133` — `riskLevelFor(kind)` = `deny⇒high / ask⇒medium / allow⇒low` (synchronous stack path).
  - `src/agent/optional-ports.ts:499,553,560-562` — critic port emits `medium`.
  - guardian subagent LLM reply schema accepts medium: `src/agent/tier1/reviewer-subagent.ts:27,192` (`z.enum(["low","medium","high"])`).
- **The binary is ONE helper only**, not the system: `src/agent/reviewer-port.ts:46-47`
  `riskLevelFor(action) = action.isReadOnly ? "low" : "high"`. This helper feeds the
  `onConfirm`/classifier-backed adapter's `ApprovalDecision.riskLevel` only. The ITEM's
  premise ("built-in riskLevelFor is binary, medium unreachable") is TRUE for this one
  function but FALSE for the codebase — medium is produced by 3 other producers.
- **`critical` tier: absent everywhere.** Confirmed by grep — no `critical` risk literal in
  `src/permission` or `src/agent`.
- **Advisory, NOT gating.** No branch anywhere reads `.riskLevel` to authorize/deny/escalate.
  Grep for gating branches on riskLevel returns only *producer* sites
  (`optional-ports.ts:561` type-narrowing, `gate-pattern-wire.ts:109` assignment) — zero
  consumers that switch control flow on the tier.

## R1 — Consumers of the risk level (grep of reads of `.riskLevel`)

Only TWO real consumers, both non-authoritative:
1. **OTel metric attribute** — `src/observability/attrs.ts:250,267` (`permissionAttrs`) via
   `src/permission/recorder.ts:122` / `reviewer.ts:196,229` / `policy.ts:155`. It becomes a
   categorical dashboard label (`quanta.permission.risk_level`, `vocabulary.ts:133`). A metric
   dimension — never read back to make a decision.
2. **Rationale string interpolation** — `src/agent/closeout-critic.ts:95`
   `const risk = v.riskLevel !== undefined ? \` risk=${v.riskLevel}\` : ""` — pure display text.

No gate, no sticky-precedence, no dispatch, no HITL rung keys on the tier value. `reviewer.ts`
sticky/dispatch logic keys on `outcome`/`reviewer`, never `riskLevel`.

## R2 — Adversarial necessity (refuting "NEEDED")

The ITEM itself concedes the no-heuristic-authority fence: the score MUST NOT gate/authorize,
only inform. Given that constraint:

- The ONLY two consumers are an OTel label and a rationale string. Both are pure display /
  telemetry. **Neither benefits from a 4th tier or from finer granularity** — a metric label and
  a `risk=high` string render whatever literal they receive; adding `critical` yields one more
  bucket nobody dispatches on.
- The claimed gap ("medium unreachable / no critical") is a **cosmetic property of one adapter
  helper**, not a capability gap. The shared type already carries `medium`, and 3 producers emit
  it. A graded `riskLevelFor` in the onConfirm adapter would change a *display/telemetry label*
  for one code path — it changes zero decisions and zero operator-visible gating.
- Adding `critical` would require widening `types.ts`/`outcome.ts`/`recorder.ts`/`attrs.ts`/
  `vocabulary.ts` (5+ SSOTs + drift guards + the OTLP attribute contract) to add a tier that
  **no consumer reads**. Cost > 0, benefit = 0 (parity with Codex's enum name, nothing else).

**No real consumer benefits from graded tiers.** Every attempt to name one collapses to "a
prettier dashboard bucket" — which the existing 3-tier already supplies, and which the fence
forbids from ever influencing authorization. This is Codex-enum parity-theater.

## Decision

**DROP.** Not needed on current main. The system is already 3-tier (not binary); `medium` is
reachable via `policy.ts`, `optional-ports.ts`, and the guardian LLM schema; the only binary
site is one adapter helper whose output feeds advisory telemetry/rationale strings with zero
gating consumer. Adding a graded score + `critical` tier delivers no behavioral value under the
no-heuristic-authority fence and incurs multi-SSOT churn for enum-name parity alone.

If anything were ever worth doing (it is not, at this ROI), it would be a 1-line cosmetic:
promote `reviewer-port.ts:47` to reuse the existing `medium` for a mutating-but-benign class —
but that changes only a metric label, so DROP stands.
