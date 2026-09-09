# W5-I receipt

Status: **W5 implemented on local `main`**. Findings implemented. **Not** W7 `verified` 39/39. Push 없음. 제품 커밋은 별도 요청.

Merge order: **R07 → R08 → R15**, then reserved/I wiring. Single writer.

source HEAD snapshot (W4 land, W5 uncommitted on top): `c156d76397feb63ec1c4992c07d011dd0647a4c6`

## Findings

| ID | Result |
|---|---|
| G-F12, F-08 | turn-scoped cancel + OAuth handle close |
| P2-A-02, P2-A-05, C-F12 | canonical LSP success cache, identity eviction, waiter-local timeout |
| E-PROV-01, G-F6, E-KNOB-01 | transport DTO, eval env order, `isTruthyToken` knobs |

## I applied

R07: `runRuntimeTurn` wraps `userInputPort` with session/turn/signal (`bindTurnUserInput`). `ws-handlers.ts` keeps `cancelAll` on socket close only; turn abort must not use it. Terminal event is not the cancel trigger.

R08: no new public export. Existing `lsp-bridge` / hook barrel already sufficient.

R15: eval independent dotenv loop removed; `loadEnvFiles([".env.dev", ".env.local", ".env"])`. CLI `index.ts` captures boot projection after dotenv + gate seed. `env-files.ts`/`env-flag.ts` unchanged. `internal.ts` not grown.

## Remaining (not W5)

- G-F5.4 EC2 실기 OPEN
- G-F9.4 live Docker/Lima daemon / F-13.2 two-process (excluded)
- W6/R16, W7
- Windows flock
- Global `prepush` not claimed as W5 closeout
- Repo-wide `lint:debt` currently also sees uncommitted W6/R16 + `repl.ts` format; W5 write-set biome error-level is clean
- Audit pass: eval entrypoint child-process loader rail; `clear()` settles waiters; doctor probes current resolver; knob `yes` mutation vs `knobsForReport`
- No W7 verified 39/39 claim
