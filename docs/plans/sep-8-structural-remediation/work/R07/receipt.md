# R07 receipt — cancellation ownership

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W5-A. Universal lifecycle manager 없음. `src/tool` 시그니처 변경 없음.

source HEAD snapshot: `c156d76397feb63ec1c4992c07d011dd0647a4c6`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `web-user-input-port.ts` ~228 (under 300); `ws-handlers.ts` comment-only I |

## Findings

| ID | Result |
|---|---|
| G-F12 | pending = session/turn/prompt + originating AbortSignal; `cancelTurn` settles one turn; `cancelAll` is socket-close only; host wrap attaches turnId/signal so abort does not wait for a terminal event |
| F-08 | `OAuthCallbackHandle.close()` idempotent; flow owns handle from opener; every exit path `finally` closes; RED rebind of the real loopback port after each teardown |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r07/ tests/integration/sep8-remediation/r07/ src/host/runtime/internal/__tests__/turn-user-input-bind.test.ts tests/unit/web-user-input-port-lifecycle-hellgate.test.ts tests/integration/web-user-input-port-e2e.test.ts tests/unit/auth/chatgpt-oauth-adapter.test.ts
```

Turn abort settles that request; sibling turn on the same handle survives. Late answer is a no-op. Loopback port rebinds after success/timeout/open-throw/caller-abort.

## Unverified / out of scope

- Windows flock
- F-13.2 two-process
- W7 verified
