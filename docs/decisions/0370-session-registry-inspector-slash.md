# ADR-0370 — `SessionResourceRegistry` inspector + `/session-registry stats` slash

- Status: **Accepted**
- Date: 2026-05-28
- Slice: `src/agent/session-resource-registry/inspector.ts` (NEW), `src/apps/cli/session-registry-cmd.ts` (NEW), `src/apps/cli/slash/registry-app.ts` (1-line MUTATE)
- Related: ADR-0345 (in-memory port) · ADR-0348 (disk adapter) · ADR-0351 (env-var swap) · ADR-0356 (flock) · ADR-0361 (sqlite adapter) · `memory/codex-logs-retention-pattern.md`

## Context

The closed `SessionResourceRegistry` port (ADR-0345) exposes 5 methods — `getOrCreate` / `peek` / `evict` / `size` / `clear` — none of which surface the **durable-mirror** dimensions an operator needs to reason about retention health. Specifically:

- the **disk** adapter (ADR-0348) accumulates per-session JSONL files under `storageDir/<id>/{events,prompt-cache}.jsonl + meta.json`. An operator wants to know "how much disk am I using? how many sessions are on file?"
- the **sqlite** adapter (ADR-0361) mirrors events + cache rows to a `bun:sqlite` WAL DB. An operator wants Codex `logs_2.sqlite`-style visibility — sessions / events / cache rows / total `estimated_bytes` / `wal_size`.
- the **in-memory** adapter wants to expose the `size()` it already has, behind the same surface.

Codex's habit (`memory/codex-logs-retention-pattern.md`) is to give admins `sqlite3 ~/.codex/logs_2.sqlite 'SELECT …'`. We want parity **without** giving operators a sql shell — they should ask `/session-registry stats` and get the same numbers.

## Decision

Add a **sibling inspector slice** + an **operator-only slash command**. The closed port stays UNTOUCHED.

### 1. `src/agent/session-resource-registry/inspector.ts` (NEW)

- Public `RegistryStats` shape with a `backend: "in-memory" | "disk" | "sqlite"` discriminator + optional numeric fields (`sessions`, `totalEvents?`, `totalCacheEntries?`, `totalBytes?`, `walSize?`, `ttlMs?`, `maxBytes?`) + `available: boolean` (NO-THROW signal).
- Three backend-specific inspect functions:
  - `inspectInMemoryRegistry(registry)` — reads `registry.size()`.
  - `inspectDiskRegistryByPath(storageDir)` — `readdir` + per-session `stat` of the 3 file names. NO JSONL parse → corrupt bodies do not poison the byte total.
  - `inspectSqliteRegistryByPath(databasePath)` — opens the DB **read-only** (`new Database(path, { readonly: true })`) + runs `COUNT(*)` against `sessions` / `events` / `cache_entries` + `SUM(total_estimated_bytes)` + `stat($path-wal).size`.
- `inspectGlobalRegistry()` — env-var detection mirrors `global.ts` precedence:
  1. `QUANTA_SESSION_REGISTRY_SQLITE_PATH` (NEW, **inspect-only** — does NOT mount; ADR-0361 §Default-OFF still holds).
  2. `QUANTA_SESSION_REGISTRY_DISK_DIR` (ADR-0351).
  3. else → in-memory singleton.
- `formatRegistryStats(s)` — pure formatter (Codex-style block).

Every function NO-THROWS. SQL / fs errors degrade to `available: false` + zeroed numeric fields. The DB handle is always closed in `finally`.

### 2. `src/apps/cli/session-registry-cmd.ts` (NEW)

- `sessionRegistryCmd: SlashCommand` — name `/session-registry`, category `"other"`.
- Subcommands: `stats` (default) | `help`. Unknown subcommand → stderr + exit 1.
- Calls `inspectGlobalRegistry()` + `formatRegistryStats()`, writes via `ctx.out`.
- Defence-in-depth try/catch — a regression in the inspector cannot crash the REPL; renders `## Session Registry — unavailable` + exit 0 (informational).

### 3. `src/apps/cli/slash/registry-app.ts` (MUTATE — 1 line)

Append `sessionRegistryCmd` to the `APP_SLASH_COMMANDS` array. The CLI-03 split (ADR-0306) already isolates this registry from the surface + session registries, so the diff is one append + one import.

### 4. Closed-port discipline preserved

The port shape — `getOrCreate` / `peek` / `evict` / `size` / `clear` — is **byte-identical** before and after this ADR. The inspector is a **sibling read-only function**, not a method added to the port. ADR-0345 / 0348 / 0361 stay untouched.

## Why not extend the port

Three reasons:

1. **Backwards compat.** Every implementer (in-memory + disk + sqlite + hostile mocks in tests) would need a new method. The R10 ADR-0357 abort proves that port-shape drift is expensive.
2. **Backend asymmetry.** `walSize` is sqlite-only; `totalBytes` is disk+sqlite; `totalEvents` is sqlite-only. A single method `stats(): RegistryStats` would force `undefined` everywhere or a 3-way union; the sibling pattern keeps each backend's signal honest.
3. **Codex parity.** Codex's admin surface (`sqlite3 logs_2.sqlite` + `du -sh ~/.codex/logs_2.sqlite-wal`) is the read-side already separate from the runtime write API. Mirroring that separation is consistent with ADR-0361's Codex-parity stance.

## Non-goals

- **Write subcommands** (`/session-registry evict <id>`, `/session-registry clear`, `/session-registry vacuum`) — out of scope. The closed port's `evict` / `clear` are deliberately NOT exposed through a slash because an operator typo dropping a hot session is a foot-gun without a confirm gesture. A separate ADR can introduce them behind a `--yes` flag.
- **Auto-mount on sqlite env var.** `QUANTA_SESSION_REGISTRY_SQLITE_PATH` is **inspect-only** in this ADR. ADR-0361 §Default-OFF declared a follow-up ADR for the mount swap on the ADR-0351 pattern; this ADR does NOT preempt it.
- **Continuous metrics emission.** ADR-0358 / 0360 already emit per-operation counters. The slash command is a **one-shot snapshot** for the operator at the prompt; a periodic Prometheus exporter is a separate concern.
- **Multi-backend simultaneous inspect.** The env-var precedence picks ONE backend per call. A composition root running with the sqlite backend mounted but the disk dir also present will see ONLY the sqlite snapshot.

## Wiring

- `inspector.ts` is NOT re-exported from `src/agent/session-resource-registry/index.ts` (default-OFF stance). Callers reach it via the explicit `@/agent/session-resource-registry/inspector` path — the slash command does so.
- `sessionRegistryCmd` is registered in `APP_SLASH_COMMANDS` (`src/apps/cli/slash/registry-app.ts`). Available to every CLI surface that consumes `BUILTINS`.

## NO-THROW invariants

- `inspectInMemoryRegistry` — hostile `registry.size()` throws ⇒ `sessions: 0`.
- `inspectDiskRegistryByPath` — `readdir` fails ⇒ `available: false`; per-entry `stat` fails ⇒ entry skipped.
- `inspectSqliteRegistryByPath` — DB open fails ⇒ `available: false`; query fails ⇒ field defaults to 0; handle closed in `finally`.
- `inspectGlobalRegistry` — composition of the above; never throws.
- `formatRegistryStats` — pure, total over the type, never throws.
- `sessionRegistryCmd.run` — wraps `inspectGlobalRegistry` in defence-in-depth try/catch; on failure renders "unavailable" + exit 0.

## Slice fence

- `inspector.ts` imports `bun:sqlite` + `node:fs` + sibling files (`./global`, `./disk-adapter/types`, `./sqlite-adapter/types`, `./types`).
- `session-registry-cmd.ts` imports `@/agent/session-resource-registry/inspector` + `./slash-commands` types.
- `registry-app.ts` adds one import + one array entry.
- No mutation of `loop.ts`, `prompt.ts`, `assemble.ts`, or any composition-root file. The port types (`./types.ts`) are unchanged.

## Test coverage

`src/agent/session-resource-registry/__tests__/inspector.hellgate.test.ts` — 15 cases:

1. empty in-memory → backend tag + sessions=0
2. populated in-memory → sessions count matches `size()`
3. empty disk dir → backend=disk, sessions=0, totalBytes=0
4. populated disk → sessions + totalBytes > 0
5. missing disk dir → `available: false` (NO-THROW)
6. empty sqlite → backend=sqlite, sessions=0
7. populated sqlite → sessions + events + cache + bytes counted
8. sqlite walSize stat → number ≥ 0
9. missing sqlite path → `available: false` (NO-THROW)
10. env not set → inspect global → in-memory
11. env precedence — sqlite > disk
12. formatter contains backend tag + title
13. formatter renders "unavailable" line when `available: false`
14. formatter — sqlite backend shows Codex parity tag
15. slash registration — `BUILTINS` contains `/session-registry`
