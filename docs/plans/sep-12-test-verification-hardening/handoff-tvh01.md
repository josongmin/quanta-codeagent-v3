# TVH-01 handoff — worker HOME `~/Library` lend + browser receipt identity

Written by the TVH-01 implementer. **Report only: nothing in this document was
implemented.** `tools/dev/run-test-shards.ts`, `tools/dev/test-shard-receipt.ts`
and `tools/dev/external-toolchain.ts` are owned by the integrator lane and were
read, not edited.

Everything below is derived from the source at HEAD `85a99bb6f` plus the
integrator's in-flight working-tree changes, with file:line citations. Where a
claim could not be derived from code it is labelled as such rather than guessed.

---

## 0. The ticket's premise #3 is already half-closed — do not re-do it

TVH-01 says "모든 local shard worker가 scratch HOME 아래에 실제 사용자 `~/Library`
전체를 symlink한다". That is no longer true at HEAD.

`tools/dev/run-test-shards.ts:359 lendRealUserLibrary` delegates to
`tools/dev/worker-home.ts:52 userLibraryDecision`, which returns:

| decision | condition |
|---|---|
| `not-browser` | `resourceClass !== "browser"` — no symlink |
| `opted-out` | `QUANTA_TEST_NO_USER_LIBRARY=1` — no symlink |
| `lend` | browser chunk, not opted out — `symlinkSync(~/Library, <workerHome>/Library)` |

The decision is also printed per chunk (`run-test-shards.ts:423`,
`user_library=<decision>`). So "every worker gets the user's Library" is fixed;
what remains is narrower and is stated below.

---

## 1. What is still wrong with the lend

### 1.1 `browser` is a source-regex class, not a "spawns Chrome" class

`tools/dev/test-shard-plan.ts:163` classifies a file as `browser` when its
SOURCE matches `/puppeteer|playwright|chromium|--headless|REAL_CHROME/i`.
Measured on the current tree:

**13 files classify `browser`:**

```
tests/integration/browser-agent-loop-e2e.test.ts
tests/integration/browser-real-chrome-adversarial-e2e.test.ts
tests/integration/browser-real-chrome-e2e.test.ts
tests/unit/browser-cdp-adapter-hellgate.test.ts
tests/unit/cli/lifecycle-pills.test.ts
tests/unit/cli/mcp-pill-live-refresh-hellgate.test.ts
tests/unit/mcp-cmd.test.ts
tests/unit/mcp-surface-wire.test.ts
tests/unit/multi-voter-hellgate.test.ts
tests/unit/prompt-system.test.ts
tests/unit/src-no-sketchy-code.test.ts
tests/unit/test-shard-plan.test.ts
tests/unit/verify-signal.test.ts
```

**3 of them construct the real CDP browser** (`defaultProcessSpawner`, the only
spawner that starts a process):

```
tests/integration/browser-agent-loop-e2e.test.ts
tests/integration/browser-real-chrome-adversarial-e2e.test.ts
tests/integration/browser-real-chrome-e2e.test.ts
```

The other ten match the detector on a string literal — `tests/unit/test-shard-plan.test.ts`
matches because it *tests the detector*, and `tests/unit/src-no-sketchy-code.test.ts`
because it names the tokens in a scan. Each of those ten chunks still receives a
symlink to the developer's entire `~/Library` for a browser it never starts.

**Recommended change (worker-home / planner, integrator-owned):** make the lend
depend on "this chunk actually launches Chrome", not on the class name. Two
options, in preference order:

1. **Declared capability.** `tools/dev/test-policy.ts` already carries
   `requiredCapabilities` / `capabilityLane` (in flight). A file that needs a
   real Chrome declares it; `lendRealUserLibrary` keys off the declaration.
   This makes the local/hosted difference an explicit capability, which is
   TVH-01's own completion criterion #4.
2. **Narrow the detector to the construction site.** `defaultProcessSpawner`
   together with `createCdpBrowser` is the exact predicate — it selected 3/3 in
   the measurement above with no false positives. Keep `browser` as the
   *serialization* class (exclusivity is about the shared Chrome resource and
   should stay broad) and introduce a separate `launchesRealChrome` predicate
   that only the lend consults. Do not conflate the two: narrowing the
   serialization class would let a real-Chrome file run concurrently with
   another one, which is a different regression.

Either way the ratchet to land with it: a test asserting the lent set is a
subset of the real-spawn set, with both sets derived from source rather than
listed by hand, plus a floor so an empty derivation cannot read as "nothing
needs the Library".

### 1.2 The lend is still the whole `~/Library`

Even for the 3 real-Chrome files, `symlinkSync(join(homedir(), "Library"), …)`
(`run-test-shards.ts:366-368`) exposes Keychains, Mail, Messages, Safari,
Cookies, and every application's Application Support to a worker whose tests
routinely spawn shells. If the lend survives at all it should be a per-subtree
bind of only the paths measured load-bearing, and must never include
`Keychains`, `Mail`, `Messages`, `Safari`, `Cookies`, `Group Containers`, or
`Application Support` entries other than Chrome's own.

---

## 2. What a worker HOME actually requires — derived from the code

`run-test-shards.ts:412-422` creates exactly four directories per worker, and
`:454-463` sets the env that points at them:

| path | env | created at | under HOME? |
|---|---|---|---|
| `<worker>/tmp` | `TMPDIR` | `:418` | no |
| `<worker>/home/.quanta` | `QUANTA_HOME` | `:419` | **yes** |
| `<worker>/prefs-home` | `QUANTA_PREFS_HOME` | `:421` | no |
| `<worker>/bench-results` | `QUANTA_BENCH_RESULTS_DIR` | `:422` | no |

`HOME` itself is `<worker>/home`, and it is never `mkdir`ed directly — it exists
only as a side effect of `mkdirSync(quantaHome, { recursive: true })`.

**So the minimum a worker HOME requires, from this repository's own code, is one
directory: `.quanta`.** Every other directory the repo needs is redirected by an
explicit env var to a sibling *outside* HOME. That is the derived answer to
"what minimum directories does a worker HOME actually require".

The Chrome profile is **not** among them. `src/browser/cdp-adapter/lifecycle-ops.ts:93-101`
launches Chrome as:

```
<bin> --headless=new --remote-debugging-port=0 --user-data-dir=<profileRoot>/<id>
      --no-first-run --disable-gpu --no-default-browser-check
```

`profileRoot` is supplied by the caller, and the three real-Chrome suites pass a
`mkdtempSync(join(tmpdir(), …))` directory that they `rmSync` in `afterAll` —
i.e. the disposable versioned profile the ticket asks for already exists at the
adapter boundary, keyed by `cdp-<seq>-<pid>-<uuid>` and `rmrf`ed on close and on
every bring-up failure path (`lifecycle-ops.ts:86-90`).

**What the lend is actually for cannot be derived from this repository.** The
only evidence in-tree is the measurement recorded in `worker-home.ts:1-24` and
`run-test-shards.ts:329-339`: a raw CDP probe completed `Page.navigate` 2/6
times under a cold HOME and 6/6 with the real Library lent in, and an EMPTY
Library skeleton measured like no Library at all. That last result is the useful
one: it rules out "the directory must exist" and says the *contents* matter, so
the minimum set is a measurement, not a reading. The bisect I would run, in this
order (most likely first, each one lent alone, six navigate attempts per arm):

1. `~/Library/Application Support/Google/Chrome` (host-level Chrome state that
   lives outside `--user-data-dir`: component updater, crashpad, metrics)
2. `~/Library/Caches/Google/Chrome` and `~/Library/Caches/com.google.Chrome`
3. `~/Library/HTTPStorages/com.google.Chrome`
4. `~/Library/Preferences/com.google.Chrome.plist`
5. `~/Library/Saved Application State/com.google.Chrome.savedState`

If none of those restores 6/6, the mechanism is not file state and the lend is
covering for something else (a TCC/code-signing prompt, or a first-run network
call) — in which case the fix is a launch flag or a signed disposable profile,
not a Library at all. Either outcome is a receipt worth having; the current
state is a workaround with no bounded justification.

---

## 3. Browser receipt identity

### 3.1 What the shard receipt hashes today

`tools/dev/test-shard-receipt.ts:150 testToolchainSha256` hashes:

```
{ bun, bunRevision, nodeCompatibility, platform, arch, externalTools }
```

where `externalTools = externalToolchainFingerprint()` — and that function
(`tools/dev/external-toolchain.ts:148-155`) maps over `EXTERNAL_TOOLS` only,
which is a list of **PATH** names. On macOS, Chrome is an app bundle and is not
on PATH under any of `chromium`, `chromium-browser`, `google-chrome`,
`google-chrome-stable`, so all four fingerprint as `<missing>` — the same value
a Linux box with no browser reports.

The integrator's in-flight change already adds `EXTERNAL_TOOL_PATHS` (the two mac
bundle paths) and `hostCapabilityFingerprint()` (`external-toolchain.ts:295-299`)
which includes them. **But `test-shard-receipt.ts:4` still imports
`externalToolchainFingerprint`, not `hostCapabilityFingerprint`.** So as the
working tree stands, the shard receipt still carries nothing about the Chrome
binary the adapter actually resolves. That is the smallest real fix and should
land first.

### 3.2 What I believe the correct identity is

Add a `browserRuntimeSha256` to `TestShardCacheIdentity` and to the field list in
`testShardCacheIdentitySha256` (`test-shard-receipt.ts:167-182`). It should be
the literal string `"n/a"` for chunks whose `resourceClass !== "browser"` — a
Chrome upgrade must not invalidate 43 pure chunks — and otherwise the hash of:

1. **The resolved binary, resolved the way the adapter resolves it.**
   `src/browser/cdp-adapter/deps.ts:40-51` walks `DEFAULT_CHROME_CANDIDATES` on
   PATH and then `DEFAULT_MAC_CHROME_PATHS` on disk. The fingerprint must use
   the same order and stop at the same entry, or it identifies a browser the
   tests do not run. Value shape: the existing
   `fingerprintPath` (`path dev:ino size mtime`), which already handles the
   "rebuilt binary, same version string" case. A drift guard keeping the two
   candidate lists in lockstep already exists
   (`tests/unit/dev/external-toolchain-coverage.test.ts`) — extend it rather
   than adding a third list.

2. **The launch-flag set**, from `lifecycle-ops.ts:93-101`. `--headless=new`
   becoming `--headless=old`, or `--disable-gpu` disappearing, changes what a
   green covered while every other input stays identical. Hash the flag array
   with the `--user-data-dir` value replaced by a placeholder (it is a fresh
   mkdtemp path every run and would make the receipt always miss).

3. **A profile SCHEMA version owned by the adapter** — a constant exported from
   `src/browser/cdp-adapter/lifecycle-ops.ts` (or `deps.ts`), bumped by hand when
   the profile layout the adapter creates or expects changes. The ticket asks for
   "browser profile schema가 바뀌면 miss"; a schema has no on-disk fingerprint
   before Chrome starts, so a declared constant is the only honest form. Pair it
   with a comment naming what a bump means, or it will rot.

4. **The `userLibraryDecision` value for the chunk** (`lend` / `not-browser` /
   `opted-out`). This is the one that makes the local/hosted lanes distinguishable:
   a green earned WITH the user's Library lent in must not replay on a run that
   opted out, and vice versa. It is a three-valued string already computed at
   `run-test-shards.ts:420` — the receipt just has to carry it.

**Explicitly NOT in the identity:** any hash of the user's `~/Library`. It is
unbounded, changes continuously for reasons unrelated to the tests, would make
every browser receipt a guaranteed miss, and is user data the receipt has no
business recording. The ticket says the same thing.

### 3.3 The wiring proof to demand before this is called done

Each of these must be an executed assertion, not a comment:

- Point `DEFAULT_MAC_CHROME_PATHS` at a copy of the binary with a different
  mtime → a previously-valid **browser** receipt MISSES, and a **pure** receipt
  from the same run still HITS. (The paired control is the point: without it the
  change is indistinguishable from making everything miss.)
- Bump the profile-schema constant → browser receipt MISSES.
- Flip `QUANTA_TEST_NO_USER_LIBRARY` between the recording run and the replay →
  browser receipt MISSES, pure receipt HITS.
- Remove Chrome entirely → the browser identity moves to `<missing>` and misses,
  rather than silently replaying a green earned with a browser present. The
  absence-is-a-value discipline already documented in
  `external-toolchain.ts:13-16` is the right model.

---

## 4. What TVH-01 did land, for context

- `tests/_helpers/repo-root.ts` — marker-based repository-root resolution
  (root `package.json` whose `name` is `quanta-codeagent`), plus
  `bunEntryArgv(relativePath, args)` which builds and existence-checks the exact
  `["bun", <entry>, …]` argv the subprocess suites spawn.
- The three suites that carried `/Users/songmin/quanta-codeagent-v3` now use it.
- `tests/unit/repo-root-portability.test.ts` — argv identity across an arbitrary
  cwd (child processes, no global `chdir`) and across a mirrored checkout at a
  different absolute prefix.
- `tests/integration/browser-real-chrome-adversarial-e2e.test.ts` — the
  `/ssrf-page` fixture no longer touches the real link-local IMDS address. A
  second loopback origin plays the metadata service; attempt / blocked / leaked
  are all deterministic and all asserted, including a positive leak control that
  makes the "no leak" assertion falsifiable for the first time.
- `tests/unit/hitl-tier-dispatch.test.ts:256` — **outside the ticket's listed
  file set**, fixed anyway because it turned out to be load-bearing, not inert
  data: that case drives the production `readTool` against `package.json` with
  the hard-coded checkout as `cwd`. Measured by substituting a foreign prefix —
  the case goes RED (`res.ok` false). Now `cwd: REPO_ROOT`. Revert freely if
  another lane owns that file; the defect is real either way.
- `tests/_helpers/link-local-usage.ts` + `tests/unit/link-local-network-use-guard.test.ts`
  — an AST/call-site guard that fails a test which uses a link-local or
  cloud-metadata address as a network target, while leaving the ~101 legitimate
  classifier-input literals across 19 files green. Enrolled in
  `tools/dev/scan-reach-baseline.json` and `tools/dev/scan-enrollment-debt.json`.

Two absolute-path hits were evaluated and deliberately LEFT: the two
`resultPreview` payloads in `tests/unit/kernel/kernel-scheduler.test.ts`
(inert — substituting a synthetic value on both sides keeps the file 6/6 green)
and the `"cwd"` provenance field in `tests/smoke/localize/*.json` (written by
`measure.ts:277` as a record of where a past calibration ran; nothing reads it
back, and rewriting it would falsify the record).

**The guard's scope is `tests/**/*.ts` and `src/**/*.test.ts`.** If the
integrator moves worker/browser fixtures into `tools/`, that corpus is not
covered and a third scan root should be enrolled the same way.

---

## 5. Pre-existing red found while verifying (not mine, not fixed)

`bun test tests/unit/_arch/scan-enrollment-ratchet.test.ts` is RED at HEAD for
`tests/unit/_arch/scan-population-floor-hellgate.test.ts`, which calls
`assertScanPopulation` but owns no id in `scan-enrollment-debt.json`. Confirmed
pre-existing by re-running the ratchet with the HEAD versions of both ledger
files restored: the failure names that file with and without my rows. It belongs
to whoever owns the scan-population helper.
