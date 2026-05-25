# ADR-0304: `SideConversationPort` — slash-surface ↔ runner seam for `/side`

- Status: Accepted
- Date: 2026-05-25
- Related: ADR (CLI-01 sibling) — composition-root tightening; the runner's
  `runSideChat` (`src/runner/orchestrate/side-chat.ts`) is unchanged.

## Context

Before this ADR, the CLI's slash-surface layer (`src/apps/cli/repl/slash-surface.ts`)
imported engine internals to wire `/side`:

```ts
// slash-surface.ts (pre-ADR)
import { assembleConfig, type SessionDeps } from "../internal"

export interface BuildReplSlashCtxArgs {
  // …
  sessionDeps: SessionDeps        // <- leak
  abortSignal: AbortSignal
}

// inside buildReplSlashCtx:
side: (): SideChatSessionState => ({
  deps: sessionDeps,
  assembleConfig,                  // <- captured per-call
  messages: getHistory(),
  signal: abortSignal,
}),
```

The downstream `/side` slash command then called `runSideChat({ deps,
assembleConfig, ... })` directly. That coupled the slash adapter to
`SessionDeps` (a 25-field union of CLI-resolved collaborators) and the
`assembleConfig` factory — even though `/side` only needs to ask "start a
side conversation with this question". Two costs:

1. Any future surface (Web / Tauri) reusing the slash dispatcher must
   present a CLI-shaped `SessionDeps` or carry a parallel runtime — but
   `SessionDeps` is by definition CLI-only.
2. The slice fence between L3 surface and L2 runner is porous — a
   slash-surface refactor that touches `assembleConfig` would silently
   compile against an engine-internal contract.

## Decision

Introduce a typed `SideConversationPort` at the L2 boundary. The slash
layer consumes only the port; the CLI surface composer builds the port
once via an adapter that captures the engine-internals in closure scope.

### Port (surface-agnostic, lives in `@/runner`)

**File**: `src/runner/side-conversation-port.ts`

```ts
export interface SideConversationStartArgs {
  readonly question: string
  readonly inherit?: SideChatContextInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly signal: AbortSignal
  readonly messages: readonly Message[]   // READ-ONLY snapshot
}

export interface SideConversationPort {
  readonly start: (args: SideConversationStartArgs) => Promise<SideChatResult>
}
```

Re-exported through `@/runner` barrel. The port FILE imports zero
engine-internal types — only `Message`, `SideChatContextInheritance`,
`SideChatResult` from the orchestrate slice.

### CLI-side adapter (closure-captures the leak)

**File**: `src/apps/cli/repl/side-conv-wire.ts`

```ts
export const buildSideConversationPort = (
  args: BuildSideConversationPortArgs,
): SideConversationPort => ({
  start: async (req) => runSideChat({
    deps: args.deps,
    assembleConfig: args.assembleConfig,   // captured ONCE here
    prompt: req.question,
    mainHistory: req.messages,
    signal: req.signal,
    ...(req.inherit ? { contextInheritance: req.inherit } : {}),
    ...(req.tools !== undefined ? { toolAllowlist: req.tools } : {}),
    ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
  }),
})
```

`SessionDeps` and `assembleConfig` are SURFACED on
`BuildSideConversationPortArgs`, then immediately closed over. The
returned port carries no reference to them in its TYPE.

### Slash-surface contract (port-only)

**File**: `src/apps/cli/repl/slash-surface.ts`

- DELETE `import { assembleConfig, type SessionDeps } from "../internal"`.
- Replace `sessionDeps: SessionDeps` in `BuildReplSlashCtxArgs` with
  `sideConvPort: SideConversationPort` (imported from `@/runner`).
- The `side: () => SideCmdSlashState` factory builds its state from the
  injected port; no engine internals visible.

### `/side` slash command shape

**File**: `src/apps/cli/side-cmd.ts`

```ts
// REMOVED imports: OrchestrateDeps, RunOnceInput, runSideChat
import { type SideConversationPort, … } from "@/runner"

export interface SideCmdSlashState {
  readonly port: SideConversationPort
  readonly getHistory: () => readonly Message[]
  readonly defaultTools?: readonly string[]
  readonly defaultMaxTurns?: number
  readonly signal: AbortSignal
}

// run body:
const result = await state.port.start({
  question: parsed.prompt,
  messages: state.getHistory(),
  signal: state.signal,
  ...(parsed.inherit !== undefined ? { inherit: parsed.inherit } : {}),
  ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
  ...(state.defaultMaxTurns !== undefined ? { maxTurns: state.defaultMaxTurns } : {}),
})
```

### Surface composer (the ONE place `assembleConfig` is touched)

**File**: `src/apps/cli/repl/surface-compose.ts`

```ts
import { assembleConfig, env } from "../internal"
import { buildSideConversationPort } from "./side-conv-wire"

// inside composeSurfaceSlashCtx:
sideConvPort: buildSideConversationPort({
  deps: setup.sessionDeps,
  assembleConfig,
}),
```

This is the SOLE remaining reference to `assembleConfig` in the
slash-surface assembly path.

## Consequences

### Positive

- **Slice fence honoured**: `src/apps/cli/repl/slash-surface.ts` contains
  zero references to `assembleConfig` or `SessionDeps` (verified by
  source-grep hellgate). `src/apps/cli/side-cmd.ts` no longer imports
  `OrchestrateDeps` / `RunOnceInput`.
- **Web / Tauri reuse path**: a non-CLI surface needs only to provide a
  `SideConversationPort` impl; it is not forced to construct a CLI-
  specific `SessionDeps`.
- **Test ergonomics**: the `/side` unit tests inject a fake
  `SideConversationPort` directly (no need to stand up registries,
  streams, or an assembler) — see
  `tests/unit/apps/cli/side-conv-port-hellgate.test.ts` (15 cases).

### Negative

- One extra indirection: callers move from `runSideChat({...})` to
  `port.start({...})`. The adapter is 25 LOC; the contract is one
  function, so cognitive overhead is minimal.

### Frozen

`SideConversationPort` is FROZEN once shipped. Specifically:

- DO NOT add closure-captured fields (e.g. `readonly deps`) — that would
  re-introduce the leak via the port type.
- DO NOT widen `SideConversationStartArgs` with engine-internal types.
  All future additions must be plain-data (string / number / discriminated
  union / `Message[]` snapshot).
- The slash adapter is the ONLY caller of `port.start` in the CLI; if a
  second surface (web) ships a parallel adapter, it MUST use the same
  port shape (no parallel "v2" port).

## Verification

- `tests/unit/apps/cli/side-conv-port-hellgate.test.ts` (15 cases, 4
  source-grep + 11 behavioral) — pins both the slice fence AND the
  port-shape behavior.
- `tests/unit/cli/side-cmd.test.ts` — 24 cases; updated to inject the
  port directly; covers argv parsing, default-OFF wiring, footer
  rendering, error path, signal forwarding.
- `tests/unit/apps/cli/slashctx-ports-wire-hellgate.test.ts` — the
  `/side` port-wire section rewritten to verify dispatch ACTUALLY enters
  `state.port.start(...)` (regression-class catch — the prior shape
  could short-circuit silently).
