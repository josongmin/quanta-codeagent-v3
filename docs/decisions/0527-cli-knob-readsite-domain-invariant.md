# ADR-0527: CLI-knob read-site-domain invariant (a wrong-homed knob is invisible on the web/daemon /knobs surface)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - Companion to ADR-0503 (3-domain knob governance: `apps/cli/cli-knobs.ts` CLI-render registry, `@/config/knob-inventory.ts` daemon/agent inventory, `@/shared/runtime-config-knobs.ts` typed runtime-config fields). ADR-0503 P0 added the completeness ratchet (every read declared somewhere) and P3 added the disjoint ratchet (every knob in exactly one registry). This ADR closes the remaining hole: declaration-DOMAIN must match read-DOMAIN.
  - jun-08 long-tail ci-bot gates (`QUANTA_GH_CODE_TOUR` §5.4, `QUANTA_CI_FINDING` §7.3) — the two wrong-homed knobs this ADR re-homes.
- **참조**:
  - `src/apps/cli/cli-knobs.ts` — header contract: CLI-LOCAL registry, restricted to terminal-render knobs that touch NEITHER AgentConfig NOR daemon config. The two ci-bot gates are REMOVED here.
  - `src/config/knob-inventory.ts` — daemon/agent-side inventory; the two gates land in the `EXTRA` integration cluster (`group: "integration"`, `home: "runtime-config"`, `readSite: apps/agent/mode-presets/ci-bot.ts`).
  - `src/apps/agent/mode-presets/ci-bot.ts` — the ONLY real read-site (`gateOn(env, "QUANTA_GH_CODE_TOUR")` :216 / `gateOn(env, "QUANTA_CI_FINDING")` :218). ZERO reads under `src/apps/cli/`.
  - `src/apps/web-daemon/knob-catalog-wire.ts` — `buildWebKnobCatalog` composes `allInventoryKnobs()` + runner + runtime-config but sets `cli: []` (CLI-render knobs are a peer surface, un-importable, irrelevant to a web client). So a knob mis-declared in cli-knobs is INVISIBLE on the web/daemon `/knobs` surface.
  - Tests: `tests/unit/cli/cli-knob-readsite-domain-hellgate.test.ts` (this ADR's ratchet) — companion to `tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` and `tests/unit/cli/knob-registry-disjoint-hellgate.test.ts`.

## Context

`cli-knobs.ts` exists for one reason: CLI-terminal-render knobs (status pills,
flash timings, spinner, history …) fit neither the daemon VALUE registry
(`runtime-config`, consumed as `runtimeConfig().x`) nor the AgentConfig-mutating
registry (`@/runner/knobs`, `apply(cfg)`). Its header contract is explicit: a
knob here touches NEITHER AgentConfig NOR daemon config — it only shapes the
local terminal UI.

`QUANTA_GH_CODE_TOUR` and `QUANTA_CI_FINDING` violate that contract. They are
AGENT-behavior gates: each is read exactly once, via `gateOn(env, "…")` in
`src/apps/agent/mode-presets/ci-bot.ts`, to add a GitHub/CI tool to the ci-bot
agent's tool set. There is ZERO read of either under `src/apps/cli/`. They were
mis-filed into the CLI registry.

Two existing ratchets BOTH pass on this mistake:
- the **completeness** ratchet only asks "is every read declared *somewhere*?" —
  a wrong-homed knob is still declared, so green.
- the **disjoint** ratchet only asks "is each knob in *exactly one* registry?" —
  a single wrong-home declaration is still exactly one, so green.

Neither checks that the declaration DOMAIN equals the read DOMAIN. The concrete
harm: `buildWebKnobCatalog` deliberately excludes `cli-knobs.ts` (`cli: []`), so
these two agent-behavior gates never appear in the web/daemon `/knobs` surface —
an operator configuring a headless ci-bot over the web cannot see or set them.

## Decision

1. **Re-home** both gates from `CLI_KNOBS` → `KNOB_INVENTORY` (the daemon/agent
   inventory) as `kind:"bool", default:false, group:"integration",
   home:"runtime-config"`, with `readSite` pointing at the real ci-bot read-site.
   This makes them surface in the web `/knobs` catalog (inventory IS composed
   there) while staying default-OFF and behaviorally byte-identical (each is
   still read at the same `gateOn` call — declaration is metadata only).

2. **Control**: `QUANTA_GIT_CO_CHANGE` stays in `cli-knobs.ts` — it has a genuine
   CLI read-site (`src/apps/cli/internal.ts:655`, `readCliKnob(...)` in
   `gitCoChangeEnabled`), so the CLI registry is correct for it. (It is ALSO read
   agent-side in ci-bot, but a read-site IN the registry domain is all the
   invariant requires.)

3. **Ratchet** (the permanent guard): a static source-scan asserting EVERY
   `CLI_KNOBS` entry has ≥1 real read-site under `src/apps/cli/`
   (read-site-domain == registry-domain). It reuses the completeness ratchet's
   read-site detection (quoted / env-dot / destructure / gate-helper /
   const-keyed literal) EXTENDED with `readCliKnob(...)`, the CLI-local accessor.
   It goes RED if a knob is declared in cli-knobs but read only outside
   `src/apps/cli/` — exactly the class that escaped completeness + disjoint.
   Red-on-injection is documented in the test header (re-adding an agent-only
   knob trips it).

## Invariant

> A knob declared in `apps/cli/cli-knobs.ts` MUST be read at least once under
> `src/apps/cli/`. Declaration domain == read domain. A knob read only in
> `apps/agent/**` / `host/**` / `runner/**` / a daemon path belongs in
> `@/config/knob-inventory.ts` (or `@/shared/runtime-config-knobs.ts` if it
> deserves a typed field), so it remains visible on the web/daemon `/knobs`
> surface.

## Consequences

- The two ci-bot gates now surface in the web/daemon `/knobs` catalog.
- No behavior change: declaration is pure metadata; each gate is still read at its
  existing `gateOn` site, default-OFF.
- A future wrong-home (CLI registry, agent-only read) fails CI immediately,
  alongside the completeness + disjoint ratchets — the three together pin
  every-read-declared, exactly-one-registry, AND domain-matches.
