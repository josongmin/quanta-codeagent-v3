/**
 * Public-surface pin (Phase 8.1 / audit C). The `@/sdk` barrel is the ONLY
 * door; this snapshot fails the moment an export is added or removed without an
 * intentional update here — so an internal refactor can never silently widen or
 * break the surface a consumer depends on.
 *
 * Types are erased at runtime, so this pins the VALUE exports (functions,
 * classes, consts). Type-only exports are covered by the `tsc` compile of
 * `embed.test.ts`, which imports them.
 *
 * jul-16 SDK ticket 01 (S7) — the WIRE door joins the surface: `connect` +
 * `transports`, the session.v1 codec + version + typed error set. And the
 * in-process quadrant's boundary is pinned NEGATIVELY (MASTER §3.3): the
 * `toSessionHandle` conformance oracle and any loopback/in-process transport
 * are asserted ABSENT — their non-exposure is a design decision, not an
 * accident.
 */

import { describe, expect, test } from "bun:test"
import * as sdk from "@/sdk"

const EXPECTED_VALUE_EXPORTS = [
  // façade
  "createAnalysisAgent",
  "DEFAULT_EVENT_BUFFER",
  "DEFAULT_PROFILE",
  // event narrowing
  "isDone",
  "isError",
  "isText",
  "isThinking",
  "isToolCall",
  "isToolResult",
  "isUsage",
  // tool authoring
  "defineTool",
  "defineToolAsync",
  // errors
  "NoCredentialError",
  "ToolRegistrationError",
  // test harness
  "fakeLlm",
  "RecordingStream",
  // version
  "version",
  // ── wire door (jul-16 ticket 01) ──
  "connect",
  "transports",
  // session.v1 codec + protocol version
  "decodeSessionCommand",
  "decodeSessionEvent",
  "decodeSessionSnapshot",
  "encodeSessionCommand",
  "encodeSessionEvent",
  "encodeSessionSnapshot",
  "SESSION_PROTOCOL_VERSION",
  // session.v1 typed errors (5종 rejected + version skew + client lifecycle)
  "SessionClosedError",
  "SessionDispatchFailedError",
  "SessionDuplicateCommandError",
  "SessionHandleClosedError",
  "SessionProtocolError",
  "SessionProtocolValidationError",
  "SessionProtocolVersionError",
  "SessionRevisionConflictError",
  "SessionTurnCorrelationLostError",
].sort()

describe("@/sdk public surface", () => {
  test("value exports match the pinned whitelist", () => {
    const actual = Object.keys(sdk)
      .filter((k) => (sdk as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS)
  })

  test("version is a semver string", () => {
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("the wire door's transports offer EXACTLY ws + stdio (no loopback/in-process door)", () => {
    // POSITIVE absence pin (MASTER §3.3): in-process consumption is
    // `createAnalysisAgent`; a public loopback transport would leak the
    // session factory quadrant. The transports table is a closed 2-entry set.
    expect(Object.keys(sdk.transports).sort()).toEqual(["stdio", "ws"])
  })

  test("the in-process conformance oracle (toSessionHandle) is NOT public", () => {
    // Internal-only proof (MASTER §3.3): the adapter exists for the transport
    // conformance suite; its absence from the barrel is the contract.
    expect((sdk as Record<string, unknown>).toSessionHandle).toBeUndefined()
    expect(EXPECTED_VALUE_EXPORTS).not.toContain("toSessionHandle")
  })
})
