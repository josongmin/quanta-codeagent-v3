// Hellgate — jun-6 SEAM-set default-OFF byte-identity (audit ROUND 2).
//
// The jun-04 collective default-off battery
// (jun04-default-off-byte-identity-hellgate.test.ts) proves the jun-04 gate set.
// The jun-6 seam knobs landed AFTER it and were NEVER added to its
// EXPECT_FALSE_GATES map, so their "default-OFF ⇒ byte-identical" claim was
// asserted NOWHERE — an unproven OFF-identity is a coverage gap (these are the
// HOST-DEFERRED seams whose only safety net IS the default-off posture: nothing
// consumes their knob yet, so a silently-flipped default would arm a half-wired
// path). This battery is the missing source-of-truth: every jun-6 seam knob is
// `false`/`undefined` at default AND flips ON only for the strict literal `"1"`.
//
// SCOPE: the jun-6 seam gates the prior battery omitted —
//   proactiveRateLimit (QUANTA_RATELIMIT_PROACTIVE) — account-ratelimit
//   surfaceDenyReason  (QUANTA_DENY_REASON)         — C6 deny-reason
//   mcpOAuthKeyring    (QUANTA_MCP_OAUTH_KEYRING)   — H18 keyring
//   sessionAutoTitle   (QUANTA_SESSION_AUTO_TITLE)  — ai-session-title
//   subagentQueue      (QUANTA_SUBAGENT_QUEUE)      — ADR-0487 admission queue
//   forceBackground    (QUANTA_FORCE_BACKGROUND)    — ADR-0487 force-bg tool
//   artifactStore      (QUANTA_ARTIFACT_STORE)      — C1 canvas
//   sideAgent          (QUANTA_SIDE_AGENT)          — N1
//   mcpConnectors      (QUANTA_MCP_CONNECTORS)      — N2
//   mcpResources       (QUANTA_MCP_RESOURCES)       — N3
//   appshot            (QUANTA_APPSHOT)             — G1
// plus the STRING knob sessionTitleModel (QUANTA_SESSION_TITLE_MODEL) which must
// be `undefined` at default (no cheap title model ⇒ auto-title inert).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"

/** Every jun-6 seam env knob that MUST be unset for a clean default posture. */
const JUN06_SEAM_KNOBS = [
  "QUANTA_RATELIMIT_PROACTIVE",
  "QUANTA_DENY_REASON",
  "QUANTA_MCP_OAUTH_KEYRING",
  "QUANTA_SESSION_AUTO_TITLE",
  "QUANTA_SESSION_TITLE_MODEL",
  "QUANTA_SUBAGENT_QUEUE",
  "QUANTA_FORCE_BACKGROUND",
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_SIDE_AGENT",
  "QUANTA_MCP_CONNECTORS",
  "QUANTA_MCP_RESOURCES",
  "QUANTA_APPSHOT",
  "QUANTA_FILE_HISTORY",
] as const

/** The STRICT-`1` seam gates: arm ONLY for the exact literal `"1"` (a hostile
 *  `true`/`on`/`yes`/` 1` must NOT enable). */
const STRICT_ONE_GATES: ReadonlyArray<{
  readonly field: keyof ReturnType<typeof runtimeConfig>
  readonly env: string
}> = [
  { field: "proactiveRateLimit", env: "QUANTA_RATELIMIT_PROACTIVE" },
  { field: "surfaceDenyReason", env: "QUANTA_DENY_REASON" },
  { field: "mcpOAuthKeyring", env: "QUANTA_MCP_OAUTH_KEYRING" },
  { field: "subagentQueue", env: "QUANTA_SUBAGENT_QUEUE" },
  { field: "forceBackground", env: "QUANTA_FORCE_BACKGROUND" },
  { field: "artifactStore", env: "QUANTA_ARTIFACT_STORE" },
  { field: "sideAgent", env: "QUANTA_SIDE_AGENT" },
  { field: "mcpConnectors", env: "QUANTA_MCP_CONNECTORS" },
  { field: "mcpResources", env: "QUANTA_MCP_RESOURCES" },
  { field: "appshot", env: "QUANTA_APPSHOT" },
  { field: "fileHistory", env: "QUANTA_FILE_HISTORY" },
]

/** `sessionAutoTitle` deliberately uses the STANDARD boolean vocabulary
 *  (`parseBool`: 1/true/on) rather than strict-`1`. It is asserted separately:
 *  still default-OFF (unset ⇒ false, `"0"`/`"false"` ⇒ false), just not strict. */
const STANDARD_BOOL_GATES: ReadonlyArray<{
  readonly field: keyof ReturnType<typeof runtimeConfig>
  readonly env: string
}> = [{ field: "sessionAutoTitle", env: "QUANTA_SESSION_AUTO_TITLE" }]

/** Every seam boolean gate (strict + standard) that MUST read `false` at
 *  default — the core "default-OFF ⇒ byte-identical" assertion. */
const SEAM_BOOL_GATES = [...STRICT_ONE_GATES, ...STANDARD_BOOL_GATES]

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of JUN06_SEAM_KNOBS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of JUN06_SEAM_KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

describe("jun-6 seam default-OFF — runtime-config gates", () => {
  test("every jun-6 seam boolean gate reads false with all knobs unset", () => {
    const c = runtimeConfig()
    const on: string[] = []
    for (const { field } of SEAM_BOOL_GATES) {
      if (c[field] !== false) on.push(field)
    }
    // LOUD: name every seam gate that is unexpectedly ON (would arm a half-wired
    // host-deferred path).
    expect(on).toEqual([])
  })

  test("sessionTitleModel (string knob) is undefined at default (auto-title inert)", () => {
    expect(runtimeConfig().sessionTitleModel).toBeUndefined()
  })

  test("each seam gate stays OFF for falsy/garbage, flips ON for any truthy token", () => {
    for (const { field, env } of STRICT_ONE_GATES) {
      // Falsy tokens / garbage must NOT enable the gate (default-OFF guarantee).
      for (const bad of ["0", "false", "off", "no", "", "garbage", "2"]) {
        process.env[env] = bad
        __resetRuntimeConfig()
        const c = runtimeConfig()
        if (c[field] !== false) {
          throw new Error(
            `${field} armed on falsy/garbage value ${JSON.stringify(bad)} (env ${env})`,
          )
        }
        delete process.env[env]
      }
      // The canonical truthy vocabulary (`gateOn`) ALL enables — `=1` and `=on`
      // alike, case-insensitive and whitespace-trimmed (the consistency win).
      for (const good of ["1", "on", "true", "yes", "TRUE", " 1 "]) {
        process.env[env] = good
        __resetRuntimeConfig()
        const c = runtimeConfig()
        if (c[field] !== true) {
          throw new Error(`${field} did NOT arm on truthy ${JSON.stringify(good)} (env ${env})`)
        }
        delete process.env[env]
      }
    }
    __resetRuntimeConfig()
    // Non-vacuous terminator: the per-iteration `throw`s above are the real
    // assertions; this guards against an empty gate table silently passing.
    expect(STRICT_ONE_GATES.length).toBeGreaterThan(0)
  })

  test("standard-boolean seam gate (sessionAutoTitle): off when unset/`0`/`false`, on for `1`", () => {
    for (const { field, env } of STANDARD_BOOL_GATES) {
      for (const off of ["0", "false", "FALSE", "off", ""]) {
        process.env[env] = off
        __resetRuntimeConfig()
        if (runtimeConfig()[field] !== false) {
          throw new Error(`${field} unexpectedly ON for off-value ${JSON.stringify(off)}`)
        }
        delete process.env[env]
      }
      process.env[env] = "1"
      __resetRuntimeConfig()
      if (runtimeConfig()[field] !== true) {
        throw new Error(`${field} did NOT arm on "1" (env ${env})`)
      }
      delete process.env[env]
    }
    __resetRuntimeConfig()
    expect(STANDARD_BOOL_GATES.length).toBeGreaterThan(0)
  })
})
