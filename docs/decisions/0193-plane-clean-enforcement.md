# ADR-0193: Plane-clean — enforce or de-claim

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0190 (plane-clean primitives — shipped the first
  `noRestrictedImports` overrides for plan-queue / budget-ledger /
  conversation-checkpoint / streaming-cancellation / subagent-resume /
  mcp/skybridge), ADR-0024 (export-gap closure — apps/cli isolation
  pattern), ADR-0108 (shadow-odb leaf primitive), ADR-0123
  (verify-checkpoint-bridge plane discipline), ADR-0136 (os-sandbox leaf),
  ADR-0145 (background subagent plane-clean modules), ADR-0171 (pii-redaction
  pure scanner), ADR-0144 / 0165 / 0170 / 0173 / 0182 / 0137 (the six ADRs
  whose plane-clean claims are corrected by this ADR)

## Context

A 3-round audit on 2026-05-25 (audit C) probed every ADR that uses the
"plane-clean" rhetoric against its on-disk imports + the biome
`noRestrictedImports` enforcement. Two structural defects fell out:

**1. Half the rhetoric was false.** Approximately 50% of slices that
advertised "plane-clean" reach across plane boundaries in production:

- `src/observability/metrics/*` claims "plane-clean" but
  `instrument-tool.ts` / `instrument-budget.ts` / `instrument-plan-queue.ts`
  / `instrument-shadow.ts` / `observability-helper.ts` import `@/tool` /
  `@/agent/budget-ledger` / `@/agent/plan-queue` /
  `@/agent/subagent-background` / `@/storage/shadow-odb` / `@/llm/providers`
  / `@/llm`.
- `src/observability/coverage/ast-source.ts` +
  `src/observability/coverage/istanbul-source.ts` claim "plane-clean" but
  pull `typescript` (the 3rd-party TS compiler API) — heavier than the
  label implies.
- `src/observability/prompt-cache/budget-bridge.ts` claims "plane-clean"
  but reaches `@/agent/budget-ledger`.
- `src/tool/document/csv-read.ts` / `yaml-read.ts` / `ndjson-read.ts`
  claim "0 @/storage import" but reach `FsJailError` from `@/storage`.

**2. The enforcement was structurally dead.** The existing biome
overrides for plane-clean files (ADR-0190 — plan-queue, budget-ledger,
conversation-checkpoint, streaming-cancellation, subagent-resume) were
defined BEFORE a later `src/**` sweep override in the same
`overrides[]` array. Biome 2.4.15 semantics: when two overrides match
the same file, **the later one's `noRestrictedImports` rule completely
replaces the earlier one** (rule-level, not key-level merge). The sweep
shipped a single `apps/cli` pattern, so every plane-clean rule was
silently overwritten — none of them fired. Reproducible via:
`cat > src/agent/plan-queue.ts <<<'import { foo } from "@/agent/loop"';
bunx biome check src/agent/plan-queue.ts` produced ZERO
`noRestrictedImports` violation prior to this ADR.

User principle: **"외친 단어만 외치지 마라 — 강제하거나 빼라."**

## 결정

A two-path remediation:

### Path 1 — RATCHET biome (10 slices)

Add a `noRestrictedImports` override **at the END of the `overrides[]`
array** (after the `src/**` sweep) for every slice whose on-disk imports
genuinely match the plane-clean claim. To unbreak the EXISTING ADR-0190
rules, also exclude their files from the sweep via `!src/agent/...`
patterns so the earlier overrides become the last-matching rule.

Slices ratcheted (rules now fire — verified by inserting a synthetic
violation per slice and observing `× Plane-clean (...)` in
`bunx biome check`):

| Slice | ADR | What it imports |
|---|---|---|
| `src/agent/plan-queue.ts` | 0128/0190 | `node:crypto` |
| `src/agent/budget-ledger.ts` | 0138/0190 | `node:crypto` + `@/shared` |
| `src/agent/conversation-checkpoint.ts` | 0124/0190 | `@/llm` type-only |
| `src/agent/subagent-resume/**` | 0166/0190 | `@/llm` type-only |
| `src/agent/streaming-cancellation/**` | 0183/0190 | `@/llm` type-only |
| `src/mcp/skybridge/**` | 0155/0190 | internal cross-refs |
| `src/agent/subagent-background.ts` | 0145 | `@/subagent` types + `node:crypto` |
| `src/agent/verify-checkpoint-bridge.ts` | 0123 | `@/storage/shadow-odb` type-only |
| `src/agent/branch-search/anchor.ts` | 0116 | `@/storage/shadow-odb` type-only |
| `src/agent/checkpoint-policy.ts` | (new) | `@/llm` + `@/storage/shadow-odb` + `@/tool` (type-only) + sibling `effect-channel` |
| `src/storage/shadow-odb/**` | 0108 | `@/tool/git` + `node:fs`/`path`/`crypto` |
| `src/runtime/os-sandbox/**` | 0136 | `node:child_process` |
| `src/security/pii-redaction/**` | 0171 | pure (own dir types only) |

Each new override blocks every cross-slice path that the slice does NOT
need. The message ends in the originating ADR number so a future
maintainer reading a biome error knows which ADR sealed the boundary.

### Path 2 — DE-CLAIM ADRs (6 ADRs)

For each ADR whose "plane-clean" claim does not match the on-disk
imports, replace the plane-clean section with an honest "Plane discipline
(ADR-0193 정정)" section that:

- Names the cross-plane imports that exist.
- States WHY they are intentional (cross-cutting layer / compiler-bridge
  / chokepoint).
- Points at the biome slice rule that DOES enforce the realistic boundary
  for that slice (e.g. `**/src/observability/**` → `@/shared` only,
  which the slice currently violates with 3 pre-existing
  `noRestrictedImports` errors).

ADRs amended:

- **ADR-0144** (observability-metrics) — added Plane discipline note;
  listed the 7 cross-cutting reaches (`@/tool`, `@/agent/budget-ledger`,
  `@/agent/plan-queue`, `@/agent/subagent-background`,
  `@/storage/shadow-odb`, `@/llm/providers`, `@/llm`); marked the slice
  as cross-cutting by design.
- **ADR-0165** (code-coverage) — Plane-clean check → Plane discipline;
  added `typescript` to the import list; marked the slice as
  compiler-bridge.
- **ADR-0170** (coverage-ast-branch) — same compiler-bridge revision.
- **ADR-0173** (coverage-istanbul-per-branch) — same; preserved the
  pure-shape-arithmetic exception for `istanbul-shape-emitter.ts` +
  `merge.ts` which ARE in-slice-only.
- **ADR-0182** (prompt-cache-observability) — `budget-bridge.ts` reaches
  `@/agent/budget-ledger` (type-only) by design; the slice as a whole is
  NOT plane-clean — the type-only "observer 자체는 ledger 를 import 안
  함" phrasing is preserved.
- **ADR-0137** (document-readers-extensions) — "0 @/storage import"
  claim corrected: `@/storage` is reached for the FS jail chokepoint;
  the slice is "tool-slice-clean" (within RFC 3.1's `@/tool` allowed
  dependency set) rather than plane-clean.

## Rule (future ADRs)

A `plane-clean` claim in a new ADR MUST be backed by a biome
`noRestrictedImports` override that fires when violated. Without the
override, drop the rhetoric. Reviewers should verify the override fires
by inserting a synthetic violating import (`import { foo } from
"@/blocked-slice"`) and running `bunx biome check` against the file —
the rule must emit `× Plane-clean (...)`.

## Alternatives rejected

1. **"Fix all violations to match the original plane-clean claims."**
   Many violations are intentional. The observability layer is cross-cutting
   by definition (it MUST reach into every slice to instrument them).
   AST coverage MUST reach the TypeScript compiler API. Forcing them
   into a `@/shared`-only diet would either delete the feature or push
   the imports into a sibling shim that adds an indirection without
   removing the coupling.
2. **"Drop plane-clean as a concept entirely."** Some slices genuinely
   ARE pure leaves (plan-queue, shadow-odb, os-sandbox, pii-redaction,
   verify-checkpoint-bridge, branch-search/anchor) and the boundary
   carries weight — losing the discipline regresses to the days when
   any slice could import any other.
3. **"Honor system — trust ADR text without enforcement."** Already
   tried, already failed: 50% rhetoric-vs-reality drift + 0 biome
   firings until this ADR. Documentation that nothing checks rots.
4. **"Move the sweep override to before all plane-clean overrides."**
   Functionally equivalent to this ADR's exclude-from-sweep approach,
   but reorders ~1000 lines of biome.json and risks unintended
   semantics for the `tests/**` patterns inside the sweep. The
   exclude-from-sweep diff is local + auditable.

## Verify

- `bunx biome check src/` — no new errors introduced by this ADR (existing
  pre-existing complexity / organizeImports / unused-import errors were
  already present; this ADR adds only `noRestrictedImports` rule
  definitions, which fire only on synthetic / future violations).
- Per ratcheted slice: insert a synthetic violation (`import { foo } from
  "@/blocked-slice"`) → `bunx biome check <file>` reports
  `× Plane-clean (ADR-0193 + ADR-NNNN): ...`. All 13 slices tested green.

## SOTA++ 자리매김

| Agent | Plane-clean rhetoric | Enforcement |
|---|---|---|
| Cursor | n/a | n/a |
| Codex | implicit (folder convention) | none |
| Claude Code 2.1 | n/a | n/a |
| **quanta (pre-ADR-0193)** | **50% slices claim "plane-clean"** | **0 biome firings** |
| **quanta (ADR-0193)** | **claim ↔ enforcement parity** | **13 ratcheted slices + 6 de-claimed ADRs** |

= "first agent surface to make 'plane-clean' a tested boundary — every
remaining claim is backed by a biome `noRestrictedImports` override
that fires on synthetic violation; every cross-cutting reality is
honestly named in the ADR text."
