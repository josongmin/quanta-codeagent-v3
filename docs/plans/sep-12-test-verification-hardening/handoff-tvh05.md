# TVH-05 handoff — `tools/dev/run-test-shards.ts` call-site diff

TVH-05 landed the timing/cache correctness work in modules it owns. Three call
sites in `tools/dev/run-test-shards.ts` (integrator-owned) must be updated for
the tree to typecheck. Until they are, `tsc --noEmit` reports exactly three
errors, all in that file:

    tools/dev/run-test-shards.ts(650,41): TS2345  writeSuccessfulTestShardReceiptAtomic
    tools/dev/run-test-shards.ts(758,51): TS2345  loadSuccessfulTestShardReceipt
    tools/dev/run-test-shards.ts(1072,9): TS2353  'toolchainSha256' does not exist

Nothing else in `tools/`, `tests/` or `src/` is affected.

## Why each change exists

| Change | Defect it closes |
|---|---|
| stable timeout policy digest in the identity | a 1-minute load average moved the 120/240/300s timeout, which was hashed into `executionPolicySha256` — identical code missed every chunk because the box got busier |
| `scopeKind` + `toolScopeSha256` + `producerReceiptsSha256` | every chunk's key carried the whole tracked tree, the whole manifest, and a global fingerprint of 27 external tools |
| timing journal | the store was read, sorted and rewritten on EVERY chunk completion — up to 44 whole-store rewrites per full campaign |
| receipt carries `timingObservations` | a green receipt whose timing write was lost could never be repaired: every later campaign HIT it, never re-ran the chunk, and `unit-speed-budget` stayed red forever |
| `pruneExpiredShardReceipts` in `finally` | prune swept the bare `full` directory while tier caches are written to `full:pr` / `full:nightly`, and it ran only after total success |

## 1. Imports

```diff
 import {
+  chunkCacheNamespace,
   loadSuccessfulTestShardReceipt,
   mergeScanReachSinks,
+  pruneExpiredShardReceipts,
   type SuccessfulTestShardReceipt,
   shardFilesSha256,
   type TestShardCacheIdentity,
   testEnvironmentSha256,
+  testRuntimeSha256,
   testShardCacheIdentitySha256,
-  testToolchainSha256,
   trackedTreeSha256,
   writeScanReachReceiptAtomic,
   writeSuccessfulTestShardReceiptAtomic,
 } from "./test-shard-receipt"
 import { type ShardSelection, selectShardManifest } from "./test-shard-selection"
 import {
   harvestChunkTimingObservations,
   loadTestTimings,
-  mergeTestTimingObservations,
+  openTimingJournal,
+  receiptTimingSamples,
+  recoverAbandonedTimingJournals,
+  type TimingJournal,
+  type TimingSample,
 } from "./test-shard-timings"
+import { resolveChunkCacheScope } from "./test-shard-cache-scope"
+import { currentTimeoutPolicy, timeoutPolicySha256 } from "./test-shard-timeout-policy"
+import { loadTestResourceCertificationsSafe } from "./test-resource-certification"
```

## 2. Replace `pruneStaleChunkReceipts` (currently around line 297)

Delete the whole local function — namespace-complete TTL collection now lives in
`test-shard-receipt.ts` and is covered by
`tests/unit/dev/test-shard-receipt-lifecycle.test.ts`.

```diff
-/**
- * TTL-based garbage collection. …
- */
-const pruneStaleChunkReceipts = (suite: SuiteName, nowMs = Date.now()): void => {
-  const dir = join(SHARD_CACHE_ROOT, suite)
-  …
-}
```

Its call site (around line 1069) moves out of the success path and into the
campaign's `finally`, so a repeatedly-red branch also collects:

```diff
-    pruneStaleChunkReceipts(opts.suite)
     process.stdout.write(
       `[test:shards] PASS suite=${opts.suite} chunks=${chunks.length}/${chunks.length} ` +
         `manifest_files=${manifest.length} head=${before.head}\n`,
     )
   } finally {
+    // Bounded GC on EVERY exit, green or red. TTL is the only criterion, so a
+    // sibling worktree resuming from its own receipts is preserved.
+    const pruned = pruneExpiredShardReceipts(SHARD_CACHE_ROOT)
+    if (pruned.removed > 0) {
+      process.stderr.write(
+        `[test:shards] cache GC removed ${pruned.removed} expired receipt(s) ` +
+          `(${Math.round(pruned.bytesReclaimed / 1024 ** 2)} MiB) across ` +
+          `${pruned.namespaces.length} namespace(s); kept ${pruned.kept}\n`,
+      )
+    }
```

## 3. `chunkCachePath` (around line 258)

```diff
 const chunkCachePath = (identity: TestShardCacheIdentity): string =>
-  join(SHARD_CACHE_ROOT, identity.suite, `chunk-${testShardCacheIdentitySha256(identity)}.json`)
+  join(
+    SHARD_CACHE_ROOT,
+    chunkCacheNamespace(identity),
+    `chunk-${testShardCacheIdentitySha256(identity)}.json`,
+  )
```

## 4. `cacheSuccessfulShard` + `harvestTimings` (around line 639)

The order flips: timings are harvested FIRST, because the receipt now carries
them. `writeSuccessfulTestShardReceiptAtomic` throws if they do not cover the
chunk's files, which is what bounds the `timing-incoherent` miss to exactly one
re-execution.

```diff
-const cacheSuccessfulShard = (
-  cached: CachedChunk,
-  result: ShardRunResult,
-  opts: RunnerOptions,
-): void => {
-  if (result.executedFiles === undefined) {
-    throw new Error(`[test:shards] chunk ${cached.chunk.index} has no executed-file receipt`)
-  }
-  const junitXml = readFileSync(result.junitPath, "utf8")
-  junitBody(junitXml, cached.chunk.index)
-  if (opts.cacheMode === "off") return
-  writeSuccessfulTestShardReceiptAtomic({
-    path: cached.cachePath,
-    identity: { ...cached.identity, junit: true },
-    executedFiles: result.executedFiles,
-    scanReachRecords: mergeScanReachSinks([result.scanReachSink]),
-    junitXml,
-  })
-}
-
-/** Every green chunk feeds measured per-file wall time back to the planner. */
-const harvestTimings = (cached: CachedChunk, result: ShardRunResult): void => {
-  try {
-    const junitXml = readFileSync(result.junitPath, "utf8")
-    const relFiles = cached.chunk.files.map((file) => relative(REPO_ROOT, file))
-    const observations = harvestChunkTimingObservations(junitXml, relFiles, result.elapsedMs, {
-      runnerClass: cached.chunk.resourceClass,
-      policyDigest: cached.identity.executionPolicySha256,
-      intraParallel: cached.intraParallel,
-      loadPerCore: Math.max(0, (loadavg()[0] ?? 0) / availableParallelism()),
-    })
-    mergeTestTimingObservations(TIMING_STORE, observations)
-  } catch (error) {
-    const message = error instanceof Error ? error.message : String(error)
-    process.stderr.write(
-      `[test:shards] WARN timing harvest failed for chunk ${cached.chunk.index}: ${message}\n`,
-    )
-  }
-}
+/**
+ * Measured per-file wall time for one green chunk. The observations are the
+ * receipt's timing evidence AND the journal's entry, so a cache hit can
+ * rehydrate what the executed run measured.
+ */
+const chunkTimingObservations = (
+  cached: CachedChunk,
+  result: ShardRunResult,
+  junitXml: string,
+): ReadonlyMap<string, TimingSample> => {
+  // Bun writes the JUnit `file` attribute RELATIVE to the worker's cwd (the
+  // repo root) even when the command line carried absolute paths, so the
+  // harvest must look suites up by the same relative key (measured on 1.3.14).
+  const relFiles = cached.chunk.files.map((file) => relative(REPO_ROOT, file))
+  return harvestChunkTimingObservations(junitXml, relFiles, result.elapsedMs, {
+    runnerClass: cached.chunk.resourceClass,
+    policyDigest: cached.identity.executionPolicySha256,
+    intraParallel: cached.intraParallel,
+    loadPerCore: Math.max(0, (loadavg()[0] ?? 0) / availableParallelism()),
+  })
+}
+
+const cacheSuccessfulShard = (
+  cached: CachedChunk,
+  result: ShardRunResult,
+  opts: RunnerOptions,
+  journal: TimingJournal,
+  testTimeoutMs: number,
+): void => {
+  if (result.executedFiles === undefined) {
+    throw new Error(`[test:shards] chunk ${cached.chunk.index} has no executed-file receipt`)
+  }
+  const junitXml = readFileSync(result.junitPath, "utf8")
+  junitBody(junitXml, cached.chunk.index)
+  const observations = chunkTimingObservations(cached, result, junitXml)
+  // One APPEND per chunk. The store itself is written once, at campaign end.
+  // Timing is a scheduler hint, never a verdict input, so a journal failure is
+  // reported and the campaign continues.
+  try {
+    journal.record(observations)
+  } catch (error) {
+    const message = error instanceof Error ? error.message : String(error)
+    process.stderr.write(
+      `[test:shards] WARN timing journal failed for chunk ${cached.chunk.index}: ${message}\n`,
+    )
+  }
+  if (opts.cacheMode === "off") return
+  writeSuccessfulTestShardReceiptAtomic({
+    path: cached.cachePath,
+    identity: { ...cached.identity, junit: true },
+    executedFiles: result.executedFiles,
+    scanReachRecords: mergeScanReachSinks([result.scanReachSink]),
+    testTimeoutMs,
+    timingObservations: [...observations].map(([file, sample]) => ({ file, ...sample })),
+    scopeReason: cached.scopeReason,
+    junitXml,
+  })
+}
```

Caller (around line 809):

```diff
-        cacheSuccessfulShard(cached, result, input.opts)
-        harvestTimings(cached, result)
+        cacheSuccessfulShard(cached, result, input.opts, input.journal, input.testTimeoutMs)
```

## 5. `executeChunks` — lookup, and rehydrate on HIT

Add `journal` to the `executeChunks` and `executeChunksWithSourcePostflight`
input types (`readonly journal: TimingJournal`), then:

```diff
     const lookup = loadSuccessfulTestShardReceipt({
       path: cached.cachePath,
       expected: cached.identity,
+      expectedTestTimeoutMs: input.testTimeoutMs,
     })
```

and immediately after `materializeCachedJunit(...)` on the hit path:

```diff
     materializeCachedJunit(input.opts, cached.chunk.index, lookup.receipt)
+    // A cache HIT must restore the scheduling evidence the executed run
+    // produced, or the speed budget sees a green shard with no timings. The
+    // sample keeps the RECEIPT's creation time, never `now`: a replayed
+    // measurement ages out exactly like the one it replays.
+    input.journal.record(
+      receiptTimingSamples(lookup.receipt.timingObservations),
+      lookup.receipt.createdAtMs,
+    )
```

## 6. `main()` — identity construction (around line 955-1075)

```diff
     const treeSha256 = trackedTreeSha256(REPO_ROOT)
+    // Fold anything an interrupted campaign already measured back in, before
+    // this campaign reads the store for planning.
+    recoverAbandonedTimingJournals(TIMING_STORE)
     const timings = loadTestTimings(TIMING_STORE)
```

```diff
-    const toolchainSha256 = testToolchainSha256()
-    const envSha256 = testEnvironmentSha256(process.env, testTimeoutMs, REPO_ROOT)
+    const runtimeSha256 = testRuntimeSha256()
+    // The STABLE policy base, not the load-derived instance value: a busy host
+    // must not be a different cache universe.
+    const timeoutPolicy = currentTimeoutPolicy()
+    const envSha256 = testEnvironmentSha256(process.env, timeoutPolicy.baseMs, REPO_ROOT)
+    const timeoutPolicyDigest = timeoutPolicySha256(timeoutPolicy)
+    // SAFE loader: TVH-04's registry is mid-migration (the module is at
+    // schema v2, the JSON is still v1), and a registry that will not parse
+    // must mean "nothing is certified", never a dead campaign.
+    const certificationLoad = loadTestResourceCertificationsSafe(
+      join(REPO_ROOT, "tools", "dev", "test-resource-certifications.json"),
+    )
+    if (certificationLoad.error !== undefined) {
+      process.stderr.write(
+        `[test:shards] WARN resource certifications unreadable (${certificationLoad.error}); ` +
+          "every chunk keeps the whole-tree cache identity\n",
+      )
+    }
+    const resourceCertifications = certificationLoad.certifications
+    const journal = openTimingJournal({ storePath: TIMING_STORE })
```

```diff
     const cachedChunks: readonly CachedChunk[] = chunks.map((chunk) => {
       const filesSha256 = shardFilesSha256(REPO_ROOT, chunk.files)
       const intraParallel = chooseIntraWorkerParallelism({ … })
+      // Certified only when EVERY file is both resource-certified (TVH-04)
+      // and declared-input certified. `test-resource-certifications.json`
+      // currently holds zero certifications, so this resolves to `whole-tree`
+      // for every chunk and the cache behaves exactly as it does today.
+      const scope = resolveChunkCacheScope({
+        repoRoot: REPO_ROOT,
+        ids: chunk.files.map((file) => relative(REPO_ROOT, file)),
+        resourceCertifications,
+      })
       const identity: TestShardCacheIdentity = {
+        scopeKind: scope.kind,
         treeSha256,
         suite: cacheSuiteName(opts),
         manifestSha256: manifestDigest,
         shardIndex: chunk.index,
         shardFileCount: chunk.files.length,
         shardFilesSha256: filesSha256,
-        toolchainSha256,
+        runtimeSha256,
+        toolScopeSha256: scope.toolScopeSha256,
         testEnvSha256: envSha256,
         junit: true,
         intraParallel,
         executionPolicySha256: executionPolicyDigest({
           version: "v2",
           runnerIdentity: `bun-${Bun.version}-${process.platform}-${process.arch}`,
           intraParallel,
-          timeoutPolicyDigest: new Bun.CryptoHasher("sha256")
-            .update(String(testTimeoutMs))
-            .digest("hex"),
+          timeoutPolicyDigest,
           isolationPolicyDigest: new Bun.CryptoHasher("sha256")
             .update(chunk.resourceClass)
             .digest("hex"),
           environmentDigest: envSha256,
           cacheMode: opts.cacheMode,
         }),
+        timeoutPolicySha256: timeoutPolicyDigest,
-        inputScopeSha256: chunkInputScopeSha256(
-          REPO_ROOT,
-          chunk.files.map((file) => relative(REPO_ROOT, file)),
-        ),
+        inputScopeSha256: scope.inputScopeSha256,
+        producerReceiptsSha256: scope.producerReceiptsSha256,
       }
       return {
         chunk,
         intraParallel,
         cachePath: chunkCachePath(identity),
         identity,
+        scopeReason: scope.reason,
       }
     })
```

Add `readonly scopeReason: string` to `interface CachedChunk`, pass `journal`
into `executeChunksWithSourcePostflight`, and commit once, after the schedule:

```diff
     const scanReachSinks = await executeChunksWithSourcePostflight({
       chunks: cachedChunks,
       opts,
       runRoot,
       before,
       testTimeoutMs,
       registry,
+      journal,
     })
+    // THE ONE store write of the campaign, whatever the chunk count.
+    const committed = journal.commit()
+    process.stdout.write(
+      `[test:shards] timing store committed files=${committed.files} ` +
+        `writes=${committed.storeWrites} recovered_journals=${committed.recoveredJournals}\n`,
+    )
```

`chunkInputScopeSha256` is no longer imported by the runner (the scope resolver
calls it). Drop `import { chunkInputScopeSha256 } from "./verification-input-scope"`.

## 7. Gate wiring (optional, `tools/dev/gate-manifest.ts`, integrator-owned)

`unit-speed-budget` no longer fails when the timing store is missing files; it
prints an `INCOHERENT timing evidence` line naming the reason and judges those
files on their JUnit aggregate. If you want the bounded rehydrate as well, add:

    --receipts=$(git rev-parse --git-common-dir)/quanta-verification-cache/test-shards/v3

It is OFF by default so the gate does not read the receipt corpus when the
store is already coherent.

## Seams left open, deliberately

- **Producer receipts.** `producerReceiptsSha256` is a real identity field but
  every chunk currently passes `[]`, because no per-chunk producer registry
  exists yet. TVH-12 populates `ProducerReceiptRef[]` from the scan/build/
  lint-debt/compiled-probe producers a chunk consumes; nothing else changes.
- **Certified rollout.** `tools/dev/test-policy-overrides.json` has zero
  `inputScope: "declared"` rows and `test-resource-certifications.json` has zero
  certifications, so `resolveChunkCacheScope` returns `whole-tree` for every
  chunk at this HEAD. That is the intended state: the narrowing is available,
  proven by test, and not yet exercised in production.
- **Superseded cache ROOTS.** `pruneExpiredShardReceipts` sweeps every
  namespace under the root it is given, but a root version bump orphans the
  previous one wholesale. Measured on this checkout:
  `.git/quanta-verification-cache/test-shards/v2/full` holds 307 receipts /
  127 MiB, all expired, all unreachable from the `v3` root the runner now uses.
  One extra call in the same `finally` collects it:
  `pruneExpiredShardReceipts(join(SHARED_CACHE_ROOT, "test-shards", "v2"))`,
  or a sweep over every `test-shards/v*` directory. Left to the integrator
  because `SHARD_CACHE_ROOT` is defined in `run-test-shards.ts`.
- **Nightly telemetry cache.** Splitting the verdict cache from the scheduling
  telemetry cache in `.github/workflows/verification-nightly.yml` is still open;
  the journal makes it a single artifact (`test-timings-v2.json`) to restore and
  publish, with no shard receipts attached.
