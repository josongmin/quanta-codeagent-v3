# Multi-Auth Fleet — Ticket Backlog (SSOT)

6 tickets extracted from [../README.md](../README.md). Status: `OPEN` unless noted.
Sizes: S (<= 1/2d), M (~1d), L (multi-day). Phase 1 is bench-only infra.

## Execution order

**Wave 0:** T-1 -> T-2  
**Wave 1:** T-3 || T-4  
**Wave 2:** T-5 -> T-6

## House constraints

- `QUANTA_BENCH_AUTH_POOL` unset => single-auth path stays byte-identical.
- Only stripped `access_token` ships to boxes. Real `refresh_token` / `id_token`
  never leave the operator machine.
- Scheduling authority is **chunk-level**, not per-instance in-process routing.
- "Per-problem routing" is achieved by microchunking, not by mixing accounts
  inside one `bench run`.
- One account's 429 cannot globally back off every other account.
- Warm-box reuse remains first-class. Account affinity is a preference, not a
  hard partition.
- Dry-run must surface account planning without reading auth JSON contents.
- Report / status surfaces must expose account labels, never token material.

## Ticket table

| ID | Title | What closes | Pri | Size | Deps | Posture |
|---|---|---|---|---|---|---|
| T-1 | AuthPool manifest + resolver | single `QUANTA_BENCH_AUTH_FILE` input shape | P0 | M | — | type-lock |
| T-2 | AuthLeaseManager | shared-OAuth global backoff / no account isolation | P0 | L | T-1 | pure-core |
| T-3 | pool account-aware scheduler | chunk cannot acquire account lease / reuse same-account box | P0 | L | T-1, T-2 | default-OFF unless pool configured |
| T-4 | microchunk routing | chunk-level routing cannot approximate per-problem parallelism | P1 | M | T-1, T-2 | opt-in |
| T-5 | full-remote auth parity | `grade --mode full` has a different auth path truth | P1 | M | T-1, T-2 | explicit label / auto-pick |
| T-6 | observability + rollout | operator cannot see account allocation / cooldown / mapping | P0 | M | T-3, T-4, T-5 | telemetry-first |

## Done means

- Two accounts can run concurrently without sharing the same slot budget.
- A 429 on account A cools down only A; B keeps draining work.
- `pool` / `full-remote` / dry-run all report the chosen account label.
- Box reuse, chunk requeue, and lease release are all leak-free under tests.
- One-instance chunks are first-class so "problem-level parallelism" is easy
  without invasive runner surgery.
