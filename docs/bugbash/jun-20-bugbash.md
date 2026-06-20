# Jun-20 Bug Bash — 6/16~6/17 변경 파일 적대 어딧

> 9-클러스터 병렬 어딧 워크플로우 결과. 6/16~6/17 커밋 52개 + 미커밋 WIP 대상.
> 각 finding은 독립 skeptic verifier로 적대 재검증함.
> **33건 surfaced = 31 actionable + 2 none-retained**
> (raw 37 → 적대 검증으로 4건 false-positive 드롭 → 33 surfaced. 그중 2건은 검증이 corrected_severity=none으로 깎은 retained-note라 actionable 아님.)
> 살아남은 HIGH 0개 (검증이 high 4건 중 2건을 med로 강등, 2건을 FP/none으로 기각).

## Snapshot (재현 기준)

| 항목 | 값 |
|------|----|
| Audited commit | `8b3f5371` (`8b3f537139da90e82fb1ca474828c7dd68e685a1`) |
| Branch | `main` |
| Worktree at audit | dirty WIP (그 후 위 커밋으로 커밋됨) |
| Worktree now (pin) | clean = `true` |
| Workflow run | `wf_3382e300-4ae` |

> 모든 `file:line` 인용은 **위 핀 커밋 기준**으로 유도됨 (`git show 8b3f5371:<file>` 에서 unique anchor 탐색).
> 라인은 손으로 적지 않고 SSOT JSON의 anchor에서 파생되며, `tests/unit/bugbash-doc-integrity-hellgate.test.ts` 가 doc↔코드 정합을 강제한다.
> Audit ran against a dirty WIP working tree; those WIP files are now committed into the pinned HEAD. Citations are resolved against this pinned commit, not the live tree.

## 요약

| 등급 | 개수 | 의미 |
|------|------|------|
| 🟠 MED | 7 | actionable |
| 🟡 LOW | 24 | actionable |
| ⚪ NONE | 2 | retained-note (검증이 by-design/consequence-반증으로 기각; 참고용) |
| **actionable 합** | **31** | |

## 인덱스

| # | 등급 | 분류 | 인용 (pinned) | 제목 |
|---|------|------|------|------|
| [1](#1) | 🟠 med | dead-code | `src/agent/primary-rail/index.ts:74` | decidePrimaryRailFinishGate (the documented false-green killer) has ZERO production callers |
| [2](#2) | 🟠 med | correctness | `src/permission/permission-store.ts:775` | mergeWithDisk callback reassigns live `state` from a pre-await snapshot, dropping mutations that interleave during the flush IO window |
| [3](#3) | 🟠 med | silent-failure | `src/apps/bench/analyze/cost.ts:96` | Cost fallback sums only the FIRST attempt's tokens for Best-of-N runs (undercount) |
| [4](#4) | 🟠 med | silent-failure | `src/agent/lsp-bridge.ts:170` | Availability probe caches a transient failure as a permanent process-wide 'LSP dead' |
| [5](#5) | 🟠 med | silent-failure | `src/apps/bench/remote/ec2.ts:137` | ensureSecurityGroup treats a describe FAILURE (network/creds) as 'SG not found' and tries to create |
| [6](#6) | 🟠 med | silent-failure | `src/apps/bench/eval/driver.ts:287` | Production SDK driver never emits `knobs_applied` telemetry (split-brain with runner driver) |
| [7](#7) | 🟠 med | efficiency | `src/runner/batch/eval/selection-executor.ts:404` | earlyAccept re-runs every hard-gate probe twice per candidate (double pytest/repro materialization) |
| [8](#8) | 🟡 low | silent-failure | `src/runner/batch/eval/closure-session.ts:59` | Gate stakes/uncertainty signals hard-coded to false at the only assembly site, neutering the anti-under-verify arm |
| [9](#9) | 🟡 low | dead-code | `src/runner/batch/eval/driver.ts:2824` | decideEscalation result is computed post-repair and only stored as telemetry; never widens the search |
| [10](#10) | 🟡 low | silent-failure | `src/agent/verification-plan/extract-issue-declared-expected.ts:31` | EXPECT_RE pre-gate is strictly narrower than EXPECT_LITERAL_RE, silently dropping valid declared outputs |
| [11](#11) | 🟡 low | jank | `src/agent/verification-plan/extract-issue-declared-expected.ts:112` | Comment claims EXPECT_RE pre-check is a harmless intent-marker, but it actively suppresses matches |
| [12](#12) | 🟡 low | efficiency | `src/observability/metrics/in-memory-registry.ts:477` | snapshot() is O(series) allocation on every call and the `series` Map has no per-metric series cap |
| [13](#13) | 🟡 low | silent-failure | `src/observability/metrics/in-memory-registry.ts:328` | Sink send/flush failures are silently swallowed with no rate-limited error counter |
| [14](#14) | 🟡 low | dead-code | `src/runner/batch/eval/knobs-bench.ts:403` | `sotaOn` posture field is computed but has zero production consumers (dead telemetry field) |
| [15](#15) | 🟡 low | jank | `tests/unit/bench-sota-preset-hellgate.test.ts:44` | SOTA hellgate test comments describe a `sotaOn \|\|` / `sotaOn ? :` composition that no longer exists in benchPostureFromState (stale red-on-injection claims, lost teeth) |
| [16](#16) | 🟡 low | jank | `src/config/knob-inventory.ts:1177` | readSite for the 8 NOOP-bench closure knobs points at the NOOP knob-declaration file, not the effect site (driver.ts), so /knobs mis-routes an operator debugging 'why is this on' |
| [17](#17) | 🟡 low | efficiency | `src/apps/bench/index.ts:141` | Dataset JSONL parsed 3× per run (and again for dry-run plan) |
| [18](#18) | 🟡 low | jank | `src/apps/bench/cli.ts:223` | --max-workers accepts negative / zero and ships it verbatim to remote --max_workers |
| [19](#19) | 🟡 low | correctness | `src/apps/bench/cli.ts:1577` | --skip-resolved casts resolved_ids to string[] without filtering non-strings |
| [20](#20) | 🟡 low | correctness | `src/agent/lsp-bridge.ts:576` | Hand-rolled `uri.replace(/^file:\/\//,"")` mishandles URL-encoded paths instead of using fileURLToPath |
| [21](#21) | 🟡 low | silent-failure | `src/agent/lsp-bridge.ts:192` | Import-probe line cap silently marks a file 'verified-ready' when imports live past line 200 |
| [22](#22) | 🟡 low | dead-code | `src/apps/bench/remote/pool.ts:791` | Unreachable lease-release after handleChunkBudgetWaitError (which is `: never`) |
| [23](#23) | 🟡 low | correctness | `src/apps/bench/remote/box-session.ts:854` | runId flows unquoted into remote ssh commands with no boundary sanitization (shell-injection defense-in-depth gap) |
| [24](#24) | 🟡 low | correctness | `src/apps/bench/remote/box-session.ts:141` | stripToAccessToken silently drops account fields whose absence may make the shipped token unusable, only guarding access_token |
| [25](#25) | 🟡 low | silent-failure | `src/apps/bench/auth-pool/load.ts:13` | defaultAuthFile falls back to filesystem root when HOME is unset |
| [26](#26) | 🟡 low | god-code | `src/apps/bench/remote/box-session.ts:1932` | gradeChunkOnBox + box-session.ts is a 600+ line module mixing lifecycle, snapshot telemetry, brittle remote python probe, verdict parsing, and command construction |
| [27](#27) | 🟡 low | duplication | `src/apps/bench/eval/driver.ts:338` | Two drivers diverged: production apps driver has tentative-patch retention the runner driver lacks |
| [28](#28) | 🟡 low | correctness | `src/runner/batch/eval/closure-diagnostics-io.ts:32` | `endReasonOf` ignores `InstanceResult.stopReason`, so `no_patch_exhausted_rate` is ~always 0 for single-attempt runs |
| [29](#29) | 🟡 low | correctness | `src/runner/batch/eval/verdict.ts:55` | "0 passed" summary grades a zero-test / SIGTERM'd run as PASS |
| [30](#30) | 🟡 low | correctness | `src/agent/verify-signal.ts:178` | generic error/failure-count failure matcher can flip a real PASS to fail-closed on incidental output |
| [31](#31) | 🟡 low | jank | `src/agent/verification-bundle/score.ts:34` | voterQuorum soft signal silently clamps votes/k > 1 to 1, conflating super-quorum with exact quorum |
| [32](#32) | ⚪ none | dead-code | `src/runner/batch/eval/repair-phase-policy.ts:25` | primaryRailState can only be 'red' or 'unrun' at this call site, making decideRepairAdmission's 'already green' guard unreachable here |
| [33](#33) | ⚪ none | correctness | `src/apps/bench/eval/driver.ts:987` | Apps `runInstance` budget telemetry reports adaptedTimeoutMs == base even though it deliberately does not adapt |

## 재발 패턴 (테마)

- **observe-only / built-not-wired**: 게이트·escalation·메트릭이 *기록만* 하고 강제하지 않음 (#1, #9, #14, #28). 메모리의 `wired≠engages theater class`와 직결.
- **apps-driver vs runner-driver split-brain**: 두 드라이버가 drift (#6, #5, #27). split-brain 막으려 만든 쌍이 정작 split-brain.
- **transient 실패를 영구 상태로 캐시 / fail-open**: 일시 오류를 영구 'dead'로 (#4 LSP, #5 SG describe).
- **brittle 문자열 파싱**: regex 채점·extractor가 edge에서 조용히 오판 (#10, #29, #30).

---

## 상세

<a id="1"></a>
### 1. 🟠 decidePrimaryRailFinishGate (the documented false-green killer) has ZERO production callers

- **등급**: MED (어딧 원래값 `high`) · **분류**: `dead-code` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/agent/primary-rail/index.ts:74` — anchor: `export const decidePrimaryRailFinishGate`
- **클러스터**: Closure engine core
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/primary-rail/index.ts:74-86`

**영향 (왜 문제인가)**

The cluster's stated raison d'être — kill false greens (non-primary green / self-authored repro that never exercises the bug, e.g. sympy-23262) — is NOT enforced in production. A non-primary green still clears the gate; the predicate mismatch only emits a `primaryFalseGreen` metric. The hole the design exists to close remains open at runtime; the gate that would close it is unreachable code.

**증거**

```
Module doc claims: `decidePrimaryRailFinishGate — closes the false-green hole. ... This gate blocks finishing while the planner-selected primaryRail is not GREEN`. But grep across src/ finds the only references are the doc comment, the definition, and tests/unit/primary-rail.test.ts. No file in src/ calls it. Meanwhile the actual repair loop (src/runner/batch/eval/repair/index.ts:87) only records `isFalseGreen` as OBSERVE-ONLY: `const isFalseGreen = (v) => v.ok && v.predicate?.evaluable === true && v.predicate.matched === false` and runValidate's comment states `observe-only in v1 — validator records, does NOT flip ok`. The round still clears on `vi.ok` (exit code) at repair/index.ts:74.
```

**검증 노트 (skeptic)**

VERIFIED REAL. decidePrimaryRailFinishGate (src/agent/primary-rail/index.ts:74-86) has zero production callers — grep across src/ and tests/ finds it ONLY in the module doc comment (line 11), the definition (line 74), and tests/unit/primary-rail.test.ts. No src/ file imports or calls it. By contrast its sibling decideRepairAdmission IS wired (src/runner/batch/eval/repair-phase-policy.ts:23). So the finish-gate function specifically is unreachable.

The claimed consequence is also accurate. The repair loop clears a round on exit-code only: repair/index.ts:74 `if (vi.ok) { validated = true; falseGreen = isFalseGreen(vi); break }`, and the single-pass path (line 47) returns `v0.ok` as `validated`. runValidate is explicitly observe-only (line 188 comment: "observe-only in v1 — validator records, does NOT flip ok"). isFalseGreen (line 87) is recorded into `primaryFalseGreen`, but that value only feeds decideEscalation (driver.ts:2830, gated behind posture.repairEscalation) — an escalation/telemetry signal — and never blocks finishing or flips the verdict. So a non-primary green (or self-authored repro that never exercises the bug, e.g. sympy-23262) still clears, exactly as the auditor states. The gate built to close that hole is dead code.

The finding does NOT overstate — it explicitly acknowledges the observe-only recording and metric emission, and its mechanics are precise.

Downgraded high→med on impact scope (not correctness, which is confirmed): this is SWE-bench eval/measurement harness code, not shipped product runtime. The hole degrades repair-loop early-blocking/escalation and measurement integrity, but the official downstream SWE-bench grading is unaffected by this in-loop validator, so it does not fabricate final benchmark verdicts — it fails to enforce/escalate. That confines blast radius to bench infra, below 'high'. Not a false-positive and not intentional fail-open: the cluster is partially live (decideRepairAdmission active, primary-rail knob ="1" in many presets), so the missing finish-gate wiring is a genuine gap, not by-design OFF.

---

<a id="2"></a>
### 2. 🟠 mergeWithDisk callback reassigns live `state` from a pre-await snapshot, dropping mutations that interleave during the flush IO window

- **등급**: MED (어딧 원래값 `med`) · **분류**: `correctness` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/permission/permission-store.ts:775` — anchor: `cloneAsMutable(merged)`
- **클러스터**: Observability / permission / sandbox
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/permission/permission-store.ts:766-777`

**영향 (왜 문제인가)**

`inMemory` is snapshotted BEFORE `await rereadForMerge()`. JS is single-threaded but the await yields, so a synchronous `setThread`/`recordDenial`/`recordUserOverride` from the event loop can mutate the live `state` object during that window. The merge callback then does `state = cloneAsMutable(merged)`, where `merged` is derived from the stale snapshot (A) — the interleaved mutation is silently overwritten in memory. For grants this loses a grant; for the denial ledger it can drop a freshly-recorded denial (security state). The follow-up flush from the dirty bit re-snapshots the already-clobbered state, so the loss is permanent, not merely delayed. Only triggers when `mergeWithDisk` is wired — which is ALWAYS for the permission store. Capturing the merge input at callback-invocation time (re-snapshot inside the callback) instead of before the await would close it.

**증거**

```
mergeWithDisk: ({ onDisk, inMemory }) => {
  const merged = mergePermissionState({ onDisk, inMemory, baseline: persistedState })
  persistedState = merged
  state = cloneAsMutable(merged)   // <-- overwrites live state
  return merged
}

// json-state-file.ts writeToDisk:
const inMemory = snapshotState()            // (A) snapshot captured here
const merged = mergeWithDisk({ onDisk: await rereadForMerge(), inMemory, baseline })  // await yields the event loop
```

**검증 노트 (skeptic)**

CONFIRMED REAL. The exact code proves the exact claimed consequence.

Mechanism traced end-to-end:
- json-state-file.ts writeToDisk (line 342) captures `const inMemory = snapshotState()` BEFORE `await rereadForMerge()` (line 352). `snapshotState` is `liveSnapshot` (permission-store.ts:781 → `snapshot(state)`), which returns a frozen DETACHED copy (spread-copied maps, lines 182-188), so it is a true point-in-time snapshot, not a live reference.
- `await rereadForMerge()` does real async IO (`await readFile`, line 320), yielding the event loop.
- The domain stores mutate the LIVE `state` object in place: `set` does `state().perThread[threadId] = perm` (permission-store.ts:465) and calls `onMutate()` which sets `dirty = true`. These run on the same event loop, so a synchronous setThread/recordDenial/recordUserOverride CAN interleave during the await window.
- When the await resolves, the mergeWithDisk callback (permission-store.ts:766-777) runs with the STALE pre-await `inMemory`. The interleaved record (G2) is in neither `inMemory` (snapshot predates it) nor `onDisk` (G2 was only just added in memory, never written), so `merged` lacks G2.
- Line 775 `state = cloneAsMutable(merged)` synchronously overwrites the live `state`, dropping G2 from memory.
- The interleaving mutation's `dirty = true` schedules a follow-up writeToDisk that re-snapshots the now-clobbered `state` (no G2), so the loss is permanent, not delayed. The auditor's "follow-up flush re-snapshots the clobbered state" is correct.

mergeWithDisk is always wired for the permission store (permission-store.ts:766), so the merge path (and thus the clobber) is always active — the claim's "ALWAYS for the permission store" holds. The cross-process lock and in-process pendingFlush serialization do NOT prevent this: they serialize WRITES, not in-process mutations that touch `state` mid-write.

Affected state includes grants (a just-approved thread/host permission) and the denial ledger (security-sensitive per the file's own comments). Real data-loss/correctness bug.

Severity med (not high): it is a single-process narrow-window race — the interleaving mutation must land precisely during the reread IO window of an in-flight flush, and flushes are debounced (200ms), so it is occasional silent loss rather than a deterministic/easily-triggered failure. Not a fail-open security bypass and not gated by any knob; the merge path is unconditionally on. Proposed fix (re-snapshot inside the callback / after all awaits, rather than using the pre-await `inMemory`) is sound and would close it.

---

<a id="3"></a>
### 3. 🟠 Cost fallback sums only the FIRST attempt's tokens for Best-of-N runs (undercount)

- **등급**: MED (어딧 원래값 `med`) · **분류**: `silent-failure` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/analyze/cost.ts:96` — anchor: `startsWith(\`${instanceId}.\``
- **클러스터**: Leaderboard / analyze / CLI
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/analyze/cost.ts:93-101`

**영향 (왜 문제인가)**

The module header documents one observe file per attempt as `<instanceId>.<attempt>.jsonl` (index.ts resolveInstance writes `.0.jsonl`, `.1.jsonl`, … for Best-of-N). `.find()` returns ONE arbitrary attempt, so when report.json has no usage and this fallback fires, an n=4 run reports ~1/4 of the real tokens/cost. The summary presents this as the run cost with no caveat — a silently-wrong dollar/token figure for exactly the expensive (Best-of-N) runs cost-analysis exists to measure.

**증거**

```
file = readdirSync(observeDir).find((f) => f.startsWith(`${instanceId}.`) && f.endsWith(".jsonl"))  ... // then only this one file is read+summed
```

**검증 노트 (skeptic)**

Confirmed real by reading the code and the writer/caller chain.

WRITER: src/runner/batch/observe.ts:107 writes one trajectory file PER Best-of-N attempt: `this.file = join(obs.dir, obs.runId, `${instanceId}.${attempt}.jsonl`)`. src/apps/bench/index.ts:343-345 `resolveInstance` calls `makeAttempt: () => runInstance(instance, withObserve(base, attemptObs(obs, attempt++)))` inside `sampleBestOfN({n})`, so an n=4 run emits `<id>.0.jsonl`..`<id>.3.jsonl`.

READER (the bug): src/apps/bench/analyze/cost.ts:95-97 `fromObserve` does `readdirSync(observeDir).find((f) => f.startsWith(`${instanceId}.`) && f.endsWith(".jsonl"))`. `.find()` returns ONLY ONE (the first-listed) attempt file; lines 102-126 read and `deepSumTokens` over that single file. There is no loop over the other attempt files and no aggregation elsewhere — the other attempts' tokens are dropped.

WHEN IT FIRES: cost.ts:146 invokes the observe fallback only when `input===0 && output===0` from report.json usage AND observeDir is provided — i.e. exactly when the observe JSONL is the sole token source. In that case an n-attempt run reports ~1/n of real input/output tokens, and costUsd (cost.ts:152-155) is computed from those undercounted tokens. Wall-clock is also only the single attempt's span, not the aggregate.

PRESENTATION: renderCost (cost.ts:170-202) prints the per-instance/total tokens and $ as the run figure; its only caveats are for total-zero usage (instancesWithUsage===0) or unknown pricing — neither covers the partial-attempt undercount, so the wrong figure is shown with no warning. This directly proves the claimed consequence: a silently-wrong, undercounted cost/token figure for Best-of-N runs.

NOT correct-by-design / not fail-open: the module's stated contract (header lines 1-13) is to "sum" trajectory tokens and be "honest" about cost. The doc comment at cost.ts:87 even says "any `<instanceId>.<attempt>.jsonl`" — treating multiple attempt files as interchangeable, which is the latent assumption error. The existing test (cost.test.ts:90) only writes a single `.0.jsonl`, so the multi-attempt case is untested.

Severity med (not high): manifests only under the conjunction of n>1 AND report.json missing usage (the secondary fallback path; the primary report.json path is unaffected). It is a cost-analysis/reporting tool, not production run logic, so no user-facing or runtime correctness impact beyond a misleading dollar/token number. But within that tool the defect is a silent, potentially large (1/n) undercount on precisely the expensive runs the analysis exists to measure, so it is more than low.

---

<a id="4"></a>
### 4. 🟠 Availability probe caches a transient failure as a permanent process-wide 'LSP dead'

- **등급**: MED (어딧 원래값 `high`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/agent/lsp-bridge.ts:170` — anchor: `availabilityCache.set(bin, probe)`
- **클러스터**: LSP / pyright / prewarm
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/lsp-bridge.ts:144-172`

**영향 (왜 문제인가)**

The probe promise is cached forever and never invalidated on a `false` result. A single transient `bin --version` failure during a busy startup — the 5s race timeout firing under CPU/IO load, or PATH not yet populated when the first diagnostics/nav/prewarm call fires — resolves to `false`, gets cached, and silently disables the ENTIRE LSP surface (diagnostics, all nav tools, prewarm, evidence enrichment) for the rest of the process. Every later `open()` short-circuits to null and the tool emits a clean 'not installed' message, masking the fact that pyright IS installed. This matches the recurring observed 'LSP inert/0% calls' symptom. A real availability probe should cache only successes (mirroring the `once` memoizer in mention-symbol-deps.ts which deliberately resets on reject) or apply a TTL.

**증거**

```
const availabilityCache = new Map<string, Promise<boolean>>()
...
const exit = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), LSP_AVAILABILITY_TIMEOUT_MS))])
...
return exit !== -1   // timeout => -1 => false
...
const isAvailable = (bin) => { const cached = availabilityCache.get(bin); if (cached !== undefined) return cached; const probe = probeAvailable(bin); availabilityCache.set(bin, probe); return probe }
```

**검증 노트 (skeptic)**

The core mechanism is REAL and verified at src/agent/lsp-bridge.ts:144-172. `availabilityCache` stores the probe PROMISE (which resolves to a settled boolean), keyed per binary, for the whole process. `probeAvailable` returns `false` both when `Bun.spawn` throws (caught at L162-164) AND when the 5s race timeout fires (L148-151, exit===-1 → L161 `return exit !== -1` → false). `isAvailable` (L166-172) caches that promise unconditionally and never invalidates a cached `false` — the ONLY reset is `__resetLspAvailabilityCacheForTest` (L180, explicitly NEVER called in production). All eight LSP surfaces gate on `isAvailable` and silently degrade to null on a cached false: diagnostics open() (L396), nav/def (L516), prewarm (L657), rename (L657, line dupe — verified L711/745/764/790 for code-action/format/signature). And `unavailableReason` (L387-391) reports "<bin> is not installed or not on PATH" even when the binary IS installed — so the masking claim is exactly correct. The cache-success-and-failure-with-no-TTL design is a genuine silent-failure footgun (the comment at L139-143 shows false-caching is deliberate for spawn dedup but does NOT distinguish transient-timeout from genuinely-absent).

WHY OVERSTATED, not full-real at high: (1) The trigger probability is lower than the finding frames it. Of its two vectors, the "PATH not yet populated when first call fires" vector is implausible — a process's PATH does not asynchronously populate mid-run; spawn ENOENT means genuinely absent. (2) The remaining vector — the 5s race timeout firing on an INSTALLED binary — requires `<bin> --version` to take >5s, which for pyright-langserver/tsserver is a fast path (<1s typical). It is possible under extreme startup contention but is NOT the easy "single transient failure during busy startup" the finding implies. (3) The claim that this "matches the recurring observed LSP inert/0% symptom" is speculative attribution — project memory attributes that symptom primarily to other causes (no grounding steer with models calling nav 0%, AMI lacking pyright, missing pythonPath config), not to a cached false probe. So the defect is real and worth fixing (cache only successes, or TTL/invalidate false), but high severity overstates the real-world likelihood; med is correct.

---

<a id="5"></a>
### 5. 🟠 ensureSecurityGroup treats a describe FAILURE (network/creds) as 'SG not found' and tries to create

- **등급**: MED (어딧 원래값 `med`) · **분류**: `silent-failure` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/remote/ec2.ts:137` — anchor: `found.code !== 0`
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/remote/ec2.ts:124-158`

**영향 (왜 문제인가)**

`found.code !== 0` is folded into the same branch as 'not found', so a transient AWS auth/network error on describe routes into create-security-group and surfaces as a misleading '[ec2-backend] create-security-group failed' (or, if create also flakes differently, a wrong SG). The sibling box-session.ts ensureSecurityGroup (line 930) correctly throws a dedicated 'could not reach EC2 (network/credentials?)' on describe failure. Two copies of the same routine have drifted; the ec2.ts copy masks the real failure cause.

**증거**

```
const found = await aws([...describe-security-groups...])
let sgId = oneLine(found.stdout)
if (found.code !== 0 || sgId === "" || sgId === "None") {
  const created = await aws([...create-security-group...])
```

**검증 노트 (skeptic)**

Confirmed by reading the exact code. In src/apps/bench/remote/ec2.ts:136-137, `let sgId = oneLine(found.stdout); if (found.code !== 0 || sgId === "" || sgId === "None")` folds a describe-security-groups FAILURE (non-zero exit = network/creds error) into the same branch as a legitimate "SG not found", then proceeds to create-security-group (lines 138-157).

The drift claim is verified: the sibling copy in box-session.ts:954-958 explicitly separates the failure case with a dedicated `if (found.code !== 0) throw new Error("[full-remote] could not reach EC2 (...) — network/credentials?")` BEFORE checking the stdout for empty/None, then only creates when sgId === "" || "None". The two routines are functionally identical except for this error-handling divergence. The box-session.ts doc comment even states "Throws on a REAL failure (never masks a connectivity error by blindly creating)" — confirming this is a known, intended invariant that the ec2.ts copy violates.

The path is live, not dead code: createEc2Backend is imported by src/apps/bench/cli.ts:45 and selected via `quanta-bench grade --backend ec2` (buildBackend at cli.ts:232); ensureSecurityGroup is called during provisioning at ec2.ts:328.

Consequence: a transient AWS auth/network error on describe routes into create-security-group. Since the SG name is fixed (sgName), a subsequent create with that name typically fails too (either the same persistent creds/network error, or InvalidGroup.Duplicate if the SG actually exists), surfacing the misleading `[ec2-backend] create-security-group failed` message that masks the true root cause (could not reach EC2 / bad credentials). This is a genuine silent-failure / misdiagnosis bug.

Severity stays med, not high: a phantom/wrong SG is unlikely because the fixed group-name makes a stray create collide and fail rather than silently produce a wrong SG; the concrete harm is masked error diagnosis and wasted debugging, not data loss or a security hole. Not overstated — the claimed "misleading create-security-group failed" outcome is the realistic result; the "wrong SG" alternative the auditor hedges on is the less likely path. Recommend mirroring box-session.ts's dedicated `found.code !== 0` throw.

---

<a id="6"></a>
### 6. 🟠 Production SDK driver never emits `knobs_applied` telemetry (split-brain with runner driver)

- **등급**: MED (어딧 원래값 `high`) · **분류**: `silent-failure` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/eval/driver.ts:287` — anchor: `new BenchStreamTap(w.stream`
- **클러스터**: Repair orchestrator + eval drivers
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/eval/driver.ts:275-412`

**영향 (왜 문제인가)**

The `knobs_applied` event is recorded into the JSONL trajectory (stream/adapters/jsonl-recorder.ts:511,584) and rendered to stdout (stream/adapters/stdout.ts:261). It is the greppable per-run marker of which knobs/preset actually ran — exactly the observability MEMORY says is SSOT for 'winning config'. In real (SDK) bench runs every observed trajectory is MISSING this line, while unit/integration tests that exercise the runner-core driver see it and pass. The telemetry this cluster exists to keep byte-identical is silently absent in production.

**증거**

```
Runner driver emits it in BOTH agent entry points:
  src/runner/batch/eval/driver.ts:1626 `emitKnobsApplied(tap, process.env)` (runAgentOnce)
  src/runner/batch/eval/driver.ts:1679 `emitKnobsApplied(tap, process.env)` (runAgentPhase)
The production apps driver re-implements runAgentOnce (line 287) and runAgentPhase (line 359) with their own `new BenchStreamTap(...)` but NO emitKnobsApplied call. `grep emitKnobsApplied src/apps/bench/eval/driver.ts` → 0 hits. The helper is also un-exported in the runner driver (`grep 'export.*emitKnobsApplied'` → 0), so the apps driver cannot call it even if it wanted to. Production `runInstance` comes from this apps driver (src/apps/bench/eval/index.ts:8 → ./driver; src/apps/bench/index.ts:102 imports from ./eval), NOT the runner driver.
```

**검증 노트 (skeptic)**

VERIFIED REAL. The production bench path resolves to the apps driver, not the runner driver: src/apps/bench/index.ts:102 imports runInstance from ./eval (→ ./driver), and src/apps/agent/mode-presets/batch.ts:56,95 sets BENCH_EVAL_MODULE="@/apps/bench/eval" and imports runInstance from there. Both prod entry points use the APPS driver.

The apps driver re-implements runAgentOnce (line 275) and runAgentPhase (line 310), each creating its own `new BenchStreamTap(...)` (lines 287, 359) and executing via runAgentViaSdk, but `grep emitKnobsApplied src/apps/bench/eval/driver.ts` = 0 hits, and `grep knobs_applied src/apps/` finds nothing outside an unrelated CLI timeline-panel allowlist. The runner driver emits it unconditionally at BOTH agent entry points (driver.ts:1626 runAgentOnce, :1679 runAgentPhase). emitKnobsApplied is defined at runner driver:1569 and is NOT exported (grep 'export.*emitKnobsApplied' = 0), so the apps driver — which imports ~40 other symbols from the runner driver at line 46 but not this one — physically cannot call it. The runner driver's runInstance/runInstanceOnce/runAgentPhase/runAgentOnce are reached ONLY by tests (no non-test importer of runner runInstance exists), so unit/integration tests exercising the runner core see the event and pass while real SDK runs never emit it. The event IS genuinely consumed: recorded to JSONL (jsonl-recorder.ts:511,584 with reason:"knobs_applied" for grep) and rendered to stdout (stdout.ts:261). This is a true production/test split-brain telemetry gap, not correct-by-design, not a default-OFF knob, not intentional fail-open (the emit is unconditional in the path that does have it).

Severity corrected high→med: the emitKnobsApplied swallow-comment notes (and MEMORY confirms) that report.json's `knobs` section remains the canonical SSOT for 'winning config' and is written independently of this event. So the canonical record of which knobs/preset ran is NOT lost — only the per-trajectory greppable JSONL line and the stdout render are absent in production. That is a real observability regression (the greppable per-run marker is gone from every SDK trajectory), but it is not silent loss of the authoritative config record, so it lands at medium rather than high.

---

<a id="7"></a>
### 7. 🟠 earlyAccept re-runs every hard-gate probe twice per candidate (double pytest/repro materialization)

- **등급**: MED (어딧 원래값 `med`) · **분류**: `efficiency` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/selection-executor.ts:404` — anchor: `const maybeFinalizeEarlyAccept = async`
- **클러스터**: Verification-bundle + verify-signal (WIP)
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/selection-executor.ts:404-418, 459-462`

**영향 (왜 문제인가)**

When `earlyAccept` is on but a candidate does NOT clear the early gate, `scoreOne` was already invoked during generation (running `regression`/`resolvedKofN`, each of which `withCandidatePatch` resets the tree + runs pytest/repro consensus), then `finalize` invokes `scoreOne` for the SAME candidate again. Hot bench path: up to 2N full re-materialize+pytest runs instead of N, doubling the most expensive cost in the selection loop. The first-pass verdicts are discarded, not cached.

**증거**

```
const maybeFinalizeEarlyAccept = async (...) => {
  if (args.earlyAccept !== true) return null
  const entry = await scoreOne(candidate, size, size)  // calls applyClean/regression/resolvedKofN ports
  ...
}
// later, finalize():
for (let i = 0; i < cands.length; i++) {
  scored.push(await scoreOne(cands[i] as Candidate, minB, maxB))  // re-invokes ALL ports again
}
```

**검증 노트 (skeptic)**

Confirmed real by reading the code and its callers. In the sequential path (selection-executor.ts:514-519) each generated candidate triggers maybeFinalizeEarlyAccept (line 408-418), which calls scoreOne(candidate,...) at line 410. scoreOne (379-402) invokes the expensive ports applyClean/regression/resolvedKofN. The ScoredEntry returned is consumed ONLY by the earlyAcceptable() boolean check (278-299, which reads hard.regressionGreen / hard.patchedResolvedKofN, proving the costly ports really ran) and is then discarded — there is no memoization. Whether the candidate clears the gate or not, it is scored AGAIN: if accepted, finalize(raw,true) loops over all deduped cands at line 459-462 re-running scoreOne on the same candidate; if not accepted, it is re-scored in the later finalize(raw,false) at line 536. I verified the ports in driver.ts (2154-2186) are constructed fresh with no caching — regression/resolvedKofN both wrap withCandidatePatch (reset tree → apply patch → run pytest/repro → reset), so each redundant scoreOne is a full re-materialize + pytest/repro consensus. The 'up to 2N runs, results discarded, not cached' claim is exactly proven. Severity kept at med (not high) because: (1) it is gated behind earlyAccept which is a default-OFF knob (doc comment line 363: 'Default false preserves N-best'); (2) it only affects the sequential limit<=1 path. When the knob is on, the ~2x waste on the single most expensive operation in the loop is accurately described, so med stands.

---

<a id="8"></a>
### 8. 🟡 Gate stakes/uncertainty signals hard-coded to false at the only assembly site, neutering the anti-under-verify arm

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/closure-session.ts:59` — anchor: `sampleDisagreement: false`
- **클러스터**: Closure engine core
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/closure-session.ts:57-65`

**영향 (왜 문제인가)**

The gate is documented as a bidirectional decision over real structural signals (the '5 model-misses shipped blind' under-verify side). With these signals pinned false, the entire 'verify when stakes/uncertainty' branch and the LSP `structure` source are dead at runtime — the gate cannot distinguish a 5-file cross-file destructive patch from a trivial one. bundle.gate.action gates the repair phase (driver.ts:2515, repair-phase-policy.ts:30 `gateAction === 'verify'`), so this silently reduces the gate to a repro-availability check while presenting as a rich structural gate.

**증거**

```
buildClosureSession (the sole real assembler) hard-codes: `gate: { stakes: { patchFileCount: 1, crossFile: false, destructive: false }, uncertainty: { sampleDisagreement: false, unresolvedSymbols: false }, ... }`. In gate-decision.ts, `highStakes(s)` is `crossFile || destructive || patchFileCount >= 2` and `uncertain(s)` is `sampleDisagreement || unresolvedSymbols` — both are structurally always false here. The `structure` LSP source requires `unresolvedSymbols || crossFile` (both false), so it can never be added. Thus decideGate's verify-vs-commit outcome collapses to a function of `reproAvailable` alone.
```

**검증 노트 (skeptic)**

The finding's headline consequence is wrong because the auditor read closure-session.ts and gate-decision.ts but missed the transform in assembleClosureBundle (src/agent/closure/bundle.ts:49-63). The hard-coded `uncertainty.sampleDisagreement: false` from closure-session.ts:59 is NOT passed verbatim to decideGate — bundle.ts:52-53 OR's it with `owner.coverageExpectation !== "single-site"`. That coverageExpectation is computed by decideOwnerAdmission from the REAL stage1Files/ownerResolved evidence passed at the driver.ts:2493 assembly site: it is "cross-owner" when localization is ambiguous (no clear leader / uncorroborated top), "owner-family" when a corroborated sibling shares an evidence stream, and only "single-site" for a clean single owner. So `uncertain(s)` is genuinely live and evidence-driven — the verify-vs-commit outcome does NOT collapse to `reproAvailable` alone. The gate routes to `verify` for ambiguous/owner-family localizations even with no repro. Likewise, the commit-fast `issueProvidesFix` and `highConfidenceSingleOwner` branches are gated on real owner-admission state (bundle.ts:58-62), not the hard-coded constants.

Two sub-claims in the evidence ARE accurate but don't carry the consequence: (1) the `stakes` fields (crossFile/destructive/patchFileCount) are hard-coded and not overridden, so highStakes() is indeed always false at this site; (2) the LSP `structure` source (needs unresolvedSymbols||crossFile, both false) is indeed dead at this site. These are real minor observations — there's no structural-stakes or LSP-structure input wired here yet — which is why this isn't a pure false-positive. But the claimed neutering of the entire anti-under-verify arm is overstated: the uncertainty/coverage axis is the live driver of that arm and it works.

---

<a id="9"></a>
### 9. 🟡 decideEscalation result is computed post-repair and only stored as telemetry; never widens the search

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `dead-code` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/driver.ts:2824` — anchor: `repairEscalation = decideEscalation`
- **클러스터**: Closure engine core
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/driver.ts:2813-2827`

**영향 (왜 문제인가)**

Despite returning `escalate: true` with an `owners` list intended to drive branch-search/subagent widening (the #14315 multi-site lever), the decision has no behavioral effect: it runs after repair completes and is only serialized to the report. This is the recurring 'wired but does not engage' pattern — a reviewer reading the module believes multi-owner widening happens when it never does.

**증거**

```
repair-escalation.ts doc: `Widen (branch-search / subagent) ONLY on explicit multi-owner evidence`. At the call site, the EscalationDecision is assigned to `args.extra.repairEscalation` and nowhere else; grep for `repairEscalation`/`.owners`/`escalation` shows the only consumer is `RunExtra.repairEscalation?` in src/runner/batch/types.ts:321 (a report field). It is computed from `args.phase.validated` / `args.phase.primaryFalseGreen` — i.e. AFTER the repair phase already finished — and `escalation.owners` is never fed into selection/seed/widen.
```

**검증 노트 (skeptic)**

The factual mechanics of the finding are correct. At src/runner/batch/eval/driver.ts:2823-2837, decideEscalation's EscalationDecision is assigned ONLY to args.extra.repairEscalation. A full grep confirms the sole references to repairEscalation outside the knob are: the write at driver.ts:2824, and the report field declaration at src/runner/batch/types.ts:321. No code ever reads escalation.owners or .escalate to drive selection/seed/widen. It runs from attachSelectionAndClosureArtifacts -> buildSuccessfulResultExtra (post-repair success path), fed by post-repair phase outputs (args.phase.validated, primaryFalseGreen, primaryRailRedAfterRepair). So "computed post-repair, only stored as telemetry, never widens the search" is literally true.

BUT the framing as dead-code/med and "a reviewer believes multi-owner widening happens when it never does" is overstated, because the no-op is explicit and loudly documented at exactly the sites a reviewer reads:
- types.ts:316-319 says verbatim "Telemetry-only — does NOT activate branch-search/subagent (that behavioral wiring is a later measure-first step). ABSENT ⇒ byte-identical." A reviewer reading the field type cannot conclude widening happens — the doc states the opposite.
- The knob (repair-escalation.ts) is Default-OFF with a strict truthy gate and a deliberate NOOP-apply (cfg => cfg), with a comment that the effect is delivered out-of-band as a report field.
This is the project's documented observe-only / measure-first telemetry pattern (same as owner-admission, faultEvidence, repro-vote), not latent dead code: the value IS consumed by being serialized to the report. It produces no behavioral effect by design and is byte-identical when the knob is off.

Corrected severity low (not med, not none): it is a real, accurate observation that the #14315 multi-owner-widen lever is NOT yet behaviorally wired, which is worth knowing — but it is intentional, documented, and gated default-OFF, so it is not a bug and the "reviewer is misled" consequence does not hold against the actual in-code comments.

---

<a id="10"></a>
### 10. 🟡 EXPECT_RE pre-gate is strictly narrower than EXPECT_LITERAL_RE, silently dropping valid declared outputs

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/agent/verification-plan/extract-issue-declared-expected.ts:31` — anchor: `const EXPECT_RE =`
- **클러스터**: Fault-evidence + verification-plan
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/verification-plan/extract-issue-declared-expected.ts:31-40, 114-120`

**영향 (왜 문제인가)**

`equals?` and the plural verb forms (`returns`, `gives`, `produces`, etc.) exist ONLY in EXPECT_LITERAL_RE. Because the outer EXPECT_RE gate lacks them, a real issue that says "should equal `X`" or "should returns `X`" matches the literal pattern but is suppressed by the gate, so issueDeclaredExpected returns undefined and the spec-fidelity steer never fires. The pre-gate can only ever SUBTRACT valid matches (LITERAL already requires the same modal+verb prefix), so it adds zero precision and only costs recall.

**증거**

```
EXPECT_RE verbs: /…\s+(?:print|output|return|give|produce|render|show|be|display|yield)\b/   vs   EXPECT_LITERAL_RE verbs: /…\s+(?:print|output|returns?|gives?|produces?|renders?|shows?|be|equals?|displays?|yields?)…/  . The branch is guarded:
  if (EXPECT_RE.test(problemStatement)) {
    const m = EXPECT_LITERAL_RE.exec(problemStatement)
Proven at runtime: "The result should equal `(1,)`" → EXPECT_RE.test=false, but EXPECT_LITERAL_RE would capture "(1,)". Same for "It should returns `(1,)`" (plural verb form): EXPECT_RE.test=false, LITERAL captures "(1,)".
```

**검증 노트 (skeptic)**

The mechanical claim is REAL and runtime-proven. EXPECT_RE pre-gate verbs (print|output|return|give|produce|render|show|be|display|yield) are strictly narrower than EXPECT_LITERAL_RE verbs (which add equals?, returns?, gives?, produces?, renders?, shows?, displays?, yields?). I confirmed at runtime: "The result should equal `(1,)`" → EXPECT_RE.test=false but EXPECT_LITERAL_RE captures "(1,)"; "It should returns `(1,)`" → same. Since EXPECT_LITERAL_RE already requires the same modal+verb+delimited-literal, the EXPECT_RE pre-gate (extract-issue-declared-expected.ts:114) can only subtract valid matches — it adds zero precision and only costs recall. So the redundant-but-narrower gate is a genuine defect (the comment at lines 111-113 claims the pre-check just "keeps intent explicit," not realizing it changes behavior).

However, MED severity is overstated. (1) The PRIMARY consequence — the spec-fidelity steer — is behind a DEFAULT-OFF knob (spec-fidelity-steer.ts: NOOP-apply, opened via env override only, ENABLING={1,on,true}); in normal operation it never fires regardless of extraction. (2) The extracted VALUE is documented to NEVER be injected into the model prompt (lines 15-18); a missed extraction only fails to gate the opt-in steer and leaves the verification-plan step on its default execution-proof predicate (build.ts:113-119, observe-only artifact). So the failure mode is a missed RECALL opportunity on a bench experiment, not a wrong answer, wrong spec, or any correctness/safety regression. (3) The module's stated design is explicitly fail-closed / precision-over-recall, so under-firing is the safe direction. Real bug, benign blast radius → low.

---

<a id="11"></a>
### 11. 🟡 Comment claims EXPECT_RE pre-check is a harmless intent-marker, but it actively suppresses matches

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `jank` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/agent/verification-plan/extract-issue-declared-expected.ts:112` — anchor: `EXPECT_RE pre-check keeps`
- **클러스터**: Fault-evidence + verification-plan
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/verification-plan/extract-issue-declared-expected.ts:112-113`

**영향 (왜 문제인가)**

The comment frames EXPECT_RE as redundant-but-explanatory ("already requires it"), implying it cannot change behavior. In fact its verb list diverges from EXPECT_LITERAL_RE (no `equals?`, no plural forms), so it does change behavior by dropping otherwise-valid extractions. A maintainer trusting the comment would not realize edits to one regex's verb list must be mirrored to the other, inviting further silent recall drift.

**증거**

```
// 2) "should <verb> `LITERAL`" — only when an expect verb is actually present
//    (EXPECT_LITERAL_RE already requires it; the EXPECT_RE pre-check keeps the
//    intent explicit and the failure mode obvious).
```

**검증 노트 (skeptic)**

The factual core is REAL and empirically proven. At line 114 EXPECT_RE.test() is a gate before running EXPECT_LITERAL_RE.exec(). The two verb lists genuinely diverge: EXPECT_RE (line 32) = print|output|return|give|produce|render|show|be|display|yield; EXPECT_LITERAL_RE (line 40) = print|output|returns?|gives?|produces?|renders?|shows?|be|equals?|displays?|yields?. EXPECT_RE has NO `equal(s)` at all and no plural forms. I confirmed with a runnable test that strings like "should equal `42`", "should returns `foo`", "should produces `baz`" are captured by EXPECT_LITERAL_RE but the EXPECT_RE pre-check returns false, so the extraction is SUPPRESSED. Thus the pre-check does change behavior — it is not the harmless/redundant intent-marker the comment frames it as, and a maintainer editing one verb list would not realize the other must be mirrored. So the comment IS misleading (the jank is real).

However the finding is OVERSTATED on two counts: (1) The comment does not verbatim claim "cannot change behavior" — it says "EXPECT_LITERAL_RE already requires it [a verb]", which is literally true; "implying it cannot change behavior" is the auditor's inference. (2) The CLAIMED CONSEQUENCE (silent recall drift) is bounded and low-impact: extractIssueDeclaredExpected feeds a DEFAULT-OFF spec-fidelity steer (src/runner/knobs/knobs/spec-fidelity-steer.ts, byte-identical when off), the extracted value is NEVER injected into the model prompt (module design note lines 9-18, fail-closed precision-over-recall), so a missed extraction only means a steer/observe-predicate silently doesn't fire — never a wrong anchor. The only realistic divergent verb is `equal(s)`; the plural-after-modal forms ("should returns/gives") are grammatically invalid English and rare in real issue text. Net: a genuine comment-accuracy/maintainability defect with small bounded effect — jank/low is the correct severity.

---

<a id="12"></a>
### 12. 🟡 snapshot() is O(series) allocation on every call and the `series` Map has no per-metric series cap

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `efficiency` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/observability/metrics/in-memory-registry.ts:477` — anchor: `snapshot() {`
- **클러스터**: Observability / permission / sandbox
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/observability/metrics/in-memory-registry.ts:477-481`

**영향 (왜 문제인가)**

The module comment promises bounded memory via histogram compaction, but that only bounds observations WITHIN a series. The number of SERIES (one per unique `name|labels` combination) is unbounded — a caller that emits a metric with an unbounded-cardinality label (e.g. a per-request id, a free-form error string) grows `series` and `kindByName` without limit for the process lifetime, and every `snapshot()` re-allocates the whole row array. The wired instrument-tool path uses only bounded labels (`tool`,`ok`) so this is latent, not currently exploited; flagged because the doc's 'no unbounded memory growth' claim does not actually hold at the series level and there is no cardinality guard if a future emitter passes a high-cardinality label.

**증거**

```
snapshot() {
  const rows: MetricSnapshot[] = []
  for (const acc of series.values()) rows.push(snapshotRow(acc))
  return rows
}
```

**검증 노트 (skeptic)**

The code at src/observability/metrics/in-memory-registry.ts:477-481 matches the evidence verbatim: snapshot() allocates a fresh O(series) rows array each call, and there is no per-metric series cap or cardinality guard on the `series`/`kindByName` Maps. The finding is also factually correct that the module doc's "without unbounded memory growth" claim (lines 6-9, contract #5) is scoped to observations WITHIN a histogram series (P² compaction), not to the NUMBER of series.

However the finding's own framing concedes this is latent, and the practical consequence is overstated:

1. O(series) allocation in snapshot() is correct-by-design. The public contract returns MetricSnapshot[] — one row per series is the irreducible cost of the API; there is no cheaper materialization that honors the contract. This is not a defect, it is the expected cost.

2. Unbounded series growth requires a FUTURE high-cardinality emitter. The wired hot path (instrument-tool.ts) uses bounded labels (tool, ok). I found one borderline existing case — budget.breach.total emits scope which the doc admits can be a sessionId (instrument-budget.ts:48, doc line 6) — but breaches are rare events, not per-request.

3. The "for the process lifetime" claim is weakened by registry lifecycle: instrument-tool.ts:86 documents that registries are constructed fresh per tool-set ("Each call builds a sink-less defaultMetricsRegistry()"), i.e. short-lived per-instrument objects, not a process-wide singleton that accumulates series across the whole process. So series don't actually persist for the full process lifetime in the common path.

Net: the observation is real as a design-hardening note (no cardinality guard; doc claim is series-imprecise), but there is no exploited path, the allocation is by-design, and the memory-growth consequence does not hold as stated for the process lifetime. Corrected severity low (a legitimate latent hardening item), not a real defect with the claimed consequence.

---

<a id="13"></a>
### 13. 🟡 Sink send/flush failures are silently swallowed with no rate-limited error counter

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/observability/metrics/in-memory-registry.ts:328` — anchor: `sink.send(sample)`
- **클러스터**: Observability / permission / sandbox
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/observability/metrics/in-memory-registry.ts:325-334`

**영향 (왜 문제인가)**

A consistently-throwing exporter (mis-configured OTLP endpoint, network down) makes every metric and the final flush a silent no-op for the entire process lifetime with zero operator signal — the observability plane itself goes dark and nothing reports that it did. This is by-design per the no-crash contract, but there is not even an internal `metrics.export.dropped` counter or a one-shot warn, so a broken collector is indistinguishable from a healthy one. Low because it is deliberate and matches the tree's other observability surfaces, but it means export health is unobservable.

**증거**

```
const safeSend = (sink, sample) => {
  if (sink === undefined) return
  try { sink.send(sample) } catch { /* Swallow — contract #3 ... */ }
}
// flush(): catch { /* Swallow — same posture */ }
```

**검증 노트 (skeptic)**

The CODE is accurately quoted: `safeSend` (lines 325-334) and `flush` (lines 488-496) silently swallow sink exceptions, and there is genuinely no `metrics.export.dropped` counter or one-shot warn for send/flush failures anywhere in the registry. So the literal "silent swallow, no error signal for export failures" observation is real.

But the CLAIMED CONSEQUENCE is overstated on two material points, which is why this is at most a low/note rather than a real defect:

1. "Every metric ... a silent no-op ... the observability plane itself goes dark." False as stated. The in-memory accumulators are updated BEFORE the sink is ever touched: `increment`/`observe`/`gauge` do `series.set(...)` / `existing.total += d` first, then call `emit()`→`safeSend()` (verified at lines 399-417). So `snapshot()` — the documented in-process plane that feeds the `/metrics` panel, cost panel, and admin slash command (port.ts:76-79) — keeps working perfectly even with a permanently-throwing sink. Only the EXPORT egress to the external collector goes silent, not "the observability plane itself" and not "every metric."

2. This is correct-by-design and default-OFF. port.ts:20-25 states "Default-OFF: nothing in the loop instantiates a registry today"; the `MetricSink` interface (port.ts:47-54) mandates implementations MUST NOT throw, making the registry catch purely defensive backup, not the expected error path. The real OTLP sink (otel-sink.ts:195,248,288,297) swallows ALL of its own internal errors per ADR-0144 #3 — so a down endpoint never even propagates to `safeSend`; the registry catch would essentially never fire in practice. The comments cite the explicit ADR-0144 contract #3 no-throw policy and note a future strict mode could rethrow.

Net: the code observation is accurate but the consequence ("plane goes dark, broken collector indistinguishable from healthy with zero signal, every metric a no-op") overstates impact for a deliberate, ADR-governed, currently-uninstantiated fail-open. Keeping at low because the narrow true kernel — export-health is genuinely unobservable with no dropped-counter — is a legitimate (if minor and intentional) observability gap worth a future strict-mode/counter, matching the auditor's own "Low / deliberate" framing.

---

<a id="14"></a>
### 14. 🟡 `sotaOn` posture field is computed but has zero production consumers (dead telemetry field)

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `dead-code` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/knobs-bench.ts:403` — anchor: `sotaOn: state.preset`
- **클러스터**: Knobs + config + presets
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/knobs-bench.ts:262,403`

**영향 (왜 문제인가)**

A computed field that nothing reads is dead weight that misleads future readers (the doc says callers branch on it). It also silently mis-reports: `agentless-v1-nosteer`/`agentless-v2`/all v3 presets are functional supersets of agentless-v1 yet get sotaOn=false, so any future consumer wiring would get wrong answers for those arms.

**증거**

```
knobs-bench.ts:403 `sotaOn: state.preset === "agentless-v1",` is set on every BenchPosture, but `grep -rn sotaOn src --include=*.ts` (excluding knobs-bench.ts) returns NOTHING — no buildConfig, no report, no driver branch reads it. The doc comment at line 260-262 claims callers branch on it ("True when the SOTA super-preset is active"), but they don't.
```

**검증 노트 (skeptic)**

VERIFIED REAL (dead-code/low). At src/runner/batch/eval/knobs-bench.ts:403 every BenchPosture sets `sotaOn: state.preset === "agentless-v1"`, declared at line 262. A whole-repo grep for `sotaOn` (and for `.sotaOn` property reads) returns exactly two reads, BOTH in tests/unit/bench-sota-preset-hellgate.test.ts (lines 83, 92), and zero in production. Compare to every other BenchPosture field returned by benchOptIns()/benchPostureFromState — `.reproVote`, `.noPatchBreaker`, `.retryTransient`, `.adversarialRepro`, etc. all have real driver.ts consumers (driver.ts:1755, 2254, 3073, 832...). `sotaOn` has none. So it is a genuinely dead computed telemetry field.

The "misleads future readers" consequence holds, and is in fact stronger than the auditor stated: benchPostureFromState (lines 323-403) derives every behavioral posture field (lspNav, localizePhase, issueHintMode, issueHintExpectedActual) from individual knob values via readKnobValue — NOT from sotaOn. Yet the hellgate test comments (lines 44, 54, 68, 131) describe an OLD architecture where each field was `sotaOn || ...`, and SOTA-4's comment (lines 76-77) explicitly claims "callers (buildConfig, knobsForReport) can branch" on sotaOn — which no caller does. SOTA-4/SOTA-5 are tautological wiring assertions (assert the field they just set), not behavior tests of any consumer; the other SOTA tests pass via the agentless-v1 preset setting individual knobs, not via sotaOn.

Two minor corrections to the auditor: (1) the "callers branch" claim lives in the TEST comment, not the doc comment at 260-262 (which only says "True when the SOTA super-preset is active") — slight misattribution. (2) The "silently mis-reports for v2/v3/nosteer presets" consequence is purely hypothetical — strict `=== "agentless-v1"` would indeed return false for those supersets, but since there are zero consumers nothing is actually mis-reported today; it's a latent forward-looking risk, not a live bug.

Severity LOW is correct: a single harmless derived boolean with no production reads. Real dead code worth deleting (along with the misleading test comments), but no functional impact.

---

<a id="15"></a>
### 15. 🟡 SOTA hellgate test comments describe a `sotaOn ||` / `sotaOn ? :` composition that no longer exists in benchPostureFromState (stale red-on-injection claims, lost teeth)

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `jank` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `tests/unit/bench-sota-preset-hellgate.test.ts:44` — anchor: `\`lspNav = sotaOn || ...\``
- **클러스터**: Knobs + config + presets
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `tests/unit/bench-sota-preset-hellgate.test.ts:44-45,54-55,68-69,98-100,113`

**영향 (왜 문제인가)**

The 'Red-on-injection: remove `sotaOn ||`...' claims are false — that code is gone, so the stated mutation can't fail the test. The tests no longer guard what their comments say they guard; an engineer trusting them would believe sotaOn is load-bearing for lspNav/localizePhase/issueHint when it is inert (see companion dead-field finding).

**증거**

```
Test comments assert e.g. `lspNav = sotaOn || gateOn(BENCH_LSP)` (line 44, 99-100) and `sotaOn ? { phase1Turns: 5 } : undefined` (line 54) and `sotaOn ? "agentless" :` (line 68). But the current benchPostureFromState (knobs-bench.ts:327,330,342) reads each value from the resolved PRESET-LAYER knob state (`readKnobValue(state,"lsp",isTrue)`, `"localize-phase"`, `"issue-hint"`) — there is no `sotaOn ||` or `sotaOn ?` anywhere. The tests still PASS only because the agentless-v1 preset expands to lsp:1/localize-phase:5/issue-hint:agentless via the resolver, not via sotaOn.
```

**검증 노트 (skeptic)**

The finding is factually correct. tests/unit/bench-sota-preset-hellgate.test.ts imports benchOptIns from src/apps/bench/eval/driver, which delegates to benchPostureFromState(resolveBenchKnobs(...)) in src/runner/batch/eval/knobs-bench.ts. The cited comments (lines 44-45, 54-55, 68-69, 98-100, 113) describe a `sotaOn || gateOn(BENCH_LSP)`, `sotaOn ? {phase1Turns:5} : undefined`, and `sotaOn ? "agentless" :` composition that does NOT exist in the current code. benchPostureFromState (knobs-bench.ts:327,330,342) reads each value via readKnobValue(state,"lsp"/"localize-phase"/"issue-hint",...) from the resolved PRESET-layer knob state; sotaOn (line 403) is merely a derived label `state.preset === "agentless-v1"`.

I proved the lost teeth via injection: forcing sotaOn to false (line 403) fails ONLY SOTA-4 (which directly asserts opt.sotaOn===true); SOTA-1/lspNav, SOTA-2/localizePhase, SOTA-3/issueHintMode all still PASS — confirming those fields do not read sotaOn, contradicting the "Red-on-injection: remove sotaOn ||" comments. I also probed SOTA-6: its comment claims lspNav stays true because "sotaOn is true and the OR short-circuits," but the actual reason is that QUANTA_BENCH_LSP=0 is treated as falsy/unset by the gate parser so the preset's lsp:1 wins at the preset layer (lsp resolves to {value:true,source:"preset"}). The comment's stated mechanism is wrong on two counts.

Downgraded from med to low: this is pure comment/red-on-injection drift, not lost behavioral coverage. The tests still PASS and still have real teeth against the actual mechanism — breaking the real readKnobValue(lsp) path fails SOTA-1 and SOTA-6, and the agentless-v1 preset genuinely expands to lsp:1/localize-phase:5/issue-hint:agentless (presets.ts:38-48), so the end-to-end SOTA=1 contract is still enforced. The harm is bounded to misleading an engineer about WHY the guard fires (believing sotaOn is load-bearing when it is an inert derived field), with no actual test coverage of the SOTA behavior lost.

---

<a id="16"></a>
### 16. 🟡 readSite for the 8 NOOP-bench closure knobs points at the NOOP knob-declaration file, not the effect site (driver.ts), so /knobs mis-routes an operator debugging 'why is this on'

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `jank` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/config/knob-inventory.ts:1177` — anchor: `readSite: "runner/knobs/knobs/primary-rail.ts"`
- **클러스터**: Knobs + config + presets
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/config/knob-inventory.ts:1150-1218`

**영향 (왜 문제인가)**

readSite is documented (header line 10-12) as the field /knobs and discoverability point operators at. For these knobs it points at a file whose code is `(cfg)=>cfg` — an operator debugging behavior is sent to a no-op rather than the driver where the knob actually gates. The convention is also internally inconsistent: comparable NOOP knobs like repro-test/localize-phase use readSite=driver.ts (line 1072,1108).

**증거**

```
fault-evidence/verification-plan/primary-rail/patch-hygiene/no-patch-breaker/repair-escalation/spec-fidelity-steer readSites are `runner/knobs/knobs/<knob>.ts` (e.g. line 1157 `readSite: "runner/knobs/knobs/fault-evidence.ts"`). Those files are NOOP-apply (`applyFaultEvidence = (cfg)=>cfg`); the actual behavioral read is driver.ts via benchPostureFromState (driver.ts:2461,2492,2806-2814; 2754 etc., spec-fidelity at driver.ts:1248). The truthfulness ratchet (tests/unit/knob-inventory-readsite-truthful-hellgate.test.ts:48) only checks the file contains the envKey LITERAL, which is satisfied by the `envKey:` field in the registration — so it cannot catch this.
```

**검증 노트 (skeptic)**

All factual claims verified against the actual code.

(1) NOOP confirmed: the 7 referenced knob files (fault-evidence/verification-plan/primary-rail/patch-hygiene/no-patch-breaker/repair-escalation/spec-fidelity-steer.ts under src/runner/knobs/knobs/) all define `apply = (cfg: AgentConfig): AgentConfig => cfg` — a pure no-op. Their own headers state "NOOP-apply registry entry: the EFFECT is delivered out of band by the bench driver via benchPostureFromState".

(2) readSite points at the NOOP file: knob-inventory.ts:1157,1167,1177,1187,1197,1207,1217 set readSite to `runner/knobs/knobs/<knob>.ts`, matching the finding's line citations exactly.

(3) Real effect site is driver.ts via benchPostureFromState: confirmed at driver.ts:1248 (specFidelitySteer), 2471/2502-2503 (faultEvidence/primaryRail), 2764-2773 (verificationPlan/primaryRail), 2804-2831 (patchHygiene/verificationPlan/faultEvidence/repairEscalation/noPatchBreaker). posture.* fields are the behavioral gates.

(4) Ratchet cannot catch it: knob-inventory-readsite-truthful-hellgate.test.ts:48 only checks `readFileSync(abs).includes(e.envKey)` — and the NOOP file satisfies that purely via its `envKey: "QUANTA_BENCH_FAULT_EVIDENCE"` registration field (confirmed at fault-evidence.ts:28), not via any actual behavioral read. So the truthfulness ratchet is satisfied while the readSite points at a no-op.

(5) Convention inconsistency confirmed: comparable bench NOOP/value knobs use readSite=driver.ts — localize-phase:1072, branch-search:1081, repro-test:1108.

Severity assessment (kept at low, not raised, not dropped to none): The header (lines 9-12) does document readSite as the /knobs discoverability point, and pointing it at a `(cfg)=>cfg` file is genuinely misleading and inconsistent with sibling knobs — so this is real jank, not a false positive. However the claimed consequence ("operator sent to a no-op dead end") is mildly overstated: the NOOP file's own header explicitly forwards the reader to benchPostureFromState/the driver, so it is a one-hop documented redirect, not a true dead end. Audience is bench operators only and all 8 knobs are default-OFF, so blast radius is tiny. Net: real low-severity discoverability/consistency wart, matching the auditor's own jank/low classification.

---

<a id="17"></a>
### 17. 🟡 Dataset JSONL parsed 3× per run (and again for dry-run plan)

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `efficiency` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/index.ts:141` — anchor: `split("\n")`
- **클러스터**: Leaderboard / analyze / CLI
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/index.ts:458-474`

**영향 (왜 문제인가)**

readSwebenchTasks reads+parses the whole file for the empty check, then readFilteredSwebenchTasks reads+parses it AGAIN to filter; maybeRunDatasetMode already called selectSwebenchTasks (parse #3) earlier to build the dry-run plan and discarded it. For a large Verified dataset (500 rows) this re-reads/re-parses the same file every entry. Not a correctness bug, but pointless repeated IO+JSON parse on the run path.

**증거**

```
const parsed = readSwebenchTasks(datasetFile)   // parse #1 (empty check)
... 
const tasks = readFilteredSwebenchTasks(datasetFile)   // parse #2 (re-reads + re-parses + re-filters)
```

**검증 노트 (skeptic)**

Confirmed by reading src/apps/bench/index.ts and the parse implementation.

On the non-dry-run path the same dataset file is read + JSON-parsed 3 times:
1. maybeRunDatasetMode (line 648): selectSwebenchTasks(datasetFile) -> readFilteredSwebenchTasks -> readSwebenchTasks -> readFileSync + parseSwebenchJsonl. This runs unconditionally (before the --dry-run branch), and on the run path its result `tasks` is NOT passed to runDatasetMode (only datasetFile is, line 663). So it is discarded.
2. runDatasetMode (line 465): readSwebenchTasks(datasetFile) for the empty check — full read + parse again.
3. runDatasetMode (line 473): readFilteredSwebenchTasks(datasetFile) — full read + parse + filter again.

parseSwebenchJsonl (src/runner/batch/corpus/dataset.ts:96) does text.split + per-line JSON.parse with no memoization, and readSwebenchTasks (line 442) does a fresh readFileSync each call. No caching layer exists. So the redundant IO+parse is real.

Caveats that keep this LOW: (a) the cost is once per process invocation at startup, NOT per task/per entry as the consequence text ("every entry") implies — a mild overstatement; (b) it is bounded by file size (~500 rows) and is negligible relative to the actual benchmark work (per-task Docker grading + multi-minute LLM patch-gen). It is genuine pointless repeated IO/CPU but not a correctness bug and not performance-significant. Severity low (not none) because the redundancy is real and the fix is trivial: parse once and thread the parsed/filtered tasks through.

---

<a id="18"></a>
### 18. 🟡 --max-workers accepts negative / zero and ships it verbatim to remote --max_workers

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `jank` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/cli.ts:223` — anchor: `const mwRaw = argValue("--max-workers")`
- **클러스터**: Leaderboard / analyze / CLI
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/cli.ts:222-227`

**영향 (왜 문제인가)**

Number.isInteger(Number("-5")) and Number.isInteger(Number("0")) are both true, so `--max-workers -5` or `0` passes through buildBaseBackend into ssh.ts buildRemoteGradeScript which renders `--max_workers -5` for the official swebench harness. index.ts uses the strict argPositiveInt helper for exactly this class of garbage; this sibling parser does not, so an operator typo produces a broken/garbage remote grade command instead of a clear rejection or fallback to the default.

**증거**

```
const maxWorkers = mwRaw !== undefined && Number.isInteger(Number(mwRaw)) ? Number(mwRaw) : undefined
```

**검증 노트 (skeptic)**

Confirmed by reading the code and the full consequence chain. At src/apps/bench/cli.ts:224-225, `maxWorkers = mwRaw !== undefined && Number.isInteger(Number(mwRaw)) ? Number(mwRaw) : undefined`. Number.isInteger(Number("-5")) and Number.isInteger(Number("0")) are both true, so negatives/zero are accepted (set to the actual value, NOT undefined). It is then spread into `common` at line 228 because `maxWorkers !== undefined`.

The chain holds end-to-end: ssh.ts:102 resolves `opts.maxWorkers ?? cfg.maxWorkers ?? DEFAULT_MAX_WORKERS`. Critically, `??` (nullish coalescing) does NOT fall back on 0 or negative numbers — only on null/undefined — so a parsed 0 or -5 survives and overrides DEFAULT_MAX_WORKERS (=4, backend.ts:135). ssh.ts:83 then renders `--max_workers ${maxWorkers}` literally into the remote swebench harness command, producing `--max_workers -5` / `--max_workers 0`. ec2.ts:327 has the identical `??` pattern.

The contrast claim is also accurate: the sibling helper argPositiveInt (index.ts:162-171) uses `/^\d+$/` plus `n > 0`, rejecting negatives/zero/garbage and warning, then falling back. buildBaseBackend's inline parser does neither. So the two parsers in the same module disagree on this exact garbage class.

Severity stays low/jank (auditor's own rating): it requires an operator CLI typo on a benchmark grading tool, there is no security or silent-wrong-answer impact, and the failure is a broken/garbage remote grade command (the official harness would error or misbehave) rather than data corruption. Not correct-by-design, not intentional fail-open, not a default-OFF knob.

---

<a id="19"></a>
### 19. 🟡 --skip-resolved casts resolved_ids to string[] without filtering non-strings

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/cli.ts:1577` — anchor: `as string[]`
- **클러스터**: Leaderboard / analyze / CLI
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/cli.ts:1526-1527`

**영향 (왜 문제인가)**

Unlike verdicts.ts strArray (which filters to non-empty strings), this takes the array as-is. A malformed prior report (numbers/nulls in resolved_ids, or double-encoded JSON string) flows unfiltered into the `done` Set and into mergedResolved, which is then logged as the merged resolved tally and could mis-skip or pollute the headline count. verdicts.strArray already exists and handles exactly this; reusing it would close the gap.

**증거**

```
const rep = JSON.parse(readFileSync(skipReport, "utf8")) as { resolved_ids?: unknown }
priorResolved = Array.isArray(rep.resolved_ids) ? (rep.resolved_ids as string[]) : []
```

**검증 노트 (skeptic)**

The cited line numbers (1526-1527) are wrong — those are provisionBox — but the evidence text matches the real code at src/apps/bench/cli.ts:1576-1577. The code does exist and does cast unfiltered: `priorResolved = Array.isArray(rep.resolved_ids) ? (rep.resolved_ids as string[]) : []`. The reuse premise is sound: verdicts.ts:37-50 `strArray` is a real, more-robust coercer for the SAME resolved_ids field — it filters non-strings/empty-strings AND handles the double-encoded-JSON-string case the comment says some swebench exports produce. So this site reinvents a weaker inline version. That's a legitimate low-severity correctness/reuse gap.

But the claimed consequence is partially overstated. (1) Numeric/null pollutants flow into `done = new Set(priorResolved)`, which is only consumed via `done.has(instance_id)` where instance_id is a string — numbers/nulls simply never match a string key, so they CANNOT cause a mis-skip. (2) The double-encoded-JSON-string case is the more concrete real defect, but it makes Array.isArray false → priorResolved=[] → the skip becomes a silent no-op (re-grades everything): the SAFE direction, not a wrong-skip. (3) The only real harm is count pollution: pollutant entries inflate `mergedResolved.length` in the logged tally (line 1608), and only when fed a hand-malformed report. Net: real but minor robustness/consistency gap, consequence ("mis-skip or pollute") overstated on the mis-skip half. Low severity (dev-facing CLI flag reading a report the dev just produced; degrades safely on the realistic double-encode case).

---

<a id="20"></a>
### 20. 🟡 Hand-rolled `uri.replace(/^file:\/\//,"")` mishandles URL-encoded paths instead of using fileURLToPath

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/agent/lsp-bridge.ts:576` — anchor: `l.uri.replace(/^file:`
- **클러스터**: LSP / pyright / prewarm
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/lsp-bridge.ts:572-577, 742`

**영향 (왜 문제인가)**

`@/lsp/adapters/base.ts` correctly uses `fileURLToPath()` everywhere it converts a `file://` URI to a path. These two sites re-implement it with a naive prefix strip that leaves percent-encoding intact: a workspace path containing a space (or any non-ASCII char) yields a URI like `file:///a%20b/c.py`, and the strip produces the literal `/a%20b/c.py` — a path that does not exist. In `evidenceLspStatic.toLoc` this emits a wrong `definition_chain`/`references` file into the Evidence Packet; in `lspCodeActionPort.applyEdit` it picks the wrong file to open a server for. Use `fileURLToPath` (already imported in the lsp slice) for parity and correctness.

**증거**

```
const toLoc = (l) => ({ file: l.uri.replace(/^file:\/\//, ""), line: l.range.start.line + 1 })
...
const file = firstUri.replace(/^file:\/\//, "")
```

**검증 노트 (skeptic)**

The code at lines 576 and 742 is accurately quoted: both sites do `uri.replace(/^file:\/\//,"")` instead of `fileURLToPath`. `node:url` is not imported in lsp-bridge.ts, while base.ts consistently uses fileURLToPath/pathToFileURL (verified at base.ts:4,692,737,1041,1274,1550). The encoding mismatch is real and reproducible: `file:///a%20b/c.py` → naive strip gives `/a%20b/c.py` vs fileURLToPath gives `/a b/c.py`. So the underlying mechanical defect is genuine.

However the claimed consequences are overstated on both sites:

Site 1 (toLoc, line 576): The resulting `file` flows into StaticEvidence.definition_chain/references, which is serialized as LLM input via `JSON.stringify(pkt)` (tool.ts:24) — it is informational context shown to the model, NOT used as a live filesystem path downstream (the fs-path usages in builder.ts/runtime.ts come from the separate test-failure `file` field, not LSP nav results). So a path with spaces/non-ASCII degrades to a `%20`-encoded string the model reads — cosmetic/context degradation, not a wrong-file crash. Real but low impact, and only triggers on workspaces with spaces/non-ASCII path components, which is uncommon for the SWE-bench/Python repos this targets.

Site 2 (applyEdit, line 742): The claim "picks the wrong file to open a server" is FALSE. The stripped `file` is used ONLY for `specFor(file)` (which reads only `extname()` — the extension `.py` is never percent-corrupted) and for an error-message string. The actual edit application calls `DefaultCodeActionAdapter.applyEdit(edit)` → `client.applyWorkspaceEdit(edit)`, passing the original `edit` object whose URIs base.ts decodes correctly. Moreover the method is dormant per its own comment (line 736: "applyEdit is not used by lsp_code_action (enumeration only)"). So no wrong server is opened and no consequence materializes here.

Net: a genuine parity/correctness nit (should use fileURLToPath for consistency and to avoid %20 leaking into evidence text), but the headline consequence ("path that does not exist", "wrong file to open a server") is overstated. Severity low: real-but-minor, edge-triggered (paths with spaces), evidence-text-only impact, second site inert.

---

<a id="21"></a>
### 21. 🟡 Import-probe line cap silently marks a file 'verified-ready' when imports live past line 200

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/agent/lsp-bridge.ts:192` — anchor: `PYRIGHT_IMPORT_SCAN_LINE_CAP = 200`
- **클러스터**: LSP / pyright / prewarm
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/lsp-bridge.ts:222-238, 260-272`

**영향 (왜 문제인가)**

`findPyrightImportProbe` only scans the first 200 lines. A file whose first import statement appears after line 200 (large modules, big license/docstring headers) yields `probe === null`, which `ensurePyrightFileReady` treats identically to a genuinely import-less file: it returns `true` (verified-ready) WITHOUT ever confirming pyright resolved a cross-file symbol. The pool then marks the file prepared and the first real nav call may hit a still-cold server — exactly the hang the readiness probe exists to prevent. The cap conflates 'no import probe possible' with 'verified ready'; the two should be distinguishable so a no-probe file does not falsely claim warm-verified status.

**증거**

```
for (let i = 0; i < lines.length && i < PYRIGHT_IMPORT_SCAN_LINE_CAP; i++) { ... }
return null
...
const probe = await readPyrightImportProbe(filePath)
if (probe === null) return true
```

**검증 노트 (skeptic)**

The factual core is correct: findPyrightImportProbe (lsp-bridge.ts:222-238) scans only the first PYRIGHT_IMPORT_SCAN_LINE_CAP=200 lines, and a Python file whose first import statement lives past line 200 yields probe===null indistinguishably from a genuinely import-less file. ensurePyrightFileReady (260-273) returns true on probe===null, and warmFile in lsp-workspace-pool.ts:274 then adds the file to entry.preparedFiles. So the conflation between "no import to probe" and "import exists but past cap" is real, and a capped-out file IS marked prepared without the cross-file resolve check the probe exists to perform.

However the claimed consequence is overstated for three reasons:
1. The no-probe→return-true path is an EXPLICIT, documented design decision, not an accident. The doc comment (250-256) states return true = "verified-ready (or no probe)". Only the cap-conflation subset is unintentional; the fail-open-on-no-probe behavior is intended.
2. Returning true is NOT a no-op: ensurePyrightFileReady first awaits client.prime(filePath) (line 271), which does didOpen/didChange (base.ts:753 ensureOpen). The document is genuinely opened into the live server, so the file is partially warmed — it's a graceful degradation, not a fully cold server.
3. The "exactly the hang the readiness probe exists to prevent" framing overstates impact: a subsequent nav call on a still-indexing server is bounded by the nav RPC timeout (definition() propagates transport/timeout errors to the tool layer which degrades), not an unbounded hang. And the trigger (a Python file whose FIRST import appears after line 200) is a narrow edge case.

Net: a real but minor latent imperfection (the two cases should be distinguishable so a no-probe file does not claim warm-verified status), correctly classified as low severity. Not a false positive — the code does conflate the cases — but the consequence ("falsely claim warm-verified status" causing the exact hang) is overstated given the prime() warming and bounded nav timeouts.

---

<a id="22"></a>
### 22. 🟡 Unreachable lease-release after handleChunkBudgetWaitError (which is `: never`)

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `dead-code` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/remote/pool.ts:791` — anchor: `handleChunkBudgetWaitError(workerId`
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/remote/pool.ts:785-788`

**영향 (왜 문제인가)**

handleChunkBudgetWaitError unconditionally throws (return type `never`), so the authLease?.release/`authLease=undefined`/`continue` on lines 786-788 can never execute. The lease is in fact returned by the outer `finally` at line 831, so it isn't actually leaked — but the dead lines imply a recovery/requeue path that does not exist (a budget-wait timeout aborts the whole worker, not just this chunk). Misleading; should be deleted or the throw replaced with a real requeue if per-chunk recovery was intended.

**증거**

```
const handleChunkBudgetWaitError = (...): never => { ... throw new Error(...) }
...
} catch (err) {
  handleChunkBudgetWaitError(workerId, chunk, runtime, err)
  authLease?.release({ rateLimited: false, lostBox: false, completed: false })
  authLease = undefined
  continue
}
```

**검증 노트 (skeptic)**

Confirmed by the actual code. `handleChunkBudgetWaitError` (pool.ts:571-584) has return type `: never` and ends with an unconditional `throw new Error(...)` at line 581 — no early return, no conditional throw. In the catch block (lines 787-792), the call at line 788 always throws, making lines 789-791 (`authLease?.release(...)`, `authLease = undefined`, `continue`) statically unreachable dead code. The auditor's secondary claim is also correct: there is no actual lease leak, because the thrown error propagates up through the outer `finally` at lines 833-837 (line 836 `authLease?.release(...)`), which releases the lease. (Minor cite imprecision: the auditor said "line 831" but the real release-on-throw is line 836; this does not change the conclusion.) The dead lines misleadingly imply a per-chunk recovery/`continue` path that does not exist — a budget-wait timeout in fact aborts the whole worker and the run, since the throw propagates through both finallys to the caller. So the consequence is exactly as claimed: harmless-but-misleading dead code that should be deleted, or the throw replaced with a real requeue if per-chunk recovery was intended. Severity low is appropriate: no runtime misbehavior, no leak — purely a code-clarity/maintenance issue. Note this is an uncommitted working-tree change (git blame shows lines 786-789 "Not Committed Yet").

---

<a id="23"></a>
### 23. 🟡 runId flows unquoted into remote ssh commands with no boundary sanitization (shell-injection defense-in-depth gap)

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/remote/box-session.ts:854` — anchor: `\`~/runs/${snapshot.runId}/run.log\``
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/remote/box-session.ts:270-277, 611, 1699-1717, 44 (PoolChunk.runId)`

**영향 (왜 문제인가)**

Unlike preset/model/instanceIds (wrapped in shq()), the runId-derived paths are interpolated raw into ssh command strings. A runId containing a space, `;`, `$(...)`, or backtick breaks out of the intended command on the box. The one wired caller (microchunk.ts) sanitizes the instance-id suffix and uses an ordinal prefix, so it is currently safe, but the boundary itself has no guard — assertUniqueChunkRunIds checks only uniqueness. A future direct PoolChunk constructor (or a baseRunId derived from an attacker-influenced dataset path) injects shell on a box that holds a live credential. Add a runId charset assertion in assertUniqueChunkRunIds / chunkBoxPaths.

**증거**

```
chunkBoxPaths(runId) => { dataset: `~/runs/${runId}/instances.jsonl`, ... }
// pool.ts: const paths = chunkBoxPaths(chunk.runId); await session.ssh(`mkdir -p ${paths.observeDir}`)
// box-session buildBenchCommand interpolates paths.dataset/preds/report/observeDir UNQUOTED into the bench command, and runChunkBench/detachedLaunchCommand embed runLog/runExit unquoted too.
// PoolChunk doc only ASSERTS: 'MUST be filesystem-safe (no spaces / slashes)' — nothing enforces it.
```

**검증 노트 (skeptic)**

The mechanical claims are all accurate. chunkBoxPaths (pool.ts:271-277) interpolates runId raw into `~/runs/${runId}/...`; those ChunkPaths flow UNQUOTED into buildBenchCommand (box-session.ts:1750-1752: `--swebench ${paths.dataset}`, `--observe-dir ${paths.observeDir}`, `--predictions ${paths.preds} --report ${paths.report}`), detachedLaunchCommand (1465-1466: `${runLog}`/`${runExit}` raw), and the pool's `session.ssh(`mkdir -p ${paths.observeDir}`)` (pool.ts:614). Unlike preset/model/instanceIds, which are shq()-wrapped, the runId-derived paths get no quoting. assertUniqueChunkRunIds (pool.ts:144-155) checks ONLY uniqueness — no charset assertion — and PoolChunk.runId's doc (pool.ts:44-45) merely ASSERTS "MUST be filesystem-safe" without enforcing it. So the boundary-guard gap is real.

However the CLAIMED CONSEQUENCE (shell injection on a live-credential box) is NOT currently reachable, which the finding itself concedes ("currently safe"). EVERY wired PoolChunk constructor sanitizes the runId to `[A-Za-z0-9_-]`: cli.ts runIdFromDataset (415-417) and buildPoolChunks (424-435), and microchunk.ts baseRunIdFromPath/sanitize + ordinal prefix (34, 37-38, 73-74). No unsanitized wired runId-producing path exists. The exploit requires a hypothetical FUTURE direct constructor bypassing both sanitizers.

Threat model is also weak: this is a local operator-run benchmarking CLI; runId derives from the operator's OWN local dataset filename, and the "attacker-influenced dataset path" must survive the operator's filesystem plus the existing charset filter (it can't). The trust boundary is effectively the operator themselves, who already controls the box and its credentials. This is a legitimate defense-in-depth hardening item (add a charset assertion at the chunkBoxPaths/assertUniqueChunkRunIds boundary so the doc-comment invariant is enforced rather than merely asserted), but it is not an exploitable med correctness/security bug today — hence low.

---

<a id="24"></a>
### 24. 🟡 stripToAccessToken silently drops account fields whose absence may make the shipped token unusable, only guarding access_token

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `correctness` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/remote/box-session.ts:141` — anchor: `"expires_at", "last_refresh"`
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/remote/box-session.ts:127-149`

**영향 (왜 문제인가)**

Only access_token absence is fail-fast. If the source token has a present-but-expired `expires_at` (or the box clock differs), the shipped credential is accepted by the loader (refresh_token is the REDACTED placeholder, so the box CANNOT refresh) and every turn 401s — producing exactly the '0 turns / empty patch after a full provision cycle' silent waste the guard claims to prevent, just via a different field. Not a leak (the strip itself is correct and refresh/id are dropped as intended), but the freshness guarantee the pool relies on ('FRESH token per chunk') is unchecked against expires_at.

**증거**

```
for (const k of ["access_token", "account_id", "expires_at", "last_refresh", "plan_type"]) {
  if (parsed[k] !== undefined) safe[k] = parsed[k]
}
safe.refresh_token = REDACTED
safe.id_token = REDACTED
```

**검증 노트 (skeptic)**

The finding is mechanically REAL and the claimed consequence is reachable through the exact wired path. The box launches with QUANTA_PROVIDER=chatgpt-oauth (src/apps/bench/remote/box-session.ts:1745), so it uses ChatGPTOAuthAdapter. At the top of every stream() call, ensureFreshToken() (chatgpt-oauth.ts:213-284) reads the shipped token and calls isExpired(rec, now, TOKEN_REFRESH_SKEW_MS=60_000). If the shipped expires_at is within 60s of now (clock skew between local box and EC2, near-expiry at ship time, or expiry during a chunk's grade run), it invokes refreshToken({current: rec}) where rec.refresh_token is the literal placeholder "REDACTED-not-shipped-to-remote" (box-session.ts:127,148). The issuer returns invalid_grant/400/401, classifyRefreshFailure maps it to kind:"auth" (non-retryable, no fallback per the adapter's documented retry policy), and ensureFreshToken throws an LLMError that kills the turn — producing the "0 turns / empty patch after a full provision cycle" silent waste that the stripToAccessToken guard explicitly exists to prevent (per its own comment at box-session.ts:131-133). The guard only fail-fasts on a missing/empty access_token (line 134) and never validates expires_at freshness, exactly as the finding states. isExpired also treats an unparseable/absent expires_at as expired (token-store.ts:273-274), so the strip's conditional copy (only-if-present) is a secondary corner with the same outcome.

Severity is correctly low, not higher: (1) ChatGPT OAuth access tokens are long-lived (hours), so the 60s-skew failure window is narrow; (2) the pool re-ships a FRESH token read off disk per chunk (pool.ts:617, shipAccessToken at box-session.ts:1721), so the relevant in-run window is a single chunk's duration, not the 150min box wall-time; (3) the impact is a failed bench arm with requeue, no security/data/leak impact (the strip itself is correct and refresh/id are dropped as intended). It is a genuine correctness gap — the freshness guarantee the pool advertises ("FRESH token per chunk") is unchecked against expires_at, and the ship path performs no pre-strip local refresh — but it is a self-limiting, narrow-window measurement-hygiene bug, matching the auditor's low rating.

---

<a id="25"></a>
### 25. 🟡 defaultAuthFile falls back to filesystem root when HOME is unset

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `silent-failure` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/auth-pool/load.ts:13` — anchor: `env.HOME ?? ""}/.quanta/auth`
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/auth-pool/load.ts:12-13`

**영향 (왜 문제인가)**

With HOME unset this yields `/.quanta/auth/chatgpt.json` (absolute, from FS root) rather than failing or using os.homedir(). A bench launch in an env without HOME silently reads the wrong absolute path and reports 'no usable access_token' far from the real cause, instead of a clear 'HOME unset' error. The codebase has a quantaHomeDir()/homedir() SSOT elsewhere; this hand-rolled join bypasses it.

**증거**

```
export const defaultAuthFile = (env: NodeJS.ProcessEnv): string =>
  `${env.HOME ?? ""}/.quanta/auth/chatgpt.json`
```

**검증 노트 (skeptic)**

The code at src/apps/bench/auth-pool/load.ts:12-13 matches the evidence: `defaultAuthFile` reads `env.HOME ?? ""`, so with HOME unset it yields the FS-root-absolute path `/.quanta/auth/chatgpt.json`, bypassing the project's home SSOT `quantaHomeDirFrom(env)` (src/shared/quanta-home.ts), whose `defaultHome()` uses `os.homedir()` (passwd-DB fallback when HOME is unset). The SSOT-divergence/consistency nit is REAL.

But the claimed consequence and the "silent-failure" label are wrong/overstated:
1. The resolved single-mode authFile flows into `readFileSync(authFile, "utf8")` at src/apps/bench/cli.ts:313 and :632. With HOME unset, `/.quanta/auth/chatgpt.json` does not exist, so this throws a LOUD `ENOENT ... open '/.quanta/auth/chatgpt.json'` — not silent, and the error names the offending absolute path (a clear hint HOME was empty).
2. The claimed misleading "no usable access_token" message lives in `stripToAccessToken` (src/apps/bench/remote/box-session.ts:134-138) and is only reachable AFTER the file is read+JSON-parsed. The ENOENT throw happens first, so that message is NOT produced in the HOME-unset scenario. The "reports 'no usable access_token' far from the real cause" claim is false.
3. Realism: a CLI bench tool's launch env essentially always has HOME set (shells, CI, EC2; bench explicitly ships $HOME). HOME-unset is an unusual edge case and fails loudly with the bad path visible.

Net: a real but minor consistency/robustness nit (should use the SSOT / os.homedir passwd fallback), mislabeled as silent-failure with a fabricated downstream message. Real defect, overstated consequence; severity low.

---

<a id="26"></a>
### 26. 🟡 gradeChunkOnBox + box-session.ts is a 600+ line module mixing lifecycle, snapshot telemetry, brittle remote python probe, verdict parsing, and command construction

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `god-code` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/remote/box-session.ts:1932` — anchor: `export const gradeChunkOnBox = async`
- **클러스터**: Remote bench / EC2 / pool
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/remote/box-session.ts:1426-1972`

**영향 (왜 문제인가)**

The embedded python probe (parsed back via brittle regex over `ps -Ao args` and `--report <path>` flag-scraping) is a parser-in-a-string with no test isolation from the TS side, and the snapshot machinery (createSnapshotController, ~15 normalize helpers) is interleaved with EC2 lifecycle. This is the WIP refactor's main rot surface: any change to the bench CLI flag names silently breaks the ps-regex probe (e.g. `--report\s+(\S+)`), and the failure mode is a degraded BoxRuntimeProbe (undefined fields) rather than an error — operator status quietly goes blank. Worth splitting probe/snapshot into their own tested modules.

**증거**

```
box-session.ts spans provisionBox, bootstrapBox, gradeChunkOnBox, a ~100-line embedded python boxRuntimeProbeCommand heredoc (lines 724-822), snapshot normalize/parse helpers, detached-poll streaming, grade-lock, artifact fetch — all in one file; gradeChunkOnBox alone orchestrates lock+upload+ship+run+fetch+parse+diagnostics+snapshot across ~80 lines with a multi-step finally.
```

**검증 노트 (skeptic)**

The structural observation is REAL but the severity/consequence framing is overstated.

REAL parts: box-session.ts is genuinely large (2030 lines, not "600+" — even bigger than claimed) and does mix concerns: provisionBox/bootstrapBox/attachBox lifecycle (lines 1183-1452), a ~100-line embedded python heredoc probe (boxRuntimeProbeCommand, 737-835), ~15 snapshot normalize helpers (normalizeSnapshotPayload/snapshotVerdictMeta/etc 640-733), detached-poll streaming (runBenchDetachedPoll 1491-1522), grade-lock + gradeChunkOnBox orchestration with a multi-step finally (1932+), and artifact fetch/verdict parse. So "god module mixing N concerns" is factually accurate as a code-smell, and god-code/low is a fair classification.

OVERSTATED / wrong parts of the CLAIMED CONSEQUENCE:
1. "Parser-in-a-string with no test isolation from the TS side" — FALSE as stated. The probe's JSON contract IS exercised by an integration test: tests/integration/bench-box-ls-status.test.ts feeds a real probe payload (line 134) through inspectBox -> readBoxRuntimeProbe -> normalizeRuntimeProbePayload and asserts both the rendered status ("source=probe active=yes report=no runExit=no preds=84", line 208) and the --json shape (lines 266-272). The TS-side parse (normalizeRuntimeProbePayload, 691-733) is therefore covered. What is NOT tested is the in-string python regex logic itself (the ps-scrape happens on the live box), but that is inherent to any remote probe, not unique rot.

2. "Any flag rename silently blanks the probe / operator status goes blank" — OVERSTATED. The python probe has explicit fallbacks (lines 810-818): if --report/--predictions/--observe-dir scrape returns None, it derives them from latest_log()/dirname, and activeRunDetected is computed from process-name matching ('src/apps/bench/cli.ts run' and 'swebench.harness.run_evaluation', lines 803-804/821), not from flag scraping. So a --report rename degrades ONE field, not the whole probe; activeRunDetected, run.log path, mtime, and lastLogLine survive. Status does not "go blank."

3. Failure-mode criticality is overstated: readBoxRuntimeProbe is fail-open-to-undefined (840-846) and is consumed ONLY by inspectBox for the `box ls` operator status display (cli.ts 836-895), never on the grading/correctness path. A degraded probe yields a missing optional field in a human status table, not a wrong grade or run failure. inspectBox also already falls back to snapshot (statusSource snapshot>probe>launch-tags>none, cli.ts 838-844).

Net: a legitimate maintainability/cohesion note (split probe+snapshot into tested modules is reasonable) but the alarming "brittle untested parser, silent blank status" framing does not hold against the code (fallbacks present) or the test tree (integration coverage exists). low severity, real-but-overstated.

---

<a id="27"></a>
### 27. 🟡 Two drivers diverged: production apps driver has tentative-patch retention the runner driver lacks

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `duplication` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/eval/driver.ts:338` — anchor: `const tentativeOn =`
- **클러스터**: Repair orchestrator + eval drivers
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/eval/driver.ts:844-991`

**영향 (왜 문제인가)**

The cluster brief requires the two drivers emit IDENTICAL telemetry/behavior to prevent split-brain. They already differ on tentative retention, knobs_applied (finding 1), regression localEnv (finding 2), and budget-timeout scaling. The runner driver is a test-only twin that has silently drifted from the production path it is supposed to mirror; tests pin behavior that production no longer has (and vice versa). Every future change risks landing in one twin only.

**증거**

```
Apps driver runAgentPhase wires DEFAULT-ON tentative retention: src/apps/bench/eval/driver.ts:338 `const tentativeOn = instance.swebench !== undefined && !gateDisabled(process.env, "QUANTA_BENCH_TENTATIVE")`, 340 createTentativeRecorder(), 342 onVerifyPass, 391 recorder.selectEmitted, 397 logger.warn '[tentative] ENGAGED'. The runner driver runAgentPhase (src/runner/batch/eval/driver.ts:1653-1710) has ZERO tentative logic (`grep tentative` → 0 hits). The apps `runInstance` itself calls the runner wrapper '(dead)' in its own comment (apps driver line 960-964). No non-test file imports the runner-driver runInstance (`grep` confirms only apps/bench/eval/driver.ts imports from @/runner/batch/eval/driver, and it re-implements runInstance).
```

**검증 노트 (skeptic)**

The core technical claim is REAL and verified in the actual code:
- Runner driver runAgentPhase (src/runner/batch/eval/driver.ts:1675) constructs BenchStreamTap with `undefined` as the onVerifyPass callback — it has zero tentative-patch logic (`grep -i tentative` → 0 hits).
- Apps driver runAppMainPhase (src/apps/bench/eval/driver.ts:338-401) wires DEFAULT-ON tentative retention: createTentativeRecorder(), onVerifyPass snapshotting, recorder.selectEmitted, and the '[tentative] ENGAGED' log. Confirmed verbatim.
- The runner driver's runInstance is effectively dead in production: src/apps/bench/eval/index.ts:8 re-exports runInstance from the APPS ./driver, and the agent-mode batch preset dynamic-imports BENCH_EVAL_MODULE = "@/apps/bench/eval" (src/apps/agent/mode-presets/batch.ts:56,95). The runner's own export (src/runner/batch/eval/index.ts:8) has NO production importer — only 3 test files import it. The apps driver's own comment (line 961) calls the runner wrapper "(dead)." So the orchestration shell is genuinely duplicated and the runner twin has drifted.

However the finding is OVERSTATED in ways that change severity:
1. The supporting EVIDENCE claim "only apps/bench/eval/driver.ts imports from @/runner/batch/eval/driver" is FALSE. The runner driver is the SHARED LIBRARY: the apps driver imports ~20 helpers from it (prepareAttemptContext, verifyAndFinalizeResult, maybeValidateTerminalResult, runRetryLoop, projectOutcome, resolveBenchKnobs, etc., lines 26-46), and 8 knob files + stream-tap also import from it. So it is NOT a "test-only twin" — only its top-level orchestration shell (runInstance/runInstanceOnce/runAgentPhase) is duplicated; the heavy phase logic is genuinely shared, undercutting the "two diverged drivers / split-brain" framing.
2. Production behavior is correct: the runner shell is never executed in production, so there is no runtime defect — only a dead, test-pinned duplicate that is stale on the tentative axis. The "every future change risks landing in one twin" risk is partly mitigated by an existing parity guard (tests/unit/runner/verify-select-driver-parity.test.ts source-greps BOTH drivers), though that guard does not cover the tentative axis specifically.

Net: a genuine but low-impact duplication/dead-code drift, not a correctness or split-brain bug. The misstated importer claim and the absence of any production execution of the runner shell drop this from med to low.

---

<a id="28"></a>
### 28. 🟡 `endReasonOf` ignores `InstanceResult.stopReason`, so `no_patch_exhausted_rate` is ~always 0 for single-attempt runs

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/closure-diagnostics-io.ts:32` — anchor: `const endReasonOf = (r: InstanceResult)`
- **클러스터**: Repair orchestrator + eval drivers
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/closure-diagnostics-io.ts:32-42`

**영향 (왜 문제인가)**

In the common single-attempt configuration, endReasonOf returns null for every instance, so classify() can never produce `no_patch_exhausted`, and `no_patch_exhausted_rate` — one of the headline closure metrics computed in computeClosureDiagnostics (closure-diagnostics.ts:184) — reads a systematic 0. A real `stopReason:"max_turns"` with empty patch is misclassified as `empty_patch_other`. The diagnostic the sidecar exists to surface is silently wrong; `r.stopReason` is sitting right there unused.

**증거**

```
endReasonOf reads ONLY `r.budget?.attemptOutcomes`:
  src/runner/batch/eval/closure-diagnostics-io.ts:33 `const outs = r.budget?.attemptOutcomes ?? []` … returns null if none match.
But `budget` is stamped ONLY on the multi-attempt path; the default maxAttempts===1 path returns the result with NO budget (apps driver line 974 returns runInstanceOnce verbatim; runner driver lines 3088-3090 same). `InstanceResult.stopReason` exists (src/runner/batch/types.ts:146) and is populated on every run but is never consulted here. classify() needs endReason==='max_turns'||'budget_exhausted' to yield 'no_patch_exhausted' (closure-diagnostics.ts:117-119).
```

**검증 노트 (skeptic)**

The code mechanism is accurately described and the bug is real-but-narrow.

CONFIRMED FACTS:
- `endReasonOf` (src/runner/batch/eval/closure-diagnostics-io.ts:32-42) reads ONLY `r.budget?.attemptOutcomes`, returns null when absent, and never consults `r.stopReason` (which exists at types.ts:146 and IS populated on every agent-loop run via `stopReason = outcome.reason` in both drivers).
- `budget` is stamped ONLY on the multi-attempt path: apps driver src/apps/bench/eval/driver.ts:975 returns `runInstanceOnce` verbatim (no budget) when `maxAttempts === 1`; runner driver line 3098-3100 same. Multi-attempt stamps budget at lines 983-991 / 3107-3113.
- classify() (closure-diagnostics.ts:117-119) needs endReason === 'max_turns' || 'budget_exhausted' to yield 'no_patch_exhausted', so on a single-attempt run a true max_turns empty-patch instance is misclassified 'empty_patch_other' and no_patch_exhausted_rate reads 0. The comment at line 30-31 even acknowledges this is a stopgap "until the stream tap threads the real reason."

WHY OVERSTATED (not 'common single-attempt configuration'):
1. The sidecar is EVAL-ONLY and gated at its sole call site (src/apps/bench/index.ts:538). It runs only when (a) operator explicitly sets QUANTA_BENCH_CLOSURE_DIAG=1, OR (b) closureTelemetryPresent (primaryRailPresent/verificationPlan/gateEntered present).
2. The auto-enable case (b) — the documented "common" path that doesn't require remembering a flag — comes exclusively from the agentless-v2* preset family (verification-plan/primary-rail/fault-evidence). EVERY one of those presets ALSO sets "retry-transient": "3" (presets.ts:101,133,165,192,...). retry-transient=3 ⇒ maxAttempts=3 ⇒ multi-attempt path ⇒ budget.attemptOutcomes IS populated.
3. On the multi-attempt path, classifyOutcome (retry-policy.ts:264-277) checks classifyByStopReason BEFORE the empty-patch fallback, so stopReason==='max_turns' yields {kind:'real-fail', subkind:'max_turns_exhausted'} regardless of empty patch, and endReasonOf (line 37) correctly returns 'max_turns'. So no_patch_exhausted_rate is computed CORRECTLY in the realistic auto-enabled measurement runs.

Thus the bug bites ONLY the narrow intersection: explicit QUANTA_BENCH_CLOSURE_DIAG=1 with a no-preset / retry-transient=1 config — which is not the "common single-attempt configuration" claimed, and such runs have no closure telemetry anyway. The fix is trivial and correct (fall back to r.stopReason), but the headline 'systematic 0 in the common config' is wrong; in practice the sidecar's normal trigger path is always multi-attempt. Real latent gap, low severity, not the claimed systematic failure.

---

<a id="29"></a>
### 29. 🟡 "0 passed" summary grades a zero-test / SIGTERM'd run as PASS

- **등급**: LOW (어딧 원래값 `med`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/verdict.ts:55` — anchor: `const PASS_SUMMARY_RE`
- **클러스터**: Verification-bundle + verify-signal (WIP)
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/verdict.ts:155-157`

**영향 (왜 문제인가)**

`\d+ passed` accepts "0 passed" — i.e. pytest collected ZERO tests (bad -k filter, collection error swallowed, or the wrapper got SIGTERM'd after printing a degenerate summary). With a non-zero exit code (e.g. 143) and no explicit failure marker, `summaryPass` flips the verdict to PASS. The local-testCmd path then reports a false GREEN for a run where nothing actually ran. Should require a positive passed count (e.g. `[1-9]\d* passed`) or refuse "0 passed" as a pass signal.

**증거**

```
const PASS_SUMMARY_RE = /\b\d+\s+passed\b/i  // matches "0 passed"
const summaryPass = hasExplicitPassingSummary(combined) && !explicitFailure
const passed = !explicitFailure && (test.code === 0 || summaryPass)
// verified: PASS_SUMMARY_RE.test("0 passed") === true
```

**검증 노트 (skeptic)**

Core mechanic is REAL: PASS_SUMMARY_RE=/\b\d+\s+passed\b/i matches "0 passed" (verified), and line 157 `passed = !explicitFailure && (test.code === 0 || summaryPass)` lets summaryPass override a non-zero exit code, so a run printing "0 passed" with exit 143 and no failure marker flips to PASS. The code's own comment (L145-152) confirms summary-over-exit-code is the intended salvage path, so the SIGTERM scenario is genuine. No test asserts "0 passed" as a pass, so it's an unguarded heuristic edge, not intentional fail-open; the proposed fix (/\b[1-9]\d* passed\b/) preserves the intended salvage of a real "5 passed" run.

But the finding overstates the triggers and blast radius. I ran real pytest: a bad -k filter prints "N deselected"/"no tests ran"/"no tests collected" (NONE match the regex → no false pass), and a "collection error" prints "1 error" which IS caught by the generic-error-count failure matcher (/\b[1-9]\d*\s+errors?\b/) → correctly fails. So two of the three cited triggers do not actually produce "0 passed". The genuine trigger is narrower: literal "0 passed, N deselected" or a SIGTERM'd run that already printed "0 passed". Reachability also narrows impact: for the production SWE-bench dataset (Python harness wired, testCmd:"true"), grading returns at L113 and never reaches L155-157; this code runs only on the local-testCmd path and the unwired-harness fallback. Real false-GREEN when it occurs, but narrow trigger + off the primary grading path = low severity.

---

<a id="30"></a>
### 30. 🟡 generic error/failure-count failure matcher can flip a real PASS to fail-closed on incidental output

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `correctness` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/agent/verify-signal.ts:178` — anchor: `export const OUTCOME_FAILURE_MATCHERS`
- **클러스터**: Verification-bundle + verify-signal (WIP)
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/verify-signal.ts:208,221-223`

**영향 (왜 문제인가)**

A passing test run whose stdout incidentally contains a substring like "1 errors" / "3 failures" (deprecation logs, a tool's own diagnostics, doctest prose) trips `generic-error-count`/`generic-failure-count`, making `explicitFailure=true` and forcing `passed=false` even with exit code 0 and an explicit `N passed` summary. Direction is fail-closed (a false-NEGATIVE on grading, not a false green), so lower severity, but it can silently mark a genuinely-resolved local-testCmd instance unresolved and is hard to diagnose.

**증거**

```
hasExplicitFailureSummary -> isVerifyOutputFailing -> OUTCOME_FAILURE_MATCHERS includes:
{ id: "generic-error-count", pattern: /\b(?:[1-9]\d*)\s+errors?\b/m }
// in verify.ts:
const passed = !explicitFailure && (test.code === 0 || summaryPass)
```

**검증 노트 (skeptic)**

The mechanism is exactly as described and verifiable in the code. In src/agent/verify-signal.ts the unanchored generic matchers exist verbatim: generic-error-count = /\b(?:[1-9]\d*)\s+errors?\b/m (lines 215-218), generic-failure-count = /\b(?:[1-9]\d*)\s+failures?\b/m (lines 209-213). isVerifyOutputFailing (line 258-259) returns true if ANY matcher fires against the whole output. In src/runner/batch/eval/verdict.ts (note: file is 167 lines, not 208/221-223 as cited — the line numbers in the finding are wrong, but the logic is present): line 154 explicitFailure = hasExplicitFailureSummary(combined) scans `${stdout}\n${stderr}`, and line 157 `passed = !explicitFailure && (test.code === 0 || summaryPass)`. So any substring like "2 errors" / "3 failures" anywhere in combined output forces passed=false even with exit 0 and an explicit "N passed" summary. The existing test (tests/unit/verify-signal.test.ts:134-138) confirms "1 passed, 2 errors in 0.01s" → failing, proving explicit-failure overrides the pass summary. Because these generic matchers use \b (not ^ line-anchoring), incidental output (deprecation prose "will raise 2 errors", coverage/tool diagnostics, doctest prose) can trip them — and the module's own soundness comment (lines 153-159) claims the false-positive direction is "mitigated by anchoring matchers," which these specific matchers are NOT, so the rationale doesn't cover them.

Severity stays low, consistent with the finding's own framing, for two reasons the finding correctly notes: (1) direction is fail-closed (false-NEGATIVE on grading — a resolved instance silently marked unresolved — never a fake green), and (2) the impact is correctly scoped to the local-testCmd fallback path. The primary production swebench path returns early via the Python harness (verdict.ts lines 113-122, passed=r.resolved) and never reaches this matcher; the testCmd path is only hit for non-swebench instances or swebench-without-harness + real non-noop testCmd. Realistic but uncommon trigger, narrow path, fail-closed — REAL, severity low.

---

<a id="31"></a>
### 31. 🟡 voterQuorum soft signal silently clamps votes/k > 1 to 1, conflating super-quorum with exact quorum

- **등급**: LOW (어딧 원래값 `low`) · **분류**: `jank` · **검증 verdict**: `real`
- **위치 (pinned 8b3f5371)**: `src/agent/verification-bundle/score.ts:34` — anchor: `voterQuorum`
- **클러스터**: Verification-bundle + verify-signal (WIP)
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/agent/verification-bundle/score.ts:43-48,88-94`

**영향 (왜 문제인가)**

In soft `resolvedKofNMode`, `voterQuorum = votes/k` can exceed 1 (more reproducing voters resolved than the quorum k) and is clamped to 1. Two candidates with votes=k and votes=3k both score identically on this signal, so the soft ranking cannot prefer the stronger-consensus candidate — the clamp throws away ranking information the signal was meant to provide. Not a correctness bug (clamp is intentional for [0,1]) but the quorum ratio is the wrong normalizer if discrimination above quorum is desired.

**증거**

```
resolvedKofNVoterQuorum = votes / k   // e.g. 10/3 = 3.33
softValue: return Math.min(1, Math.max(0, v))  // clamps to 1
// score += SOFT_WEIGHTS.voterQuorum * value
```

**검증 노트 (skeptic)**

The mechanical claim is verified against the actual code. In `soft` resolvedKofNMode, `voterQuorum` is populated by `resolvedKofNVoterQuorum = resolved.votes / resolved.k` (src/agent/verification-bundle/resolved-kofn.ts:12-13), wired in via selection-executor.ts:302-305,394. `softValue` at score.ts:43-48 clamps with `Math.min(1, Math.max(0, v))`, so any super-quorum candidate (votes>k, e.g. 10/3=3.33) saturates to 1. Two candidates with votes=k and votes=3k therefore score identically on the voterQuorum term, and the soft ranking (score += SOFT_WEIGHTS.voterQuorum * value, score.ts:88-94) cannot distinguish them on this signal. The claimed consequence is logically sound.

There is even a stronger supporting fact the auditor didn't cite: the type contract at types.ts:75-76 documents voterQuorum as "Fraction of adversarial voters that did NOT refute, in [0,1]" — but votes/k is NOT a [0,1] fraction; it's reproducing-votes over the quorum threshold, which exceeds 1 whenever super-quorum. So there is a genuine normalizer/semantics mismatch, and the clamp masks it.

However, severity is correctly low (jank, not correctness bug), and the consequence is mildly overstated for framing reasons: (1) it only affects the non-default `soft` mode (default is `hard`, selection-executor.ts:383, where voterQuorum is null and patchedResolvedKofN is the hard gate instead); (2) it only loses discrimination ABOVE quorum (votes>=k) — below quorum the ratio is in [0,1) and ranks fine; (3) other soft signals (minimality, ownerCoverage) still discriminate between super-quorum candidates, so ranking is not actually collapsed; (4) the clamp is explicitly documented as intentional ([0,1] coercion, score.ts:39-42) and the auditor concedes it is not a correctness bug. The real defect is the choice of normalizer (k vs total voter count) plus the doc/impl mismatch, which is a low-severity design issue, not a behavioral bug.

---

<a id="32"></a>
### 32. ⚪ primaryRailState can only be 'red' or 'unrun' at this call site, making decideRepairAdmission's 'already green' guard unreachable here

- **등급**: NONE (어딧 원래값 `low`) · **분류**: `dead-code` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/runner/batch/eval/repair-phase-policy.ts:25` — anchor: `primaryRailState`
- **클러스터**: Closure engine core
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/runner/batch/eval/repair-phase-policy.ts:23-30`

**영향 (왜 문제인가)**

Minor rot: the gate admits repair whenever a rail is present and baseValidatedRed, regardless of whether the rail was actually re-run green. The 'rail already green ⇒ no repair' protection that decideRepairAdmission advertises does not apply to the production caller, only to tests. Low impact (admission still requires a present rail) but it is a comment/contract-vs-callsite mismatch worth noting.

**증거**

```
`primaryRailState: args.primaryRailStep !== undefined && args.verificationPlan?.baseValidatedRed === true ? 'red' : 'unrun'`. The ternary derives state from a static precomputed fact (baseValidatedRed) before any rail run, so it never yields 'green'. decideRepairAdmission's branch `if (i.primaryRailState === 'green') return { admit: false, ... }` (primary-rail/index.ts:47) is therefore dead at this call path.
```

**검증 노트 (skeptic)**

The narrow factual observation is correct: at repair-phase-policy.ts:23-30, primaryRailState is derived purely from `args.verificationPlan?.baseValidatedRed === true ? 'red' : 'unrun'`, so it can never be 'green' at this call site, leaving decideRepairAdmission's `if (i.primaryRailState === 'green')` branch (primary-rail/index.ts:47) unexercised from this path.

But the CLAIMED CONSEQUENCE is wrong, not just minor. The auditor frames this as a contract-vs-callsite mismatch where the "rail already green ⇒ no repair" protection "does not apply to the production caller." That conflates two distinct phases:

1. `benchShouldRunRepairPhase` is an ADMISSION gate, evaluated in driver.ts:2528 (resolveRepairState) BEFORE `runRepairPhase` is invoked (driver.ts:2605-2606). At admission time the primary rail has not been re-run, so a 'green' outcome is not observable — only "we have a validated-red repro" (red) or "we don't" (unrun) are knowable. `baseValidatedRed` is documented (verification-plan/types.ts:67-68) as a precomputed static fact: "True iff a synthesized repro proved RED on the unpatched base." Feeding it as 'red'/'unrun' is exactly correct.

2. The "rail already green ⇒ no repair" protection is NOT missing from production — it is enforced by a DIFFERENT, correctly-timed decider: `decidePrimaryRailFinishGate` (primary-rail/index.ts:74-86), which blocks finishing while a present primary rail is not green, plus `primaryRailRedAfterRepair` (repair-phase-policy.ts:33-38). Green is a post-run outcome handled where it actually exists.

So `decideRepairAdmission` is a general-purpose pure tri-state decider; this caller legitimately supplies only two of its three input states because the third ('green') is semantically impossible at admission time. A reusable pure function whose full input domain isn't exercised by one caller is normal design, not dead code or a contract violation. There is no behavioral defect: repair admission requires present + validated-red, which is the intended gate. Severity: none.

---

<a id="33"></a>
### 33. ⚪ Apps `runInstance` budget telemetry reports adaptedTimeoutMs == base even though it deliberately does not adapt

- **등급**: NONE (어딧 원래값 `low`) · **분류**: `correctness` · **검증 verdict**: `overstated`
- **위치 (pinned 8b3f5371)**: `src/apps/bench/eval/driver.ts:987` — anchor: `adaptedTimeoutMs`
- **클러스터**: Repair orchestrator + eval drivers
- **어딧 당시 인용(참고, drift 있을 수 있음)**: `src/apps/bench/eval/driver.ts:966-991`

**영향 (왜 문제인가)**

The same `budget` shape now carries different semantics in the two drivers: in production `adaptedTimeoutMs` is a no-op duplicate of base, in the test twin it is a real scaled value. Any downstream consumer (or test) reading `budget.adaptedTimeoutMs` as 'the timeout that was actually used' gets a meaningful number from one driver and a redundant one from the other. Low severity (field is internally consistent within each path) but it is a latent telemetry-drift trap given the identical-telemetry mandate.

**증거**

```
src/apps/bench/eval/driver.ts:984-988 stamps `budget:{ baseTimeoutMs: deps.timeoutMs, adaptedTimeoutMs: deps.timeoutMs, ...}` — adapted always equals base by construction. The runner-driver twin computes a genuinely different adaptedTimeoutMs via computeAdaptedTimeout (src/runner/batch/eval/driver.ts:3046) and stamps it (3099). The apps version's own doc comment (lines 959-964) explains it intentionally skips cost-multiplier scaling.
```

**검증 노트 (skeptic)**

The finding's literal code claims are accurate: src/apps/bench/eval/driver.ts:984-991 stamps budget.adaptedTimeoutMs = deps.timeoutMs = baseTimeoutMs (so adapted always equals base by construction), and the runner-driver twin (src/runner/batch/eval/driver.ts:3046-3113) computes a genuinely scaled adaptedTimeoutMs via computeAdaptedTimeout. The apps doc comment (lines 961-965) confirms the no-scaling is deliberate (cost-multipliers are a matrix-budget construct that would balloon wall-clock ~15x).

But the CLAIMED CONSEQUENCE — a downstream telemetry-drift trap where the same budget shape carries different semantics across the two drivers — does not materialize, for two independent reasons:

1. No consumer reads budget.adaptedTimeoutMs. grep across src/ (non-test) shows the only consumers of InstanceResult.budget are report.ts:148 (spreads the whole object verbatim into report.json, an offline artifact) and closure-diagnostics-io.ts:33 (reads only budget?.attemptOutcomes). Nothing interprets adaptedTimeoutMs as 'the timeout actually used.' The 'any downstream consumer getting different numbers' scenario has no consumer.

2. The divergent value is never produced in production. The bench CLI (src/apps/bench/index.ts:102,340,345) calls runInstance from the APPS driver. The runner-driver's runInstance (the one with the 'real' scaled value) has ZERO production callers — only its own internal helpers/tests reference it. This matches the project's own record that the runner driver is dead (apps=prod/runner=dead). So no real report ever carries the scaled semantics; production reports always come from the apps path where adaptedTimeoutMs faithfully equals the per-attempt timeout actually used (== base, because scaling is intentionally skipped).

Within the production path the field is internally consistent AND accurate (it truthfully reports the timeout used). The finding itself concedes internal consistency and 'low severity.' With no reader of the field and no production emitter of the divergent value, this is at most a cosmetic redundancy in a dead twin's telemetry, not a correctness bug. Overstated; corrected severity none.

---
