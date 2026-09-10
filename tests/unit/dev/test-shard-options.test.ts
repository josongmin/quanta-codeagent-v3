import { afterEach, describe, expect, test } from "bun:test"
import { parseShardRunnerOptions } from "../../../tools/dev/test-shard-options"

describe("shard runner options", () => {
  afterEach(() => {
    delete process.env.QUANTA_TEST_CACHE
    delete process.env.QUANTA_VERIFICATION_TIER
  })

  test("cache=off is parsed and env is an authority too", () => {
    expect(parseShardRunnerOptions(["--cache=off"]).cacheMode).toBe("off")
    expect(parseShardRunnerOptions(["--cache=read-write"]).cacheMode).toBe("read-write")
    process.env.QUANTA_TEST_CACHE = "off"
    expect(parseShardRunnerOptions([]).cacheMode).toBe("off")
    expect(parseShardRunnerOptions(["--cache=read-write"]).cacheMode).toBe("read-write")
  })

  test("unknown cache mode fails closed", () => {
    expect(() => parseShardRunnerOptions(["--cache=maybe"])).toThrow(/unknown cache mode/)
  })

  test("tier is explicit, env-aware, and rejects the non-sharded smoke lane", () => {
    expect(parseShardRunnerOptions(["--tier=pr"]).tier).toBe("pr")
    process.env.QUANTA_VERIFICATION_TIER = "nightly"
    expect(parseShardRunnerOptions([]).tier).toBe("nightly")
    expect(parseShardRunnerOptions(["--tier=full"]).tier).toBe("full")
    expect(() => parseShardRunnerOptions(["--tier=smoke"])).toThrow(/not a shard-runner tier/)
    expect(() => parseShardRunnerOptions(["--tier=unknown"])).toThrow(/unknown verification tier/)
  })
})
