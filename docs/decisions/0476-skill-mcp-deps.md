# ADR-0476 — skill-mcp-deps: skill-declared MCP dependencies, auto-attached on activation

Status: Accepted (slice landed default-OFF; wiring deferred to integration TODOs)
Date: 2026-06-03

## Context

A skill often needs a specific MCP server to do its job (e.g. a "deploy" skill
needs a deploy-control MCP server; a "db-query" skill needs a database MCP
server). Today `@/skill/skill-frontmatter` parses only `userInvocable` and
`allowedTools` — there is NO link from a skill to the MCP servers it requires.
The user must manually pre-attach every server, and there is no way for the
harness to attach the right server JUST when the skill is active and tear down
when it is not.

Competitor parity: agent configs commonly declare `dependencies.tools[]` with
`type: mcp` entries (value + transport + command/url). We absorb that shape.

## Decision

A new leaf slice `src/skill/skill-mcp-deps/` with three pure pieces:

1. **`parseSkillMcpDeps(rawDependencies)`** — validates a raw `dependencies`
   block (lifted off SKILL.md frontmatter) into a closed `SkillMcpDep[]` plus
   typed `McpDepError[]`. Recognised shape:

   ```yaml
   dependencies:
     tools:
       - type: mcp
         value: my-server          # serviceName (dedupe identity)
         transport: stdio          # stdio | streamable_http | sse
         command: my-mcp-binary    # required for stdio
         args: ["--flag"]          # optional
       - type: mcp
         value: remote-svc
         transport: streamable_http
         url: https://mcp.example.com/v1   # required for HTTP carriers
   ```

2. **`resolveMcpDeps(activeSkills, env)`** — folds the active skills' declared
   deps into a **deduped** `McpServerSpec[]` to attach. Dedupe is by
   `depIdentity`: stdio ⇒ `stdio::<serviceName>`; HTTP ⇒
   `<transport>::<serviceName>::<url>`. First declaration wins; a server is
   NEVER attached twice.

3. **`AttachMcpPort`** — the inverted seam the composition root calls on skill
   activation, wired to `@/agent/plugin-mcp-launcher`
   (`launchPluginMcpServers` / `McpLauncherPort`).

### Source of the declaration: frontmatter, NOT a sidecar

We read the dependency block from the **SKILL.md frontmatter
`dependencies.tools[]`**, not a separate `agents/<vendor>.yaml` sidecar.
Rationale: a skill's MCP needs are intrinsic to the skill, the frontmatter is
already the parse home, and a single-file skill stays self-describing (no
second file to keep in sync). The validator is source-agnostic, so a vendor
sidecar can be mapped onto the SAME `parseSkillMcpDeps` simply by handing it the
sidecar's `dependencies` object — only the read site differs.

### Port inversion

The slice lives under `@/skill` but does NOT import
`@/agent/plugin-mcp-launcher` (a leaf cannot reach the launcher). The attach
call is injected as `AttachMcpPort` (mirrors `src/permission/classifier.ts`
ClassifierPort and `src/memory/consolidate` Phase2Summarizer). The composition
root maps the slice-local `McpServerSpec` onto the launcher's `MCPServerSpec`.

### NO-THROW

Every export returns a `Result`/plain value. A malformed dep yields a typed
`McpDepError` and is SKIPPED — the skill keeps working. A hostile getter on the
raw block is caught. The `AttachMcpPort` reports failures via per-server
`McpAttachOutcome { attached:false, reason }`, never exceptions.

### DEFAULT-OFF

`skillMcpDepsEnabled(env)` is true iff injected env `QUANTA_SKILL_MCP_DEPS ===
"1"`. When unset, `resolveMcpDeps` returns `[]` BEFORE inspecting any skill —
byte-identical to today (no resolution, no attach). The slice never reads
`process.env`.

### No arbitrary heuristics

Transport set is a closed enum (`stdio | streamable_http | sse`). Dedupe key is
a named, documented `depIdentity` — not an ad-hoc choice. No magic numbers.

## Consequences

- New leaf slice, fully unit-testable in isolation with injected fakes.
- 21-case hellgate (`tests/unit/skill-mcp-deps-hellgate.test.ts`) proves: active
  → resolved-to-attach; gate-off → no resolution; inactive → not resolved;
  duplicate across skills → attached once; malformed → skipped not thrown;
  no-deps → no-op; AttachMcpPort port inversion.
- Wiring (frontmatter parse hook + activation-time attach call) is deferred to
  the human via integration TODOs (this slice is fenced from those host files).

## Integration TODOs (human applies serially)

1. `src/skill/skill-frontmatter.ts` — extend `SkillFrontmatterSchema` (or a
   parallel lenient read) to carry the optional `dependencies` block, then hand
   it to `parseSkillMcpDeps` at discovery time so each skill record carries its
   resolved `SkillMcpDep[]` (or raw `dependencies` for late resolution).
2. Composition root (skill activation / `/skill` invoke site) — on activation,
   call `resolveMcpDeps(activeSkills, env)` then `attachPort.attach(specs)`,
   where `attachPort` is an `AttachMcpPort` wrapping `@/agent/plugin-mcp-launcher`.

   ### Accurate launcher mapping (verified against the real API)

   The launcher does NOT expose a flat `attach(specs)`; it is manifest +
   registry + port driven. The real exports are:
   `launchPluginMcpServers(manifest: PluginManifest, registry: PluginMcpRegistry,
   port: McpLauncherPort)`, `createIsolatedMcpLauncherPort`,
   `createInMemoryPluginMcpRegistry`, `composeServerId`. The launcher's
   `MCPServerSpec` (from `@/skill/plugin-manifest`) is
   `{ command: string, args: string[], env?, url?, headers? }` — there is NO
   `transport` field; the carrier is INFERRED (`url` present ⇒ HTTP carrier;
   else stdio via `command`), and the schema `.refine` requires
   `command.length > 0 || url !== undefined`.

   So the `AttachMcpPort` adapter must map each slice `McpServerSpec` onto a
   synthetic single-server `PluginManifest` (or batch them into one manifest's
   `mcpServers` record keyed by `serviceName`) and call `launchPluginMcpServers`:

   ```ts
   import {
     launchPluginMcpServers, createIsolatedMcpLauncherPort,
     createInMemoryPluginMcpRegistry, type PluginMcpRegistry, type McpLauncherPort,
   } from "@/agent/plugin-mcp-launcher"
   import type { MCPServerSpec as LauncherSpec } from "@/skill/plugin-manifest"
   import { resolveMcpDeps, type AttachMcpPort, type McpServerSpec } from "@/skill/skill-mcp-deps"

   const toLauncherSpec = (s: McpServerSpec): LauncherSpec =>
     s.transport === "stdio"
       ? { command: s.command ?? "", args: [...(s.args ?? [])] }
       : { command: "", args: [], url: s.url }   // HTTP carrier: url-inferred

   // ONE registry + port per session (so dedupe/idempotency + shutdown survive).
   const registry: PluginMcpRegistry = createInMemoryPluginMcpRegistry()
   const launcherPort: McpLauncherPort = createIsolatedMcpLauncherPort(/* opts */)

   const attachPort: AttachMcpPort = {
     attach: async (specs) => {
       const manifest = {
         name: "skill-mcp-deps",  // serverId = "skill-mcp-deps::<serviceName>"
         mcpServers: Object.fromEntries(specs.map((s) => [s.serviceName, toLauncherSpec(s)])),
         // ...other required PluginManifest fields per @/skill/plugin-manifest schema
       }
       const handles = await launchPluginMcpServers(manifest as any, registry, launcherPort)
       return specs.map((s) => {
         const h = handles.find((x) => x.serverId === `skill-mcp-deps::${s.serviceName}`)
         return { serviceName: s.serviceName, attached: h?.ready ?? false, reason: h?.error }
       })
     },
   }

   const activeSkills = currentActiveSkills.map((sk) => ({ skillId: sk.name, rawDependencies: sk.dependencies }))
   const specs = resolveMcpDeps(activeSkills, injectedEnv)  // [] when gate OFF
   if (specs.length > 0) await attachPort.attach(specs)     // launcher dedupes on serverId
   ```

   `launchPluginMcpServers` already short-circuits a re-spawn via
   `registry.hasServerId(serverId)`, so re-activation is idempotent at the
   launcher layer too (belt-and-suspenders with the resolver's own dedupe).
   On deactivation, recompute `resolveMcpDeps` over the still-active set and
   shut down handles whose `serverId` is no longer required (or
   `await registry.shutdownAll()` at session end).

   ### Transport-collision hazard in the adapter (MUST handle)

   The resolver's `depIdentity` treats the SAME `serviceName`+`url` exposed
   over `sse` vs `streamable_http` as TWO distinct attachments (different wire
   protocol = different connection). But the launcher keys servers by
   `composeServerId(pluginId, serverName)` and the manifest `mcpServers` is a
   `Record<string, MCPServerSpec>` — if the adapter keys that record by
   `serviceName` alone (as the illustrative snippet above does), the two HTTP
   carriers COLLIDE on the same record key and one is lost. The adapter MUST
   therefore key the launcher record by a transport-qualified name so the
   resolver's two-distinct-attachments semantics survive at the launcher:

   ```ts
   // key = "<serviceName>::<transport>" so sse vs streamable_http don't collide
   const launcherKey = (s: McpServerSpec) => `${s.serviceName}::${s.transport}`
   mcpServers: Object.fromEntries(specs.map((s) => [launcherKey(s), toLauncherSpec(s)])),
   // ...and match handles by serverId = `skill-mcp-deps::${launcherKey(s)}`
   ```

## Negative invariants (what this slice deliberately does NOT do)

- Does NOT read `process.env` — the gate reads only the injected
  `SkillMcpDepsEnv` projection. The composition root supplies the real env.
- Does NOT import `@/agent/plugin-mcp-launcher` (a `@/skill` leaf cannot reach
  the launcher). The attach call is the injected `AttachMcpPort`; the slice
  emits the launcher-agnostic `McpServerSpec`, never the launcher's
  `MCPServerSpec`.
- Does NOT redefine the `.mcp.json` / `MCPServerSpec` schema. Mapping onto the
  launcher's spec (incl. url-inferred carrier) is the composition root's job.
- Does NOT throw — a malformed dep is a typed `McpDepError`, the dep is
  skipped, and valid siblings still parse. A bad MCP declaration must never
  crash a skill.
- Does NOT spawn, connect, or perform any side effect. Resolution is pure;
  the only side effect (attach) is delegated through the port.
- Does NOT widen the transport set implicitly. `MCP_DEP_TRANSPORTS` is a closed
  enum; a new carrier requires an ADR (it silently broadens the attach surface).
- Does NOT change behavior when the gate is OFF. `resolveMcpDeps` returns `[]`
  BEFORE inspecting any skill — byte-identical to today.
- Does NOT decide skill ACTIVATION. It consumes the already-active set; what
  makes a skill active (invoke / always-on / trigger) is the host's concern.
