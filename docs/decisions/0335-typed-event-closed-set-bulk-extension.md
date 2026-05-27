# ADR-0335 — Typed-event closed-set bulk extension (`plugin_activation` + `app_activation`)

Status: accepted
Date: 2026-05-27

> **Numbering note.** Drafted as `0335`; no collision found
> (`0334` is free, `0333-image-retry-production-hookup.md` is the
> latest occupant). User-deference renumber policy
> (`memory/adr-collision-policy-2026-05-25.md`) is in force for any
> future race.

## Context

ADR-0320 introduced `src/memory/typed-event/` with a 5-variant closed
union; ADR-0324 extended it 5 → 6 by adding `compaction_event`. This
ADR closes the **Codex r2 absorption residual wire** by extending the
closed set 6 → 8 in a single atomic schema change.

Two activation surfaces in the Codex r2 wire layer (memory
`codex-r2-wire`, `codex-plugin-manifest-pattern`, `surface-model`)
have no narrative anchor in the typed-event stream today, so the
follow-up turn cannot read "this plugin became active" / "this app
mention resolved" without re-parsing the flat message body:

1. **Plugin activation** — Codex `.codex-plugin/plugin.json` discovery
   + enable flow. A plugin manifest carries a **tool manifest +
   scoped capability set** (`Interactive | Read | Write`, closed
   enum). This is distinct from `skill_activation`, which only
   carries `description + body` — plugins also gate **effects**, so
   the model needs to see the capability surface as a typed signal.
2. **App activation** — Codex `@@app-name` mention resolution. In
   quanta's surface model (`memory/surface-model`) an "app" maps to a
   surface: CLI process, Tauri shell + Web UI, or CLI-embedded
   browser (subagent / embedded WebView). The model needs to see
   *which environment is now active* as a typed signal so it can
   reason about which tools are available.

Both surfaces are already producer-emitted in the Codex r2 wire
install layer (`src/agent/codex-r2-wire-install/`) but the producers
have no closed-set variant to emit into. ADR-0335 closes that gap.

## Decision

Extend the ADR-0320 closed-set `TypedHistoryEvent` union 6 → 8 by
adding two new variants in a single atomic step:

```ts
export type PluginActivationTrigger = "user" | "auto" | "system"
export type PluginCapability = "Interactive" | "Read" | "Write"

export interface PluginActivationEvent {
  readonly kind: "plugin_activation"
  readonly pluginId: string
  readonly trigger: PluginActivationTrigger
  readonly capabilities: readonly PluginCapability[]
  readonly at: number
  readonly turnId?: string
}

export type AppActivationSurface = "cli" | "web-tauri" | "cli-browser"
export type AppActivationTrigger = "user" | "auto" | "system"

export interface AppActivationEvent {
  readonly kind: "app_activation"
  readonly appId: string
  readonly surface: AppActivationSurface
  readonly trigger: AppActivationTrigger
  readonly at: number
  readonly turnId?: string
}
```

### Schema rationale

- **`plugin_activation` vs `skill_activation`** — plugins differ from
  skills along the **capability axis**: a skill is a
  description+body bundle, whereas a plugin carries a tool manifest
  + scoped capabilities (`Interactive | Read | Write`). The two
  variants stay separate so the consumer can render the capability
  set distinctly and the model can reason about it without
  re-parsing the manifest. `capabilities` is `readonly` and can be
  empty — a 0-capability discovery still emits (the model sees the
  attempt). The store does not de-dup the array; producers are
  responsible for sane payloads, consistent with ADR-0320 §port-contract.
- **`app_activation` vs `mode_change`** — both signal an environment
  flip, but `surface` is a **closed 3-set** mapped to the quanta
  surface model (CLI / Web-Tauri / CLI-browser per
  `memory/surface-model`); `mode_change` is free-form string. The
  closed set means a downstream prompt builder can render
  surface-specific guidance without string parsing.
- **Shared `trigger` enum vocab** (`"user" | "auto" | "system"`) —
  reuses the {@link SkillActivationTrigger} shape so producers can
  thread the same source through multiple variants. New aliases
  (`PluginActivationTrigger`, `AppActivationTrigger`) are introduced
  for variant-local clarity rather than re-using the original alias,
  so future divergence is type-safe.

### ADR-0324 `CompactionEventReason` status (audit finding)

The task brief asked whether ADR-0324's `CompactionEventReason`
already covers `token_budget` + `manual`. **Audit result: YES — all
3 reasons already exist** in the schema today
(`types.ts:99`):

```ts
export type CompactionEventReason = "context_limit" | "token_budget" | "manual"
```

ADR-0324 already shipped the closed reason set verbatim. ADR-0335 is
therefore **schema-only for the new variants**; no `reason` axis
change is needed. The producer-policy expectations the brief calls
out (token-budget breaker triggers reactive compact; `/compact`
slash drives `manual`) are recorded here as the *producer-emit
contract* without altering the schema:

| reason          | expected producer trigger                                      |
|-----------------|----------------------------------------------------------------|
| `context_limit` | provider context ceiling reached (pre-sampling / mid-turn).    |
| `token_budget`  | token-budget breaker fires reactive compact before ceiling.    |
| `manual`        | user `/compact` slash, orchestrator-driven, or API trigger.    |

A new test (`compaction_event reason set: producer can emit all 3
reasons end-to-end`) pins each reason round-trips through the store
unmodified. No schema change.

### Closed-set extension (not supersession)

This ADR **extends** ADR-0320; it does **not** supersede ADR-0320 or
ADR-0324. The 6 prior variants keep their field names, shapes, and
JSDoc verbatim. The `TypedHistoryEvent` union grows 6 → 8; the
`TypedHistoryEventKind` literal union gains `"plugin_activation"`
and `"app_activation"`. The port surface (`append / snapshot /
since / clear`) is unchanged.

The extension log in ADR-0320 §`Closed-set extension log` records
this transition.

### Files touched (slice-fence)

In-slice (ADR-0320 fence, `src/memory/typed-event/`):

- `types.ts` — add `PluginActivationTrigger`, `PluginCapability`,
  `PluginActivationEvent`, `AppActivationSurface`,
  `AppActivationTrigger`, `AppActivationEvent`; widen
  `TypedHistoryEvent` union 6 → 8.
- `index.ts` — re-export the 6 new type aliases.
- `__tests__/port-contract.test.ts` — extend
  `Equals<TypedHistoryEventKind, ...>` from 6 to 8 literals; widen
  the exhaustiveness switch.
- `__tests__/in-memory-store.hellgate.test.ts` — extend the
  6-variant round-trip case to 8; add 9 new hellgate tests:
   - plugin_activation: 3 triggers × multi-capability round-trip
   - plugin_activation: empty capabilities array accepted
   - plugin_activation: empty pluginId accepted (producer-side)
   - plugin_activation: `turnId` optional
   - app_activation: 3 surfaces × 3 triggers (9 combos)
   - app_activation: empty appId accepted (producer-side)
   - app_activation: `turnId` optional
   - 8-variant union exhaustiveness (compile + runtime)
   - compaction_event 3-reason producer-emit (ADR-0324 reason set
     confirmation)

Exhaustive-switch consumers updated (one location identified by grep
over `case "compaction_event"` / `event.kind`):

- `src/agent/context-change/inject.ts` — add `<plugin-activation>`
  and `<app-activation>` envelope arms mirroring the ADR-0324
  pattern. Tag names follow the dash-separated kebab convention
  already in use (`<context-update>`, `<mode-change>`, etc.).

ADRs:

- `docs/decisions/0320-typed-history-event-store.md` — add 2 rows
  to the variants table; extend the closed-set extension log with
  a single 6 → 8 transition row referencing this ADR.
- `docs/decisions/0335-typed-event-closed-set-bulk-extension.md` —
  this file.

## Non-goals

- **9th variant in this ADR.** The union widens to exactly 8. A 9th
  variant requires a separate ADR.
- **Plugin manifest resolver impl.** Default-OFF: no production
  code path emits `plugin_activation`. The resolver that discovers
  `.codex-plugin/plugin.json`, parses the manifest, validates the
  capability set, and pushes the event onto a
  `TypedHistoryEventStore` is **ADR-0336** (resolver impl).
- **App catalog.** Default-OFF: no production code path emits
  `app_activation` either. The app-mention resolver (parses
  `@@app-name`, maps to a surface, pushes the event) is part of
  **ADR-0336** alongside the plugin resolver.
- **Capability gating / permission integration.** The
  `capabilities` field is **descriptive only** — recording what the
  manifest declared. Whether the runtime *enforces* the declared
  capability set is the permission slice's responsibility (out of
  scope here).
- **`CompactionEventReason` schema change.** Audit confirmed
  ADR-0324 already carries the 3-reason set
  (`context_limit | token_budget | manual`). No schema change in
  this ADR for the reason axis — producer-emit policy only.

## Wiring

- **This ADR (schema-only):** 2 new variants in the closed union;
  default-OFF; no consumer; no producer.
- **ADR-0336 (resolver impl, future):** `.codex-plugin/plugin.json`
  discovery + manifest parser + capability validator that emits
  `plugin_activation`; `@@app-name` resolver that emits
  `app_activation`. Both go through `src/agent/codex-r2-wire-install/`
  composition root.
- **ADR-0321 (consumer, existing):** the prompt-body inject seam
  reads `since(t)`; the inject builder (`inject.ts`) already
  handles the 2 new variants per this ADR's in-slice patch.

## Slice fence

Same as ADR-0320: `src/memory/**` may not import `@/tool`,
`@/stream`, `@/permission`, `@/lsp`, `@/observability`, `@/llm`,
`@/security`, `@/patch`, `@/rules`, `@/mcp` (RFC §3.1, ADR-0001).
This extension adds only literal-typed fields and `readonly` arrays
of `string` literal unions — no new dependencies.

The single out-of-slice patch (`src/agent/context-change/inject.ts`)
is the exhaustive-switch consumer and is in scope under
"closed-set extension requires updating every exhaustive switch on
the union" — already the established ADR-0324 pattern.
