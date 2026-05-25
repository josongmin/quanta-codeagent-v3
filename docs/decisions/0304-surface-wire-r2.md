# ADR-0304 — Surface-Wire R2: identity onChange + granular registry + per-tool auto-record

* Status: Accepted (2026-05-26)
* Tier: 2
* Closes last-mile of: ADR-0300 (granular registry), ADR-0302 (identity prompt rebuild)
* Slice: `src/apps/cli/repl/surface-compose.ts` (composition root for the REPL surface)

## Context

Prior tracks landed the ADAPTERS / PORTS but the REPL surface composition hadn't wired them end-to-end:

* **ADR-0302 (Identity)** — built `SystemPromptRebuilderPort` + `SystemSource` closure-cell + extended `buildIdentityModeAdapter` with optional `onChange?(mode)` arg, but explicitly deferred the surface wire per slice-fence policy. Today `/identity set foo` swaps the active mode cell but the next turn still sees the stale system prompt captured at bootstrap.
* **ADR-0300 (GranularRegistry)** — built `defaultGranularRegistry()` + extended `createPerToolCheckpointAdapter({ registry? })`. Today `surface-compose.ts` doesn't instantiate any registry, so the new sibling adapter falls back to the `shadow-odb-not-configured` Err arm.
* **Per-tool auto-record cadence** (deferred from ADR-0300) — explicitly NOT in the agent loop / dispatch. Today snapshots are never recorded — the granular registry stays empty even when wired.

This ADR closes all three with caller-side wires in `composeSurfaceWires`.

## Decision

Three last-mile wires bundled in one slice because they all converge on `surface-compose.ts` (file-disjoint parallel impossible). All three default-OFF byte-identical (RFC §1.2): absent env knobs / absent identity adapter ⇒ behavior identical to the ADR-0300/0302 ship state.

### Wire 1 — Identity onChange → SystemPromptRebuilder → SystemSource

```ts
const systemSource = createSystemSource(setup.sessionDeps.system)
let identityAdapterRef: { readonly get: () => string } | undefined
const systemPromptRebuilder = identityModeVariantRaw !== undefined
  ? createSystemPromptRebuilder({
      mode: () => identityAdapterRef?.get() as ModeVariantKey | undefined,
      cwd: setup.cwd,
      baseBuilder: (mode) => buildSystemPromptForMode({ mode: mode ?? "default", registry }),
    })
  : undefined

const identityModeVariant = {
  ...identityModeVariantRaw,
  onChange: (mode: ModeVariantKey): void => {
    try {
      const fresh = systemPromptRebuilder.rebuild()
      systemSource.set(fresh)
      setup.sessionDeps.system = fresh   // mirror onto per-turn deps
    } catch (e) {
      logger.warn(`identity onChange rebuild failed (mode=${mode}): ${...}`)
    }
  },
}
```

Circular construction is broken with a mutable `identityAdapterRef` `let` — the rebuilder closes over `() => identityAdapterRef?.get()`, and `buildReplSlashCtx → maybeIdentity` constructs the adapter with `onChange` pointing at THIS rebuilder. The ref is assigned AFTER `buildReplSlashCtx` returns, completing the cycle.

`setup.sessionDeps.system` mutation is the per-turn refresh mechanism — `assembleConfig(messages, d)` reads `d.system` literally each turn, so a write between turns is the next turn's prompt.

### Wire 2 — `defaultGranularRegistry()` + adapter threading

```ts
const granularRegistry = defaultGranularRegistry()
const perToolSnapshotAdapter = createPerToolCheckpointAdapter({ registry: granularRegistry })
setup.sessionDeps.granularRegistry = granularRegistry
```

The registry is ALWAYS instantiated (pure in-memory, ~zero cost). The adapter's `restoreXxx` methods now return typed `not-found` Err (not the legacy `shadow-odb-not-configured` arm) for unseen toolCallIds. The slot on `AgentConfig.granularRegistry` is helper-only — the agent loop NEVER reads it; caller-side surface wires (per-tool snapshot recorder, future `/rewind-tool` revision) consume it directly. `assembleConfig` mirrors `SessionDeps.granularRegistry` → `AgentConfig.granularRegistry` via the existing presence-spread pattern.

### Wire 3 — Per-tool auto-record cadence (caller-side, no agent loop touch)

New file `src/apps/cli/repl/per-tool-snapshot-recorder.ts`:

```ts
export const createPerToolSnapshotRecorder = (opts): PerToolSnapshotRecorder => ({
  wrapTool(tool) {
    return {
      ...tool,
      execute(input, ctx) {
        return (async function* () {
          await captureSnapshot(tool.name, input)  // no-throw
          for await (const ev of tool.execute(input, ctx)) yield ev
        })()
      },
    }
  },
})
```

In `composeSurfaceWires`, env-gated:

```ts
if (envSource.QUANTA_PER_TOOL_RECORD === "on") {
  const recorder = createPerToolSnapshotRecorder({
    registry: granularRegistry,
    readFile: (path) => nodeReadFile(path, "utf8").catch(() => null),
    getCurrentMessages: () => state.history,
    getCurrentTurn: () => turnCounter++,
    extractPaths: defaultExtractPaths,  // path / file_path / paths / files
    logger: { warn: (m) => logger.warn(m) },
  })
  setup.sessionDeps.registry = wrapRegistry(setup.sessionDeps.registry, recorder)
}
```

The wrap is caller-side: the surface replaces `sessionDeps.registry` with a wrapped sibling BEFORE the agent loop consumes it. The loop / dispatch / individual tool factories are UNTOUCHED. The recorder mints a stable `toolCallId` per execute call (UUID by default), reads the configured paths into `filesBefore`, captures `taskMessagesBefore` from the surface transcript, and calls `registry.record(...)`. NO-THROW at every step — a misbehaving registry, missing file, or thrown extractor logs a `warn` and the tool execute proceeds unchanged.

## Default-OFF posture (RFC §1.2)

| Knob / state | Wire 1 | Wire 2 | Wire 3 |
|---|---|---|---|
| `QUANTA_IDENTITY_MODE` absent | adapter not built; `onChange` callback never wired; `systemPromptRebuilder` is `undefined` | — | — |
| `QUANTA_PER_TOOL_RECORD` ≠ `on` | — | — | recorder NOT instantiated; registry stays empty; `sessionDeps.registry` untouched |
| Identity registry omitted from `setup.sessionDeps` | onChange callback never wired (Wire 1 dormant) | granular registry STILL instantiated (Wire 2 active — no coupling) | — |

Each wire is independently gated; turning Wire 1 OFF does NOT disable Wire 2 (and vice versa).

## Test seal

`tests/unit/cli/surface-wire-r2-hellgate.test.ts` — 22 hellgate cases / 56 expects / 0 fail.

| Group | Cases |
|---|---|
| Wire 1 (identity onChange) | HELL-R2-01 .. HELL-R2-06 (6 cases) |
| Wire 2 (granular registry threading) | HELL-R2-07 .. HELL-R2-12 (6 cases) |
| Wire 3 (per-tool auto-record) | HELL-R2-13 .. HELL-R2-22 (10 cases) |

Covered adversarial paths: onChange-throws-swallowed, registry-record-throws-swallowed, extractPaths-throws-swallowed, readFile-returns-null-omits-path, tool-execute-throws-still-records-pre-state, over-cap-record-no-throw-execute-completes, two-consecutive-executes-distinct-ids, registry-shared-by-reference, default-OFF-slot-omitted.

## Negative invariants (do NOT do this)

1. NEVER record snapshots from inside `dispatch.ts` or `loop*.ts` — Wire 3 is CALLER-SIDE-ONLY. An observer on the dispatch tee would couple the granular-registry slice to the agent slice and break the slice fence.
2. NEVER make `sessionDeps.system` per-turn dynamic by changing its type to `() => string` — the existing `string` field + per-turn mutation is the byte-identical refresh path. Type churn would require every surface (Web/Tauri) to migrate.
3. NEVER fire `onChange` on rejected (unknown) modes — the adapter's `set("bogus")` returns the typed-error envelope and MUST leave the system prompt unchanged.
4. NEVER auto-detect tool path fields by tool name (`if (name === "write") ...`). The default extractor is shape-based (`path` / `file_path` / `paths` / `files`) so a new tool with one of these fields gets snapshotting automatically.
5. NEVER replace the registry in a way that changes the `ToolRegistry` class contract — the surface ALWAYS hands the agent loop an instance constructible by `new ToolRegistry(Tool[])`. Wire 3 enumerates via the public `specs()` + `get(name)` API.

## Plane-clean

* `surface-compose.ts` imports add: `node:fs/promises`, `@/agent/checkpoint/granular-registry`, `@/agent/system-prompt#buildSystemPromptForMode`, `@/tool#ToolRegistry`, `./per-tool-snapshot-recorder`, `./system-prompt-rebuilder`. NO new cross-slice deps.
* `per-tool-snapshot-recorder.ts` imports ONLY `@/agent/checkpoint/granular-registry` (port), `@/llm` (Message type), `@/tool` (Tool / ToolContext / ToolEvent types). NO `@/storage`, no `node:fs` (the reader port is injected).
* `runner/assemble/config.ts` adds `GranularRegistryPort` import and one optional field on `SessionDeps`. The existing presence-spread pattern handles default-OFF.

## Files

* `src/apps/cli/repl/surface-compose.ts` — wires 1/2/3
* `src/apps/cli/repl/per-tool-snapshot-recorder.ts` — NEW
* `src/apps/cli/repl/slash-surface.ts` — `identityModeVariant.onChange` plumbing
* `src/runner/assemble/config.ts` — `granularRegistry` slot on `SessionDeps` + 2A/2B helper split (complexity ceiling)
* `tests/unit/cli/surface-wire-r2-hellgate.test.ts` — 22 cases / 56 expects
