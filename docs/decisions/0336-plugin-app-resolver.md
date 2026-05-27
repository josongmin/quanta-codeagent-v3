# ADR-0336 — Plugin manifest absorption + app catalog + composite resolver

- Status: Accepted (slices landed, default-OFF; composition wire-up
  deferred to a follow-up ADR)
- Date: 2026-05-27
- Related: ADR-0325 (mention-injection slice — closed
  `MentionResolverPort` and the 3-kind enum this ADR's resolvers
  populate), ADR-0330 (mention-runner skill resolver — this ADR
  closes its two negative invariants `resolvePlugin → null` and
  `resolveApp → null`), ADR-0335 (typed-event variants for
  `plugin_activation` / `app_activation` — referenced via LOCAL MOCK
  types pending its landing).

## Context

ADR-0330 shipped a SKILL-ONLY `MentionResolverPort` implementation
and explicitly froze plugin / app resolution as `null` — every
`plugin://…` or `@@…` mention produced no envelope. The freeze had
two cited blockers:

1. **No plugin discovery surface.** Codex's `.codex-plugin/plugin.json`
   manifest format had not yet been absorbed.
2. **No "app" concept in quanta's surface model.** Mapping `@@chrome`
   / `@@vscode` / etc. into the CLI / Web-Tauri / CLI-embedded browser
   surface trio (memory `surface-model.md`) was undefined.

This ADR closes both, ships three new default-OFF slices, and wires
a composite resolver factory that callers can use in lieu of
ADR-0330's `createSkillOnlyResolver`.

## Decision

Land three new slices and a new ADR document. The ADR-0330 slice
body is NOT mutated — the composite resolver is built externally and
the mention-runner is left untouched.

### 1. `src/agent/plugin-discovery/` (Codex plugin absorption)

Closed-port surface mirroring memory `codex-plugin-manifest-pattern`:

- `PluginCapability = "Interactive" | "Read" | "Write"` — **frozen**
  closed-enum verbatim from Codex.
- `PluginManifest { id, name, description?, capabilities,
  mcpServers?, skills? }` — sanitized parsed shape. Unknown
  top-level fields and unknown capability strings are silently
  dropped (forward-compat with newer Codex releases).
- `PluginRegistryPort { lookup(id), list() }` — closed read-only
  port. NO-THROW contract.
- `FilesystemPort { readDir, readFile }` — closed local FS port for
  the scanner. Kept inside this slice so the discovery module has
  zero `node:*` imports and can run in any JS runtime that supplies
  a port (browser-host, headless server, in-memory tests).
- `parsePluginManifest(jsonText)` — pure NO-THROW parser. `id` and
  `name` cross-fill each other (only one provided ⇒ the other
  falls back).
- `discoverPlugins(rootDir, fs)` — breadth-1 fs scanner. Scans
  immediate children of `rootDir` for `.codex-plugin/plugin.json`,
  parses each, overrides `id` with the directory name (more stable
  than the manifest's self-declared id), returns the surviving list
  in discovery order.
- `createInMemoryPluginRegistry(list)` / `emptyPluginRegistry` —
  pure adapters.

### 2. `src/agent/app-catalog/` (quanta surface ↔ app mapping)

- `AppSurface = "cli" | "web-tauri" | "cli-browser"` — **frozen**
  closed-enum mirror of memory `surface-model.md`.
- `AppDescriptor { id, surface, description? }`.
- `AppCatalogPort { lookup(id), list() }` — same shape as
  `PluginRegistryPort`.
- `DEFAULT_APP_CATALOG` — static 3-entry list (one per surface):
  - `cli` → surface `cli` ("the CLI surface").
  - `browser` → surface `cli-browser` ("the CLI-embedded browser
    surface"). Distinct from `desktop`: the CLI owns the browser
    sub-surface lifecycle.
  - `desktop` → surface `web-tauri` ("the Web-Tauri desktop
    surface"). Owns its own lifecycle.
- `createInMemoryAppCatalog(list)` / `defaultAppCatalog` — pure
  adapters.

The 3 default entries are the minimum quanta surface coverage. ROI
of any future feature is NOT gated by surface availability (per
`surface-model.md`); apps not present on the active surface simply
do not list.

### 3. `src/agent/plugin-app-resolver/` (composite resolver)

The production sibling to ADR-0330's `createSkillOnlyResolver`.
Composes three kind-specific resolvers into a single
`MentionResolverPort`:

- `createSkillResolver(skills?)` — duplicates ADR-0330's first-line
  policy locally so the ADR-0330 slice body stays unmutated.
- `createPluginResolver(registry?)` — first line of
  `manifest.description`; fallback `"<name> (capabilities: …)"`
  when no description present.
- `createAppResolver(catalog?)` — `surface: <surface>` prefix,
  optional ` — <description>` suffix.
- `createCompositeMentionResolver({ skills?, plugins?, apps? })` —
  combine all three. Each sub-resolver is independent; omitting any
  dependency ⇒ that kind silently returns `null` (skipped).

### Local typed-event mocks (ADR-0335 placeholder)

`src/agent/plugin-app-resolver/types.ts` declares two LOCAL
interfaces — `LocalPluginActivationEvent` and
`LocalAppActivationEvent` — structurally identical to the variants
ADR-0335 will add to the canonical typed-event store. Mock placement
mirrors the R1 / ADR-0330 pattern of re-declaring an adjacent
slice's shape locally. Integration after ADR-0335 lands is a
one-line `type` alias swap.

## Non-goals (negative invariants — frozen by ADR-0336)

- **No mention-runner mutation.** ADR-0330's `runner.ts` /
  `skill-resolver.ts` / `index.ts` are NOT modified. The composite
  resolver is built externally and the runner consumes the
  resulting port through ADR-0325's existing
  `buildInjectionFragments` consumer.

- **No fs adapter ship.** `discoverPlugins` ships only as a pure
  function over the closed `FilesystemPort`. A Node-fs adapter
  (using `node:fs`) is intentionally NOT bundled — composition
  roots wire one explicitly so the slice can run on any JS
  runtime.

- **No `.mcp.json` absorption.** The plugin manifest captures the
  `mcpServers[]` array shape but does not parse a sibling
  `.mcp.json` file. Full MCP-server activation on plugin load is a
  follow-up ADR.

- **No plugin activation wire.** The plugin resolver embeds
  capability text in the mention body but does NOT trigger any
  runtime side-effect — no skill-set extension, no MCP launch, no
  permission grant. Activation is the composition root's job; the
  resolver is purely a body-text producer.

- **No surface availability gating.** Per memory `surface-model.md`,
  the resolver does NOT check whether the active surface supports
  the resolved app — it always returns a body-text. Surface checks
  belong at activation time, not resolution time.

- **No ADR-0335 import.** Typed-event variants are referenced via
  LOCAL MOCK interfaces so this ADR is non-blocking on ADR-0335.

## Wiring (composition-root pattern)

```ts
import { defaultAppCatalog } from "@/agent/app-catalog"
import {
  discoverPlugins,
  createInMemoryPluginRegistry,
} from "@/agent/plugin-discovery"
import { createCompositeMentionResolver } from "@/agent/plugin-app-resolver"
import { createReadOnlySkillRegistry } from "@/skill/registry-readonly"
import { buildInjectionFragments, parseMentions } from "@/agent/mention-injection"

// Plugins — fs-backed (composition root supplies FilesystemPort).
const manifests = discoverPlugins(pluginRoot, nodeFsPort)
const plugins = createInMemoryPluginRegistry(manifests)

// Skills — existing read-only registry.
const skills = createReadOnlySkillRegistry(skillRegistry)

// Apps — default catalog (or per-workspace override).
const apps = defaultAppCatalog

// Composite resolver replaces ADR-0330's skill-only resolver.
const resolver = createCompositeMentionResolver({ skills, plugins, apps })

// Per-turn:
const fragments = buildInjectionFragments(parseMentions(input), resolver)
```

The mention-runner's `createMentionInjector` (ADR-0330) does NOT
need to know about plugins / apps — its caller passes the composite
resolver into `buildInjectionFragments` directly.

## Tests

- `src/agent/plugin-discovery/__tests__/parser.hellgate.test.ts` —
  14 cases (malformed JSON / required-field absence / id↔name
  fallback / capability enum closure / mcpServers shape / skills
  shape / forward-compat).
- `src/agent/plugin-discovery/__tests__/discovery.hellgate.test.ts` —
  9 cases (empty / missing root / single / multi / no `.codex-plugin`
  path / partial malformed / fs throws × 2 / dir-name id override).
- `src/agent/plugin-discovery/__tests__/in-memory-registry.hellgate.test.ts` —
  6 cases (empty × 2 / hit-miss / boundary / duplicate-id / snapshot
  isolation).
- `src/agent/app-catalog/__tests__/default-catalog.hellgate.test.ts` —
  8 cases (3 default app lookups / unknown id / list cardinality /
  surface enum closure / description shape / snapshot isolation).
- `src/agent/plugin-app-resolver/__tests__/plugin-resolver.hellgate.test.ts` —
  8 cases (absent / null lookup / hit with desc / hit without desc ×
  2 / NO-THROW / empty target / CRLF).
- `src/agent/plugin-app-resolver/__tests__/app-resolver.hellgate.test.ts` —
  7 cases (absent / null lookup / hit with desc / hit without desc /
  NO-THROW / empty target / 3-surface default).
- `src/agent/plugin-app-resolver/__tests__/composite-resolver.hellgate.test.ts` —
  7 cases (empty / skill-only / plugin-only / app-only / all-three /
  kind-dispatch isolation / NO-THROW).

Total = 59 cases.

## Consequences

- **Positive.** ADR-0330's two negative invariants are closed — a
  `plugin://github` or `@@browser` in user input now produces a
  proper mention envelope when the composition root supplies the
  required registry / catalog. Default-OFF preserved: callers that
  don't construct the composite resolver see byte-identical legacy
  (ADR-0330 skill-only behaviour).
- **Negative.** Plugin discovery is fs-only (breadth-1, no
  recursion, no `.mcp.json` parsing). MCP-server activation on
  plugin load is deferred. App catalog ships static defaults only —
  per-workspace overrides and plugin-declared app extensions are
  future ADRs.
- **Slice-fence.** `plugin-discovery/` imports nothing outside
  itself. `app-catalog/` imports nothing outside itself.
  `plugin-app-resolver/` imports `@/agent/app-catalog` +
  `@/agent/plugin-discovery` + `@/agent/mention-injection` (for the
  port type only). No imports into `@/agent/mention-runner` and no
  mutations to its body.

## Follow-up ADRs

- **`.mcp.json` absorption + MCP launch on plugin activation** —
  parse the sibling `.mcp.json` file, hook into existing MCP slice
  to spin up declared servers when a plugin is mentioned.
- **Plugin-declared skill set extension** — when a plugin lists
  `skills[]`, surface those skills into the active-skills prompt
  block on plugin activation.
- **ADR-0335 typed-event integration** — swap the LOCAL MOCK
  activation event interfaces for canonical imports from
  `@/agent/typed-events`.
- **Per-workspace app catalog overrides** — read a project-local
  catalog file (e.g. `.quanta/apps.json`) to extend / override
  `DEFAULT_APP_CATALOG`.
