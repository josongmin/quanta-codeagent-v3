# ADR-0330 — Mention runner: skill resolver impl + injector composition

- Status: Accepted (slice landed, default-OFF; AgentConfig wire-up
  deferred to ADR-0327)
- Date: 2026-05-27
- Related: ADR-0325 (mention-injection slice — this ADR ships the
  resolver impl + production composition for it), ADR-0134 (`@/skill`
  registry — read-only adapter consumes `SkillRegistry.lookup`),
  ADR-0327 (AgentConfig `mentionInjector` slot — reserved; this ADR
  produces the function value that slot is meant to hold).

## Context

ADR-0325 landed the mention-injection slice at
`src/agent/mention-injection/` with four pure layers:

1. `parseMentions` — pure parser, three sigil alternatives.
2. `MentionResolverPort` — closed 3-method port (skill / plugin / app).
3. `buildInjectionFragments` — port consumer.
4. `buildMentionInjectionMessages` — `<mention>` envelope builder.

What is MISSING is the **production wire**: a real
`MentionResolverPort` implementation and a composition function that
takes the four layers + a real skill registry and returns the function
value that `AgentConfig.mentionInjector` (slot reserved in ADR-0327)
is expected to hold. Today the slice is dead code — discoverable, but
nothing builds the function it produces.

Closing that gap is this ADR's scope. Plugin and app resolver impls
are deliberately deferred to future ADRs (see Non-goals).

## Decision

Land two new artifacts:

### 1. `src/skill/registry-readonly.ts` (additive — `@/skill` body unchanged)

A read-only descriptor view over `SkillRegistry`. ONE method:

```ts
interface SkillRegistryReadOnly {
  lookup(name: string): { name: string; description: string } | null
}
```

Built via `createReadOnlySkillRegistry(registry: Pick<SkillRegistry, "lookup">)`.
NO-THROW: hostile / partial / malformed registry entries are converted
to `null` by `sanitize()` + try/catch. Empty / undefined name input ⇒
`null` (no call-through).

Also exports `emptyReadOnlySkillRegistry` — an always-null default
for headless / test contexts.

This file lives in `@/skill` so it picks up the slice's existing
fences (zero cross-slice imports — only `./registry`). The full
`SkillRegistry` interface (`entries` / `bySope` / `collisions`) stays
inside the slice and is not consumed by `@/agent` via the mention
pipeline. `@/agent/mention-runner` imports `SkillRegistryReadOnly`
but the type is also re-declared structurally on the runner side so
test fakes don't have to reach into `@/skill`.

### 2. `src/agent/mention-runner/` (new slice)

Four files:

- `types.ts` — `SkillRegistryReadOnly` (structural mirror of
  `@/skill/registry-readonly`'s port) + `MentionRunnerConfig`.
- `skill-resolver.ts` — `createSkillOnlyResolver(skills?)` builds a
  `MentionResolverPort` where:
  - `resolveSkill(target)` consults `skills.lookup(target)`. Hit ⇒
    `{ bodyText: firstLineOf(description) }`. Miss / NO-THROW ⇒ `null`.
  - `resolvePlugin(target)` ALWAYS returns `null` (frozen).
  - `resolveApp(target)` ALWAYS returns `null` (frozen).
- `runner.ts` — `createMentionInjector(cfg)` returns the
  `(userInputText: string) => readonly Message[]` function. Pipes:
  `parseMentions → buildInjectionFragments(resolver) →
   buildMentionInjectionMessages`. NO-THROW at the pipeline boundary.
- `index.ts` — barrel.

### Progressive disclosure policy

The skill resolver projects ONLY the first line of `Skill.description`
into `InjectionFragment.bodyText`. The SKILL.md body is NOT loaded by
mention. Rationale: a `@code-review` mention should surface the
user-facing tagline; deeper instructions belong on actual skill
invocation (via the `Skill` tool, ADR-0134). First-line extraction
matches `src/skill/tool-search.ts`'s `splitDescription` policy.

## Non-goals (negative invariants — frozen by ADR-0330)

- **No plugin resolver impl.** `resolvePlugin` returns `null` for every
  target. Implementing it requires absorbing Codex's
  `.codex-plugin/plugin.json` manifest format (or designing quanta's
  equivalent) + a plugin discovery surface — that is a separate ADR.
  No `plugin://` mention will produce a `<mention>` envelope under
  ADR-0330.

- **No app resolver impl.** `resolveApp` returns `null` for every
  target. The "app" concept is not yet defined in quanta's surface
  model (CLI / Web-Tauri / CLI-embedded browser per
  `surface-model.md`). Mapping `@@chrome` / `@@vscode` / etc. to a
  surface-aware bridge requires its own ADR. No `@@app` mention will
  produce a `<mention>` envelope under ADR-0330.

- **No SKILL.md body loading.** First-line of `description` only.
  Skill body remains lazy — loaded by `Skill` tool invocation, never
  by `@skill` mention.

- **No AgentConfig wiring.** This ADR produces the function value;
  ADR-0327 wires it into `AgentConfig.mentionInjector` and into the
  per-turn `messages[]` splice point (between `baseMessages` and the
  trailing `<system-reminder>`).

## Wiring (when ADR-0327 lands)

Composition root:

```ts
import { buildSkillRegistry } from "@/skill"
import { createReadOnlySkillRegistry } from "@/skill/registry-readonly"
import { createMentionInjector } from "@/agent/mention-runner"

const skills = await buildSkillRegistry({ repoRoot, homeDir, /* ... */ })
const readOnly = createReadOnlySkillRegistry(skills)
const mentionInjector = createMentionInjector({ skills: readOnly })

// in AgentConfig:
const cfg: AgentConfig = { /* ... */, mentionInjector }
```

`AgentConfig.mentionInjector` is invoked once per turn with the raw
user input text; the returned `Message[]` is spliced into the per-turn
`messages[]` at the ADR-0321 insertion point.

## Tests

- `src/agent/mention-runner/__tests__/skill-resolver.hellgate.test.ts` —
  13 cases (registry absent / null lookup / first-line / multi-line /
  empty description / plugin-always-null × 2 / app-always-null × 2 /
  NO-THROW / CRLF tolerance / malformed entry).
- `src/agent/mention-runner/__tests__/runner.hellgate.test.ts` — 11
  cases (empty / no-mention / known / unknown / mixed / plugin-frozen
  / app-frozen / NO-THROW / dedup / order preservation / first-line
  body).
- `tests/unit/skill-registry-readonly.test.ts` — 9 cases (empty /
  hit / miss / empty name / hostile throw / malformed-no-skill /
  malformed-bad-desc / `emptyReadOnlySkillRegistry` / case sensitivity).

Total = 33 cases, 48 expects.

## Consequences

- **Positive.** ADR-0325's slice is no longer dead code. A surface that
  wants explicit-mention injection now has one function call to wire it
  on (`createMentionInjector({ skills })`). Default-OFF preserved —
  callers that don't wire it see byte-identical legacy.
- **Negative.** Plugin and app mentions are silently ignored under
  ADR-0330. A `plugin://github` or `@@chrome` in user input produces
  no envelope. Documented and frozen until follow-up ADRs land.
- **Slice-fence.** `src/skill/registry-readonly.ts` adds zero
  cross-slice imports (only `./registry`). `src/agent/mention-runner/`
  imports `@/agent/mention-injection` (in-slice) + `@/llm` (allowed
  cross-slice for `@/agent`) + `@/skill/registry-readonly` only via
  structural-mirror type duplication on the runner side (test fakes
  don't reach into `@/skill`). No mutations to `@/skill` or
  `@/agent/mention-injection` body.

## Follow-up ADRs

- **Plugin manifest absorption** — `.codex-plugin/plugin.json` discovery
  + `MentionResolverPort.resolvePlugin` impl.
- **App concept** — define what "app" means in quanta's surface model;
  implement `MentionResolverPort.resolveApp`.
- **ADR-0327 wiring** — `AgentConfig.mentionInjector` slot + per-turn
  splice point in the agent loop.
