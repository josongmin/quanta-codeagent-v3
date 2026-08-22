import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_STATE_MESSAGE_KINDS, AGENT_STATE_PROTOCOL_VERSION } from "@/protocol/agent-state"

/**
 * Wire-protocol drift contract (hellgate) — agent-state channel.
 *
 * The daemon owns the CANONICAL agent-state protocol in
 * `src/protocol/agent-state/messages.ts`. The web frontend lives OUTSIDE bun's
 * tsconfig `paths`, so it keeps a HAND-MAINTAINED COPY of the message union in
 * `apps/web-frontend/src/types/protocol.ts` (copy-not-import, same posture as
 * the canvas / session protocols) plus a runtime version pin in
 * `apps/web-frontend/src/ws/envelope.ts`.
 *
 * This channel is OUT-OF-BAND: it does NOT ride the in-band `SessionEvent`
 * union, so the existing `web-frontend-protocol-drift-contract-hellgate` is
 * BLIND to it. THIS guard is therefore the only thing that makes agent-state
 * drift impossible to merge. A drift here (a kind dropped from / renamed in the
 * frontend copy) silently drops a `plan.*` / `mode.changed` / `tool.progress` /
 * `context.compacted` / `ratelimit.snapshot` frame at the client.
 *
 * It imports the canonical kind list + version const, reads the frontend copy
 * AS TEXT (the frontend is a different toolchain — it cannot be `import`ed from
 * a bun test), extracts the `kind: "<literal>"` discriminants the union members
 * declare as INDEPENDENT TEXT ANCHORS (NOT `m1 === m2` — the canonical side is a
 * real `import`, the frontend side is parsed text, so the comparison cannot be
 * tautological), then asserts set-equality in BOTH directions + a version match.
 *
 * The SSOT is the daemon. To change the wire shape: edit
 * `src/protocol/agent-state/messages.ts` FIRST, then re-mirror the frontend copy
 * (`types/protocol.ts` + `ws/envelope.ts`) until this test is green again.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")

const FRONTEND_PROTOCOL_PATH = join(REPO_ROOT, "apps/web-frontend/src/types/protocol.ts")
const FRONTEND_ENVELOPE_PATH = join(REPO_ROOT, "apps/web-frontend/src/ws/envelope.ts")

const readText = (path: string): string => readFileSync(path, "utf8")

/**
 * Extract the discriminant literals of the frontend `AgentStateMessage` union
 * members. Each member is an interface declaring `readonly kind: "<literal>"`.
 * We FIRST scope to the union member-interface NAMES (the `export type
 * AgentStateMessage = | A | B | …` block) so a stray `kind: "…"` elsewhere in
 * the file (e.g. a canvas message interface) cannot leak in, THEN resolve each
 * named interface's `kind` literal. This is the independent TEXT anchor — it
 * never references the imported canonical set, so equality is load-bearing.
 */
const extractAgentStateKinds = (source: string): Set<string> => {
  const unionRe = /export type AgentStateMessage\s*=([\s\S]*?)(?:\n\n|\nexport |\n\/\*|$)/
  const unionMatch = unionRe.exec(source)
  const unionBody = unionMatch?.[1]
  if (unionBody === undefined) {
    throw new Error("could not locate `export type AgentStateMessage = …` union block")
  }
  const memberNames = (unionBody.match(/[A-Za-z0-9_]+/g) ?? []).filter((n) => n.length > 0)

  const literals = new Set<string>()
  for (const name of memberNames) {
    // Match the member interface body and pull its `kind: "<literal>"`.
    const ifaceRe = new RegExp(`interface ${name}\\b[\\s\\S]*?\\bkind:\\s*"([^"]+)"`)
    const ifaceMatch = ifaceRe.exec(source)
    const literal = ifaceMatch?.[1]
    if (literal !== undefined) literals.add(literal)
  }
  return literals
}

/** Extract a single string-literal const value: `const NAME = "literal" as const`. */
const extractStringConst = (source: string, constName: string): string => {
  const re = new RegExp(`${constName}\\s*=\\s*"([^"]+)"`)
  const value = re.exec(source)?.[1]
  if (value === undefined) throw new Error(`could not locate \`${constName} = "…"\``)
  return value
}

describe("agent-state drift contract: frontend copy === canonical daemon SSOT", () => {
  test("[kinds] frontend AgentStateMessage union === AGENT_STATE_MESSAGE_KINDS (both directions)", () => {
    const frontendKinds = extractAgentStateKinds(readText(FRONTEND_PROTOCOL_PATH))
    const canonical = new Set<string>(AGENT_STATE_MESSAGE_KINDS)

    // Sanity: the extractor actually found the 12 members (a regex that matched
    // nothing would make the both-directions loops vacuously pass).
    // Count = 9 original + 3 item.* kinds (item.started / item.delta / item.completed).
    expect(frontendKinds.size).toBe(12)
    expect(canonical.size).toBe(12)

    // Diagnostic-friendly: sorted-array compare prints the exact missing/extra.
    expect([...frontendKinds].sort()).toEqual([...canonical].sort())

    // Explicit both-directions set assertions (belt-and-suspenders).
    for (const k of canonical) {
      expect(frontendKinds.has(k)).toBe(true)
    }
    for (const k of frontendKinds) {
      expect(canonical.has(k)).toBe(true)
    }
  })

  test("[teeth] the extractor DETECTS a renamed kind (not vacuous)", () => {
    // Prove the guard has teeth: a frontend that renamed `plan.created` →
    // `plan.created.RENAMED` must produce a set that NO LONGER equals canonical.
    // If the extractor silently matched nothing, this would falsely pass.
    const mutated = readText(FRONTEND_PROTOCOL_PATH).replace(
      'kind: "plan.created"',
      'kind: "plan.created.RENAMED"',
    )
    const mutatedKinds = extractAgentStateKinds(mutated)
    const canonical = new Set<string>(AGENT_STATE_MESSAGE_KINDS)
    expect(mutatedKinds.has("plan.created")).toBe(false)
    expect(mutatedKinds.has("plan.created.RENAMED")).toBe(true)
    expect([...mutatedKinds].sort()).not.toEqual([...canonical].sort())
  })

  test("[version] frontend AGENT_STATE_PROTOCOL_VERSION (envelope.ts) === canonical", () => {
    // The frontend pins the same version string the daemon stamps (the copy
    // lives in `ws/envelope.ts`, where `decodeAgentStateFrame` consults it); a
    // mismatch makes the decoder reject EVERY frame (the version-pin gate),
    // silently rendering nothing.
    const frontendEnvelope = extractStringConst(
      readText(FRONTEND_ENVELOPE_PATH),
      "AGENT_STATE_PROTOCOL_VERSION",
    )
    expect(frontendEnvelope).toBe(AGENT_STATE_PROTOCOL_VERSION)
  })
})
