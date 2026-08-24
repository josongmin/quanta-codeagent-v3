# ADR-0557 — The long-term memory store is durable by default, home-scoped, and never crashes the session

Status: Accepted (2026-08-25)
Slice: `src/memory/store-path.ts` (new) · `src/runner/assemble/memory-factory.ts` · `src/runner/assemble/store.ts` · `src/memory/adapters/sqlite.ts` (parent `mkdir` only)
Feature: `memory-durable-home-scoped-default`
Related: ADR-0413 (memory learning default-ON via the session factory) · ADR-0555 (resolved `kind`/`storePath` on the slot; the banner and `/memory stats` print them) · ADR-0068 (`~/.quanta/memory/` — the consolidator's home-scoped layout this store now shares)
Hellgate: `tests/unit/memory/durable-store-default-hellgate.test.ts` (D1–D7)

## Context

ADR-0413 made memory learning default-ON, and ADR-0555 made the surfaces tell the truth about which store was on. The truth was this:

- **The default persisted nothing.** The CLI seeds `QUANTA_MEMORY=1`; `resolveStoreKind("1")` and `resolveStoreKind(undefined)` both resolved to `"memory"` = `new InMemoryStore()` per process. `persistSession` wrote distilled entries into that `Map` at session end, the process exited, and they were gone. Measured: a second construction with the same env had `all().length === 0`. "Cross-session knowledge accumulation" — the stated goal of ADR-0413 — never happened through this store.
- **The only durable path crashed and polluted repos.** `QUANTA_MEMORY=sqlite` opened `new SqliteStore(".quanta/memory.sqlite")` — CWD-relative — and `sqlite.ts` never created the parent directory. `bun:sqlite` does not create intermediate directories, so in any repo without a pre-existing `.quanta/` dir the constructor threw `SQLiteError: unable to open database file`; `buildTooling` was not wrapped, so session boot crashed. Where it did open, WAL mode dropped three files (`.sqlite`, `-wal`, `-shm`) into the user's repository — this repo's `.gitignore` does not travel with the target repo.
- **"The default writes nothing to disk" was never a launch property.** The session-memory (B) and consolidator (C) systems already write `~/.quanta/memory/` on every launch (`src/memory/consolidate/paths.ts`, home-scoped). The only real distinction the volatile default bought was cwd-scoped vs home-scoped — and the volatile store was neither.

## Decision

1. **Durable by default, home-scoped.** Unset, the seeded `"1"`, and every other truthy token resolve to `"sqlite"` at `~/.quanta/memory/memory.sqlite` — the same parent B/C already use. The path resolver lives in `src/memory/store-path.ts` and takes `homeDir` as a parameter (`defaultDurableStorePath(homeDir)`), so no test ever touches the real home; the factory exposes `override.homeDir` / `override.cwd` as the DI seams and defaults them to `os.homedir()` / `process.cwd()`.
2. **The parent directory is created on open.** `SqliteStore` does `mkdirSync(dirname(path), { recursive: true })` before `new Database(path)` for file paths (`:memory:`, `""`, and `file:` URIs are left to sqlite). This is the only change to the adapter.
3. **Explicit volatile stays.** `QUANTA_MEMORY=memory` ⇒ `InMemoryStore`, unchanged meaning; the banner still prints `kind=memory (volatile)` for it. `QUANTA_MEMORY=0/off/false/no` ⇒ no store, unchanged. `QUANTA_MEMORY_PATH` and `override.storePath` still win outright.
4. **Legacy compat is honest, not silent.** If the old cwd-relative file `<cwd>/.quanta/memory.sqlite` exists AND no explicit path was given, that file keeps being used — user data is never moved or copied — and ONE `logger.warn` names both paths and the migration (`mkdir -p … && mv "<legacy>" "<home>"`). Detection is pure (`resolveStorePath({ homeDir, cwd, explicitPath, exists })`; `exists` defaults to `existsSync`).
5. **A store-open failure never kills the session.** If `SqliteStore` construction throws (read-only home, `EACCES` on the mkdir, …), the factory emits ONE attributed `logger.warn` naming the path and the error and falls back to `InMemoryStore`. The slot's `kind` is then `"memory"`, so the ADR-0555 banner honestly prints `kind=memory (volatile)`; nothing is swallowed (silent-failure ratchet unchanged).
6. **Truth flows through the existing surfaces.** No new label: `MemorySessionSlot.kind` / `.storePath` (ADR-0555) carry the resolved facts, the banner prints `kind=sqlite` + the path, `/memory stats` prints `Store: sqlite (<path>)`.

## Alternatives considered

- **Per-workspace store directory** (Grok: `~/.grok/memory/{slug}-{hash8}`). Not adopted. `MemoryEntry` already carries `appliesTo.cwd` / `taskGroup` routing meta and `rankEntries` has a routing term (`QUANTA_MEMORY_ROUTING`), so one home-scoped store with per-entry cwd routing is the design that already exists; a per-repo directory would split recall across repos (a preference learned in one project would be invisible in the next) for no measured gain, and would add a slug/hash scheme to keep stable across renames.
- **Keep the volatile default and document it harder.** ADR-0555 did that; a documented lie is still a store that learns nothing. Rejected.
- **Migrate the legacy cwd file automatically.** Moving user data on boot, with a WAL that may not be checkpointed, is exactly the kind of silent side effect this repo's silent-failure work exists to remove. The warn tells the operator the `mv`; they run it when nothing is open.
- **Wrap the open in `buildStoreCore` and return a fallback there.** The factory owns `kind`, and `kind` must match the instance actually returned — so the fallback lives where the truth is assembled (`openStoreWithFallback` in the factory), and `buildStoreCore` keeps throwing for direct callers.

## Consequences

- A default launch now writes `~/.quanta/memory/memory.sqlite` (+ `-wal`/`-shm`) under the home directory. This is the parent B/C already wrote to; no new disk location is introduced. Nothing is written into the working tree.
- The banner for a stock launch changes from `memory on (kind=memory (volatile), …)` to `memory on (kind=sqlite, …)`; `/memory stats` prints the home path.
- Users with an old `<cwd>/.quanta/memory.sqlite` keep it — recall is unchanged for them — and see one warn per launch until they move it.
- The CLI and the web-daemon (`session-collaborators.ts` calls the same factory) share the one home-scoped file; sqlite WAL supports multi-process readers/writers.
- Tests that build the default session through the real composition root now resolve under `os.homedir()`. Every test in this slice injects `override.homeDir` or sets `HOME` to a temp dir. Follow-up outside this write set: a repo-wide `HOME` redirect in `tests/setup.ts` would make that impossible to forget for future suites (B/C have had the same exposure since ADR-0068).
- Follow-up outside this write set: `src/config/knob-inventory/extra.ts` still describes `QUANTA_MEMORY` as `default: "memory"` / "unset⇒memory"; the `readSite` is truthful, the default string is stale.
- Hellgate D1–D7 (`tests/unit/memory/durable-store-default-hellgate.test.ts`), red-on-injection verified: reverting the default to `"memory"` → D1/D2 (and D6) red; removing the `mkdir` → D3 red; restored → 20/20 green. Pre-existing assertions that pinned the volatile default (`memory-factory-hellgate`, `memory-default-on-e2e-hellgate` §1/§2/§3/§5/§8, `memory-truth-and-egress-hellgate` T1/T2) were updated to the durable default with an ADR-0557 comment; every other assertion in those files is unchanged.
