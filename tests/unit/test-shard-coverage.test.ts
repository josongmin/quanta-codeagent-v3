import { describe, expect, test } from "bun:test"
import { assertShardCoverage, parseShardDiscovery } from "../../tools/dev/test-shard-coverage"

describe("native Bun shard discovery receipt", () => {
  test("parses the native worker banner and binds it to the expected shard", () => {
    expect(parseShardDiscovery("--shard=3/8: running 472/3775 test files", "3/8")).toEqual({
      shard: "3/8",
      selected: 472,
      discovered: 3775,
    })
    expect(parseShardDiscovery("--shard=3/8: running 472/3775 test files", "4/8")).toBeUndefined()
  })

  test("rejects a missing worker, a changing corpus, an empty selection, and a non-partition", () => {
    const complete = Array.from({ length: 8 }, (_, index) => ({
      shard: `${index + 1}/8`,
      selected: index === 0 ? 3 : 2,
      discovered: 17,
    }))
    const [first, ...rest] = complete
    if (first === undefined) throw new Error("fixture must contain shard 1")
    expect(() => assertShardCoverage(complete, 8)).not.toThrow()
    expect(() => assertShardCoverage(complete.slice(1), 8)).toThrow(/missing/)
    expect(() => assertShardCoverage([{ ...first, discovered: 18 }, ...rest], 8)).toThrow(/changed/)
    expect(() => assertShardCoverage([{ ...first, selected: 0 }, ...rest], 8)).toThrow(/invalid/)
    expect(() => assertShardCoverage([{ ...first, selected: 4 }, ...rest], 8)).toThrow(
      /full partition/,
    )
  })
})
