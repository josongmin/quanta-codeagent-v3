/**
 * skill-mcp-deps — dependency parser (ADR-0476).
 *
 * Validates the raw `dependencies` block lifted off a SKILL.md frontmatter
 * (or a sidecar agents/<vendor>.yaml) into a closed {@link SkillMcpDep}[].
 *
 * DESIGN CHOICE (documented): we read the dependency declaration from the
 * SKILL.md FRONTMATTER `dependencies.tools[]` block, NOT a separate sidecar
 * file. Rationale: the skill's MCP needs are intrinsic to the skill, the
 * frontmatter is already the parse home (`@/skill/skill-frontmatter`), and a
 * single-file skill stays self-describing (no second file to keep in sync).
 * The shape mirrors the common agent-config `dependencies.tools[]` convention
 * so vendor sidecars can be mapped onto the SAME validator by the composition
 * root simply by handing us their `dependencies` object — this slice does not
 * care WHERE the raw block came from, only that it matches the contract.
 *
 *   dependencies:
 *     tools:
 *       - type: mcp
 *         value: my-server
 *         transport: stdio
 *         command: my-mcp-binary
 *         args: ["--flag"]
 *       - type: mcp
 *         value: remote-svc
 *         transport: streamable_http
 *         url: https://mcp.example.com/v1
 *
 * NO-THROW: a malformed entry yields a typed {@link McpDepError} in the result
 * and is SKIPPED — the rest still parse, and the skill keeps working.
 *
 * Slices imported: `@/shared` ONLY.
 */

import { errMessage, isRecord } from "@/shared"
import {
  HTTP_DEP_TRANSPORTS,
  MCP_DEP_TRANSPORTS,
  type McpDepError,
  type McpDepTransport,
  type SkillMcpDep,
  type SkillMcpDepsResult,
} from "./types"

/** Type guard: a non-null plain object (record). */
/** Read a required non-empty string field, TRIMMED, or null. The trim is
 *  load-bearing: the returned value feeds {@link depIdentity} (dedupe key) and
 *  the launcher's serverId. Returning the raw value would let `value: " svc "`
 *  and `value: "svc"` resolve to DIFFERENT identities — double-attaching the
 *  same logical server (violates the slice's "never double-attach" invariant)
 *  and threading surrounding whitespace into the launcher serverId. */
const reqString = (rec: Record<string, unknown>, key: string): string | null => {
  const v = rec[key]
  if (typeof v !== "string") return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Validate the optional `args` field into a string[]. Absent ⇒ []. A present
 *  non-array, or an array with a non-string element, is a hard malformed
 *  error (we do not silently coerce — that would hide an authoring mistake). */
const parseArgs = (rec: Record<string, unknown>): readonly string[] | McpDepError => {
  const v = rec.args
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    return { kind: "malformed", detail: "`args` must be an array of strings" }
  }
  if (!v.every((e) => typeof e === "string")) {
    return { kind: "malformed", detail: "`args` must contain only strings" }
  }
  return v as readonly string[]
}

const isTransport = (v: unknown): v is McpDepTransport =>
  typeof v === "string" && (MCP_DEP_TRANSPORTS as readonly string[]).includes(v)

/** Validate ONE raw `dependencies.tools[]` entry. Returns the parsed dep, or a
 *  typed error (the caller pushes it into `errors` and skips the entry).
 *  Entries whose `type` is not `"mcp"` are NOT errors in spirit — they are
 *  simply non-MCP deps this slice ignores — but we surface them as a
 *  `not-mcp-tool` so the caller can decide; the resolver drops them. */
const parseOneTool = (entry: unknown): SkillMcpDep | McpDepError => {
  if (!isRecord(entry)) {
    return { kind: "not-mcp-tool", detail: "tool entry is not an object" }
  }
  if (entry.type !== "mcp") {
    return {
      kind: "not-mcp-tool",
      detail: `tool entry type is not "mcp" (got ${String(entry.type)})`,
    }
  }
  const serviceName = reqString(entry, "value")
  if (serviceName === null) {
    return { kind: "malformed", detail: "mcp tool requires a non-empty `value` (service name)" }
  }
  if (!isTransport(entry.transport)) {
    return {
      kind: "malformed",
      detail: `mcp tool value:${serviceName} has unknown transport ${String(entry.transport)}; expected one of ${MCP_DEP_TRANSPORTS.join(", ")}`,
    }
  }
  const transport = entry.transport
  const args = parseArgs(entry)
  // `Array.isArray`'s guard (`arg is any[]`) does NOT narrow a `readonly string[]`
  // out of the union, so branch on the error discriminant instead (an array has
  // no `kind`). After this, `args` narrows to `readonly string[]`.
  if ("kind" in args) return args // McpDepError

  if (transport === "stdio") {
    const command = reqString(entry, "command")
    if (command === null) {
      return {
        kind: "malformed",
        detail: `stdio mcp tool value:${serviceName} requires a non-empty command`,
      }
    }
    return { serviceName, transport, command, args }
  }

  // HTTP carriers (streamable_http | sse) require url.
  if (HTTP_DEP_TRANSPORTS.includes(transport)) {
    const url = reqString(entry, "url")
    if (url === null) {
      return {
        kind: "malformed",
        detail: `${transport} mcp tool value:${serviceName} requires a non-empty url`,
      }
    }
    return { serviceName, transport, url }
  }

  // Unreachable given isTransport, but noUncheckedIndexedAccess discipline.
  return { kind: "malformed", detail: `unhandled transport ${transport}` }
}

const isError = (v: SkillMcpDep | McpDepError): v is McpDepError =>
  "kind" in v && (v.kind === "malformed" || v.kind === "not-mcp-tool")

/**
 * Parse a skill's raw `dependencies` block into validated MCP deps + errors.
 *
 * Accepts the value of the frontmatter `dependencies` key (or a sidecar's
 * equivalent). Recognised shape: `{ tools: [ { type: "mcp", ... }, ... ] }`.
 * `undefined`/absent ⇒ `{ deps: [], errors: [] }` (a no-deps skill). A
 * malformed top-level block (not an object, or `tools` not an array) yields a
 * single `malformed` error and NO deps — never throws.
 */
export const parseSkillMcpDeps = (rawDependencies: unknown): SkillMcpDepsResult => {
  if (rawDependencies === undefined || rawDependencies === null) {
    return { deps: [], errors: [] }
  }
  try {
    if (!isRecord(rawDependencies)) {
      return {
        deps: [],
        errors: [{ kind: "malformed", detail: "`dependencies` must be a mapping" }],
      }
    }
    const tools = rawDependencies.tools
    if (tools === undefined) {
      // A dependencies block with no `tools` is legal (e.g. only declares
      // other dep kinds) — simply no MCP deps. Not an error.
      return { deps: [], errors: [] }
    }
    if (!Array.isArray(tools)) {
      return {
        deps: [],
        errors: [{ kind: "malformed", detail: "`dependencies.tools` must be an array" }],
      }
    }
    const deps: SkillMcpDep[] = []
    const errors: McpDepError[] = []
    for (const entry of tools) {
      const parsed = parseOneTool(entry)
      if (isError(parsed)) {
        errors.push(parsed)
      } else {
        deps.push(parsed)
      }
    }
    return { deps, errors }
  } catch (e) {
    // Defensive: the validator is pure, but a hostile getter on the raw object
    // could throw. NO-THROW contract holds.
    return { deps: [], errors: [{ kind: "malformed", detail: errMessage(e) }] }
  }
}
