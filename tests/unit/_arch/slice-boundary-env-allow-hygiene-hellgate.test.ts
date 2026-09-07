/**
 * ★ CONTRACT — envAllowFiles entries must cover a live process.env/process.argv read.
 * Comments, dead names, and missing files do not justify a carve-out.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { findStaleEnvAllowEntries } from "./slice-boundary-scanner"

describe("slice-boundary env allow hygiene", () => {
  const root = "/virtual/src/agent"

  test("RED-ON-INJECTION: a carve-out over a file without a live read is stale", () => {
    expect(
      findStaleEnvAllowEntries(["stale.ts"], root, [
        {
          file: join(root, "stale.ts"),
          src: "// process.env.QUANTA_ONLY_IN_A_COMMENT\nexport const value = 1\n",
        },
      ]),
    ).toEqual(["stale.ts"])
  })

  test("CONTROL: a carve-out covering a live process.env read is retained", () => {
    expect(
      findStaleEnvAllowEntries(["from-env.ts"], root, [
        {
          file: join(root, "config", "from-env.ts"),
          src: "export const value = process.env.QUANTA_LIVE\n",
        },
      ]),
    ).toEqual([])
  })
})
