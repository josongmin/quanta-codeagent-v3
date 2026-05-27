# ADR-0376 — `/session-registry help` sub-command discovery

- Status: **Accepted**
- Date: 2026-05-28
- Slice: `src/apps/cli/session-registry-cmd.ts` (MUTATE — expand `HELP_LINES` + add stderr known-list to the unknown-sub branch), `tests/unit/session-registry-slash.test.ts` (MUTATE — +5 hellgate cases)
- Related: ADR-0345 (closed-port `evict`) · ADR-0370 (inspector + stats slash) · ADR-0374 (evict sub-command, sibling)

## Context

ADR-0370 shipped `/session-registry help` with three lines — `stats` / `help` / alias. ADR-0374 adds `evict <id>`. As the sub-command surface grows, the operator's mental model needs **two** pieces of information that ADR-0370's help block did not carry:

1. **Every sub-command, in one place.** A new operator should not need to read the ADRs to know `evict <id>` exists.
2. **Backend detect priority.** The same env-var precedence chain `global.ts` and `inspector.ts` use to pick a backend (`SQLITE_PATH > DISK_DIR > in-memory`) is invisible to the operator without grepping source. When operators ask "why does `/session-registry stats` say `disk` when I set the sqlite env var?" the answer is in this priority chain.

Codex operators reach the same information via `man codex` + `~/.codex/logs_2.sqlite` docs; we keep it in-band so the help block IS the documentation surface.

## Decision

Two changes:

### 1. Expand `HELP_LINES` in `session-registry-cmd.ts`

Replace the 3-line block (alias / stats / help) with a structured 11-line block:

```text
## /session-registry — Operator surface for session registry

Sub-commands:
  stats         Print backend + sessions/events/bytes (default)
  evict <id>    Force-evict one session by id (idempotent)
  help          Show this menu

Backend detect priority (first match wins):
  1. QUANTA_SESSION_REGISTRY_SQLITE_PATH   — sqlite adapter (ADR-0367)
  2. QUANTA_SESSION_REGISTRY_DISK_DIR      — disk adapter (ADR-0351)
  3. (otherwise)                           — in-memory singleton (ADR-0345)
```

The `Sub-commands` section is a 3-row table. The `Backend detect priority` section mirrors `global.ts` precedence **exactly** — if ADR-0367 / ADR-0361 ever reorder it this block must be updated in lockstep. There is no central source-of-truth for this chain (each surface owns its own help copy by repo convention).

### 2. Unknown-sub branch surfaces the known-list (already in place)

The pre-existing unknown-sub stderr line — `unknown subcommand: <typo> (use one of stats, evict, help)` — is unchanged in shape but now references the **expanded** `SUBCOMMANDS` array (which now includes `evict`). This makes the typo-recovery loop self-discoverable: operator types `evic`, gets the stderr hint, knows `evict` exists.

### 3. Default sub-command unchanged

`/session-registry` with no args still aliases to `stats` (the most-used informational path). The help block is opt-in via `help` — operators who already know the surface do not pay the discovery cost.

## Why not a generic `/help <slash>` mechanism

Considered + rejected:

1. **Cross-cutting `/help`** — every slash command would need a `helpBlock` field on `SlashCommand`. The closed contract (`src/apps/cli/slash-contract.ts`) deliberately keeps `SlashCommand` minimal; adding `helpBlock` would propagate through 47 BUILTINS. A separate ADR can introduce that pattern if multiple slashes need it; this ADR keeps the surface local.
2. **Markdown rendering** — the help block is plain text + ASCII alignment. No markdown parsing, no terminal-width detection. The slash output is grep-stable across log lines.
3. **Per-sub-command help** (`/session-registry help evict`) — out of scope. The single-block form is the right size for 3 sub-commands; if the surface grows past 6+ sub-commands a follow-up ADR can introduce per-sub help.

## Non-goals

- **Generic help framework** for all slashes — out of scope. Each slash owns its own help block by repo convention; a framework-level slot is a separate ADR.
- **Markdown rendering** — the help block is plain ASCII. Terminal-width detection / markdown → ANSI rendering is out of scope.
- **i18n** — English only. Codex / Cursor / Claude all keep their slash help in English; we follow.
- **`help <sub>` per-sub-command form** — single block for now; revisit if the sub-command count grows.

## Wiring

- No registration change. ADR-0370 already wired `/session-registry` into `APP_SLASH_COMMANDS`.
- No new imports. The help block is a `readonly string[]` constant in the same file.

## NO-THROW invariants

- `renderHelp` is pure — joins a static array. Cannot throw.
- `run(["help"])` exits 0 + writes to `ctx.out`.

## Slice fence

- `src/apps/cli/session-registry-cmd.ts` — mutated (HELP_LINES expansion).
- `tests/unit/session-registry-slash.test.ts` — mutated (+5 hellgate cases).
- No mutation of any other file.

## Test coverage

`tests/unit/session-registry-slash.test.ts` adds 5 cases for this ADR (numbered [13]–[17] alongside ADR-0370's [1]–[5] and ADR-0374's [6]–[12]):

| Case | Subject                                                          |
| ---- | ---------------------------------------------------------------- |
| [13] | help lists every sub-command (`stats` / `evict` / `help`)        |
| [14] | help shows `evict <id>` usage shape (placeholder visible)        |
| [15] | help shows backend detect priority chain (env-var names + order) |
| [16] | help is NO-THROW + exit 0 (re-pin of ADR-0370 [4])               |
| [17] | unknown-sub stderr includes `evict` in known-list                |

Pre-existing [1]–[5] continue to pin ADR-0370 invariants — case [4] is a subset of [16] but kept for ADR-0370 anchoring.
