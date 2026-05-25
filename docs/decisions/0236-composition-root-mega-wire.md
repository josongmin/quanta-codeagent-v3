# ADR-0236 — Composition-root mega-wire (11 subsystems, default-OFF)

Status: Accepted (2026-05-25)
Renumbered from 0229 (taken by `dispatch-guard-wiring.md`) → 0232 (taken
by W3-2 `shell-snapshot` slot) → 0233 (taken by W3-5 vendor-detector
`Wire 2`) → 0234 (taken by W3-3 git-directive turn-collector) → 0236
(next free, 0235 is W3-2 `shell-snapshot-runshell-wire.md`). Per the
`adr-collision-policy-2026-05-25` memory entry, our slice renumbers to
the next-free integer each time a sibling track lands first.

## Context

Eleven SOTA++ slices shipped between ADR-0203 and ADR-0226 added closed
ports + default-impls behind the agent loop. None of them were yet exposed
on `AgentConfig`, on the unified-agent CLI, or as slash commands. The
remaining gap was the **composition root** — the single seam where a
host (CLI / Tauri / bench / ci-bot) actually constructs the wiring and
hands it to `runAgent`.

Without this wire each slice was unreachable from a production surface
(only its unit/hellgate tests exercised it).

The 11 in scope:

| # | Slice              | Existing artifact                                  |
|---|--------------------|-----------------------------------------------------|
| 1 | Mode-typed delegation         | ADR-0218 `subagent-typed`              |
| 2 | Focus Chain auto-reinject     | ADR-0219 `focus-chain`                 |
| 3 | Rich fork-session port        | ADR-0226 `fork-session.ForkSessionPort`|
| 4 | Text inbox                    | ADR-0224 `apps/cli/text-inbox`         |
| 5 | Plan edit ($EDITOR)           | ADR-0225 `apps/cli/edit-plan-cmd`      |
| 6 | Composer edit ($EDITOR)       | ADR-0225 `apps/cli/edit-message-cmd`   |
| 7 | Sticky model per mode         | ADR-0212 `sticky-model`                |
| 8 | Tool profile presets          | ADR-0213 `tool-profile`                |
| 9 | Identity mode variant prompt  | ADR-0211 `system-prompt`               |
|10 | Playbook trigger watcher      | ADR-0203 `skill/playbook`              |
|11 | RRULE automation engine       | ADR-0215 `scheduler/automation-engine` |

(The `autoBackground` slot from ADR-0223 was already wired; left
untouched.)

## Decision

**One composition-root slot per slice, every slot default-OFF.** Absent
slot ⇒ byte-identical loop behaviour. The wire is:

1. **AgentConfig slots** — 11 new optional fields on `AgentConfig`
   (`src/agent/types.ts`), each importing the slice's port via a typed
   `import("…").Port` lazy reference so no slice-cycle pulls in another
   subsystem's runtime cost at the agent boundary.

2. **Loop integration** — only the `focusChain` slot has agent-loop
   semantics: the per-turn `tickTurn()` + `getInjection()` runs at the
   top of every turn (after `steerBarrier` / `pollConversationAction`,
   before the LLM snapshot) and any non-null injection is appended as a
   user message. All other slots are **caller-side** — the surface
   composes them through their own seams (slash commands, host UI,
   future tool-side consumers). The 10 caller-side slots cost zero
   wall-clock when absent.

3. **CLI flags** — five new flags on `apps/agent/cli-args.ts`:
   `--tool-profile <p>`, `--sticky-model`, `--identity-mode <m>`,
   `--focus-chain-every <N>`, `--no-auto-background`. Each routes
   through `parseAgentArgs` → `toAssembleRequest` →
   `buildBaseFromArgs`, which constructs the matching default-impl and
   spreads the slot into `AssembleRequest.base`. Absent flag ⇒ slot
   omitted (`exactOptionalPropertyTypes` clean).

4. **Slash commands** — three new commands appended to BUILTINS:
   `/profile`, `/identity`, `/focus-chain`. Each defines a typed seat
   on `SlashContext` (`profile?`, `identity?`, `focusChain?`); the
   command reads/writes via that seat. Absent seat ⇒ "not wired in
   this surface" + exit 0 (parity with every other
   surface-optional builtin).

5. **Identity-mode prompt build** — when `--identity-mode <m>` is set,
   the composition root builds the system prompt via
   `buildSystemPromptForMode({ mode, registry })` (ADR-0211) and
   publishes the registry on `AgentConfig.identityModeVariant.registry`
   so future surfaces (e.g. mid-session `/identity` swap) can rebuild
   from the same registry without re-deriving it.

6. **playbookTrigger / automationEngine** — slot-only (no
   composition-root default-impl wired today). Hosts that want the
   watcher running bind it themselves at session start and stop it at
   session end. The slot exists so the binding lives somewhere typed.

## Rationale

- **Default-OFF discipline** (RFC §1.2): byte-identical loop for every
  caller that does not opt in. The composition root is additive; no
  slice's default behaviour changes.
- **No-throw composition**: every wire seam (`resolveStickyModelStore`,
  `resolveToolProfile`, `resolveFocusChain`, `resolveIdentitySystemPrompt`)
  catches construction failures and either degrades (sticky-model →
  in-memory fallback) or surfaces a stream `error` AgentEvent (loop
  focus-chain inject defense). A surface bug must not crash the agent.
- **Closed enums at the CLI boundary**: every value flag
  (`--tool-profile`, `--identity-mode`) validates against the closed
  set with a clear error message — typos surface at parse time, not at
  runtime.
- **Loop-only invariant**: `focusChain` is the SOLE slot the loop
  actively drains. Every other slot is read by a slash, a tool, or a
  surface adapter. This keeps the loop body's cognitive complexity
  budget intact.
- **Single source of truth for caller-side defaults**: the helpers
  (`resolve*`) live next to `buildBaseFromArgs` in the unified-agent
  surface — every mode-preset inherits the wire via `req.base`.

## Negative invariants (do NOT do)

- Do NOT eagerly construct slice default-impls when the operator did
  not opt in (e.g. do NOT mint a `defaultFocusChainTracker` when
  `--focus-chain-every` is absent). The slot stays omitted; consumers
  see `undefined`.
- Do NOT wire `delegation`, `forkSession`, `textInbox`, `planEdit`,
  `composerEdit`, `playbookTrigger`, or `automationEngine` from the
  loop. The loop never reads these. Surface-side consumers
  (`Agent` tool, future `/delegate` slash, REPL surface, host UI)
  opt in.
- Do NOT default-wire `playbookTrigger` to `fs.watch` automatically.
  The watcher spawns a node handle + retains a fs descriptor — that
  is a host policy, not an agent default.
- Do NOT silently accept `--focus-chain-every 0`. Zero would wire a
  no-op tracker (the tracker treats `<= 0` as "disable"). Reject it as
  a parser-level error; the operator should simply omit the flag.

## Consequences

- 11 new optional fields on `AgentConfig` (no breaking change — every
  field is optional and absent slots leave the loop byte-identical).
- 5 new CLI flags (composable; each independent default-OFF).
- 3 new slash commands (`/profile`, `/identity`, `/focus-chain`),
  appended to BUILTINS at the END so the existing slot pinning tests
  (`tests/unit/slash-commands.test.ts`) and parallel W3-* tracks do
  not collide.
- Tests: `tests/integration/composition-root-wire-hellgate.test.ts`
  (21 cases) pins slot omission, CLI flag parse, slash routing, and
  focus-chain cadence/empty-todo behaviour. tsc 0; biome 0 on the
  new wire bodies.

## Migration

- New code: opt in by setting the matching `AgentConfig` slot OR by
  passing the matching CLI flag to `apps/agent`.
- Existing code: unchanged. Absent slot ⇒ legacy behaviour. The
  per-mode presets (`apps/agent/mode-presets/*.ts`) inherit the new
  slots through `req.base` automatically — no edits required.
