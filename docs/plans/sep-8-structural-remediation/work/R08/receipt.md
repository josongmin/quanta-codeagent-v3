# R08 receipt — LSP cache / waiter

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W5-B. Public barrel 추가 없음 (`lspBinaryAvailable` / hook exports 기존 유지).

source HEAD snapshot: `c156d76397feb63ec1c4992c07d011dd0647a4c6`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `check-lsp-test.ts` local cache removed; hook/hub stay well under 900 |

## Findings

| ID | Result |
|---|---|
| P2-A-02 | shadow `availabilityCache` removed; canonical `lsp-bridge/availability` success-only cache; false→true re-probe; in-flight dedup kept |
| P2-A-05 | sessions Map: in-flight dedup + success reuse; null/reject eviction by promise identity; late failure cannot drop a new client; dispose-during-open closes the late client |
| C-F12 | timeout removes only its waiter; empty URI key deleted; same-URI live waiter still resolves on late publish; `clear()`/`stop()` settle waiters immediately instead of waiting for timeout |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r08/ tests/integration/sep8-remediation/r08/ tests/unit/shadow-verify-adapters-hellgate.test.ts tests/unit/lsp-diagnostics-hook-hellgate.test.ts
```

Availability override skips the cache, so concurrent dedup is asserted on live `isAvailable` promise identity.

## Unverified / out of scope

- New public LSP exports (not required)
- W7 verified
