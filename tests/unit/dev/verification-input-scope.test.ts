import { describe, expect, test } from "bun:test"
import {
  certifyDeclaredInputs,
  hashDeclaredInputs,
  WHOLE_TREE_INPUT_SCOPE_SHA256,
} from "../../../tools/dev/verification-input-scope"

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

  test("any whole-tree member keeps the chunk on the whole-tree digest", () => {
    const optIn = new Set(["pure.test.ts"])
    const mixed = hashDeclaredInputs([
      certifyDeclaredInputs({ id: "pure.test.ts", source: "const x = 1", optIn }),
      certifyDeclaredInputs({ id: "scan.test.ts", source: "const x = 1", optIn }),
    ])
    expect(mixed).toBe(WHOLE_TREE_INPUT_SCOPE_SHA256)
    expect(
      hashDeclaredInputs([
        certifyDeclaredInputs({ id: "pure.test.ts", source: "const x = 1", optIn }),
      ]),
    ).not.toBe(WHOLE_TREE_INPUT_SCOPE_SHA256)
  })
})
