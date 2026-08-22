/**
 * tool-origin substrate — provenance derivation (ADR-0471 Substrate-B).
 *
 * WHAT: a closed `ToolOrigin` enum (WHERE a tool came from — which source array
 *       registered it) plus a pure `deriveProvenance(name, origin)` that maps a
 *       call-site fact to a provenance class. This is the ACCURATE substrate the
 *       human-owned dispatch #2 consumes instead of name-guessing.
 * ADR: 0471 (untrusted-source-envelope).
 * SLICES IMPORTED: @/shared (assertNever only). The provenance union is defined
 *       LOCALLY here on purpose: @/tool importing @/agent is a disallowed slice
 *       edge, so the human dispatch #2 maps THIS local `Provenance` onto
 *       `@/agent/untrusted-envelope`'s `UntrustedSource` (string-identical
 *       members, so the map is the identity). Keeping the union local means the
 *       tool slice stays a leaf with no cross-slice reach.
 * NO-THROW: pure synchronous transforms; the only throw is the assertNever
 *       exhaustiveness guard, which is unreachable for the closed enum.
 *
 * Provenance is a DIFFERENT axis from `SensitivityClass` (does the OUTPUT carry
 * a secret to redact?). THIS axis asks: did the output ORIGINATE from a party
 * the model should treat as untrusted DATA? The two are orthogonal — a
 * `web_fetch` body is `public` on sensitivity yet `web_fetch` on provenance.
 */
import { assertNever } from "@/shared"

/**
 * Closed enum: WHERE a registered tool came from (its source array at
 * assembly). This is a CALL-SITE fact recorded when the registry is built, NOT
 * a guess inferred from the tool name.
 *
 *  - `builtin` — the default tool set (`buildDefaultTools`) + subagent tools.
 *  - `mcp`     — a Model-Context-Protocol server tool (third-party code).
 *  - `plugin`  — a loaded plugin/extension tool.
 *  - `lsp`     — language-server diagnostics / navigation tools (harness-driven).
 *  - `git`     — the git tool group (harness-driven over the local repo).
 */
export type ToolOrigin = "builtin" | "mcp" | "plugin" | "lsp" | "git"

/** The closed set, frozen, for membership checks and exhaustiveness tests. */
export const TOOL_ORIGINS: readonly ToolOrigin[] = Object.freeze([
  "builtin",
  "mcp",
  "plugin",
  "lsp",
  "git",
] as const)

/**
 * Local provenance union. String-IDENTICAL to
 * `@/agent/untrusted-envelope`'s `UntrustedSource` so the human dispatch #2 maps
 * it with the identity function — but defined here to keep `@/tool` a leaf (no
 * `@/agent` import across the slice fence).
 *
 *  - `mcp` | `plugin`  — third-party tool output, adversary-controllable.
 *  - `web_fetch`       — fetched web body / search result, attacker-controllable.
 *  - `bash`            — shell stdout (can `cat`/`curl` hostile content).
 *  - `file`            — file CONTENT read from disk: untrusted (a checked-out
 *                        dependency / downloaded artifact is not agent-authored).
 *  - `internal`        — the agent's OWN trusted round-trips + harness output.
 */
export type Provenance = "mcp" | "web_fetch" | "file" | "plugin" | "bash" | "internal"

/** Built-in tool names whose OUTPUT is untrusted file CONTENT. Reading a file
 *  surfaces bytes the agent did not author (a dependency, a downloaded
 *  artifact), so the content is `file` provenance, not `internal`. */
const FILE_CONTENT_TOOLS: ReadonlySet<string> = new Set<string>([
  "read",
  "read_image",
  "csv_read",
  "pdf_read",
  "xlsx_read",
  "yaml_read",
  "ndjson_read",
])

/** Built-in tool names whose OUTPUT is a fetched web body — attacker-controllable. */
const WEB_TOOLS: ReadonlySet<string> = new Set<string>(["web_fetch", "web_search"])

/** Map a built-in tool NAME to its provenance. Origin is already known to be
 *  `builtin` here, so the only remaining question is WHICH built-in. */
const deriveBuiltinProvenance = (name: string): Provenance => {
  if (WEB_TOOLS.has(name)) return "web_fetch"
  // `bash`, `bash_await`, `bash_kill` (any async-shell sibling) → shell stdout.
  if (name === "bash" || name.startsWith("bash_")) return "bash"
  if (FILE_CONTENT_TOOLS.has(name)) return "file"
  // edit / write / grep / glob / agent / harness tools → agent-own, trusted.
  return "internal"
}

/**
 * Pure provenance derivation. ORIGIN decides first (call-site truth); the NAME
 * only disambiguates among built-ins. A tool registered from the MCP source
 * array is `mcp` even if it is literally named `web_fetch` — origin wins, so a
 * hostile MCP server cannot launder its output to `internal` by name choice.
 */
export const deriveProvenance = (name: string, origin: ToolOrigin): Provenance => {
  switch (origin) {
    case "mcp":
      return "mcp"
    case "plugin":
      return "plugin"
    case "lsp":
    case "git":
      // harness-driven over the local repo / language server → agent-own.
      return "internal"
    case "builtin":
      return deriveBuiltinProvenance(name)
    default:
      return assertNever(origin, "ToolOrigin")
  }
}
