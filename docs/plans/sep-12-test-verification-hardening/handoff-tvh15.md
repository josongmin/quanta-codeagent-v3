# TVH-15 handoff — failure-artifact producer, gate wiring, and one live blocker

Written by the TVH-15 implementer. Everything below is either **needed from
another owner** or **a finding another owner has to act on**. The consumer side
is landed in the working tree and is green.

---

## 0. The one BLOCKER, and it is not mine

`tools/dev/test-shard-lifecycle.ts` is **dirty in the working tree with a
deliberate mutation**:

```diff
@@ -214,7 +214,7 @@ const waitForEmptyGroup = async (
     const probe = probeGroup(pgid, deps)
     if (probe.kind === "empty") return probe
     const remaining = deadline - deps.now()
-    if (remaining <= 0) return probe
+    if (remaining <= -1e12) return probe // INJECTED
     await deps.sleep(Math.min(nextPollDelay(attempt, schedule), remaining))
     attempt += 1
   }
```

HEAD is correct; the working tree is not. `-1e12` ms is ≈ 31,700 years, so
`waitForEmptyGroup` never returns while a group holds, and `deps.sleep` is
handed a NEGATIVE remaining — an unbounded busy spin. Measured: a caller with a
1s TERM grace and a 3s KILL grace hung indefinitely; I reproduced it, isolated
it to this line, and it is the reason `killProcessTreeOutcome` is **not** on the
liveness path of `tools/dev/bounded-child.ts` (see §2).

Whoever is running that mutation experiment should revert it before committing.
I did not touch the file.

---

## 1. `package.json` — `test:resilient` must change (I do not own the file)

Current:

```json
"test:resilient": "bun run test:clean-js && bun run tools/test-resilience/cli.ts run tests/unit tests/integration",
"test:resilient:quarantine": "bun run tools/test-resilience/cli.ts quarantine-check",
```

`run` no longer executes a suite. It is kept ONLY so this script fails loudly
with the fail-closed message instead of silently starting a second broad-suite
run. **Exact replacement strings:**

```json
"test:flake:diagnose": "bun run tools/test-resilience/cli.ts diagnose --from-artifact .cache/test-failure-attempt.json --out .cache/flake-diagnosis.json --first-failure-out .cache/first-failure.json",
"test:resilient:quarantine": "bun run tools/test-resilience/cli.ts quarantine-check",
"test:determinism": "bun run tools/dev/test-determinism-ratchet.ts"
```

Delete `test:resilient`. It named a lane that no longer exists: there is no
"resilient run", only an authoritative run plus an advisory diagnosis.

**Exit-code contract for `test:flake:diagnose` — it can never be 0.**

| exit | meaning |
|---|---|
| 1 | diagnosis completed, ≥1 `confirmed-real` |
| 3 | diagnosis completed, no `confirmed-real` — still NOT a pass |
| 2 | fail-closed: no artifact, unreadable artifact, or invalid artifact |
| 0 | unreachable by construction, pinned by `tests/unit/tools/test-resilience-diagnosis-hellgate.test.ts` |

Do **not** wire it into a gate whose success is `exit == 0`. It is a diagnostic.
`tools/dev/gate-manifest*.ts` should carry `test:determinism` and
`test:resilient:quarantine` (both are real 0/1 ratchets); the diagnosis command
belongs in a failure-triage path, not in `required`.

---

## 2. `tools/dev/bounded-child.ts` — the promoted primitive, and its signature

Final path: **`tools/dev/bounded-child.ts`**. `tools/test-resilience/bounded-child.ts`
is now a three-line re-export so the diagnosis lane names its own import surface.

```ts
export interface BoundedChildLimits {
  readonly totalMs: number          // bound on the child's RUN
  readonly inactivityMs: number     // no byte on either stream for this long ⇒ kill
  readonly maxStreamBytes: number   // per stream; draining continues past it
  readonly termGraceMs: number
  readonly killGraceMs: number
  readonly watchdogPollMs: number
  readonly maxPollMs: number        // ceiling on the 50ms→N drain backoff
}
export const DEFAULT_CHILD_LIMITS: BoundedChildLimits
export const deadlineBudgetMs: (limits: BoundedChildLimits) => number

export type BoundedChildStatus = "passed" | "failed" | "timed-out" | "cancelled" | "spawn-error"
export type BoundedChildDeadline = "total" | "inactivity"

export interface BoundedChildOutcome {
  readonly status: BoundedChildStatus
  readonly deadline: BoundedChildDeadline | undefined
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly elapsedMs: number
  readonly deadlineBudgetMs: number          // the ceiling this call DECLARED
  readonly kill: KillTreeOutcome | undefined // emptied | survived | unobservable
  readonly survivors: number | undefined     // undefined ⇒ ps unreadable, never assume 0
  readonly spawnError?: string
}

export interface BoundedChildRequest {
  readonly cmd?: readonly string[]   // argv form
  readonly shell?: string            // `sh -c <string>` form, UNPARSED — exactly one of cmd/shell
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly limits?: Partial<BoundedChildLimits>
  readonly signal?: AbortSignal      // ⇒ status "cancelled", never "timed-out"
  readonly observer?: ProcessObserver
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => void  // test seam
  readonly groupAlive?: (pgid: number) => boolean                        // test seam
}

export const runBoundedChild: (request: BoundedChildRequest) => Promise<BoundedChildOutcome>
```

### What `gate.ts` should do

`Bun.spawnSync(["sh", "-c", gate.run])` becomes:

```ts
const outcome = await runBoundedChild({
  shell: gate.run,                     // UNPARSED — the `--` pass-throughs survive
  cwd: REPO_ROOT,
  env: process.env,
  limits: { totalMs: gate.timeoutMs ?? DEFAULT_CHILD_LIMITS.totalMs },
  signal: campaignAbort.signal,
})
```

Three things to decide at the call site, none of which the primitive can decide
for you:

1. **`status === "timed-out"` is not `failed`.** A gate that ran out of time has
   produced no verdict; rendering it as a failed gate attributes a defect to the
   code under test. Report it as its own outcome, with `outcome.deadline` saying
   which bound fired.
2. **`survivors !== 0` is a campaign-level event.** `undefined` means the
   process table could not be read, which is not the same as zero. Both deserve
   a line in the receipt.
3. **`truncated === true` means the tail you are printing is not the whole
   output.** Say so, or an operator will debug a diff that does not exist.

`shell` mode exists for exactly this call site. Do not re-tokenise gate strings.

### Why the kill loop is local

`bounded-child.ts` imports `probeGroupFromSnapshot`, `processGroupAlive` and the
`KillTreeOutcome` type from `test-shard-lifecycle.ts`, and does every process
observation through `tools/dev/process-observer.ts` (bounded `ps`, 50ms→3s
backoff, typed unavailable reasons). It does **not** call
`killProcessTreeOutcome`, because a primitive that every top-level gate runs
through cannot make its own liveness depend on a poll loop it does not own —
see §0 for the execution that proved it. If you want the two merged, merge them
in the direction of this file owning the loop, not the other way.

---

## 3. REQUIRED FROM THE RUNNER OWNER: `quanta.test-failure-attempt.v1`

`tools/dev/run-test-shards.ts` writes a SUCCESS receipt
(`quanta.test-shard-success.v2`) and JUnit XML. It writes **nothing on failure**.
That is the artifact the diagnosis consumes, and without it the tool exits 2 —
deliberately, with no fallback, because the fallback is how the second
broad-suite authority came back last time.

Schema (authority: `tools/test-resilience/failure-artifact.ts`, strictly
validated — every rejection names the field):

```jsonc
{
  "schema": "quanta.test-failure-attempt.v1",
  "head": "<40-hex>",        // REJECTED if "" — the old adapter wrote "" here
  "dirty": false,
  "suite": "unit",
  "createdAtMs": 1757600000000,
  "replay": {
    "seed": "<head>:<testId>",   // the seed the attempt ran under
    "permutation": "lpt-v2:chunk7",
    "cores": 12,
    "loadAverage1m": 101.4,
    "workerParallel": 4,         // concurrent shard workers
    "intraParallel": 8,          // `bun test --parallel` width inside the worker
    "testTimeoutMs": 60000,
    "resourceClaims": ["class:pure"],
    "retryCount": 0              // runner-side retries BEFORE this artifact; 0 = authoritative
  },
  "failures": [
    {
      "file": "tests/unit/x.test.ts",
      "testId": "describe > … > leaf",   // EXACT, as JUnit reconstructs it
      "leaf": "leaf",
      "kind": "assertion|timeout|setup|infrastructure|cancelled|unknown",
      "fingerprint": "<64-hex>",         // failureFingerprint(testId, message)
      "elapsedMs": 1234,                 // REAL elapsed, not 0
      "chunkIndex": 7,
      "message": "first bytes of the failure body"
    }
  ]
}
```

`failures: []` is rejected: a clean attempt writes **no artifact at all**, so an
empty one means the producer lost the failures.

### Where the runner already has every field

| field | source in `run-test-shards.ts` at HEAD |
|---|---|
| `head` | `GitSnapshot.head` (already captured, already compared per chunk) |
| `dirty` | the runner already refuses a dirty checkout for authoritative receipts |
| `suite` | `opts.suite` |
| `intraParallel` | the `intraParallel` already threaded into `TestShardCacheIdentity` |
| `workerParallel` | the chunk scheduler's concurrency |
| `testTimeoutMs` | `testTimeoutMs`, already passed as `--timeout` |
| `resourceClaims` | `plan.resourceClass` (+ any exclusivity the scheduler applied) |
| `chunkIndex` | `plan.index` |
| `file` / `testId` / `leaf` / `elapsedMs` | the per-chunk JUnit the worker already writes — `tools/test-resilience/junit.ts` `parseJunitCases()` returns exactly `{ testId, leaf, file, status, elapsedMs }`; take `status === "fail"` |
| `message` | the spool tail for that file |
| `fingerprint` | `failureFingerprint(testId, message)` — exported |
| `seed` / `permutation` | **do not exist yet.** See below. |
| `retryCount` | 0 today (the runner does not retry); write it explicitly |

`parseJunitCases` is the piece worth reusing: JUnit is the only reporter that
gives per-test identity (MEASURED: the text reporter prints a line for FAILURES
only, so a filtered run cannot say which tests passed), and it already handles
the two shapes Bun emits — `classname` is the describe chain REVERSED and
DOUBLE-escaped (`&amp;gt;`).

### `seed` and `permutation` do not exist yet — the smallest honest version

- **`seed`**: `sha256(head + ":" + testId)`, exported to the worker as
  `QUANTA_TEST_SEED`. CI pins it to HEAD so a re-run reproduces; nightly fans
  out over several seeds. Nothing consumes it until the six unseeded
  `Math.random()` sites are converted (they are listed with per-file reasons in
  `tools/dev/test-determinism-baseline.json`), but the artifact should carry it
  from day one or the field will never be filled.
- **`permutation`**: the identity of the chunk composition and order the runner
  chose — `"<planner>:<shardFilesSha256 prefix>"` is enough. The planner already
  computes `shardFilesSha256` for the cache identity.

Both are strings; the validator only requires them non-empty. Writing
`"unseeded"` and `"unrecorded"` would pass validation and would be a lie — if
you cannot produce them yet, say so here rather than filling them.

### Suggested wiring

Write the artifact from the same place that decides the run is red, atomically,
to `.cache/test-failure-attempt.json`, and print the path. In CI, upload it and
hand it to the triage job as `--from-artifact`.

---

## 4. Gate/manifest enrolment for the two new ratchets

Both are plain 0/1 commands and safe for `precommit`/`prepush`:

- `bun run tools/dev/test-determinism-ratchet.ts` — blocks NEW upper-bound wall
  assertions in ordinary functional tests, NEW `Math.random()` beyond the
  per-file/per-role baseline, and any increase in per-file or corpus awaited
  fixed-sleep time. Green on the live tree; measured cost ~4.5s for 4,034 files.
- `bun run tools/test-resilience/cli.ts quarantine-check` — now validates owner,
  issue, `firstSeenSha`, fingerprint, resource claim, `expiresAt` and
  criticality, resolves the entry against the test names actually DECLARED in
  the file (AST), and refuses an entry that matches zero or more than one live
  test.

**The quarantine ledger will go RED on 2026-12-12** when its single entry
expires. That is the mechanism working: expiry forces a decision. The entry's
`owner` is currently the repo's git identity (`t <t@t.t>`) because no other
owner is derivable from the repository — replace it with a real one.

### Scan-enrolment note

`tools/dev/test-source-corpus.ts` is a THIRD corpus enumerator, and that is
deliberate: `test-shard-discovery.discoverSuiteFiles` is suite-scoped
(`tests/unit`, `tests/integration`, …) while the determinism ratchet must also
see `src/**/*.test.ts` and `apps/web-frontend/**/*.test.ts` — 4,034 files versus
the shard suites. If you would rather have one enumerator, the merge direction
is to give `test-shard-discovery` a "whole corpus" mode and have this file call
it; do not narrow the ratchet to the shard suites, which would drop 300+ files.

My ratchet test deliberately does not spell `readdirSync` / `Bun.Glob` /
`["git","ls-files"]`, so it is not a `scan-verdict guard` under
`tools/dev/anti-vacuity-census.ts` and needs no `assertScanPopulation`
enrolment. Its anti-vacuum guarantee is stronger than a count floor: the
ratchet's own `anti-vacuum-floor` violations are a real code path, driven in
`the anti-vacuum floor is a real code path, not a comment`.

---

## 5. What is landed in the working tree (consumer side, green)

| file | what it is |
|---|---|
| `tools/dev/bounded-child.ts` | NEW — the repo-wide bounded child primitive (§2) |
| `tools/dev/test-determinism-scan.ts` | NEW — AST + scope-chain detector for wall assertions, `Math.random()` roles, awaited fixed sleeps |
| `tools/dev/test-determinism-ratchet.ts` | NEW — the one-directional guard + CLI |
| `tools/dev/test-determinism-baseline.json` | NEW — random sites by file/role (with per-file reasons for the 6 outcome-relevant ones) + per-file sleep budgets + anti-vacuum floors |
| `tools/dev/test-wall-clock-inventory.ts` / `.json` | NEW — 165 classified sites, keyed by CONTENT not by line |
| `tools/dev/test-source-corpus.ts` | NEW — one definition of "ordinary test source" |
| `tools/test-resilience/cli.ts` | REWRITTEN — `diagnose` consumes the artifact, fails closed, never exits 0 |
| `tools/test-resilience/failure-artifact.ts` | NEW — the schema above + `failureFingerprint`, `replayCommand`, `escapeTestSelector` |
| `tools/test-resilience/diagnose.ts` | NEW — dedupe, per-file batching, global budget, four typed outcomes |
| `tools/test-resilience/junit.ts` | NEW — per-test identity from the JUnit reporter |
| `tools/test-resilience/quarantine.ts` | NEW — schema v2 + world-checked validation |
| `tools/test-resilience/quarantine.json` | the one entry, with full provenance |
| `tools/test-resilience/bounded-child.ts` | re-export of `tools/dev/bounded-child.ts` |
| `tests/unit/tools/test-resilience-bounded-child-hellgate.test.ts` | NEW |
| `tests/unit/tools/test-resilience-diagnosis-hellgate.test.ts` | NEW |
| `tests/unit/tools/test-resilience-quarantine-v2-hellgate.test.ts` | NEW |
| `tests/unit/dev/test-determinism-scan.test.ts` | NEW |
| `tests/unit/dev/test-determinism-ratchet.test.ts` | NEW |

`tools/test-resilience/parse.ts` is unchanged, and the two pre-existing tests
against it still pass — `QuarantineEntry` was EXTENDED, not replaced.

---

## 6. Two findings for other owners, no action from me

1. The ratchet caught three sites that landed in OTHER lanes while I worked, and
   I classified each by reading it. No change is needed from those owners; this
   is notice that the ledgers now carry their rows.
   - `tests/unit/dev/gate-dag.test.ts:271-272` — two upper bounds on
     `parallel.wallMs`, both on an INJECTED `fakeClock()`, so
     `irrelevant-non-time`.
   - `tests/unit/_arch/worktree-pollution-guard.test.ts:161` —
     `Date.now() - started < 4_000` against `Bun.spawnSync(timeout: 400)` on
     `sleep 5`: `functional-deadline`, with `exitCode === null` /
     `signalCode === "SIGTERM"` as the deterministic half.
   - `tests/unit/dev/test-shard-cache-incoherence.test.ts:174` — a
     `Math.random()` inside a template building a unique cache filename. The
     scanner classes it `id-shaped` (the value only ever becomes part of a
     path), so it is baselined rather than blocked.
2. `bun run lint:debt` is RED at the time of writing, entirely outside my files:
   `format` in `tests/unit/test-shard-cache-identity.test.ts` and
   `tests/unit/test-shard-plan.test.ts`, and a `noTemplateCurlyInString`
   regression (23 > 22) whose named files are `src/runner/batch/eval/project-env-python-shim.ts`
   and five other lanes' tests. `bunx biome check` over all 19 of my files
   reports 0 diagnostics.
