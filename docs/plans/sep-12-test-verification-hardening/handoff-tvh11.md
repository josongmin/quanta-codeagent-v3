# TVH-11 handoff — capability receipt producer + module-load effect guard

Status: **implemented, uncommitted, unwired.** Every test file listed below is
correct *today* without any runner change — absent a receipt the consumer
returns a typed `blocked-missing`, which is a visible skip, never a pass and
never a spawn. The wiring below is what turns those skips back into executions.

## 1. What landed

| file | role |
| --- | --- |
| `tools/dev/capability-receipt.ts` | `quanta.capability-receipt.v1` schema, mint, validate. Pure. |
| `tools/dev/capability-probe-producer.ts` | the ONLY module allowed to spawn to answer "can this host do X?". Parallel candidates, one total deadline, loser kill+drain, every timer cleared. CLI included. |
| `tools/dev/capability-receipt-consumer.ts` | the test-side half. `readFileSync` + `statSync` only — no spawn, no socket, no network. |
| `tools/dev/capability-callsites.ts` | AST extraction of `capability("<id>")` calls, for the bidirectional drift guard. |
| `tools/dev/module-load-effects.ts` | AST detector: module-load external effects, scope-aware. Pure. |
| `tools/dev/module-load-effect-guard.ts` | corpus + allowlist enforcement, CLI, `--write-baseline`. |
| `tools/dev/module-load-effect-allowlist.json` | the frozen pre-existing inventory (150 entries, ceiling 150, shrink-only — the ceiling walks DOWN with the inventory, so a fix by another lane is banked rather than leaving slack). |
| `tools/dev/preload-closure-probe.ts` | the `meta-runtime` producer: one invocation, both runtime probes, one small artifact. |
| `tests/unit/_arch/module-load-effect-guard.test.ts` | enforcement + paired controls + red-on-injection + the three-way drift guard. |

Fourteen test files were made inert at module load; see §5.

## 2. Runner wiring I need (the integrator's call sites)

### 2a. Produce the capability receipt once per tier, before any test module loads

```sh
bun tools/dev/capability-probe-producer.ts \
  --tier   "$TIER" \
  --head   "$(git rev-parse HEAD)" \
  --out    "$RECEIPT_PATH" \
  --total-deadline-ms 60000 \
  [--chrome --chrome-profile-root "$(mktemp -d)"]
```

It prints the receipt path, one line per capability, and the two exports below.
Exit is always 0: an unreachable capability is a *value* in the receipt
(`unavailable` / `probe-timeout`), not a producer failure.

Then hand both variables to every test process in the tier:

```sh
export QUANTA_CAPABILITY_RECEIPT="$RECEIPT_PATH"
export QUANTA_CAPABILITY_BINDING="<bindingSha256 printed by the producer>"
```

- `QUANTA_CAPABILITY_RECEIPT` alone is enough to make the receipt usable.
- `QUANTA_CAPABILITY_BINDING` is the fail-closed half: the consumer refuses a
  receipt whose `bindingSha256` differs, **before** any test decides to do
  anything. Set it whenever the runner knows what it minted.
- The consumer *also* recomputes the toolchain fingerprint locally
  (`external-toolchain.ts`, `statSync` only) and refuses a receipt whose
  `toolchainSha256` moved. That check needs no env at all.

`--chrome` is opt-in because it performs a real CDP bring-up (≈4s here). Pass it
for any tier that schedules `tests/integration/browser-*`; without it,
`chrome-cdp` is absent from the receipt and the browser suites report
`blocked-missing` (a visible skip), never a silent green.

In CI, also set `QUANTA_REQUIRE_CAPABILITIES=1` on a tier that is *supposed* to
have the capabilities: `blocked-missing` and `failed-setup` then THROW instead of
skipping, matching the contract `tests/contract/_guard.ts` already established.

### 2b. Produce the `meta-runtime` artifact (optional but strongly worth it)

```sh
bun tools/dev/preload-closure-probe.ts --out "$META_ARTIFACT"
export QUANTA_PRELOAD_CLOSURE_ARTIFACT="$META_ARTIFACT"
```

Measured: `tests/meta/preload-runtime-closure-hellgate.test.ts` spawns **2 child
`bun` processes** without it (in `beforeAll`, after discovery) and **0** with it.
All 9 cases pass in both configurations.

### 2c. Wire the static guard into a gate

```sh
bun tools/dev/module-load-effect-guard.ts     # exit 1 on any violation
```

The enforcement also runs as `tests/unit/_arch/module-load-effect-guard.test.ts`,
so a gate entry is optional — but the CLI prints the anti-vacuum counters
(`files=… effects=… violations=…`) which a gate log should carry.

After a rebase that lands new test files, `--write-baseline` re-inventories
without letting the debt grow:

```sh
bun tools/dev/module-load-effect-guard.ts --write-baseline
```

It **refuses** to write a baseline larger than the existing ceiling, printing the
new sites instead; and when the inventory SHRINKS (another lane fixed a file) it
walks the ceiling down with it, so the win is banked rather than left as slack a
future regression could occupy silently. Raising `maxEffects` stays a
deliberate, reviewable edit to the JSON.

## 3. Reconciliation with TVH-03 (read this before changing either side)

There are **not** three capability schemas. There are two halves of one:

- `tests/_helpers/capability-lane.ts` + `tools/dev/capability-result.ts`
  (TVH-03) own **reporting**: what a lane DID, reduced into
  `quanta.capability-result.v1` for the required aggregator.
- `tools/dev/capability-receipt*.ts` (TVH-11) own **discovery**: whether the
  capability is there, answered ONCE per tier so test modules stop probing at
  import.

They share the vocabulary exactly. `CapabilityVerdict` is member-for-member
identical to `CapabilityOutcome` (`executed | skipped-unsupported |
blocked-missing | failed-setup`), and
`tests/unit/_arch/module-load-effect-guard.test.ts` holds:

- a **compile-time** exact-equality assertion between the two unions (a rename
  on either side is a `typecheck:all` failure, not a silent second dialect), and
- a **runtime wiring proof** that constructs a `CapabilityResult` from each
  verdict and hands one to the real `reportCapability`.

Capability **ids are the manifest's `needs[].id`**, not a private namespace —
`typescript-language-server`, `pyright-langserver`, `python3`, `debugpy`,
`lldb-dap`, `cargo`, `node`, `git`, `clang`, `ast-grep`, `lancedb`, plus
`chrome-cdp` for the bring-up that no `needs` entry can express. A bidirectional
drift guard fails when the corpus asks for an id nothing probes, or the producer
probes an id nothing asks for.

`tools/dev/test-capability-manifest.ts` already says what this implements:

- `contract-lsp-lance` — *"the group exists so the probe happens ONCE per job
  and the files consume its receipt."* That is §2a + the three contract files.
- `browser` — `membershipAuthority: "declared-pending-gate"`, *"These files
  spawn at MODULE LOAD with no lane env gate, so the runner cannot move them
  until that gate exists."* **That gate now exists.** Once §2a is wired, the
  browser group can move to `lane-gated`; the measured module-load deltas are
  0 process / 0 port / 0 temp dir (§5).

## 4. What I did NOT do, and why

- **No runner/gate/manifest edits.** `run-test-shards.ts`, `gate*.ts`,
  `test-policy*.ts|json`, `test-capability-manifest.ts`, `package.json` and the
  workflows are other owners'. Everything above is a call site for them.
- **No `meta-runtime` resource class.** It belongs in
  `tools/dev/test-shard-plan.ts` (`TEST_RESOURCE_CLASSES` +
  `CLASS_SOURCE_DETECTORS`), which is not mine. The producer and the artifact
  contract exist; the class declaration is one line for the scheduler owner.
  **Note:** `CLASS_SOURCE_DETECTORS` matches `REAL_CHROME` to put
  `browser-agent-loop-e2e.test.ts` in the `browser` class. I kept the
  `REAL_CHROME_RAN` identifier for exactly that reason — renaming it silently
  reclassifies the file into a chunk that overlaps 135 CPU-hungry peers.
- **`tests/unit/tool/glob-gitignore-mtime.test.ts`** (the non-hellgate sibling)
  still does `mkdtempSync` + `git init` inside its `describe` body. It is not in
  the TVH-11 file list; it is in the frozen baseline and is the cheapest
  remaining burndown item (same fix as its hellgate sibling, ~10 lines).
- **Timing telemetry** (`discoveryStart` / `firstCaseStart` / `moduleLoadMs` /
  `cleanupMs`, ticket item 5) is runner-side and was not in my file list.

## 5. Measured module-load deltas (per file, HEAD → fixed)

Instrumentation, all four channels around a bare `await import()`:

1. **PATH-shim spawn census** — one log line per child process created. Needed
   because a synchronous `execSync`/`spawnSync` is born and reaped between two
   `ps` samples and is invisible to a concurrent-process census.
2. **`ps` descendant census**, end-state *and* peak-sampled at 150ms, so a probe
   that spawns Chrome and closes it before returning is still counted.
3. **`lsof` LISTEN census** scoped to the probe pid.
4. **Temp-dir census under an isolated `TMPDIR`**, so every entry is
   attributable rather than statistical (this host runs >100 foreign processes
   that churn `/private/tmp` continuously). A same-run idle control window of
   equal length reads 0/0/0/0.

| file | HEAD proc / port / tmp / spawns | fixed | HEAD import ms | fixed import ms |
| --- | --- | --- | --- | --- |
| `browser-agent-loop-e2e` | **+11** / **+1** / **+1** / 0 | 0 / 0 / 0 / 0 | 2538 | 943 |
| `browser-real-chrome-e2e` | 0 (**peak +14**) / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 3918 | 9 |
| `lance-real-wire` | 0 / 0 / 0 / **1** | 0 / 0 / 0 / 0 | 2478 | 292 |
| `lsp-typescript` | 0 / 0 / 0 / **2** | 0 / 0 / 0 / 0 | — | — |
| `lsp-pyright` | 0 / 0 / 0 / **2** | 0 / 0 / 0 / 0 | — | — |
| `debugpy-real-e2e` | 0 / 0 / 0 / **1** (`xcrun -f lldb-dap`, lane OFF) | 0 / 0 / 0 / 0 | — | — |
| `glob-gitignore-mtime-hellgate` | 0 / 0 / **+1** / **1** (`git init -q`) | 0 / 0 / 0 / 0 | — | — |
| `sphinx-ra-shim` | 0 / 0 / 0 / **1** (`python3 -c …`) | 0 / 0 / 0 / 0 | — | — |
| `cha-multisite-hellgate` | 0 / 0 / 0 / **1** (`python3 --version`) | 0 / 0 / 0 / 0 | — | — |
| `project-env-snapshot-wiring-hellgate` | 0 / 0 / 0 / **1** (`git --version`) | 0 / 0 / 0 / 0 | — | — |
| `ast-grep-bugs-hellgate` | 0 / 0 / 0 / **1** | 0 / 0 / 0 / 0 | — | — |
| `ast-grep-scenarios` | 0 / 0 / 0 / **1** | 0 / 0 / 0 / 0 | — | — |
| `ast-grep-e2e-hellgate` | 0 / 0 / 0 / **1** (`which ast-grep`) | 0 / 0 / 0 / 0 | — | — |
| `preload-runtime-closure-hellgate` | **2 child `bun`**, one during COLLECTION | 2 in `beforeAll`; **0** with the artifact | — | — |

`preload-runtime-closure` is measured differently on purpose: bun defers a
`describe` callback when a module is imported dynamically, so an import probe
cannot see a describe-body effect. It is measured by running `bun test` on the
file itself and counting shimmed child `bun` invocations.

## 6. Pre-existing failures I measured and did NOT cause

Two suites fail when they finally EXECUTE. Both were attributed by running the
unmodified `git show HEAD:` version of the same file side by side, so neither is
a TVH-11 regression — they were simply never observed before, because at HEAD
the module-load probe decided availability and then the file failed quietly in a
lane nobody ran focused.

| suite | HEAD (unmodified) | with TVH-11 | verdict |
| --- | --- | --- | --- |
| `tests/contract/lance-real-wire.test.ts` | 0 pass / **2 fail** (35.98s) | 0 pass / **2 fail** (35.34s) | identical; the receipt resolves the SAME interpreter HEAD did (`/opt/homebrew/opt/python@3.11/…/python3.11`). Named failure: *"real Lance-backed wire keeps stale-chunk cleanup restart-safe when QUANTA_INDEX_DB_PATH is set"*. **Pre-existing; needs an owner.** |
| `tests/unit/tool/debug/debugpy-real-e2e.test.ts` (lane ON) | 17 pass / **4 fail** (229.55s) | 17 pass / **4 fail** (232.17s) | identical, same four cases: three `lldb-dap` C arms at a 40,000ms timeout and the Rust arm at 90,000ms, on a box at load >100. **Host pressure, pre-existing.** The receipt resolves the same adapter path `xcrun -f lldb-dap` returns. |

## 7. Known sharp edges

- The receipt is **per tier**, and its TTL is capped at 6h with the duration
  itself validated as schema — an edited `expiresAtMs` cannot buy more.
- `chmod 0444` on the written receipt is intent, not security; it stops an
  accidental in-run edit, not a determined one.
- The producer's chrome probe brings a session up **and closes it**. A probe
  that left Chrome running would be the double-spawn defect wearing a new hat.
- `ast-grep` is absent on the dev box used here, so the ast-grep suites report
  `skipped-unsupported` for the binary arms. That is a *probed* absence and is
  distinct from `blocked-missing`; the inverted "binary absent" arms gate on
  proven absence, so with no receipt BOTH directions skip rather than one of
  them guessing.
