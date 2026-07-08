# ALBB-09 — Silent degradation emit parity (codex-r2, plugins, MCP, compaction events)

**Priority:** P1
**Wave:** B
**Depends on:** none (site #5 `classifySource` absorbed here — ALBB-01 deleted as not-real)
**Owner:** `src/agent/codex-r2-wire-install/install.ts`, `src/agent/loop-activation-hook.ts`, `src/agent/mcp-bridge.ts`, `src/agent/loop/compaction-wire.ts`

## Goal

Extend the landed FIX-5 emit-on-throw parity (`resolveContextEventsForTurn` /
`resolveMentionInjectionMessages` now `stream.emit({type:"error",...})` on throw)
to the remaining fail-soft seams so a FAILURE never degrades into a state
indistinguishable from "nothing to inject / no plugins / no servers / no
compaction event". Fail-closed observability is a structural invariant, not an
ad-hoc per-site patch: each site must surface an error event / counter / warn,
and STILL degrade clean (byte-identical success path, NO-THROW preserved).

## Problem

All five cited sites exist in current code and are reachable in production. The
defect class: a caught failure returns the empty / null "nothing to do" value
with either NO observability at all, or an observability signal that is
PREEMPTED by an inner swallow before the already-emitting outer wrapper can run.

**1. codex-r2 install closures preempt the outer FIX-5 emit.**
`src/agent/codex-r2-wire-install/install.ts:122-126` (contextEventsForTurn) and
`:160-164` (mentionInjector) each catch closure-entry throws with `logger.warn` +
`return []`:

```ts
// install.ts:122
} catch (e) {
  // closure-entry NO-THROW — log + swallow.
  logger.warn(`codex-r2-wire.contextEventsForTurn: ${errMessage(e)}`)
  return []
}
```

The outer FIX-5 wrapper `resolveContextEventsForTurn`
(`src/agent/loop/compaction-wire.ts:601-614`) DOES `config.stream.emit({type:"error",...})`
on throw — but it calls `config.contextEventsForTurn()`, which IS this install
closure. The inner catch returns `[]` normally, so the throw NEVER reaches
`:603` and the outer emit at `:609` is dead for the installed path. Same shape
for `resolveMentionInjectionMessages` (`src/agent/loop/context-assembler.ts:114-121`)
vs the install `mentionInjector` closure. Net: on the ACTUAL wired codex-r2
path the operator gets a `logger.warn` to the process log but NO `error`
AgentEvent on the session stream — a degraded `@file` expansion is invisible to
the surface/UI. (Note: `buildMentionInjector` already threads a per-mention
`onError` sink for individual `@file` failures via `buildInjectionFragments`;
the gap is the CLOSURE-ENTRY catch, which has no stream reach.)

**2. `emitCompactionEvent` has a bare, unlogged catch — diverges from its own siblings.**
`src/agent/loop/compaction-wire.ts:588-595`:

```ts
export const emitCompactionEvent = (config: AgentConfig, event: CompactionEventVariant): void => {
  if (config.compactionEventEmit === undefined) return
  try {
    config.compactionEventEmit(event)
  } catch {
    // Pure observability.
  }
}
```

A bare `} catch {}` with NO `logger.warn`. This diverges from the proactive
parity ref `src/agent/compaction.ts:695-697` (`logger.warn(\`compaction.postCompactEmit: ...\`)`)
and from the install-side sibling `buildCompactionEventEmit`
(`install.ts:176-179`, `logger.warn(\`codex-r2-wire.compactionEventEmit: ...\`)`).
It is also NOT covered by the `PINNED_LABELS` allowlist in the silent-catch
ratchet — it is one of the anonymous loop-surface bare-catches. `logger` and
`errMessage` are ALREADY imported in this file (`compaction-wire.ts:4`), so the
fix is byte-clean.

**3. Plugin parse failure returns EMPTY with NO counter — invisible in BOTH `calls` and `errors`.**
`src/agent/loop-activation-hook.ts:271-280`:

```ts
try {
  const mod = await import("@/agent/mention-injection")
  mentions = mod.parseMentions(latestUserText)
} catch {
  return EMPTY
}
```

This catch runs BEFORE the `codex_r2.activation.calls` counter at `:287`, so a
parse/import failure is counted in NEITHER `activation.calls` NOR
`activation.errors`, whereas the activator-throw catch at `:307-309` bumps
`codex_r2.activation.errors`. `ActivationHookConfigLike`
(`loop-activation-hook.ts:66-72`) has ONLY `activatePlugins` + `metricsEmitter`
— NO `stream` field. The intended observability seam here is the ADR-0360
metric side-channel, NOT a stream event.

**4. MCP configured-server load failure is warn-only — no stream event.**
`src/agent/mcp-bridge.ts:784-788` (supervised path) and `:832-836`
(single-client path) both:

```ts
} catch (e) {
  logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
  await client.stop().catch(() => undefined)
  return null
}
```

The server's tools silently vanish from the aggregate — the operator sees "no
tools from server X" identically whether X was un-configured or FAILED to start.
`LoadMcpToolsOpts` (`mcp-bridge.ts:684+`) has no error-sink field; wiring an
observable event needs a new optional opt threaded from the composition root.

**5. `classifySource` throw → silent `return null` (absorbed here; ALBB-01 deleted).**
`src/agent/dispatch/execute.ts:89-94` (path drifted from the ticket's
`loop/dispatch/execute.ts`):

```ts
try {
  cls = tool.classifySource(call.input)
} catch {
  // Tool-side bug must not break dispatch — treat as no source class.
  return null
}
```

A throwing `classifySource` silently drops redaction/sensitivity classification.
The catch is a deliberate fail-safe (a tool's classifier bug must not break
dispatch), so behavior stays — but the drop is currently invisible. Absorbed
into this ticket as an observability bump (ALBB-01, which formerly owned the
dispatch file, was deleted as not-real). See Required change #5.

## Required changes

Ordered trivial → real-plumbing. All are NO-THROW by design (turn outcome
unchanged); the ONLY observable delta is the error event / counter / warn.

1. **`emitCompactionEvent` (trivial, byte-clean now)** — add
   `logger.warn(\`compaction-wire.emitCompactionEvent: ${errMessage(e)}\`)` to
   the bound catch (`compaction-wire.ts:592`). Parity with
   `compaction.ts:697` and `install.ts:178`. Success path untouched ⇒
   byte-identical. Tightens the loop-surface bare-catch ratchet by 1 and should
   be added to the `PINNED_LABELS` allowlist.

2. **codex-r2 install closures (re-throw to the emitting outer wrapper)** —
   cleanest fix is to RE-THROW from the closure-entry catches at
   `install.ts:122` and `:160` (keep the `logger.warn`, then `throw e`), letting
   `resolveContextEventsForTurn` / `resolveMentionInjectionMessages` do the
   single `stream.emit({type:"error",...})` they already implement. Do NOT
   duplicate an emit-in-place (the closures hold no `stream`). This matches the
   Claude-Code / Codex baseline: a degraded context/@mention injection surfaces
   ONE non-fatal error event, and the turn still degrades clean (outer wrapper
   returns `[]`). Verify the wrappers are the ONLY call path before re-throwing
   (grep callers of `cfg.contextEventsForTurn` / `cfg.mentionInjector`); if any
   raw caller exists, keep the swallow and add an in-place emit via a threaded
   sink instead.

3. **Plugin parse catch (narrow counter fix — NO stream)** — in the
   `parseMentions` catch at `loop-activation-hook.ts:278`, bump
   `codex_r2.activation.errors` via the existing `safeEmit(emitter, ...)`
   (mirroring the activator-throw catch at `:308`). Do NOT add a `stream` field
   to `ActivationHookConfigLike` — the ADR-0360 metric side-channel is the
   intended seam. (Optional: bump `activation.calls` first so `error_rate =
   errors/calls` stays computable for parse failures too.)

4. **MCP load-error sink (real plumbing, measure-first for wiring)** — add an
   optional `onServerLoadError?: (info: { server: string; error: unknown }) => void`
   to `LoadMcpToolsOpts`, invoked in both catch sites (`:784`, `:832`) alongside
   the existing `logger.warn`. Wire it at the composition root to
   `session.stream.emit({type:"error", message:\`mcp server "${server}" failed to start: ...\`})`.
   Absent ⇒ byte-identical (warn-only, as today). A configured server that
   fails to start becomes an observable non-fatal warning on the surface.

5. **`classifySource` observability bump (trivial, behavior-preserving).** Keep
   the fail-safe `return null`, but make the swallowed classifier throw visible:
   add a once-per-tool `logger.warn` (label `dispatch.classifySource`) in the
   catch at `src/agent/dispatch/execute.ts:89-94`. Do NOT change dispatch
   behavior or fail closed — a tool-side classifier bug must not block the call.
   This closes the last silent-drop in the sweep now that ALBB-01 is gone.

## Acceptance

- Installed codex-r2 path: a throwing `contextEventsForTurn` / `mentionInjector`
  closure produces an `error` AgentEvent on `config.stream` (not only a process
  `logger.warn`), and the turn continues with `[]` context / no injected
  messages.
- `emitCompactionEvent`: a throwing `compactionEventEmit` produces a
  `logger.warn` with label `compaction-wire.emitCompactionEvent`; the turn is
  unaffected.
- Plugin activation: a throwing `parseMentions` bumps
  `codex_r2.activation.errors` (and `.calls`); the turn continues with `EMPTY`.
- MCP: a configured server whose `start()`/`listTools()` throws produces an
  observable warning event (when the sink is wired); the other servers still
  load; the failed server contributes no tools.
- All four: default/absent-sink config is byte-identical to today.

## Proof rails

Red-on-injection behavioral tests (inject a throwing provider/injector/store/
server; assert the error event / counter / warn FIRES **and** the turn still
degrades clean). Extend the existing landed patterns rather than re-founding:

```sh
# EXTEND: adds "memory recall / proactive compaction throw ⇒ error event"
# behavioral pattern — mirror it for the INSTALLED codex-r2 context-events +
# mention-injector closures (assert error event on stream, not just logger.warn).
bun test tests/integration/observability-error-event-e2e.test.ts

# EXTEND (test D covers activator-throw ⇒ errors+1): add a "parseMentions throw ⇒
# activation.errors += 1 (and calls += 1)" case — currently UNCOVERED.
bun test tests/unit/loop-activation-telemetry-hellgate.test.ts

# TIGHTEN: the silent-catch ratchet already pins install.ts warn labels + tracks
# loop-surface bare-catch counts. After fix #1, add
# "compaction-wire.emitCompactionEvent" to PINNED_LABELS and lower the loop
# baseline by 1 (proves the bare `} catch {}` was removed, not just relabeled).
bun test tests/unit/silent-catch-24h-ratchet.test.ts

# NEW: MCP configured-server-start-failure emits observable event when the
# onServerLoadError sink is wired; absent ⇒ byte-identical (warn-only).
#   tests/unit/agent/mcp-server-load-error-emit.test.ts   (new)
bun test tests/integration/mcp-bridge.test.ts
```

Each new/extended case is a mutation guard: reverting the fix (re-swallow /
drop-the-warn / drop-the-counter) must turn the assertion RED. No vacuous
compile asserts, no arbitrary thresholds — pure emit-parity invariant.
