# RFC-08 — UX polish/deferred: current-HEAD final scope

**Status:** FINAL PLAN — current `main@0a00ced392102073fe35eccd202bca92cabd71dc` audit complete; implementation not started.
**Decision:** exactly **1 in-repo BUILD**, **7 PARK**, and **8 DROP**. This RFC is not a general UX backlog.

## Final accounting

### BUILD 1 — effort-cycle key action (S)

The real gap is a bindable keyboard action that cycles the active model's supported reasoning-effort tiers. `/effort`, `EffortStore`, the five-tier vocabulary, per-model support metadata, model-switch clamp, status pill, and keybinding loader already exist.

### PARK 7 — no implementation in this repo now

| id | item | admission condition |
|---|---|---|
| P1 | hooks GUI authoring | an owning renderer and a consumer contract exist; engine and `/hooks` approval CLI remain unchanged |
| P2 | Cmd-K command palette renderer | owning web/Tauri repo requests a typed catalog contract; do not prebuild a WS data source |
| P3 | keyboard-shortcut editor renderer | owning renderer consumes `~/.quanta/keybindings.json`; validation remains in this repo |
| P4 | code-mode `excluded_tool_namespaces` | an efficacy/security experiment proves a narrow-only namespace policy is needed |
| P5 | code-mode `direct_only_tool_namespaces` | a concrete tool-routing consumer proves it cannot use the existing gated dispatch path |
| P6 | code-mode `yield_time_ms` line/output cadence | measurement shows solve-rate or latency improvement beyond the existing timeout/output/call caps |
| P7 | named multi-axis config profiles | repeated operator demand proves atomic model+permission+sandbox+effort switching is worth a new config projection |

P1–P3 are out-of-repo renderer work. P4–P7 are unproven convenience/transport deltas. None is an admitted ticket.

### DROP 8 — already built or non-absorbable

| id | item | current owner / reason |
|---|---|---|
| X1 | keybindings substrate | `src/apps/cli/keybindings/` already owns file load, normalization, closed actions, validation, and merge |
| X2 | Ultra reasoning tier | `ReasoningEffort:"max"` and `EffortLevel:"max"` already exist above `high` |
| X3 | code-mode per-cell cap/runaway bound | `memoryBytes`, `timeoutMs`, `maxCalls`, and `outputCap` are live and knob-wired |
| X4 | MCP protocol-version machinery/revision placeholder | `src/mcp/protocol-version.ts` owns supported versions and negotiation; future revisions are data/protocol updates, not this RFC |
| X5 | OS-keyring backend | `src/host/runtime/keyring/` already owns macOS Keychain, libsecret, null/fallback, and MCP-OAuth composition; provider-credential widening is separate security scope, not a PARK item here |
| X6 | `collaboration_mode` machinery | existing surface-profile axes plus the independent effort axis subsume behavior; the only unbuilt atomic-preset ergonomic is P7 |
| X7 | apps-MCP host widgets | ChatGPT-desktop-specific product host; quanta's protocol elicitation already exists |
| X8 | hooks engine/approval CLI/trust owner | command-hook engine and `/hooks` approval surface exist; trust work belongs to RFC-04 and its current owner |

## BUILD-1 final design — bindable `effort-cycle`

### Authority

- **State:** the existing session `EffortStore` (`src/agent/effort.ts`). `/effort`, the status pill, and the next turn's `AgentConfig.sessionEffort` already share this instance.
- **Model:** the existing slash model wire's `current()` and `effortSupport(model)` methods.
- **Vocabulary/order:** model metadata `supportedEfforts`, in ascending order `default → low → medium → high → max`.
- **Input binding:** the existing `~/.quanta/keybindings.json` loader and `KEY_ACTIONS` closed enum.

No `EffortCycleStore`, second effort cell, new config framework, or model metadata table is allowed.

### Changes

1. Add `"effort-cycle"` to `KEY_ACTIONS` in `src/apps/cli/keybindings/types.ts`.
2. Add a pure leaf function, e.g. `nextSupportedEffort(current, support)`, in `src/apps/cli/effort-cycle.ts`.
3. Add optional `onCycleEffort` through `raw-line-reader/options.ts` → prompt UX composition. In the keybinding dispatch branch, `action === "effort-cycle"` calls it directly and consumes the key.
4. Compose that callback from the existing slash `effort` and `model` wires: read current model/support, compute next, call the existing `effort.set(next)` so the canonical store and pill update together.
5. Do not add a default chord. The action is operator-bindable only. `DEFAULT_KEYBINDINGS` and `KEYBIND_TRUTH` stay unchanged because the latter explicitly lists fixed, actually installed chords; inventing a terminal chord would create collision/portability risk.

Example operator config after implementation:

```json
{
  "version": 1,
  "bindings": {
    "alt+shift+e": "effort-cycle"
  }
}
```

The example is not a default and is subject to the existing key normalizer.

### Cycle semantics

- Supported list `default,low,medium,high,max` wraps `max → default`.
- A non-reasoning model with `supportedEfforts:["default"]` is a fixpoint.
- If the current tier is not supported, begin from the model's existing `defaultEffort`, then advance on the next press; never emit an unsupported tier.
- Unknown model metadata follows the existing conservative model-picker posture: use the canonical five tiers, not a new guessed family classifier.
- A successful press changes state/pill only; it never submits the input line or changes the draft buffer.

### RED / DoD

- Bind a chord to `effort-cycle`; a real raw-line-reader press changes the same `EffortStore` read by `/effort` and the next assembled LLM request.
- `/effort high` followed by the chord produces `max`; another produces `default` on a five-tier model.
- On `gpt-4o` support, repeated presses remain `default`.
- Switch model through the existing `/model` adapter, then cycle; the callback must use the adapter's live `current()` shadow, not stale boot `setup.model`.
- The input buffer and submit count remain unchanged.
- With `QUANTA_KEYBINDINGS` absent, callback count is zero and reader output is byte-identical.
- With keybindings enabled but no chord mapped to `effort-cycle`, callback count is zero.
- Remove the `action === "effort-cycle"` live call and the configured-chord test must go RED; an enum-only test is vacuous.

### Owner files

- `src/apps/cli/keybindings/types.ts`
- new `src/apps/cli/effort-cycle.ts`
- `src/apps/cli/raw-line-reader/options.ts`
- `src/apps/cli/raw-line-reader/keymap.ts`
- `src/apps/cli/repl/prompt-pipeline.ts`
- `src/apps/cli/repl/surface-compose/prompt-ux.ts`
- `src/apps/cli/repl/session-loop-options.ts`

Tests stay in the existing keybinding/raw-line-reader/model-command hellgate families. Do not grow `registry-surface.ts` or add a parallel store.

## Structural action packet

### RFC08-1 — bindable effort-cycle action (P0, S, READY)

**Owner:** existing `EffortStore` state, slash model wire, and raw-line-reader key action dispatch.

**Dependency:** none on RFC-07. It may run concurrently with RFC07-3 or RFC07-1 because its write-set is disjoint.

**Write-set ceiling:** the seven owner files listed above plus focused tests; no provider adapter, `registry-surface.ts`, config loader, or agent loop edits.

#### Phase A — freeze contract RED

1. Add a pure cycle table fixture for:
   - five-tier wrap: `default→low→medium→high→max→default`;
   - sparse supported list order;
   - unsupported current tier → model `defaultEffort` recovery;
   - non-reasoning `default` fixpoint;
   - unknown metadata → canonical five-tier conservative list.
2. Add a raw-line-reader test with a configured chord mapped to `effort-cycle`; require one callback, zero submits, and byte-identical draft buffer.
3. Add the integration RED: `/effort high` → configured chord → `max` → next assembled request observes `max` from the same `EffortStore`.
4. Add a live-model RED: `/model` changes the adapter shadow, then the chord uses `model.current()`/`effortSupport()` rather than boot `setup.model`.

#### Phase B — implement the narrow path

1. Add `"effort-cycle"` to `KEY_ACTIONS`; do not add it to `DEFAULT_KEYBINDINGS`.
2. Implement only the pure `nextSupportedEffort` leaf. It owns no state.
3. Add optional `onCycleEffort` through reader options and prompt UX composition.
4. In the keybinding remap branch, call `onCycleEffort` directly for the configured action, consume the key, and redraw only the effort pill/meta surface required by the existing setter.
5. Compose the callback from the existing slash `effort.get/set` and `model.current/effortSupport` wires. Do not close over `setup.model`.
6. Leave `KEYBIND_TRUTH` unchanged until a fixed default chord actually exists.

#### Phase C — close proof

```sh
bun test src/apps/cli/__tests__/effort-cycle.hellgate.test.ts src/apps/cli/__tests__/keybindings.hellgate.test.ts src/apps/cli/__tests__/model-picker.hellgate.test.ts src/apps/cli/__tests__/model-cmd-e2e.hellgate.test.ts src/apps/cli/__tests__/raw-line-reader-keymap-golden.hellgate.test.ts
bun test tests/integration/effort-cycle-session-live-e2e.test.ts
bun run typecheck
bun test tests/unit/god-code-ratchet.test.ts
```

Required receipts:

- configured chord: callback `1`, submit `0`, buffer unchanged;
- unconfigured action and `QUANTA_KEYBINDINGS` OFF: callback `0`;
- `/effort`/hotkey/next LLM request agree on one store;
- live model switch clamps/cycles only within its supported tiers;
- `git diff --check` over the exact write-set.

**Completion condition:** all REDs flip GREEN through the live handler and same-store product path. An enum entry, pure helper, or unit test alone is not completion.

**Stop:** a second store/model table, default chord, direct provider mutation, new env/config system, or `registry-surface.ts` growth becomes necessary.

## Stop rules

- If BUILD-1 needs a new store, config loader, model registry, default chord, or direct LLM mutation, stop; the design has crossed an existing owner.
- Do not implement any PARK item without its stated consumer/measurement admission.
- Do not reopen a DROP because a competitor uses a different label.
- Renderer work must be tracked in its owning repo, not as a backend placeholder here.
- An enum member without a reachable key handler is not completion.

## Execution and proof state

BUILD-1 is independent and S-sized. It may land with any keybinding-adjacent batch, but it is not on a critical path. Completion requires the configured-chord product path, canonical-store agreement, live-model support clamp, and gate-OFF receipt on one revision. A document update, local unit GREEN, commit, and publication are separate states.
