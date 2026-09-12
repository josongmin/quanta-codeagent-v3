# TVH-03 handoff — changes required in files this agent does not own

Owner of this file: TVH-03 (real toolchain / capability lane separation).
Everything below is in a file owned by the integrator or another lane agent.
Each item is an exact diff or an exact instruction. Nothing here was applied.

**State this handoff assumes**: the TVH-03 working-tree change is present —
`tools/dev/test-capability-manifest.ts`, `tools/dev/test-tier-accounting.ts`,
the rewritten `tools/dev/test-policy.ts` tier rules,
`tools/dev/test-policy-overrides.json` with the 8-file canary,
`tools/dev/external-toolchain.ts` with the daemon layer, and
`tests/_helpers/capability-lane.ts`.

Measured after that change (`bun tools/dev/run-test-shards.ts --suite=full
--tier=<t> --discover-only`). The corpus is growing under concurrent agents, so
the counts are given as DELTAS off the discovered universe as well as absolutes:

    tier      files  digest(16)        = universe minus…
    prepush      8   0e5fa39009c91b81  n/a — the declared canary, corpus-independent
    pr        3924   8e1b03e8213acfd7  universe − 6 nightly-exhaustive − 17 capability
    full      3934   ad2f0664b9bc9820  universe − 6 nightly-exhaustive − 7 nightly-heavy
    nightly   3947   ebdfe31c1de6566d  universe (set-equal, both directions)

    universe = 3947 at the time of measurement.

Apples-to-apples BEFORE (the OLD `DEFAULT_KNOWN_TIERS = all four` rule replayed
over the SAME corpus): prepush = pr = full = 3941 / `73a96576f0474649`,
nightly 3947 / `ebdfe31c1de6566d`. Three names, one digest — and the nightly
digest is UNCHANGED before and after, which is the coverage-preservation proof:
no file left every tier.

---

## 1. BLOCKING — `tools/dev/test-tier-population.json`

`prepush` now selects **8** files (the declared always-run canary). The
committed floor is 3900, so `bun run tools/dev/run-test-shards.ts
--suite=full --tier=prepush` will abort with a SELECTION-shrink error before it
runs anything. `--discover-only` is unaffected (it does not call
`checkTierPopulation`), which is why the tables above render.

Replace the file with:

```json
{
  "schema": "quanta.test-tier-population.v1",
  "tiers": {
    "prepush": {
      "minFiles": 8,
      "reason": "prepush is the always-run CANARY only — exactly the 8 alwaysRun rows in test-policy-overrides.json, and corpus-independent by construction. The changed/affected set is unioned on top by verification-selection.ts, so this floor guards the canary, not the campaign"
    },
    "pr": {
      "minFiles": 3900,
      "reason": "measured 3924 = universe(3947) − 6 nightly-exhaustive − 17 capability-lane files; PR is the merge-blocking deterministic population"
    },
    "full": {
      "minFiles": 3900,
      "reason": "measured 3934 = universe(3947) − 6 nightly-exhaustive − 7 nightly-heavy capability files; full keeps the 10 pr-required-deterministic capability files"
    },
    "nightly": {
      "minFiles": 3900,
      "reason": "measured 3947, set-equal to the discovered universe — every capability group fanned out plus the 6 nightly-exhaustive files"
    }
  }
}
```

If prepush's floor is left at 3900, prepush is RED at the runner, not at
discovery. Land this in the same commit as the policy change.

---

## 2. `package.json` — replace the `find`-based capability blob

Current:

```json
"test:real-toolchain": "QUANTA_REAL_TOOLCHAIN_E2E=1 bun test $(find tests/unit -name '*-real-e2e.test.ts') --parallel=1",
```

One serial blob mixing a 600s upstream astropy clone/build and a live-Ollama
inference with bounded LSP probes, under one PASS line. Replace with the two
lanes TVH-03 asks for plus a group selector:

```json
"test:capability:pr": "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run tools/dev/run-capability-group.ts --lane=pr-required-deterministic --junit-out=.cache/capability-pr-junit.xml",
"test:capability:nightly": "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run tools/dev/run-capability-group.ts --lane=nightly-heavy --junit-out=.cache/capability-nightly-junit.xml",
"test:capability:group": "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run tools/dev/run-capability-group.ts",
"test:real-toolchain": "bun run test:capability:pr",
```

`tools/dev/run-capability-group.ts` does not exist yet and is NOT in TVH-03's
file ownership. It is ~40 lines and the manifest already gives it everything:

```ts
import { CAPABILITY_GROUPS, laneGatedGroups } from "./test-capability-manifest"
// --lane=<CapabilityLane> | --group=<id>, then for each selected group:
//   bun test <group.members…> --parallel=1 --reporter-outfile=<junit>
// then, per group:
//   bun run tools/dev/capability-result.ts --producer=<group.id> \
//       --junit=<junit> --out=.cache/capability-<group.id>.json
// exit non-zero when any group's capability-result fails
//   validateCapabilityResult({id, capability: {minimumExecutedFiles,
//   minimumExecutedCases}}, artifact)  // both numbers from
//   capabilityProducerFloors()
```

Only `lane-gated` groups may be run this way — `laneGatedGroups()` already
filters them. `declared-pending-gate` groups (browser, bwrap, docker-lima) must
NOT be selected until their owner lands a lane gate; running them today would
spawn Chrome at module load from a second place.

Also, `test`, `test:integration`, `test:full:ci`, `test:watch` and `test:cov`
still specify no tier, so they run the untier'd discovered manifest (3946
files, capability files included). Give each an explicit `--tier=`; TVH-02 owns
that row.

---

## 3. `tools/dev/gate-manifest.ts` — split the capability gate in two

Current entry (line ~186):

```ts
  {
    id: "real-toolchain-e2e",
    stage: "prepush",
    run: "QUANTA_REAL_TOOLCHAIN_E2E=1 bun run test:real-toolchain",
    why: "the `*-real-e2e.test.ts` lane — 43 cases that run in NO other gate, …",
    needsQuietBox: "real rust-analyzer/gopls/pyright indexing a fixture project. …",
  },
```

Replace with the deterministic-PR / nightly-heavy split TVH-03 calls for:

```ts
  {
    id: "capability-pr-deterministic",
    stage: "prepush",
    run: "bun run test:capability:pr",
    why: "the 7 PR-required capability groups (lsp-rust, lsp-go, lsp-pyright, lsp-typescript, node-runtime-cdp, js-test-runner, language-test-matrix) — 10 files that are deterministic once their toolchain is provisioned, and that now run in NO other gate because they were removed from ordinary pr/full membership",
    hostDependent:
      "each group degrades to a VISIBLE skip when its tools are absent; the per-group capability-result.v1 floor is what turns that into a failure in CI. Locally a PASS here means 'nothing I have was broken', not 'the groups hold'",
    needsQuietBox:
      "real rust-analyzer/gopls/pyright indexing a fixture project. MEASURED on this 16-core box: at load 52 evidence-lsp-bridge-real-e2e goes 1 pass / 1 fail (a starved server answers with an EMPTY hover); at load 3.9 it goes 2 pass in 5.2s",
  },
  {
    id: "capability-nightly-heavy",
    stage: "prepush",
    run: "bun run test:capability:nightly",
    notInWorkflow:
      "nightly-only by policy: a real upstream astropy clone+C-extension build (1,200s case timeout), five networked uv builds, a live local-model inference (measured 7.4s idle → 151.4s under load), and the native debuggers ubuntu-latest does not ship (clangd/lldb-dap/dlv/debugpy). Runs in verification-nightly.yml as a fan-out, never as a merge gate",
    hostDependent: "every arm is an external daemon, a network clone, or a debugger the runner may not have",
  },
```

…and in `GATE_CONTRACT` (line ~498) replace
`{ id: "real-toolchain-e2e", stage: "prepush" }` with the two ids above.
`MIN_OWNED.prepush` moves by +1 — TVH-02 owns that row and is replacing the
hard-coded floor with the exact id+stage set anyway.

**Do not** point either gate at `bun test $(find …)`. The ordinary tiers no
longer contain these files, so a `find` blob and the manifest can drift with
nothing noticing.

---

## 4. `tools/dev/run-test-shards.ts` — make `excluded` real in `--discover-only`

`emitDiscovery` spreads the discovered population, whose `excluded` is
hard-coded `[]`. So "PR runs 3,923 of 3,946" and "PR runs 3,923 and that is the
whole corpus" print identically. `tools/dev/test-tier-accounting.ts` (TVH-03,
new) computes this correctly today and can be run standalone; this wires the
same numbers into the runner's own output.

```diff
@@ tools/dev/run-test-shards.ts
 import {
   loadPolicyOverrides,
   policyDigest,
   resolveTestPopulation,
-  selectTestPoliciesForTier,
+  selectTierMembership,
+  assertTierAccounting,
+  type TierExclusion,
 } from "./test-policy"
@@
 const tierSelection = (
   relativeFiles: readonly string[],
   tier: RunnerOptions["tier"],
-): { readonly files: readonly string[]; readonly policySha256?: string } => {
-  if (tier === undefined) return { files: relativeFiles }
+): {
+  readonly files: readonly string[]
+  readonly excluded: readonly TierExclusion[]
+  readonly policySha256?: string
+} => {
+  if (tier === undefined) return { files: relativeFiles, excluded: [] }
   const overrides = loadPolicyOverrides(TEST_POLICY_OVERRIDES).overrides
   const policies = resolveTestPopulation(relativeFiles, overrides)
-  const selected = selectTestPoliciesForTier(policies, tier)
-  if (selected.length === 0) {
+  const membership = selectTierMembership(policies, tier)
+  // selected + excluded must reconstruct the universe EXACTLY, with a reason
+  // per excluded file. Throws on a short sum, a double count, a lost file, or
+  // a blank reason — a file that falls out of every tier is the one way this
+  // split can silently delete coverage.
+  assertTierAccounting(membership, relativeFiles)
+  if (membership.selected.length === 0) {
     throw new Error(`[test:shards] INVALID — tier=${tier} selected zero files`)
   }
   return {
-    files: selected.map(({ id }) => id),
+    files: membership.selected,
+    excluded: membership.excluded,
     policySha256: policyDigest(policies),
   }
 }
@@ const emitDiscovery
           name: `${selected.name}:${opts.tier}`,
           files: tiered.files,
+          excluded: tiered.excluded,
           digestSha256: digestFiles(tiered.files),
           policySha256: tiered.policySha256,
         }
```

`TierExclusion` is `{ path, reason }` — the same shape
`DiscoveredPopulation.excluded` already declares, so no schema change.

---

## 5. `tools/dev/verification-required-producers.ts` — per-group floors

**The manifest is now BOUND to this file, not parallel to it.** Every
`CapabilityGroup` carries a `producer` field that must be one of
`requiredProducerIds()`, and `validateCapabilityManifest()` rejects any other
value. `capabilityProducerFloors()` emits `{ id, producer, lane,
minimumExecutedFiles, minimumExecutedCases }` — the last two are exactly the
`CapabilityFloor` shape this file already validates against
`quanta.capability-result.v1`. No second schema was introduced.

Current rollup: all 11 lane-gated groups → `toolchain`; `contract-docker` and
`contract-lsp-lance` → `contract`; `pty` → `pty`; the three
`declared-pending-gate` groups (`browser`, `os-sandbox-bwrap`, `docker-lima`) →
`full-suite`, which is the honest answer because their members still execute in
the ordinary suite — and `full-suite` carries NO capability floor, i.e. their
execution is currently unprovable. `validateCapabilityManifest()` forbids a
lane-gated or out-of-band group from naming `full-suite` for that reason.

`PR_REQUIRED_PRODUCERS` carries three coarse capability rows, each with
`ZERO_EXECUTION_FLOOR` = 1 file / 1 case. That catches only "the job executed
literally nothing": a `toolchain` job where 16 of 17 files skipped and one ran
clears it. Replace the single `toolchain` row with one row per
`pr-required-deterministic` group:

```ts
import { capabilityProducerFloors } from "./test-capability-manifest"

const CAPABILITY_ROWS: readonly RequiredProducer[] = capabilityProducerFloors()
  .filter((floor) => floor.lane === "pr-required-deterministic")
  .map((floor) => ({
    id: floor.id,
    workflow: REQUIRED_WORKFLOW_PATH,
    job: `capability-${floor.id}`,
    capability: {
      minimumExecutedFiles: floor.minimumExecutedFiles,
      minimumExecutedCases: floor.minimumExecutedCases,
    },
  }))
```

Floors as declared today (files / cases): `lsp-rust` 3/4, `lsp-go` 1/2,
`lsp-pyright` 1/1, `lsp-typescript` 1/1, `node-runtime-cdp` 1/1,
`js-test-runner` 2/2, `language-test-matrix` 1/3 — summing to 10 files against
the coarse floor of 1, which
`tests/unit/dev/test-capability-lanes.test.ts` asserts is strictly tighter.

`pty` keeps its row but should take the manifest's `pty` group floor
(8 files / 8 cases), which is the "required PTY job can succeed with
PTY_AVAILABLE=false across all 8 files" hole TVH-03 names. `contract` likewise:
`contract-docker` 2/2 and `contract-lsp-lance` 3/3.

## 6. `.github/workflows/ci.yml` — required capability jobs

- One job per `pr-required-deterministic` group, id `capability-<group.id>`,
  each provisioning only its own `needs` (the manifest's `provision` string per
  need is the exact command family: `rustup component add rust-analyzer`,
  `go install golang.org/x/tools/gopls`, `npm i -g pyright`, …).
- Each job: `QUANTA_REAL_TOOLCHAIN_E2E=1 QUANTA_REQUIRE_CAPABILITIES=<group.id>
  bun run test:capability:group --group=<group.id>`.
  `QUANTA_REQUIRE_CAPABILITIES` is what turns an absent tool into RED —
  `tests/_helpers/capability-lane.ts` selects the real `describe` (not
  `describe.skip`) for a required-but-blocked group so its `beforeAll` throws.

  THE NAME IN THIS SECTION WAS WRONG. It said `QUANTA_REQUIRE_CAPABILITY`
  (singular), which is what the lane helper read while the receipt consumer read
  `QUANTA_REQUIRE_CAPABILITIES` (plural) with a different grammar. The two are
  now one name and one grammar — `1` for everything, or a comma list naming
  exactly the ids it names — and the singular does nothing. A job copied from
  the earlier version of this file armed NOTHING and reported a pass.

  RE-VERIFIED on this host under the surviving name, where `gopls` is absent:

      QUANTA_REAL_TOOLCHAIN_E2E=1 QUANTA_REQUIRE_CAPABILITIES=lsp-go \
        bun test tests/unit/evidence-lsp-bridge-go-real-e2e.test.ts
      → [capability] group=lsp-go … outcome=blocked-missing detail="absent on this host: gopls"
      → error: [capability] REQUIRED group lsp-go is blocked-missing … QUANTA_REQUIRE_CAPABILITIES
        names this group, so an absent capability is the failure, not a reason to pass.
      → 0 pass 1 fail

  PAIRED CONTROL, same file, switch unset: 0 pass 4 skip 0 fail. So the RED is
  the switch's doing and not the host's. (The counts differ because the switch
  names ONE group: the required group's cases are selected into the real
  `describe` and fail, and the file's other groups still skip.)

- Each job then publishes its artifact:
  `bun run tools/dev/capability-result.ts --producer=<group.id>
   --junit=.cache/capability-<group.id>-junit.xml
   --out=.cache/capability-<group.id>.json`.
- **Add a pre-build step for `js-test-runner`** so the test performs zero
  network I/O: install the pinned versions once into
  `$RUNNER_TEMP/js-fixtures/{jest,mocha}` and export
  `QUANTA_JS_RUNNER_FIXTURE_ROOT=$RUNNER_TEMP/js-fixtures`. Versions are
  `JS_RUNNER_FIXTURES` in the manifest (jest 29.7.0, mocha 10.8.2).
  `tests/_helpers/js-runner-fixture.ts` copies the prebuilt `node_modules` when
  that env is set and falls back to a bounded `npm install --save-exact` when it
  is not.
- `unsupported` platforms must be `not-selected` in the matrix, never a green
  job. `os-sandbox-bwrap` is Linux-only by declaration (`kind: "platform"`).

## 7. `.github/workflows/verification-nightly.yml` — capability fan-out

One job per `nightly-heavy` group: `native-debugger`, `python-native-build`,
`python-uv-build`, `local-model` (plus `browser`, `os-sandbox-bwrap`,
`docker-lima` once those lanes are gated). Independent timeout and artifact
each. Nightly must also set `REQUIRE_CONTRACT=1` and provision Python/Lance/LSP
for the contract groups — TVH-03 names nightly's lack of that as how the same
contract gate skips its way to green.

`receiptFields` per group is the list each job must attach beyond the tool
fingerprint. For `python-native-build` those are `upstreamRepo`,
`upstreamBaseCommit`, `pythonVersion`, `uvVersion`, `compilerAbi`,
`dependencyLockSha256`; the test already emits the first four and the base
commit verbatim from the fixture. `dependencyLockSha256` is emitted today as
`"<materialized per run: prepareProjectEnvSandbox>"` — see BLOCKER B below.

---

## 8. `tests/unit/tool/debug/debugpy-real-e2e.test.ts` — owned by the TVH-11 lane

TVH-03 registers this file in the capability manifest as a member of
`native-debugger` (lane `nightly-heavy`), so the shard runner now excludes it
from `prepush`, `pr` and `full`. What that file needs from its owner:

1. It is `nightly-heavy`, not PR-required — ubuntu-latest ships none of
   clangd / lldb-dap / dlv / debugpy.
2. Its `needs` are declared as: `python3` (binary), `debugpy` (module),
   `lldb-dap`, `clang++`, `clangd`, `dlv`, `cargo`, `go`. Note `clang` (not
   just `clang++`) and `xcrun` were added to `EXTERNAL_TOOLS` because this file
   resolves them; keep both names if the probes stay.
3. No module-load probe. `tests/_helpers/capability-lane.ts` exports
   `hasBinary` (PATH only, no subprocess), `hasLldbDap` (stats the two Xcode /
   CommandLineTools paths instead of running `xcrun`), `hasPythonModule`
   (bounded `python3 -c "import X"`, 5s) and `probeBounded` (every
   `Bun.spawnSync` with an explicit `timeout`). `Bun.spawnSync` DOES honour
   `timeout` on Bun 1.3.14 — verified: a 5s sleep under `timeout: 300` returns
   in 302ms with SIGTERM.
4. It must report through `capabilityGate` / `laneDescribe` /
   `assertCapabilityNotBlocked` / `reportExecuted` like its 16 siblings, or the
   `native-debugger` group's executed count will be short by one file and the
   group floor (4 files / 6 cases) will not be reachable.
5. `tests/unit/dev/test-capability-lanes.test.ts` asserts from source that every
   lane-gated member consults the lane gate; it currently passes because the
   file mentions `QUANTA_REAL_TOOLCHAIN_E2E`. Keep that true.

There is also an untracked scratch copy at
`tests/.tmp/tvh11-before/tests__unit__tool__debug__debugpy-real-e2e.test.ts`.
It is under `tests/` and would be picked up by a filesystem walk; it is not
git-tracked so the TVH-03 guards skip it, but it should be deleted before
landing.

---

## 9. Files whose tier membership TVH-03 deliberately did NOT change

Declared in the manifest as `membershipAuthority: "declared-pending-gate"`,
because they need the capability but do NOT yet carry a lane gate. Removing
them from ordinary membership would drop coverage silently.

| group | members | what its owner must land |
|---|---|---|
| `browser` | `tests/integration/browser-agent-loop-e2e.test.ts`, `browser-real-chrome-e2e.test.ts`, `browser-real-chrome-adversarial-e2e.test.ts` | a real lane gate. The TVH-11 `capability-receipt-consumer` work already removed the module-load Chrome spawn; once these are env-gated, flip the group to `lane-gated` and they leave PR automatically. |
| `os-sandbox-bwrap` | `tests/integration/os-sandbox-bwrap-real-exec-e2e.test.ts` | Linux-only declaration is already in the manifest; it needs a lane gate before it can be moved. |
| `docker-lima` | `tests/integration/docker-sandbox-e2e.test.ts` | consume a job-level daemon receipt instead of probing per file. |

`contract-docker`, `contract-lsp-lance` and `pty` are `out-of-band`: their
members are not under any `SUITE_ROOTS` entry, so there is no shard-runner tier
membership to change. They are declared so CI fan-out and the fingerprint see
them.

---

## BLOCKERS — not done, stated as blockers

**A. `test:real-toolchain` still runs the `find` blob.** `package.json` is not
TVH-03's file. Until item 2 lands, `bun run test:real-toolchain` still selects by
suffix. That is now only a COST problem, not a correctness one — the 16 rewritten
files spawn nothing at module load (measured: all 16 load in 829ms with the lane
off, emitting one typed `[capability]` line each) — but the astropy clone and the
live-model inference are still in the same serial blob as the bounded LSP probes.

**B. `dependencyLockSha256` for `python-native-build` is not a real lock.**
The astropy test emits `"<materialized per run: prepareProjectEnvSandbox>"`.
The sandbox resolves its dependency set per run through
`materializeProjectEnvPyproject`, so there is no lock file to hash without
changing `src/runner/batch/corpus/project-env.ts` — production code, outside
TVH-03's scope. The upstream repo, base commit, Python, uv and compiler ABI ARE
recorded. Closing this needs either a committed `uv.lock` per corpus repo or a
hash of the materialized pyproject, and it needs the project-env owner.

**C. `js-test-runner` still installs from the registry on a runner with no
pre-built fixture.** The install is now pinned (`jest@29.7.0`,
`mocha@10.8.2`), exact (`--save-exact`), bounded (180s, with the bun hook
timeout set strictly looser so the install's own deadline is what reports), and
inside `beforeAll` rather than module load. A genuinely offline lane needs the
CI pre-build step in item 6; `QUANTA_JS_RUNNER_FIXTURE_ROOT` is the hook and is
already implemented on the test side.

**D. `lint:debt` is RED at this HEAD, from another lane's files.** After
TVH-03, `worst complexity 0/0` and `noExcessiveCognitiveComplexity 0/0` —
TVH-03's own complexity regressions were refactored away (`defaultPolicy` and
`loadPolicyOverrides` split in `test-policy.ts`, the manifest validator split
into `shapeProblems`/`needProblems`, the coverage test's nested ternary replaced
by an exhaustive `Record<CapabilityNeed["kind"], …>`). The one remaining
regression is `lint/correctness/noUnusedVariables: 2 > 0` in
`tests/contract/lsp-pyright.test.ts` and `tests/contract/lsp-typescript.test.ts`
— the contract lane's files, not TVH-03's.
