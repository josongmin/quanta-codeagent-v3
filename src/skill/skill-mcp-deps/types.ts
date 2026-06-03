/**
 * skill-mcp-deps — shared types (ADR-0476).
 *
 * WHAT: A skill declares the MCP servers it needs; when the skill is active
 * the harness auto-attaches them. Today `@/skill/skill-frontmatter` parses
 * only `userInvocable` / `allowedTools` — there is NO skill→MCP link. This
 * slice closes that gap with three pure pieces:
 *   (1) {@link parseSkillMcpDeps} — validate a raw `dependencies` block lifted
 *       off SKILL.md frontmatter into a closed {@link SkillMcpDep}[].
 *   (2) {@link resolveMcpDeps} — given the ACTIVE skills, fold their declared
 *       deps into a deduped {@link McpServerSpec}[] to attach (never double-
 *       attach the same server).
 *   (3) {@link AttachMcpPort} — the inverted seam the composition root calls on
 *       skill activation (wired to `@/agent/plugin-mcp-launcher`).
 *
 * SLICES IMPORTED: `@/shared` ONLY (Result/ok/err/errMessage). This slice
 * lives under `@/skill` but does NOT import `@/agent/plugin-mcp-launcher`
 * (a leaf cannot reach the launcher) — the attach call is injected as the
 * {@link AttachMcpPort} callback (port inversion, mirrors
 * `src/permission/classifier.ts` ClassifierPort + `src/memory/consolidate`
 * Phase2Summarizer). It also does NOT redefine the `.mcp.json` schema — the
 * resolved spec is the launcher-agnostic {@link McpServerSpec} declared here,
 * which the composition root maps onto the launcher's `MCPServerSpec`.
 *
 * NO-THROW: every exported function returns a `Result` or a plain value
 * (never throws). A malformed dep is a typed `err`, the dep is SKIPPED, and
 * the skill keeps working — a bad MCP declaration must never crash a skill.
 *
 * DEFAULT-OFF: {@link skillMcpDepsEnabled} reads the INJECTED env flag
 * `QUANTA_SKILL_MCP_DEPS` (never `process.env`). When unset/not "1",
 * {@link resolveMcpDeps} returns `[]` BEFORE inspecting any skill — byte-
 * identical to today (no resolution, no attach).
 *
 * NO arbitrary heuristics / magic numbers: the transport set is a closed
 * enum; dedupe is by an explicit, documented identity key.
 */

/** Transport carriers a skill may declare for an MCP dependency. Closed set —
 *  matches the standard `.mcp.json` carriers (stdio spawn vs. the two HTTP
 *  carriers). Widening requires an ADR (a new carrier silently broadens the
 *  attach surface). */
export const MCP_DEP_TRANSPORTS = ["stdio", "streamable_http", "sse"] as const
export type McpDepTransport = (typeof MCP_DEP_TRANSPORTS)[number]

/** The HTTP carriers — `url` is required for these; `command` is required for
 *  `stdio`. Named so the validator branches on one source of truth. */
export const HTTP_DEP_TRANSPORTS: readonly McpDepTransport[] = ["streamable_http", "sse"]

/**
 * One validated MCP dependency declared by a skill. Shape mirrors a single
 * `dependencies.tools[]` entry with `type: "mcp"`:
 *
 *   dependencies:
 *     tools:
 *       - type: mcp
 *         value: my-server          # serviceName — the dedupe identity
 *         transport: stdio          # stdio | streamable_http | sse
 *         command: my-mcp-binary    # required for stdio
 *         args: ["--flag"]          # optional
 *         url: https://...          # required for streamable_http / sse
 *
 * The `value` is the canonical service name; for HTTP transports the `url`
 * participates in dedupe identity (see {@link depIdentity}).
 */
export interface SkillMcpDep {
  /** Canonical service name (the `value` field). Non-empty. Primary dedupe
   *  key for stdio; part of the identity for HTTP carriers. */
  readonly serviceName: string
  /** Which carrier to attach over. */
  readonly transport: McpDepTransport
  /** Present iff `transport === "stdio"`. The binary/command to spawn. */
  readonly command?: string
  /** Optional argv for the stdio command. Defaults to `[]` when absent. */
  readonly args?: readonly string[]
  /** Present iff `transport` is an HTTP carrier. The endpoint to connect to. */
  readonly url?: string
}

/**
 * The launcher-agnostic server spec {@link resolveMcpDeps} emits. The
 * composition root maps this onto `@/agent/plugin-mcp-launcher`'s
 * `MCPServerSpec` (stdio → command/args; HTTP → url). Kept separate so this
 * slice never imports the launcher's types (plane-clean leaf).
 */
export interface McpServerSpec {
  /** Stable identity used for attach + dedupe. See {@link depIdentity}. */
  readonly serviceName: string
  readonly transport: McpDepTransport
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
}

/** A skill projected down to just what this slice needs: its id + the raw,
 *  UNVALIDATED `dependencies` block lifted off its frontmatter (or sidecar
 *  agents/<vendor>.yaml). The composition root supplies `rawDependencies`
 *  straight from the parser without pre-shaping it — validation is this
 *  slice's job. `undefined` ⇒ the skill declares no deps (a no-op skill). */
export interface ActiveSkillDeps {
  /** Kebab-case skill id (matches SkillFrontmatter.name). Used only for
   *  diagnostics; identity/dedupe is per-server, not per-skill. */
  readonly skillId: string
  /** The raw `dependencies` value as parsed from YAML/frontmatter, or
   *  undefined when the skill has no `dependencies` block. */
  readonly rawDependencies?: unknown
}

/** Why a single dep was rejected. Closed union so callers can branch
 *  exhaustively when surfacing diagnostics. */
export type McpDepError =
  /** The entry was not an object, or `type` was not `"mcp"`. */
  | { readonly kind: "not-mcp-tool"; readonly detail: string }
  /** A required field was missing/blank or the transport was unknown. */
  | { readonly kind: "malformed"; readonly detail: string }

/** Per-skill validation outcome: the valid deps that parsed plus the typed
 *  errors for the ones skipped. NEVER throws; a malformed dep lands in
 *  `errors`, the rest still parse. */
export interface SkillMcpDepsResult {
  readonly deps: readonly SkillMcpDep[]
  readonly errors: readonly McpDepError[]
}

/** Env projection the gate reads — a plain record so tests pass `{}` for the
 *  OFF path and `{ QUANTA_SKILL_MCP_DEPS: "1" }` for ON. The slice never
 *  reads `process.env` (slice-boundary invariant). */
export type SkillMcpDepsEnv = Readonly<Record<string, string | undefined>>

/** Env flag name. Exactly `"1"` opts a deployment in; any other value (incl
 *  "0"/"true"/"on") keeps it OFF. */
export const SKILL_MCP_DEPS_FLAG = "QUANTA_SKILL_MCP_DEPS"

/** DEFAULT-OFF gate. True iff the injected env sets the flag to exactly "1". */
export const skillMcpDepsEnabled = (env: SkillMcpDepsEnv): boolean =>
  env[SKILL_MCP_DEPS_FLAG] === "1"

/**
 * Stable dedupe identity for a server. Two declarations attach the SAME
 * server iff their identities are equal. For stdio the identity is the
 * service name (a binary is one server regardless of which skill named it).
 * For HTTP carriers the identity folds in the transport + url so two skills
 * pointing at the same logical service over the same endpoint dedupe, but a
 * service exposed over both `sse` and `streamable_http` is treated as two
 * distinct attachments (different wire protocol = different connection).
 *
 * Named + documented identity — NOT an arbitrary key choice (memory rule).
 */
export const depIdentity = (dep: SkillMcpDep | McpServerSpec): string =>
  dep.transport === "stdio"
    ? `stdio::${dep.serviceName}`
    : `${dep.transport}::${dep.serviceName}::${dep.url ?? ""}`

/**
 * The inverted attach seam. The composition root implements this against
 * `@/agent/plugin-mcp-launcher` (`launchPluginMcpServers` / `McpLauncherPort`).
 * MUST NOT throw — failures are reported through the returned per-server
 * outcomes, never as exceptions.
 */
export interface AttachMcpPort {
  /** Attach (spawn/connect) each resolved server. Implementations MUST be
   *  idempotent on `depIdentity` — a server already attached is a no-op.
   *  Returns one outcome per input spec, in input order. */
  attach(specs: readonly McpServerSpec[]): Promise<readonly McpAttachOutcome[]>
}

/** Outcome of attaching one server. `attached: false` carries a reason; the
 *  port never throws. */
export interface McpAttachOutcome {
  readonly serviceName: string
  readonly attached: boolean
  readonly reason?: string
}
