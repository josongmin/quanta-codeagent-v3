# tests/

Executable spec for quanta-codeagent-v3. Tier-separated by determinism axis per
[ADR-0003](../docs/decisions/0003-test-pyramid.md). This file is the cold-start
entry point — read it before adding tests.

## Tiers (ADR-0003)

| Tier | Path | Files | Determinism | Default gate | Wall-clock budget |
|------|------|-------|-------------|--------------|-------------------|
| unit | `tests/unit/` | 361 | full (in-proc) | every push/PR | ~45 s (`test:unit`) |
| integration | `tests/integration/` | 109 | full (FakeLLM, tmpdir, in-proc adapters) | every push/PR | bundled with `test` (total ~117 s) |
| contract | `tests/contract/` | 3 | env-gated (real Docker / language servers) | PR/main with `test:contract` | depends on host |
| smoke | `tests/smoke/` | 26 | replay (Tier-0) + live (Tier-1) | `smoke` / `smoke:live` | ~seconds (replay) |
| eval | `src/apps/bench/` | n/a | non-deterministic (real LLM) | nightly / `eval` label, non-blocking | minutes–hours |
| meta | `tests/meta/` | 1 | filesystem-only (hellgate) | every push/PR (bundled with `test:unit`) | sub-second |
| adversarial | `tests/adversarial/` | 2 | full (in-proc) | every push/PR (bundled with `test:unit`) | ~3 s |
| measurement | `tests/measurement/` | 1 | full (in-proc) | every push/PR (bundled with `test:unit`) | sub-second |
| retrieval-eval | `tests/eval/` | 6 | non-deterministic (LIVE provider APIs, polite-skip without keys) | `eval:retrieval` only — never on a gate, it spends money | seconds |

### `tests/integration/agent-loop-bugbash/` (ALBB-24 proof rail)

Behavioral hellgates that pin the jul-9 agent-loop bug-bash (Wave A/B/C) fixes
with red-on-injection proofs — a re-inline OR a silent behavior regression both
fail loudly. This is the companion to the **structural** facade guard
`tests/unit/agent/loop-decomposition-hellgate.test.ts` (which stays purely
structural). Each `describe` embeds its ALBB id; see the namespace's own
[`README.md`](./integration/agent-loop-bugbash/README.md) for the id → file
index. Bug-bash CI slice:
`bun test tests/integration/agent-loop-bugbash tests/unit/agent/albb-*`.

### Which directories a gate actually reaches

The table above is a claim, and claims rot. `tests/unit/_arch/gated-test-scope-ratchet.test.ts`
derives the gated roots from `package.json` and fails when a directory of
`*.test.ts` is reachable by NO script — which is not hypothetical: `tests/meta/`,
`tests/adversarial/`, `tests/measurement/` and all six of `tests/eval/` were in
exactly that state on 2026-08-25, while this file, `bunfig.toml` and the feature
catalog all asserted that the meta hellgate ran at CI time. A directory that is
deliberately off the per-push gate must name its runner in that ratchet's
`OUT_OF_BAND` table, and the ratchet checks the script both EXISTS and still
mentions the directory.

### Artifact-purge policy

Only TypeScript source is authoritative. Any `.test.js` under `tests/` or
untracked `.js` mirror under `src/` is a stale TypeScript-emit artifact
(root-cause: legacy build step / worktree pollution). The latter is especially
dangerous because Bun resolves an extensionless import to the colocated `.js`
first, silently testing stale production code. Enforcement is two-layer:

1. Every test script (`test`, `test:unit`, `test:fast`, …) is prefixed with
   `bun run test:clean-js`, which removes test artifacts and source mirrors
   before the run. It deletes EVERY `.js` under `tests/` (not just `*.test.js`):
   `tests/**/*.js` is gitignored, so nothing tracked is at risk, and the narrower
   rule had left 35 stale mirrors in place — including
   `tests/eval/retrieval/_helpers.js`, whose `.ts` source had since diverged and
   which the extensionless `./_helpers` import would have resolved to FIRST. `bun test <path>` is covered by the earlier
   `preload-clean-source-js.ts` preload. Manual cleanup: `bun run test:clean-js`.
2. `tests/meta/no-test-js-artifacts-hellgate.test.ts` walks the test tree and
   fails CI if any `.test.js` survives.

`bun test` (and `npm test`) covers **unit + integration only** — the
deterministic gate. Contract and eval are explicitly separated to keep the
inner loop fast and the green build trustworthy.

## Test naming taxonomy

The filename suffix is the contract — it tells the reader what the file is
about to assert *before* they open it. Do not invent new suffixes.

| Suffix | Tier | Meaning |
|--------|------|---------|
| `*.test.ts` | unit / integration | Generic test file. Behaviour exercise; no single sworn invariant. |
| `*-hellgate.test.ts` | unit | **Mutation-proven, single-axis invariant.** Every assertion is labelled `★ CONTRACT` (must hold across refactors) vs `★ CHARACTERIZATION` (observed today, may evolve). Cited from the executable evidence index. 19 files. |
| `*-e2e.test.ts` | unit / integration | Integration crossing **≥2 slices** (e.g. agent loop + tool registry + permission). 41 files. |
| `*-hell-e2e.test.ts` | unit / integration | **Cross-subsystem composed adversarial** — multiple hellgates chained to prove invariants survive composition. 19 files. |

If a new test doesn't fit, name it `*.test.ts` and discuss before introducing a
new suffix. The suffix is the load-bearing convention, not the directory.

## Inner-loop commands

| Command | Scope | Wall-clock | When to use |
|---------|-------|------------|-------------|
| `bun test <path>` | single file | ~40 ms | iterating on one test |
| `npm run test:fast` | `tests/unit/{agent,llm,permission,runtime}` (~66 files / 1388 tests) | ~1.5 s | tightest sane loop while editing a core slice |
| `npm run test:watch` | `tests/unit` in watch mode | continuous | hands-off TDD |
| `npm run test:unit` | full `tests/unit` (~361 files / 5450 tests) | ~45 s | before committing a unit-only change |
| `npm test` | unit + integration | ~117 s | pre-push gate |
| `npm run test:contract` | contract (env-gated, polite-skip locally) | varies | before merging if you touched Docker / LSP code paths |

Trade-off: `test:fast` is an explicit slice — it deliberately excludes session,
memory, eval, observability, and the heavy benches. Use it as a "is the
core still alive" smoke pulse, **not** as a substitute for `test:unit` at
commit time.

## Reading order (cold start)

1. [ADR-0003](../docs/decisions/0003-test-pyramid.md) — why this tier split.
2. [Executable evidence index](../docs/analysis/code-agent-loop/quanta-comparison.md#executable-evidence)
   — every "quanta wins" claim points to a `*-hellgate.test.ts` you can run
   with `bun test <path>`. This is the single source of truth for *which
   invariant lives where*.
3. The hellgate suite itself: `tests/unit/*-hellgate.test.ts` (19 files).
   Each one is short, dense, and self-documenting via the `★ CONTRACT` header.
4. The integration harness: [tests/integration/_harness.ts](./integration/_harness.ts)
   — `ScriptedLLM`, `FakeLLM`, `RecordingStream`, `cfg()`, `findEvent()`,
   `eventsOf()`. Unit tests re-export the same harness via
   [tests/unit/_harness.ts](./unit/_harness.ts) — do **not** redefine these
   doubles in your test file.
5. Slice-boundary guards: `tests/unit/_arch/slice-boundary-configs.ts` (SSOT) +
   `tests/unit/<slice>-slice-boundary.test.ts` (49 library slices, excluding
   `apps/`). Adding a slice requires a config entry and a wired entrypoint;
   `slice-boundary-config-parity.test.ts` fails on inert configs. See
   [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §1.1 and §6.

## Writing a new hellgate test

Copy-paste skeleton. Live under `tests/unit/<axis>-hellgate.test.ts`.

```ts
/**
 * ★ CONTRACT — <axis>: <one-line invariant>
 *   src pointer: <src/path/file.ts>:<key fn or symbol>
 *   ADR: <ADR-NNNN>
 *   Every assertion below is labeled CONTRACT (invariant) vs CHARACTERIZATION (observed).
 */
import { describe, expect, test } from "bun:test"
import { cfg, FakeLLM, RecordingStream, findEvent } from "./_harness"

describe("<axis> hellgate", () => {
  test("CONTRACT: <invariant phrased as one sentence>", async () => {
    const stream = new RecordingStream()
    // arrange the minimum slice that exercises the axis
    // act
    // assert — name every expect() so a failure reads as a violated invariant
    expect(findEvent(stream, "message_stop")).toBeDefined()
  })
})
```

Rules:
- Import the harness from `./_harness`, never redefine `ScriptedLLM` / `FakeLLM` / `RecordingStream` / `cfg` locally.
- Use `findEvent(stream, "type")` / `eventsOf(stream, "type")` instead of inline `stream.events.find(e => e.type === ...)` — the helpers narrow the union for typed payload access.
- Add a row to the executable evidence index in `docs/analysis/code-agent-loop/quanta-comparison.md` so the test becomes citable.

## `REQUIRE_CONTRACT=1` knob

Contract tests (Docker, language servers) **polite-skip** when the host lacks
the runtime — running them locally is opt-in. Behaviour:

- Local default: missing runtime → `requireContract()` returns `false`, the
  test body skips, and a single `console.warn` per dependency tells you which
  one was skipped and how to make it loud.
- CI: set `REQUIRE_CONTRACT=1`. Missing runtime now **throws at module load**,
  failing the file — because CI is responsible for provisioning the
  dependency, so "absent" means "broken provisioning", not "developer
  laptop".

This closes the "broken integration looks identical to 'tool not installed'"
hole that plain `skipIf` leaves open. See [tests/contract/_guard.ts](./contract/_guard.ts).

## HARD_DENY workarounds for common dev cases

The permission policy in `src/permission/` HARD_DENYs a few classes of dev
side-effects to keep the agent safe. If you hit a deny while running tests:

- **`git push` to `main` / protected branches** — denied by repo rules; create
  a branch and push there. See `src/permission/repo-rules.ts`.
- **`bun install` / `npm install` / `pip install`** — installs are blocked by
  policy in this environment. Use the pre-installed local toolchain at
  `/Users/songmin/.bun/bin/bun` and `./node_modules/.bin/tsc`.
- **`curl` / outbound network from tests** — denied by sandbox profile;
  integration tests must use FakeLLM and tmpdir fixtures, never live network.
  See `src/runtime/sandbox.ts` and `tests/contract/_guard.ts` for the legit
  escape hatch (contract tier with explicit provisioning).

If a HARD_DENY blocks legitimate work, do not paper over it in a test — file
an ADR or escalate to `docs/decisions/`.
