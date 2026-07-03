/**
 * Public-surface pin (Phase 8.1 / audit C). The `@/sdk` barrel is the ONLY
 * door; this snapshot fails the moment an export is added or removed without an
 * intentional update here — so an internal refactor can never silently widen or
 * break the surface a consumer depends on.
 *
 * Types are erased at runtime, so this pins the VALUE exports (functions,
 * classes, consts). Type-only exports are covered by the `tsc` compile of
 * `embed.test.ts`, which imports them.
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
})
