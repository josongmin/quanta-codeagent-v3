# Known failures — SEP9-TV

Captured from local cache at 2026-09-09T15:21:55.956Z. These files are
variable local artifacts, not permanent proof. Classification stays
`unresolved` until an owner-local reproducer exists.

## KF-01 — chunk 16 full-remote token shipping assertion

| Field | Value |
|---|---|
| Status | **resolved (owner-local)** |
| Source | `.cache/full-junit.xml.shard-16.xml` |
| Source SHA256 | `f9b12b6d24d5bce0c6c46d699cef21cd5dfe18e8fc200d2616d4d3a694d53ce4` |
| Campaign | `.git/quanta-verification-cache/last-campaign.json` SHA256 `1376e3fc807f6b17e4b8bf2086a92cd9a11fc35d2c89865215134b4bd85b837e` |
| Campaign outcome | `terminated` / exit 130 / SIGINT / drained=true |
| File | `tests/unit/bench-full-remote-hellgate.test.ts` |
| Case | `NEVER ships refresh_token/id_token to the box (only the stripped token)` |
| JUnit | empty `<failure type="AssertionError" />` — no message body |
| RCA | `shipAccessToken` was never reached. G-F5 `boxProfileReadinessProbe` requires stdout containing `OK`; the hellgate recorder defaulted to empty stdout, so `assertBoxProfileReady` failed closed after bootstrap. Long-lived secrets were absent because **no credential was shipped**, not because stripping worked. |
| Repair | `mockSpawn` and sibling provision recorders answer `echo OK`. The case now asserts `chatgpt.json` stdin contains `ACCESS-xyz` and not the refresh/id secrets. Quarantine still denied. |
| Proof | `bun test tests/unit/bench-full-remote-hellgate.test.ts` — owner-local, not a cache-off full campaign. |

Do not close this by skip, quarantine-without-repro, or nightly exile.
The interrupted campaign is not a pass receipt.

## Historical audit numbers

Audit-time full population was 3,906 files. TV-00 discovery after adding
`tests/unit/dev/test-shard-discovery.test.ts` is 3,907 files. That single
addition is the only documented delta.
