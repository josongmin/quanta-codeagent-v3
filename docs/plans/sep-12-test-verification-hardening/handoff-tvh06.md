# TVH-06 P0 → workflow owner handoff

Owner of `.github/workflows/**`, `package.json`, `tools/dev/gate.ts`,
`tools/dev/gate-manifest.ts`, `tools/dev/run-test-shards.ts`: the changes below
are needed by the TVH-06 P0 slice and are OUT of that slice's edit scope. The
consumer side (validator, schema, three-way comparison) is already landed in the
working tree.

## 1. `required` must be fed the capability artifacts — REQUIRED, or the job fails closed

`tools/dev/verification-required-results.ts` now FAILS when a capability
producer (`pty`, `toolchain`, `contract`) has published no
`capability-result.v1` artifact. "Absent artifact = FAIL, not PASS" is the
explicit contract of the ticket (item 10 / 완료 기준 4), so until the jobs emit
these artifacts the `required` job will exit 1 with:

    verification-required-results: capability artifact absent for producer "pty"
    verification-required-results: capability artifact absent for producer "toolchain"
    verification-required-results: capability artifact absent for producer "contract"

This is deliberate and must NOT be softened to a warning. It is the zero-coverage
green the ticket exists to stop. (Actions billing has blocked every job since
2026-07-10, so nothing is regressing in practice today.)

### 1a. Each capability job uploads its result

Add to the END of the `pty`, `toolchain` and `contract` jobs:

```yaml
      - name: publish capability-result.v1
        if: ${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: capability-result-${{ github.run_id }}-${{ github.run_attempt }}-<JOB_ID>
          path: .cache/capability/<JOB_ID>.json
          if-no-files-found: error
```

where `<JOB_ID>` is literally `pty`, `toolchain`, `contract`. The emitting step
(a JUnit→counts reducer) is TVH-03/TVH-05 work; the file it writes must match:

```jsonc
{
  "schema": "quanta.capability-result.v1",
  "producer": "pty",                 // MUST equal the job id
  "executedFiles": ["tests/e2e-pty/..."],  // exact paths that ran ≥1 case
  "executedCases": 8,
  "skippedUnsupported": 0,           // host cannot run it
  "blockedMissing": 0,               // a REQUIRED dependency was absent → fail
  "failedSetup": 0                   // provisioning broke → fail
}
```

`blockedMissing > 0` and `failedSetup > 0` are hard failures, not skips.

### 1b. The `required` job downloads them and points the reducer at the directory

```diff
   required:
     name: required
     needs: [static-code, catalog, full-suite, pty, web, toolchain, contract]
     if: ${{ always() && github.event_name != 'schedule' }}
     runs-on: ubuntu-latest
     timeout-minutes: 5
     steps:
       - uses: actions/checkout@v4
       - uses: oven-sh/setup-bun@v2
         with:
           bun-version: 1.3.14
+      - name: download capability results
+        uses: actions/download-artifact@v4
+        with:
+          pattern: capability-result-${{ github.run_id }}-${{ github.run_attempt }}-*
+          path: .cache/capability
+          merge-multiple: true
       - run: bun run tools/dev/verification-required-results.ts
         env:
           QUANTA_REQUIRED_NEEDS: ${{ toJSON(needs) }}
+          QUANTA_CAPABILITY_RESULTS_DIR: .cache/capability
```

The reducer reads `<dir>/<producer-id>.json`. `QUANTA_CAPABILITY_RESULTS_DIR`
unset ⇒ every capability producer reads as absent ⇒ FAIL.

## 2. Two pre-existing RED fixtures, owned elsewhere (blocking my verification)

Both are unrelated to TVH-06 and both are on the gate/shard lane:

- `tests/unit/dev/gate-receipt.test.ts` — 18/18 fail at HEAD 1510407867 with
  `Cannot find module './gate-manifest-contract'`. `tools/dev/gate.ts:49` imports
  `./gate-manifest-contract`, and the fixture's `makeRepo` dependency list does
  not copy it. The file's own self-check ("dropping a sibling from makeRepo
  fails this scan") is red too — the guard fired and the landing shipped anyway.
  Fix: add `"gate-manifest-contract.ts"` to that dependency array.
- `tests/unit/dev/verification-campaign.test.ts` — 11/11 fail with
  `Cannot find module './process-observer'` from the copied
  `tools/dev/test-shard-lifecycle.ts` (working-tree, uncommitted). Same class:
  the fixture copier needs `"process-observer.ts"`.
- `tests/integration/test-shard-process-lifecycle-e2e.test.ts` — 8 typecheck
  errors against the uncommitted `tools/dev/test-shard-lifecycle.ts`
  (`groupHasRunningMemberFromPs`, `groupStateLines`, `hasRunningMember` no longer
  exported; `DrainOutcome.abandoned`; `ProcessSnapshot.exitCode`).

## 3. Not needed, recorded for completeness

`tools/dev/gate.ts` needs NO edit for the two new receipt context fields
(`baseOid`, `homeCapabilitySha256`): it constructs the context only through
`verificationContextForSnapshot` in `tools/dev/verification-receipt-probe.ts`,
which now fills them.
