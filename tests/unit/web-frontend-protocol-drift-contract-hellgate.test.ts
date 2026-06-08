import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  SESSION_COMMAND_TYPES,
  SESSION_EVENT_TYPES,
  SESSION_PROTOCOL_VERSION,
} from "@/protocol/session"

/**
 * Wire-protocol drift contract (hellgate) — foundational guard.
 *
 * The daemon owns the CANONICAL session protocol in `src/protocol/session/`.
 * The web frontend lives OUTSIDE bun's tsconfig `paths`, so it keeps a
 * HAND-MAINTAINED COPY in `apps/web-frontend/src/types/protocol.ts`
 * (event/command union variants) + a config-write allowlist mirror in
 * `apps/web-frontend/src/components/slash-knobs.ts`. Those copies DRIFT — a
 * past drift dropped two event members from the frontend union, returned
 * `undefined` from the reducer, and crashed the next `turn.output.delta`.
 *
 * This test makes drift IMPOSSIBLE TO MERGE. It imports the canonical member
 * consts and reads the frontend mirrors AS TEXT (the frontend cannot be
 * `import`ed from a bun test — it is a different toolchain), then asserts the
 * frontend declared set === the canonical set, member-for-member, in BOTH
 * directions, for:
 *   - SessionEvent types
 *   - SessionCommand types
 *   - SESSION_PROTOCOL_VERSION string
 *   - CONFIG_WRITABLE_KEYS (frontend) === CONFIG_ALLOWED_KEYS (daemon)
 *
 * The SSOT is the daemon. To change the wire shape: edit `src/protocol/session/`
 * (and `src/apps/web-daemon/server.ts` for config keys) FIRST, then re-mirror
 * the frontend copies until this test is green again.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")

const FRONTEND_PROTOCOL_PATH = join(
  REPO_ROOT,
  "apps/web-frontend/src/types/protocol.ts",
)
const FRONTEND_ENVELOPE_PATH = join(
  REPO_ROOT,
  "apps/web-frontend/src/ws/envelope.ts",
)
const FRONTEND_SLASH_KNOBS_PATH = join(
  REPO_ROOT,
  "apps/web-frontend/src/components/slash-knobs.ts",
)
const DAEMON_SERVER_PATH = join(REPO_ROOT, "src/apps/web-daemon/server.ts")

const readText = (path: string): string => readFileSync(path, "utf8")

/**
 * Extract the string literals carried by a discriminated union declared as
 * `export type <UnionName> = | A | B | …`, where each member interface `X`
 * declares its discriminant via `extends <EnvelopeName>"<literal>">`.
 *
 * Two-step so we only pick up the literals of interfaces that are ACTUALLY
 * union members (not every `extends …Envelope<"…">` in the file — though here
 * they coincide, the union scoping is the contract that matters).
 */
const extractUnionTypeLiterals = (
  source: string,
  unionName: string,
  envelopeName: string,
): Set<string> => {
  // 1. Grab the union member interface names from the `export type X = …` block.
  const unionRe = new RegExp(
    `export type ${unionName}\\s*=([\\s\\S]*?)(?:\\n\\n|\\nexport |\\n/\\*|$)`,
  )
  const unionMatch = unionName.length > 0 ? unionRe.exec(source) : null
  if (unionMatch === null) {
    throw new Error(`could not locate \`export type ${unionName} = …\` union block`)
  }
  const memberNames = (unionMatch[1].match(/[A-Za-z0-9_]+/g) ?? []).filter(
    (n) => n.length > 0,
  )

  // 2. For each member interface, resolve its discriminant literal from its
  //    `extends <envelopeName><"literal">` declaration.
  const literals = new Set<string>()
  for (const name of memberNames) {
    const ifaceRe = new RegExp(
      `interface ${name}\\b[\\s\\S]*?extends ${envelopeName}<"([^"]+)">`,
    )
    const ifaceMatch = ifaceRe.exec(source)
    if (ifaceMatch !== null) literals.add(ifaceMatch[1])
  }
  return literals
}

/**
 * Extract the members of a `new Set([ "A", "B", … ])` assigned to `constName`.
 * Used for the config-key allowlist mirrors on both the daemon and frontend.
 */
const extractSetLiterals = (source: string, constName: string): Set<string> => {
  const re = new RegExp(
    `${constName}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`,
  )
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = new Set([…])\``)
  }
  const literals = new Set<string>()
  for (const m of match[1].matchAll(/"([^"]+)"/g)) literals.add(m[1])
  return literals
}

/**
 * Extract the string-literal members of an ARRAY const:
 * `const NAME[: type] = [ "A", "B", … ]`. Used for the frontend `EVENT_TYPES`
 * decode gate in `envelope.ts` (a SECOND, runtime mirror of the event-type set
 * distinct from the `SessionEvent` union in `protocol.ts`). The gate is what
 * `decodeEventFrame` consults; if it drifts below the canonical set the daemon
 * can emit an event the client silently drops (frame AND seq lost).
 */
const extractArrayLiterals = (source: string, constName: string): Set<string> => {
  const re = new RegExp(`${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = [ … ]\` array literal`)
  }
  const literals = new Set<string>()
  for (const m of match[1].matchAll(/"([^"]+)"/g)) literals.add(m[1])
  return literals
}

/**
 * Extract a single string-literal const value:
 * `export const NAME = "literal" as const`.
 */
const extractStringConst = (source: string, constName: string): string => {
  const re = new RegExp(`${constName}\\s*=\\s*"([^"]+)"`)
  const match = re.exec(source)
  if (match === null) {
    throw new Error(`could not locate \`${constName} = "…"\``)
  }
  return match[1]
}

describe("wire-protocol drift contract: frontend copy === canonical daemon SSOT", () => {
  test("[events] frontend SessionEvent union === SESSION_EVENT_TYPES (both directions)", () => {
    const frontendEvents = extractUnionTypeLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SessionEvent",
      "SessionEventEnvelope",
    )
    const canonical = new Set<string>(SESSION_EVENT_TYPES)

    // Diagnostic-friendly: sorted-array compare so the failure prints the
    // exact missing/extra members.
    expect([...frontendEvents].sort()).toEqual([...canonical].sort())

    // Explicit both-directions set assertions (belt-and-suspenders).
    for (const t of canonical) {
      expect(frontendEvents.has(t)).toBe(true)
    }
    for (const t of frontendEvents) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[decode-gate] frontend envelope.ts EVENT_TYPES === SESSION_EVENT_TYPES (both directions)", () => {
    // The `SessionEvent` union (asserted above) is the TYPE-level mirror.
    // `EVENT_TYPES` in envelope.ts is the RUNTIME decode gate: `decodeEventFrame`
    // returns null for any `type` not in this array, and the client then DROPS
    // the frame (losing its seq, breaking resume). A past drift kept the union
    // in sync but let this array fall behind — so the daemon's `turn.llm.request`
    // / `turn.llm.continuation` events were silently dropped. Pin both directions.
    const gateTypes = extractArrayLiterals(
      readText(FRONTEND_ENVELOPE_PATH),
      "EVENT_TYPES",
    )
    const canonical = new Set<string>(SESSION_EVENT_TYPES)

    expect([...gateTypes].sort()).toEqual([...canonical].sort())

    for (const t of canonical) {
      expect(gateTypes.has(t)).toBe(true)
    }
    for (const t of gateTypes) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[commands] frontend SessionCommand union === SESSION_COMMAND_TYPES (both directions)", () => {
    const frontendCommands = extractUnionTypeLiterals(
      readText(FRONTEND_PROTOCOL_PATH),
      "SessionCommand",
      "SessionCommandEnvelope",
    )
    const canonical = new Set<string>(SESSION_COMMAND_TYPES)

    expect([...frontendCommands].sort()).toEqual([...canonical].sort())

    for (const t of canonical) {
      expect(frontendCommands.has(t)).toBe(true)
    }
    for (const t of frontendCommands) {
      expect(canonical.has(t)).toBe(true)
    }
  })

  test("[version] frontend SESSION_PROTOCOL_VERSION === canonical SESSION_PROTOCOL_VERSION", () => {
    const frontendVersion = extractStringConst(
      readText(FRONTEND_ENVELOPE_PATH),
      "SESSION_PROTOCOL_VERSION",
    )
    expect(frontendVersion).toBe(SESSION_PROTOCOL_VERSION)
  })

  test("[adr-0512] approval scopeContext field mirrored canonical ↔ frontend (additive, type set unchanged)", () => {
    // ADR-0512 P3 enriches the EXISTING `approval.requested` event with an
    // OPTIONAL `scopeContext` field on `PendingApprovalView` (the escalation
    // card payload). Adding a FIELD to an existing event interface must NOT add
    // a new SESSION_EVENT_TYPE — so the member-set guards above stay green. Pin
    // both: (a) the canonical type set still has exactly the legacy members
    // (no `permission_escalation_*` event type leaked in), and (b) the
    // `scopeContext` field literally appears in BOTH the canonical snapshot and
    // the frontend mirror so the card's read of it can never silently break.
    const canonical = new Set<string>(SESSION_EVENT_TYPES)
    expect(canonical.has("approval.requested")).toBe(true)
    // No NEW escalation event type — the enrichment is purely additive-field.
    for (const t of canonical) {
      expect(t.startsWith("permission_escalation")).toBe(false)
    }
    const canonicalSnapshot = readText(
      join(REPO_ROOT, "src/protocol/session/snapshot.ts"),
    )
    const frontendProtocol = readText(FRONTEND_PROTOCOL_PATH)
    for (const source of [canonicalSnapshot, frontendProtocol]) {
      expect(source).toContain("scopeContext")
      expect(source).toContain("activeSkill")
    }
  })

  test("[config] frontend CONFIG_WRITABLE_KEYS === daemon CONFIG_ALLOWED_KEYS (both directions)", () => {
    const frontendKeys = extractSetLiterals(
      readText(FRONTEND_SLASH_KNOBS_PATH),
      "CONFIG_WRITABLE_KEYS",
    )
    const daemonKeys = extractSetLiterals(
      readText(DAEMON_SERVER_PATH),
      "CONFIG_ALLOWED_KEYS",
    )

    expect([...frontendKeys].sort()).toEqual([...daemonKeys].sort())

    for (const k of daemonKeys) {
      expect(frontendKeys.has(k)).toBe(true)
    }
    for (const k of frontendKeys) {
      expect(daemonKeys.has(k)).toBe(true)
    }
  })
})
