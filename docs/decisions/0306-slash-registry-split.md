# ADR-0306: CLI-03 — Slash registry split (`surface` / `session` / `app`)

- Status: Accepted
- Date: 2026-05-26
- Related: ADR-0297 (CLI-04 surface feature-config), ADR-0299 (CLI-01 bootstrap host extraction), ADR-0300 (CLI-02 SideConversationPort), ADR-0301 (CLI-05 session-cmd shim removal), RFC may-22 unified-agent-runtime §3 (surface decomposition)

## Context

`src/apps/cli/slash-commands.ts` had ballooned to **763 LOC**, mixing three
fundamentally different ownership layers in one `BUILTINS` registry:

1. **Surface-only** slash commands (`/help`, `/context`, `/usage`, `/color`,
   `/navigate`, `/wait`, `/skills`, `/login`, `/status`, `/snooze`, `/cost`,
   `/plan`, `/state`, `/profile`, `/identity`, `/focus-chain`, `/effort`,
   `/inspect`, `/replay`, `/session`, `/snapshot`, `/rules`, `/history`,
   `/branches`, `/fork-checkpoint`, `/queue`, `/web`, `/paste`, `/edit-plan`,
   `/edit-message`). These never invoke the LLM and never touch the agent
   loop. Many have inline bodies that grew over rounds.
2. **Session-bound** commands (`/retry-with`, `/side`, `/why`, `/debug`) —
   need the live LLM port, the transcript, or a session-time toggle handle.
3. **App / system** commands (`/mcp`, `/memory`, `/rewind`, `/fork`,
   `/rewind-tool`, `/rewind-conv`, `/permission`) — touch system-level
   stores (MCP config, memory store, conversation-checkpoint store,
   permission store, shadow-ODB).

The mix forced the surface-only file to import from `@/agent/plan/types`,
`@/storage/shadow-odb`, `@/agent/fork-session`, and other slices via the
cmd-module imports. It also defeated the bootstrap-host extraction (ADR-
0299) intent: a future Tauri/Web surface that wires only surface-only
commands had no way to pull a subset of the registry without forking the
file.

## Decision

Split the registry into three sibling files under `src/apps/cli/slash/`,
each owning one layer; let `slash-commands.ts` become a thin assembly
that concatenates them.

### Files

```
src/apps/cli/slash/
├── registry-surface.ts   # SURFACE_SLASH_COMMANDS (34 entries)
├── registry-session.ts   # SESSION_SLASH_COMMANDS (4 entries)
├── registry-app.ts       # APP_SLASH_COMMANDS    (7 entries, 5 env-gated)
└── render-helpers.ts     # shared: truncateGraphemes, renderSkillRow,
                          # renderSkills, runSkillsRender
src/apps/cli/slash-commands.ts   # thin assembly + public surface
                                 # (55 LOC, down from 763)
```

The assembly is the historical concatenation:

```ts
export const BUILTINS: readonly SlashCommand[] = [
  ...SURFACE_SLASH_COMMANDS,
  ...SESSION_SLASH_COMMANDS,
  ...APP_SLASH_COMMANDS,
]
```

### Public surface preserved

Every external import path is byte-identical to pre-split:

- `import { BUILTINS, runSlashCommand, slashCompleter, describeSlashCommand,
   isSlashCommand } from "./slash-commands"` — unchanged.
- `import type { SlashCommand, SlashContext, SkillRow, SlashCompletionHint }
   from "./slash-commands"` — re-exported from `./slash-contract` as before.
- Every `declare module "./slash-commands" { interface SlashContext { ... } }`
  augmentation in the per-command files (`rewind-tool-cmd.ts`,
  `fork-checkpoint-cmd.ts`, `memory-cmd.ts`, `rewind-conv-cmd.ts`,
  `why-cmd.ts`, `queue-cmd.ts`, `session-cmd.ts`, `snapshot-cmd.ts`,
  `edit-plan-cmd.ts`, `replay-cmd.ts`, `paste-cmd.ts`, `inspect-cmd.ts`,
  `edit-message-cmd.ts`, `web-cmd.ts`, `mcp-cmd.ts`) continues to resolve.

### Inline bodies — extracted

Inline command bodies that lived in the monolith (`contextCmd`, `usageCmd`,
`colorCmd`, `navigateCmd`, `waitCmd`, `skillsCmd`, `reloadSkillsCmd`,
`snoozeCmd`, `resumeCmd`, `costCmd`, `planCmd`, `stateCmd`,
`workingStateCmd`, `branchesCmd`, `profileCmd`, `identityCmd`,
`focusChainCmd`, `effortCmd`, `helpCmd`) moved into
`registry-surface.ts` verbatim. The `debugCmd` body moved into
`registry-session.ts`. No body logic was changed; only the import target.

### Shared helpers

`truncateGraphemes` / `renderSkillRow` / `renderSkills` / `runSkillsRender`
were consumed by `/skills` AND `/reload-skills` so they moved into a
dedicated `slash/render-helpers.ts`. The two registry-surface commands
import from there. Purity check: zero cross-slice imports in the helpers
file — only `SkillRow` and `SlashContext` from `../slash-contract`.

### `/help` live-registry capture

The old `helpCmd` captured `BUILTINS` directly at call-time. After the
split the surface registry has no visibility into the assembled
`BUILTINS`, so the surface layer exports `buildSurfaceSlashCommands(lookup)`
that takes a closure returning the live full registry. The assembly file
passes `() => BUILTINS` so `/help` continues to enumerate every command
from every layer. The static `SURFACE_SLASH_COMMANDS` export still ships
a snapshot for tests that want the layer in isolation.

### Slot ordering — option (a)

The ticket allowed either preserving the historic slot order or updating
the test to reflect the new layered order. The layers are interleaved in
the pre-split BUILTINS (`/retry-with` at slot 6 between surface commands,
`/permission` at slot 12 between surface commands, etc.) so option (b) —
preserving byte-identical ordering — would have required interleaving the
spread, defeating the purity goal.

Option (a) was chosen: tests that pinned absolute slot indices
(`tests/unit/slash-commands.test.ts` full-equality, `tests/unit/cli-retry-with.test.ts`
`names[6] === "/retry-with"`) were updated to assert layered membership +
per-layer counts. The SET of registered names is unchanged.

### Slice fence

A new biome `noRestrictedImports` rule pins `src/apps/cli/slash/registry-surface.ts`
against `@/agent`, `@/agent/**`, `@/llm`, `@/llm/**`, `@/runner`,
`@/runner/**`, `@/host`, `@/host/**`. Per-command modules (`*-cmd.ts`) may
still import from those slices for types; the registry file imports the
cmd objects as opaque `SlashCommand` values only.

## Consequences

### Positive

- `slash-commands.ts` shrinks from **763 LOC to 55 LOC** (-92%).
- Each command lives in exactly one layer, governed by a clear rule
  (does the body need the live LLM / session state?).
- A future surface (Tauri, Web) can compose any subset of the three
  layers — `SURFACE_SLASH_COMMANDS` is exportable standalone.
- The biome fence prevents accidental cross-layer creep.

### Trade-offs

- Slot order is no longer byte-identical to pre-split. Two unit tests
  were updated to assert the layered ordering — the SET of names is
  unchanged.
- `/help` now wires through a closure to capture the live full registry
  (the surface layer alone doesn't know about session + app entries).
  The closure is called only on user `/help` invocation, so there is no
  module-init circularity hazard.

### Negative invariants (hellgate-pinned)

- `registry-surface.ts` must not import from `@/agent`, `@/llm`,
  `@/runner`, `@/host`. Enforced by biome + by source-grep in
  `tests/unit/apps/cli/slash-registry-split-hellgate.test.ts` CASE 1-4.
- `slash-commands.ts` must stay < 200 LOC (CASE 5).
- BUILTINS must register exactly the SET of names pre-split (CASE 6).
- Each layer's count must sum to BUILTINS.length (CASE 7).
- Each layer must be standalone-importable (CASE 8).
- Layered order — surface first, session second, app last (CASE 9).
- No duplicate names across the assembled registry (CASE 10).
- Session-only and app-only names must live ONLY in their owning layer
  (CASE 11, 12).
- The static `SURFACE_SLASH_COMMANDS` export must remain non-empty + each
  entry must satisfy the `SlashCommand` shape (CASE 13).
- The four public functional exports + the `BUILTINS` const must remain
  exported with the same names (CASE 14).
- No inline command body may leak back into `slash-commands.ts` —
  every `const ...Cmd: SlashCommand = {...}` literal lives in a layer
  file (CASE 15).

## Verification

- `bun x tsc --noEmit` baseline 42 errors → post-split 42 errors (0 new).
- `bun x biome check src/apps/cli/slash src/apps/cli/slash-commands.ts` →
  0 errors.
- `bun test tests/unit/slash-commands.test.ts
   tests/unit/cli/help-render.test.ts
   tests/unit/cli/repl-extract-shape.test.ts` → 48 pass / 0 fail.
- `bun test tests/unit/cli/` → 650 pass / 0 fail.
- `bun test tests/unit/apps/cli/slash-registry-split-hellgate.test.ts`
  → 15 pass / 0 fail / 64 expects.
- Full `bun test tests/unit/` → baseline parity (same 16 fail / 8 errors,
  all pre-existing).
