# DOF-05 - web bind/auth fail-closed

**Priority:** P0  
**Depends on:** none  
**Owner:** `src/apps/web-daemon/index.ts`, bind/auth config and focused tests

## Invariant

An unset auth token must never expose the daemon on a non-loopback interface by default.

## Work

Choose one authority and encode it once:

- preferred: default `QUANTA_WEB_BIND` to `127.0.0.1`; explicit wildcard bind remains allowed only with a token or explicit insecure acknowledgement
- alternative: keep wildcard default but require auth, including startup fail-closed when no token exists

Update `src/apps/web-daemon/types.ts`, README, 0315 YAML, and startup diagnostics from the same policy. Add negative tests for unset env, wildcard without token, wildcard with token, explicit loopback, IPv6 wildcard, and malformed/empty token.

## DoD

- default startup is loopback-only or authenticated
- non-loopback without required authority fails before listening
- catalog, types, README, and runtime agree
- existing authenticated WS/HTTP tests remain green

## Verification

```sh
bun test tests/unit/apps/web-daemon/auth.test.ts tests/unit/apps/web-daemon/server.test.ts
bun run typecheck:all
```
