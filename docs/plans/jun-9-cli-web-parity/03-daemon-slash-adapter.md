# Ticket 03 — daemon `host.dispatchThinClient`: resolve the route, then plan/exec

> **REVISED (jun-09 audit)**: was "host.runLocalSlash → capture terminal text". Now: implement `host.dispatchThinClient` which **resolves the ADR-0493 route** for the command, then dispatches to the typed `control-request` planner (structured), the hoisted slash (`local`), or post-text. The `SlashContext`-capture below applies **only to the `local` route**.

**Phase**: 0 · **Depends**: 01, 02 · **Parallel with**: 04 · **Risk**: medium

## Goal
Implement `SessionHost.dispatchThinClient` on the runtime host:
```ts
dispatchThinClient: async ({ name, args, request }, surface = "web") => {
  // 1. typed path: a control.request carries a ControlRequest directly
  if (request !== undefined) {
    return { effect: planControlRequest(request, ctxSnapshot()) }   // ADR-0496, pure
  }
  // 2. named command: resolve its route from the tagged descriptor
  const descriptor = REGISTRY_DESCRIPTOR(name)        // { name, thinClientDispatch }
  const route = resolveThinClientRoute({ surface, descriptor, env: process.env })  // ADR-0493
  switch (route) {
    case "control-request": return { effect: planControlRequest(toControlRequest(name, args), ctxSnapshot()) }
    case "post-text":       return { posted: true /* host posts text into the stream */ }
    case "local":           return { output: runLocalSlash(name, args), isError: … }   // SlashContext capture, below
  }
}
```
`resolveThinClientRoute` + `planControlRequest` are **imported as-is** (pure, exist). Only `runLocalSlash` + the ctx snapshot are new.

## Where
The runtime host lives in [src/host/runtime/internal/context-binding.ts](../../../src/host/runtime/internal/context-binding.ts) (`createRuntimeSessionHost` ~[:1245](../../../src/host/runtime/internal/context-binding.ts#L1245); the SessionHost methods `runTurn` / `resolveApproval` / `setIdentityMode` / `setToolProfile` are returned from there — e.g. `resolveApproval` at [:1321](../../../src/host/runtime/internal/context-binding.ts#L1321)). Add `dispatchThinClient` (and its `local`-route helper `runLocalSlash`) alongside.

## Build the `SlashContext` (the crux)
```ts
runLocalSlash: async ({ name, args }) => {
  let buf = ""
  const ctx: SlashContext = {
    out: (s) => { buf += s },          // capture sink (CLI binds process.stdout; we buffer)
    err: (s) => { buf += s },
    cwd: <session cwd>,
    // bind the slots the host can already answer from live runtime state:
    workingState: () => <host working state>,   // host already carries this — context-binding.ts:107,603
    skillScope:   () => <host skill-scope view>, // added in ADR-0512 P3 (buildSkillScopeView)
    planSnapshot: () => <host plan snapshot>,
    // …slots the host can't answer yet ⇒ leave undefined ⇒ handler prints
    //   "not wired in this surface" (the CLI's own graceful fallback).
  }
  const r = await dispatchSlash(REGISTRY, name, args ?? [], ctx)   // @/runner/slash/dispatch
  return { output: stripAnsi(buf), isError: r === false /* or handler exit≠0 */ }
}
```

## Slot binding inventory (what the daemon host can answer today)
| Slot | Available now? | Source |
|---|---|---|
| `workingState` | ✅ | host base carries it — [context-binding.ts:107](../../../src/host/runtime/internal/context-binding.ts#L107), [:603](../../../src/host/runtime/internal/context-binding.ts#L603) |
| `skillScope` | ✅ | `buildSkillScopeView` wired in ADR-0512 P3 (`/state` skill-scope) |
| `planSnapshot` | ⚠️ check | plan store is in the runtime; expose a read accessor if absent |
| `contextUsage` | ⚠️ check | the canvas usage source already computes segmented usage ([apps/web-daemon/canvas-usage-source.ts](../../../src/apps/web-daemon/canvas-usage-source.ts)) — reuse its computation |
| `cost` | ⚠️ | token meter exists; bind a `() => string` renderer |
| `branchSearch` | ❌ likely | branch-search state not exposed on the host — Phase-1 "needs-slot" |
| `agents` (fleet) | ❌ likely | TaskRegistry exists in the runtime; expose a read accessor |
| `skills` | ⚠️ | skills registry is built at boot; expose `() => Promise<SkillRow[]>` |
| `profile` / `identity` (read) | ✅ get / Phase-2 set | host has `setIdentityMode`/`setToolProfile`; add getters |

> A slot left `undefined` is **not a bug** — the handler renders the CLI's own "not wired in this surface" line (e.g. [registry-surface.ts stateCmd:396-399](../../../src/apps/cli/slash/registry-surface.ts#L396)). Ticket 05 turns the ⚠️/❌ rows green incrementally.

## ANSI handling
The CLI handlers emit ANSI color (`cyan`/`dim`/`green` from `@/ui`). Strip on the daemon (`stripAnsi`) so the web gets clean text; Phase 3 may instead pass a structured payload. Keep a single `stripAnsi` helper (one exists in the codebase — reuse, don't reinvent).

## Definition of Done (TDD)
- A host-level test: `runLocalSlash({name:"state"})` against a stub runtime with a `workingState` slot returns the rendered working-state panel text (capture buffer non-empty, `isError:false`); with the slot absent returns the "not wired" line, still `isError:false`.
- **Red-on-injection**: a handler that touches `process.stdout` directly would make the capture empty — a test asserts the captured buffer equals the rendered panel (proves no terminal leak; catches a non-hoisted handler from ticket 01).
- No `@/host` → `apps/cli` import (fence clean — only `@/runner/slash`).
- Gate-off path: `runLocalSlash` absent/short-circuits.

## Risks
- The shared file `context-binding.ts` is also where ADR-0512 P3 + the concurrent ADR-0529 host work live. Additive method ⇒ low collision, but rebase-check before landing.
- Some slots (agents/branchSearch) require new host read-accessors that the concurrent assembler rewrite might also touch — coordinate.
