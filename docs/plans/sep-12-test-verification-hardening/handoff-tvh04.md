# TVH-04 handoff — resource certification, claims, scheduler, lease

Owner lane: scheduler / resource certification / lease.
Integrator actions below touch files TVH-04 does not own.

## What landed in this lane

| file | what it is |
|---|---|
| `tools/dev/test-resource-claims.ts` | NEW. The claim vocabulary (12 kinds), the multi-claim source detector, the legacy-class projection, and `scheduleClaimsOverlap`. |
| `tools/dev/test-resource-analysis.ts` | NEW. Import-closure analyzer: a cycle-exact fixpoint over the repository module graph, an external-package allowlist, constant folding for dynamic specifiers. |
| `tools/dev/test-resource-resolution.ts` | NEW. The ONE source-aware resolution, memoised on (path, size, mtime), consumed by policy, planner, scheduler and receipt. |
| `tools/dev/test-resource-certification.ts` | Schema v2, vocabulary-checked claim keys, `unknown-claim` fallback, a parse-safe loader, `certificationCoversDerived`. |
| `tools/dev/test-resource-certification-audit.ts` | `--emit` regenerates the registry, `--check` gates it. |
| `tools/dev/test-resource-certifications.json` | 562 rows: 548 `certified`, 14 `intentionally-exclusive`, 0 missing. |
| `tools/dev/test-shard-plan.ts` | `classifyTestResource` delegates to the shared resolution; `resourceClassesOverlap` is computed from claim sets (same 8x8 matrix, `VALIDATED_NONPURE_OVERLAPS` deleted); `TestChunk` carries `claims`; `chunkClaimsOverlap` added. |
| `tools/dev/test-shard-lease.ts` | Resource keys are hashed RAW; `shared`/`exclusive` modes via a gate + 4 reader slots; canonical order; reverse rollback. |

Measured at the current HEAD: policy/planner resource mismatch **360 -> 0**;
integration-path certification **562 missing -> 0 missing**.

## 1. `test-policy.ts` — the one-function diff (REQUIRED)

The root cause of the 360-file mismatch is a single call. `pathResources` asks
the classifier what a file owns and passes an EMPTY source, so the path
heuristic always wins and `policy.resources` describes a file nobody read.

```diff
--- a/tools/dev/test-policy.ts
+++ b/tools/dev/test-policy.ts
@@
-import { classifyTestResource } from "./test-shard-plan"
+import { policyTestResources } from "./test-resource-resolution"
@@
-const pathResources = (id: string): readonly string[] => {
-  if (id.startsWith("tests/contract/")) return ["exclusive", "docker"]
-  if (id.startsWith("tests/e2e-pty/")) return ["exclusive", "pty"]
-  if (id.includes("apps/web-frontend/")) return ["exclusive"]
-  const classified = classifyTestResource(id, "")
-  return classified === "pure" ? [] : [classified]
-}
+const pathResources = (id: string): readonly string[] => policyTestResources(id)
```

`policyTestResources` keeps all three out-of-band prefixes (their `exclusive`
marker is a statement about the COMMAND, not about the file's source) and
returns the same shape — `[]` for `pure`, otherwise a one-element class list —
so no policy consumer moves at the same time. `classifyTestResource` is no
longer imported by `test-policy.ts`.

Cost: one `statSync` + one `readFileSync` per discovered id, memoised on
(path, size, mtime). Measured over 3,959 files: ~1.4s for the first pass, ~0ms
after.

Guard: `tests/unit/dev/test-resource-claims.test.ts` → "policy and planner
agree on EVERY discovered file — and the old call did not". It asserts 0
disagreements through `policyTestResources` and, as a live red-on-injection
control, asserts that the same comparison through the empty-source call still
finds some. It passes today because it calls `policyTestResources` directly;
after this diff it is also a wiring proof of the policy layer.

## 2. `run-test-shards.ts` — receipt fields (REQUIRED)

The campaign should record WHICH resolution it scheduled on, not merely that a
registry file existed.

```diff
+import { certificationDigest, loadTestResourceCertificationsSafe } from "./test-resource-certification"
+import { CERTIFICATION_REGISTRY_PATH, resolveTestResourceSnapshot } from "./test-resource-resolution"
@@ inside main(), after `const chunks = planTestChunks(...)`
+    const resourceSnapshot = resolveTestResourceSnapshot(
+      manifest.map((file) => relative(REPO_ROOT, file)),
+      { repoRoot: REPO_ROOT },
+    )
+    const certifications = loadTestResourceCertificationsSafe(
+      join(REPO_ROOT, CERTIFICATION_REGISTRY_PATH),
+    ).certifications
@@ inside the per-chunk `identity` object
+        resourceClaimsSha256: new Bun.CryptoHasher("sha256")
+          .update(chunk.claims.map(({ key, mode }) => `${key}=${mode}`).join(","))
+          .digest("hex"),
+        certificationSha256: certificationDigest(certifications),
+        resourceSnapshotSha256: resourceSnapshot.digest,
```

and the corresponding optional fields on `TestShardCacheIdentity` in
`test-shard-receipt.ts` (owner: receipt lane).

Why identity and not a comment: a chunk that ran while its files were
UNCERTIFIED was scheduled serially; the same chunk certified may have run
beside a peer. Those are different executions and must not share a cache
receipt. `chunk.claims` is already computed by the planner.

Also worth printing on the existing `frozen head=…` line:
`certified=<n> exclusive=<n> resource_snapshot=<digest.slice(0,16)>`
from `resourceSnapshot.counts`.

## 3. `run-test-shards.ts` — chunk-level overlap (GATED, do not land yet)

```diff
     overlap: (left, right) =>
-      resourceClassesOverlap(left as TestResourceClass, right as TestResourceClass),
+      chunkClaimsOverlap(chunkByScheduleKey(left), chunkByScheduleKey(right)),
```

which needs `tasks[].resourceClass` to carry the chunk index (or a claim label)
rather than the class string, since `runResourceAwareSchedule` passes that value
straight to `overlap`.

**Blocked on a measurement this lane cannot produce.** `chunkClaimsOverlap`
admits overlaps `resourceClassesOverlap` refuses — two certified chunks whose
exclusive keys are disjoint. That is the parallelism TVH-04 exists to unlock,
and it is exactly the kind of change the 2026-09-02 browser incident says must
not be taken on reasoning alone. Before flipping it:

1. `bun run tools/dev/test-resource-certification-audit.ts --check` green.
2. A 1/2/4-worker canary over the integration-path population: identical test
   IDs and verdicts at all three widths, zero resource conflicts.
3. The browser lane specifically re-measured — `host-cpu: exclusive` is
   preserved by construction (`CLASS_RESOURCE_CLAIMS.browser` and the
   `browser-profile ⇒ host-cpu` rule in `test-resource-claims.ts`) and the
   matrix test pins it, but the canary is what turns that into evidence.

Until then `resourceClassesOverlap` is the live predicate and it reproduces the
shipped matrix exactly — the 8x8 table is asserted cell by cell in
`tests/unit/dev/test-resource-claims.test.ts`.

## 4. Gate wiring for the audit (RECOMMENDED, `gate-manifest.ts` owner)

`bun run tools/dev/test-resource-certification-audit.ts --check` is a static,
~5s check with no side effects. It fails when:

- an integration-path file has no row (`missing`),
- a certified file's own source changed (`source-drift`),
- the production closure behind a certified file GREW a claim its row does not
  cover (`underDeclared`),
- a row names a file that is no longer integration-path (`orphans`).

**Known friction, stated plainly.** The registry pins each test file's source
digest, so editing a certified test file turns the check red until somebody
runs `--emit`. With several agents editing tests concurrently this will be red
often. It is safe while red — a drifted row resolves to `unknown` and the file
stays exclusive, i.e. today's behaviour — so wire it as a non-blocking
reporting gate first, and promote it to blocking once the corpus settles. The
repair is one command and the diff is one row.

Deliberately NOT pinned: the closure digest. Pinning the hundreds of production
modules behind each test would invalidate every row on every `src/` commit, so
certification would be permanently stale and buy nothing. The `--check`
containment test covers the direction that matters (a closure that GREW a
hazard); a closure that shed one is merely over-declared.

## 5. Lease split (staged, per ticket item 7)

`acquireKeyedTestShardLeases` now supports `shared`/`exclusive` and hashes raw
keys, but NOTHING calls it in production yet — `run-test-shards.ts` still takes
the whole-repository lease, which is what the ticket asks for until
certification is complete. The split into `checkout` / `git-common` / `cache` /
host keys is the next slice and should follow the same order the ticket gives.

One implementation fact the next slice needs: an exclusive key costs
`SHARED_LEASE_SLOTS + 1` = 5 kernel ports (a gate plus every reader slot),
because a port bind is a mutex and a reader-writer lock has to be built out of
several. At eight slots the existing two-key rollback test went intermittently
over its 5s budget on a loaded host (1 failure in 6 runs; 0 in 8 at four).
Raising the pool raises both the port footprint and the acquisition latency.

## 6. What TVH-04 did NOT do

- No 1/2/4-worker canary (campaign runs are out of scope for this lane).
- `tools/dev/test-shard-membership.ts` `bucketsByClass` is untouched: classes
  are unchanged, so every chunk identity and cache receipt is preserved.
- The 3,397 non-integration-path files are not certified; they resolve to their
  CLASS claims, which carry `unknown` for every non-pure class. Certifying them
  is a later slice and needs the same `--emit` run with a widened population.

## 7. Measured: certification changes NOTHING at chunk granularity yet

This is the honest bottom line and it should not be discovered later.

    bun -e '… planTestChunks(full) … compare resourceClassesOverlap vs chunkClaimsOverlap …'
    class-level overlappable pairs: 732
    claim-level overlappable pairs: 732
    newly ALLOWED by certification:  0
    newly REFUSED by certification:  0

Zero regression, and zero gain. The cause is chunk COMPOSITION, not the claims:

- membership is `class + sha bucket`, so an integration-path chunk holds ~60-83
  arbitrary files and a chunk owns the UNION of its members' claims;
- 6 of the 8 integration-path chunks contain at least one of the 14
  `intentionally-exclusive` files, and one `unknown` poisons the whole chunk;
- the 2 fully-certified chunks each claim `checkout`, `port`, `lsp-workspace`,
  `git-common`, `cache` and `docker-daemon` exclusively, so they conflict with
  each other and with every other non-pure chunk regardless.

Per FILE the picture is different, and that is where the next slice is:

    certified files: 548, distinct claim signatures: 30
    signature pairs: 435, mutually compatible: 116  (27%)
    certified files claiming NOTHING at all: 17
      297  browser-profile,cache,checkout,child-process,docker-daemon,git-common,lsp-workspace,port:ephemeral,process-env
       50  lsp-workspace,process-env
       47  child-process,lsp-workspace,port:ephemeral,process-env
       27  checkout,child-process,lsp-workspace,port:ephemeral,process-env
       24  checkout,child-process,lsp-workspace,process-env
       17  <resource-free>

**Next slice (feature / why / ROI).** Bucket chunk membership by CLAIM
SIGNATURE instead of by class hash, so compatible files land together
(`bucketsByClass` in `tools/dev/test-shard-membership.ts`, which TVH-04 does not
own). Why: a chunk's claim set is a union, so mixing signatures guarantees the
saturated one wins — the registry cannot pay off until composition respects it.
ROI: 251 of the 548 certified files sit outside the saturated signature, 17 of
them hold nothing at all and could schedule like `pure`; 27% of signature pairs
are mutually compatible. Cost: it re-identifies every chunk and therefore
invalidates every cache receipt once, which is why it belongs in its own
reviewable diff — and it must land together with the §3 canary, not before it.
