# R06 receipt — scheduler reclaim

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W4-B. No second lease. Exactly-once **not** claimed.

source HEAD snapshot: `f3a93d5fd22855951ef4f871813e2b55b0f41b0c`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `ticker.ts` 216 |

## Findings

| ID | Result |
|---|---|
| G-F4.1 | `tickScheduler` passes `claim(now, { reclaimBefore })`; same `claimToken` `renewClaim` heartbeat |
| G-F4.2 | defaults `reclaimStaleAfterMs=60000`, `renewEveryMs=20000`; `0` disables; `ownership-lost` outcome; old token finalize still refused |
| G-F4.3 | ticker rail: durable claim → park → later tick reclaims; live renew not stolen |
| G-F4.4 | reclaim is recovery-required, not exactly-once |

Live ticker (`startAutomationEngineTicker`) does not pass overrides — defaults apply. Agent slot types unchanged.

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r06/ tests/integration/sep8-remediation/r06/
```

## Unverified / out of scope

- Windows reclaim
- Claiming R02 flock as scheduler lease
- Non-idempotent external side effects after reclaim (recovery-required)
