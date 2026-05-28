# ADR-0418 — Async mention resolver + `@file` / `@symbol` mention kinds

**Status:** Accepted (2026-05-29)
**Supersedes:** ADR-0325 (3-kind sync mention injection) and ADR-0330
(sync skill-resolver runner). The 4-kind sync-additive `@file:` extension
drafted under ADR-0413's mention header is also superseded (the explicit
`@file:` prefix syntax is dropped in favour of the deterministic cascade
below).
**Slices:** `src/agent/mention-injection/` (`types` 5-kind enum / `parser`
deterministic cascade / `resolver` async port + parallel consumer /
`symbol-resolver` new / `index` barrel) + `src/agent/mention-runner/`
(`runner` + `skill-resolver` async) + `src/agent/plugin-app-resolver/`
(`composite-resolver` + `skill`/`plugin`/`app`/`file` sub-resolvers async,
`file-resolver` → fs.promises + `tailRatio`) + `src/agent/types.ts`
(`mentionInjector` async slot + `mentionInjection` DI bag) +
`src/agent/loop.ts` (await wire) + `src/agent/codex-r2-wire-install/`
(async injector closure) + the mention hellgate suite (async-migrated +
new `parser-file-symbol` / `symbol-resolver` / `resolver-async` batteries).

## Context

ADR-0325 froze a 3-kind mention enum (`skill | plugin | app`) behind a
SYNC resolver port; ADR-0330 shipped the sync skill-only runner. A
sync-additive 4th `file` kind was bolted on (resolution = `readFileSync`,
which fit the sync contract). But the natural next kind — `@symbol` — needs
a workspace-symbol lookup that is inherently async (LSP query / semantic
search index). A sync port cannot host it without blocking the event loop.

Competitor parity (Cursor / IDE `@`-mentions) wants BOTH `@path/to/file`
and `@SymbolName`. Adding `symbol` forces the resolver/injector
sync→async cascade that ADR-0325 §"deliberate_hold" explicitly deferred to
a new ADR. This is that ADR.

## Decision

### 1. Five-kind enum

`MentionKind = "skill" | "plugin" | "app" | "file" | "symbol"`. Frozen at
five; extending requires a new ADR that supersedes 0418.

### 2. Deterministic parser priority cascade (LOCKED, verbatim)

`@@<kebab>` is matched by its own alternative first (app). `plugin://<kebab>`
is independent. Every remaining `@<rest>` payload is classified by the
following cascade — FIRST match wins:

1. `<rest>` contains `/` → **file** (the whole path is the target).
   _Slash → file._
2. `<rest>` starts with `[A-Z]` (uppercase ASCII) → **symbol**. Alphabet
   `[A-Za-z0-9_]`, optional one-level `.member` suffix. _Uppercase-start →
   symbol._
3. `<rest>` starts with `[a-z]` AND contains `.` → **file** (lowercase
   dotted token, e.g. `@foo.ts`). _Dot + lowercase-start → file._
4. `<rest>` is a pure kebab `[a-z][a-z0-9-]*` (length ≤ 64) → **skill**.
   _Lowercase-kebab → skill._

Tie-break examples (verbatim):

- `@./Foo`      → file   (contains `/`)
- `@Foo.bar`    → symbol (uppercase start, `.member` allowed)
- `@a.b`        → file   (lowercase start + contains `.`)
- `@code-review` → skill (kebab, no `.` no `/`)

Left-boundary (rule 6): the sigil must sit at start-of-input or after a
non-word char — `foo@bar.com` is NOT a mention. Dedup: per `(kind, target)`,
first occurrence wins, order preserved. Pure / NO-THROW.

### 3. Async resolver port (parallel)

`MentionResolverPort` methods return `Promise<MentionResolverResult | null>`
(`resolveSkill`/`resolvePlugin`/`resolveApp` required; `resolveFile`/
`resolveSymbol` optional). `buildInjectionFragments` resolves every mention
concurrently via `Promise.all` (wall time = max(latency), not sum), with
per-mention NO-THROW (one throw / reject / timeout drops only that mention;
neighbours survive) and INPUT-order-stable output. Kind dispatch is HARD —
a `@skill` never falls through to another method.

### 4. `@file` resolver

`createFileResolver({ root, maxBytes?, tailRatio? })` — async fs read inside
a `realpath` + `is-path-inside` jail (absolute / traversal / escaping
symlink → null), binary sniff (NUL in first 8 KiB → null), 256 KiB default
cap. `tailRatio` 0 (default) = legacy head-only marker; >0 = head+tail
window with omitted-byte count.

### 5. `@symbol` resolver

`createSymbolResolver({ lsp?, semantic?, priority?, timeoutMs?, maxHits? })`
— two INJECTED lookup ports. `priority` ∈ `lsp | semantic | auto` (default
auto = LSP first, semantic fallback on miss / throw / timeout). Per-strategy
timeout (default 5000 ms). NO-THROW on sync-throw / reject / timeout /
non-array. The wire over `@/agent/lsp-bridge` + `@/runner/assemble/
search-index-backend` is the composition root's job (slice-fence permits the
cross-slice import there).

### 6. AgentConfig

`mentionInjector?: (text) => Promise<readonly Message[]>` (was sync).
`mentionInjection?` DI bag carries `fileResolver` / `symbolResolver` /
`maxFileBytes` / `tailRatio` / `symbolPriority` / `symbolTimeoutMs`.

## Configurable knobs (env → DI)

| Env | DI field | Default | Effect |
| --- | --- | --- | --- |
| `QUANTA_MENTION_FILE` | (gate) | on | enable `@file` resolution |
| `QUANTA_MENTION_SYMBOL` | (gate) | on | enable `@symbol` resolution |
| `QUANTA_MENTION_FILE_MAX_BYTES` | `maxFileBytes` | 100_000 (env) / 262_144 (lib default) | file read cap |
| `QUANTA_MENTION_FILE_TAIL_RATIO` | `tailRatio` | 0.5 (env) / 0 (lib default) | head/tail split |
| `QUANTA_MENTION_SYMBOL_RESOLVER` | `symbolPriority` | auto | lsp\|semantic\|auto |
| `QUANTA_MENTION_SYMBOL_TIMEOUT_MS` | `symbolTimeoutMs` | 5000 | per-strategy timeout |

## Default-OFF / byte-identical

No production path imports the slice until a wire-up ADR lands. With zero
`@file` / `@symbol` mentions in the input, output is byte-identical to the
legacy 3-kind path; with `mentionInjection` absent, file/symbol mentions
resolve to `null` (skipped).

## No-heuristics

The cascade is fully deterministic (regex + ordered predicate, no scoring).
File cap / tail ratio / symbol timeout are named constants with env override,
not tuned thresholds.

## Consequences

- `mentionInjector` callers MUST migrate to `await` (the only existing wire,
  `codex-r2-wire-install`, is updated here).
- The `@file:` explicit-prefix form is removed; `@path/x` (slash) or
  `@foo.ts` (lowercase dot) are the file forms. An uppercase-leading dotted
  token like `@README.md` classifies as a **symbol** (`README.md`) by the
  cascade — documented, not a bug.
