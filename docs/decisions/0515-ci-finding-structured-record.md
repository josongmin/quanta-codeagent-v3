# ADR-0515: ci_finding — structured CI-investigation finding store + tool (§7.3 long-tail)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - `src/tool/ci-finding/store.ts` (pure in-memory session store + render helpers)
  - `src/tool/ci-finding/tool.ts` (`ci_finding` record/list/get tool)
  - `src/tool/ci-finding/index.ts` (slice barrel)
  - `src/tool/gh/index.ts` (`ghTools` opts.ciFindingStore registration seam)
  - `src/apps/agent/mode-presets/ci-bot.ts` (`buildCiBotWiring` mints the store on the gate)
  - `src/tool/surface/manifest.ts:806` (config-slot manifest entry)
  - `src/config/knob-inventory.ts:1357` (`QUANTA_CI_FINDING` knob; re-homed out of `cli-knobs.ts` by ADR-0527)
  - Tests: `tests/unit/ci-finding.test.ts`, `tests/integration/longtail-new-tools-e2e.test.ts`
  - Absorbs: Codex / Cursor CI-investigation STRUCTURED-record parity.

## Context

A CI-investigation skill today leaves its conclusion as PROSE in the transcript: "the
`test (ubuntu)` job failed because of a flaky timeout, fix is to bump the wait". Prose is
not rendererable, not dedupable, and not feedable to a next stage. Codex/Cursor instead
capture a STRUCTURED record (job + category + root-cause + evidence + suggested fix +
confidence) the host can render, dedupe, or hand to a follow-up. quanta had no typed
substrate for this.

## Decision

Add a plane-clean slice `@/tool/ci-finding` (imports only `@/shared`):

- `createCiFindingStore` — a pure in-memory, session-scoped registry of `CiFinding`
  records. Determinism by construction: an INJECTED clock (`now`) + id-factory
  (default monotonic `cif-<seq>`), so tests need no `Date.now`/`Math.random`. Retention is
  bounded by an oldest-evicted ring (`maxFindings`, default 500) so an unbounded
  investigation cannot grow without limit. `record`/`list`/`get`/`size`; `list` filters by
  job/category. `renderFinding`/`renderFindings` are exported so the tool + tests share ONE
  deterministic format (sorted by `seq`, tie-broken by `byteCompare(id)`).
- `ci_finding` tool (`record | list | get`) over that store. `record` requires
  job/category/summary/root_cause (zod-validated, per-field cap `MAX_FIELD=4000`);
  `evidence`/`suggested_fix`/`confidence` optional. risk:meta — it mutates ONLY the
  in-session store (no FS/shell/git/network), records the agent's OWN analysis, so it
  self-reports `isReadOnly: true` / `isConcurrencySafe: true` / `hitlTier: none`, mirroring
  `communicate_update` / `objective_*`. NO-THROW: a thrown store collapses to `ok:false`.

Wiring is default-OFF and config-slot shaped: `ghTools(runner, opts)` registers the tool
ONLY when `opts.ciFindingStore` is set; the `ci-bot` mode preset (`buildCiBotWiring`) mints a
fresh per-wiring store exactly when `QUANTA_CI_FINDING` is on. Absent ⇒ the tool is absent
and the gh tool set is byte-identical to the legacy ci-bot wiring. Because the tool is
read-only it survives the ci-bot read-only `ghTools` filter.

## Consequences

The agent (under `--mode ci-bot`) can leave a typed, dedupable, render-ready CI verdict
instead of prose. Reachability is HONEST: the slice is live ONLY on the headless
`apps/agent` ci-bot surface (the interactive `apps/cli` loop deliberately does not reach
`apps/agent` — the surface-coupling ratchet forbids that edge), and only when the gate is
on. There is no web/interactive-CLI affordance yet; that is the documented promotion path.

### Alternatives considered

- **Keep prose** — rejected: not rendererable/dedupable/feedable, the gap this closes.
- **Persist to SQLite** — deferred: a single-session ephemeral store matches the ci-bot
  one-shot run; durability would only matter for a resumable multi-run investigation, which
  is not yet a use case. Promotion path: swap the in-memory ring for a `SqliteJobStore`-style
  backing if/when ci-bot gains resume.
- **Always-on (no gate)** — rejected: long-tail tool, default-OFF preserves byte-identity
  for the legacy ci-bot wiring until measured.
