# ADR-0555 — Memory store truth, and a dotenv-sourced key is not consent to egress

Status: Accepted (2026-08-25)
Slice: `src/runner/assemble/memory-factory.ts` · `src/runner/assemble/store.ts` · `src/runner/assemble/tooling.ts` · `src/apps/cli/memory-compose.ts` (split out of `internal.ts`) · `src/apps/cli/memory-cmd.ts` · `src/apps/cli/repl/session-setup.ts` · `src/shared/env-files.ts`
Feature: `memory-store-truth-and-embedder-provenance`
Related: ADR-0413 (memory learning default-ON) · ADR-0503 P4 (`readCliKnob` read-routing) · ADR-0551 (a cassette is a secrets-bearing artifact — same posture, different artifact)

## Context

Two things the CLI said about memory were not true, and one thing it did was never said.

### M4 — the store is volatile and nothing said so

The CLI seeds `QUANTA_MEMORY=1` at startup (`src/apps/cli/index.ts` via `CLI_SEEDED_GATE_NAMES`). The factory maps unset and `"1"` alike to the **volatile** `InMemoryStore` (ADR-0413's deliberate default). `persistSession` writes into it at session end, and the process exits, and it is garbage.

What the operator saw:

- the banner printed `memory on (kind=1, …)` — the raw env token, not a kind — and when `QUANTA_MEMORY` was genuinely unset (the default-ON case) the banner was **omitted entirely**, because the CLI only passed `memoryKindLabel` when the env var existed;
- `/memory stats` counted entries and bytes and never mentioned that the store evaporates at exit;
- the factory's own doc claimed the volatile default "writes NOTHING to disk" as a stock property. That is true of *this store*; it is false as a statement about a launch, because the session-memory and consolidator systems write `~/.quanta/memory/` by default regardless.

Zero tests pinned the banner string.

### M5 — a repo's `.env` silently armed network egress of memory text

`src/apps/cli/index.ts` calls `loadEnvFiles([".env.dev", ".env.local", ".env"])`, which resolves against the **launch** `process.cwd()` (not `--cwd`) and sets `process.env[k]` first-wins. The embedder is composed from `process.env.OPENAI_API_KEY` behind `QUANTA_MEMORY_EMBED`, whose default is **ON**. So a key sitting in the `.env` of whatever directory you launched from armed `OpenAIEmbedder`, which POSTs memory text to `${OPENAI_BASE_URL ?? https://api.openai.com/v1}/embeddings` — and `OPENAI_BASE_URL` from the same file redirects that egress to an arbitrary host. Nothing in the output named where the key came from.

Reproduced in this repo: `embed=on` came from this repository's own gitignored `.env.dev`.

## Decision

### Truth (M4)

1. `buildMemoryForSession(...)` returns the **resolved** `kind: "memory" | "sqlite"` (present iff a store is) and, for sqlite, the resolved `storePath`. The raw env token never leaves the factory.
2. The banner takes `MemoryStoreKind`, not `string`. It prints for the default/unset case, and renders the volatile kind as `kind=memory (volatile)`. The narrowing is the point: a caller can no longer pass a raw env value (two callers outside the original slice — `scripts/reactor-watch.ts` and the CLI fakes — were fixed to pass a resolved kind rather than widening the type back).
3. `/memory stats` prints one line: `Store: in-memory (volatile — not kept across restarts; set QUANTA_MEMORY=sqlite to persist)` or `Store: sqlite (<path>)`. The kind is threaded (`Tooling.memoryKind` → `SessionSetupResult` → `MemorySlashState.kind`); when a surface does not thread it, the slash derives it from the store **instance's class**, which is the same truth and cannot disagree.
4. The factory doc now says what is true: this store writes nothing and is gone at exit; systems B/C write under `~/.quanta/memory/` regardless.
5. The factory's private `resolveAutoTrigger` copy now delegates to `@/memory/auto-trigger`'s `assembleMemoryAuto` (one env→policy projection), preserving the ADR-0413 `override.autoTrigger === null` veto arm.

### Egress (M5)

1. `loadEnvFiles` records **provenance**: which keys were supplied by which file — never values — in a module registry (`envFileProvenance()`, `envFileSourceOf(key)`, `__resetEnvFileProvenanceForTest`). A key that was already in the real environment is never recorded; absence reads as "came from the real env".
2. `buildEmbedderCore` gains `provenance` + `embedExplicitlyOn` + `onNotArmed`. If the key's provenance is a dotenv file and the operator did **not** explicitly opt in, the embedder is not built and one attributed line is emitted: `memory embedder NOT armed: OPENAI_API_KEY came from <file>; set QUANTA_MEMORY_EMBED=1 to opt in` (`logger.warn`; the path is not a secret). If the key came from the real environment the path is byte-identical to before.
3. "Explicitly on" reuses the **existing** knob `QUANTA_MEMORY_EMBED` with `gateOn` semantics (a truthy token `1/on/true/yes` from `/knobs set` or env). Presence-only (`QUANTA_MEMORY_EMBED=`) and the accessor's default-ON are not consent — the accessor would read `"true"` for an unset knob, which is exactly the lie this ADR closes, so the opt-in check reads the raw override/env token, never the defaulted value. An explicit `=0` still wins as the kill-switch and emits no refusal noise.
4. When the embedder is armed with dotenv-sourced credentials, the banner says so: `embed=on (key from <file>, base_url from <file>)`.

### Why not a new knob

A second knob would have added a fourth memory-embedding switch and left the default-ON one in place as the trap. Reusing the existing knob keeps the operator's mental model (one switch) and makes the opt-in the same action they already know.

## Consequences

- Default CLI launch now prints `memory on (kind=memory (volatile), embed=off, session=…)` instead of nothing; a seeded `QUANTA_MEMORY=1` never prints `kind=1`.
- A key in a launch-directory `.env*` no longer sends memory text anywhere until `QUANTA_MEMORY_EMBED=1` is set; the refusal names the file.
- `src/apps/cli/internal.ts` was at the god-module ceiling (993/1000); the memory trio (`buildStore` / `buildEmbedder` / `buildMemoryConfig`) moved to `src/apps/cli/memory-compose.ts` with re-exports (names/signatures unchanged; `cli-knobs.ts` readSites for `QUANTA_MEMORY_EMBED{,_MODEL}` follow the move). `setupSession` had crossed the god-function cap by two lines; the Tooling-forwarded slash slots were hoisted into `toolingSlashSlots`.
- Hellgate: `tests/unit/apps/cli/memory-truth-and-egress-hellgate.test.ts` (T1 factory kind · T2 the **real** `buildTooling` banner · T3 `/memory stats` · E1 provenance · E2 dotenv/real-env/explicit/presence-only/kill-switch matrix · E3 paired control). Red-on-injection verified both ways: removing the provenance gate → E2 red; reverting the banner to the raw env token → T2 red.
- Follow-ups (outside this slice's write set): `src/apps/cli/repl/surface-compose/dispatch-compose.ts#memorySlot` should forward `setup.memoryKind` / `setup.memoryStorePath` into `MemorySlashState` (the instance-class fallback already makes `/memory stats` truthful without it, so this is a threading nicety, not a gap); the `@/runner/assemble` barrel should export `MemoryStoreKind`, `EmbedderProvenance`, `resolveEmbedderProvenance`.
