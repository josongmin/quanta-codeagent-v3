import { describe, expect, test } from "bun:test"
import { certifyDeclaredInputs } from "../../../tools/dev/verification-input-scope"

describe("declared input certification", () => {
  test("default is whole-tree", () => {
    expect(
      certifyDeclaredInputs({ id: "tests/unit/a.test.ts", source: "const x = 1", optIn: new Set() })
        .kind,
    ).toBe("whole-tree")
  })

  test("fs/spawn/computed import refuse certification", () => {
    const optIn = new Set(["tests/unit/a.test.ts"])
    expect(
      certifyDeclaredInputs({
        id: "tests/unit/a.test.ts",
        source: 'import { readFileSync } from "node:fs"',
        optIn,
      }).reason,
    ).toBe("forbidden-edge")
  })
})
