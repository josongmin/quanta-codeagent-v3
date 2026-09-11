import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parseShardRunnerOptions } from "../../../tools/dev/test-shard-options"

describe("shard runner options", () => {
  // The `afterEach` cleaned up after these cases and never established the
  // START state, so inside a campaign — where the gate exports
  // QUANTA_VERIFICATION_TIER — the very first parse already saw a tier nobody
  // here asked for. A test that reads the environment and does not control it
  // is testing the box it happens to run on.
  const ORIGINAL_TIER = process.env.QUANTA_VERIFICATION_TIER

  beforeEach(() => {
    delete process.env.QUANTA_TEST_CACHE
    delete process.env.QUANTA_VERIFICATION_TIER
  })

  afterEach(() => {
    delete process.env.QUANTA_TEST_CACHE
    if (ORIGINAL_TIER === undefined) delete process.env.QUANTA_VERIFICATION_TIER
    else process.env.QUANTA_VERIFICATION_TIER = ORIGINAL_TIER
  })

  // `--tier` is REQUIRED now: an absent tier used to select the whole universe
  // by omission. These cases are about the CACHE, so they carry a tier the way
  // every real invocation does rather than relying on the old default.
  const withTier = (args: readonly string[]): readonly string[] => ["--tier=pr", ...args]

  test("cache=off is parsed and env is an authority too", () => {
    expect(parseShardRunnerOptions(withTier(["--cache=off"])).cacheMode).toBe("off")
    expect(parseShardRunnerOptions(withTier(["--cache=read-write"])).cacheMode).toBe("read-write")
    process.env.QUANTA_TEST_CACHE = "off"
    expect(parseShardRunnerOptions(withTier([])).cacheMode).toBe("off")
    expect(parseShardRunnerOptions(withTier(["--cache=read-write"])).cacheMode).toBe("read-write")
  })

  test("unknown cache mode fails closed", () => {
    expect(() => parseShardRunnerOptions(withTier(["--cache=maybe"]))).toThrow(/unknown cache mode/)
  })

  test("tier is explicit, env-aware, and rejects the non-sharded smoke lane", () => {
    expect(parseShardRunnerOptions(["--tier=pr"]).tier).toBe("pr")
    process.env.QUANTA_VERIFICATION_TIER = "nightly"
    expect(parseShardRunnerOptions([]).tier).toBe("nightly")
    // `--tier=full` beside `QUANTA_VERIFICATION_TIER=nightly` is now a REFUSAL,
    // not a silent win for the flag: the caller believes one population and the
    // gate arranged another. Agreement still parses.
    expect(() => parseShardRunnerOptions(["--tier=full"])).toThrow(/contradicts/)
    expect(parseShardRunnerOptions(["--tier=nightly"]).tier).toBe("nightly")
    expect(() => parseShardRunnerOptions(["--tier=smoke"])).toThrow(/not a shard-runner tier/)
    expect(() => parseShardRunnerOptions(["--tier=unknown"])).toThrow(/unknown verification tier/)
  })
})
