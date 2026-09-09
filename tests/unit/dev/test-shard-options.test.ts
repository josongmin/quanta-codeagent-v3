import { afterEach, describe, expect, test } from "bun:test"
import { parseShardRunnerOptions } from "../../../tools/dev/test-shard-options"

describe("shard runner options", () => {
  afterEach(() => {
    delete process.env.QUANTA_TEST_CACHE
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
})
