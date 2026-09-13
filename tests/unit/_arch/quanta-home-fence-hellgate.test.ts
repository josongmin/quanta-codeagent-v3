/**
 * Hellgate — the test-suite fence keeps Quanta state out of the developer's home.
 *
 * Two halves. The POLICY (`tests/_support/quanta-home-fence.ts`) is driven over hostile
 * inputs, because a fence that exists only inside a preload is a fence nobody can test.
 * The CANARY asserts, from inside an ordinary test process, that every root a test can
 * reach through a resolver already points at scratch — which is only true if the preload
 * actually applied the policy.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { benchHome } from "@/runner/batch/corpus/paths"
import { quantaHomeDir } from "@/shared/quanta-home"
import { runtimeConfig } from "@/shared/runtime-config"
import {
  decideQuantaHomeFence,
  FENCED_ROOTS,
  OUTRANKING_ROOTS,
  scratchPrefixesFor,
} from "../../_support/quanta-home-fence"

const SCRATCH = "/tmp/quanta-test-home/4242"
const PREFIXES = scratchPrefixesFor("/var/folders/xy/T")
const decide = (env: Record<string, string | undefined>) =>
  decideQuantaHomeFence({ env, scratchRoot: SCRATCH, scratchPrefixes: PREFIXES })

describe("quanta-home fence — the policy", () => {
  test("an empty environment is fenced onto scratch", () => {
    expect(decide({})).toEqual({
      set: {
        QUANTA_HOME: join(SCRATCH, "quanta-home"),
        QUANTA_PREFS_HOME: join(SCRATCH, "prefs-home"),
      },
      unset: [],
    })
  })

  test("an operator's exported real roots do not aim the suite at their home", () => {
    const d = decide({
      QUANTA_CONFIG_DIR: "/Users/me/.quanta",
      QUANTA_BENCH_HOME: "/Users/me/Library/quanta-codeagent-v3/bench",
      QUANTA_HOME: "/Users/me/relocated",
      QUANTA_PREFS_HOME: "/Users/me",
    })
    expect([...d.unset].sort()).toEqual(["QUANTA_BENCH_HOME", "QUANTA_CONFIG_DIR"])
    expect(d.set.QUANTA_HOME).toBe(join(SCRATCH, "quanta-home"))
    expect(d.set.QUANTA_PREFS_HOME).toBe(join(SCRATCH, "prefs-home"))
  })

  test("blank counts as unset, because every resolver reads blank as absent", () => {
    const d = decide({ QUANTA_CONFIG_DIR: "  ", QUANTA_HOME: "" })
    expect(d.unset).toEqual(["QUANTA_CONFIG_DIR"])
    expect(d.set.QUANTA_HOME).toBe(join(SCRATCH, "quanta-home"))
  })

  test("roots a runner already pointed at scratch are kept, including the macOS alias", () => {
    const d = decide({
      QUANTA_HOME: "/private/var/folders/xy/T/worker/home/.quanta",
      QUANTA_PREFS_HOME: "/tmp/w/prefs",
      QUANTA_CONFIG_DIR: "/var/folders/xy/T/cfg",
    })
    expect(d).toEqual({ set: {}, unset: [] })
  })

  test("a path that only LOOKS like scratch is not scratch", () => {
    // Prefix-by-string would accept `/tmpfoo` and `/tmp/../Users/me`.
    const d = decide({ QUANTA_HOME: "/tmpfoo/home", QUANTA_PREFS_HOME: "/tmp/../Users/me" })
    expect(Object.keys(d.set).sort()).toEqual(["QUANTA_HOME", "QUANTA_PREFS_HOME"])
  })

  test("the fenced key sets are what the resolvers actually read", () => {
    expect([...OUTRANKING_ROOTS]).toEqual(["QUANTA_CONFIG_DIR", "QUANTA_BENCH_HOME"])
    expect(Object.keys(FENCED_ROOTS)).toEqual(["QUANTA_HOME", "QUANTA_PREFS_HOME"])
  })
})

describe("quanta-home fence — the canary, from inside a real test process", () => {
  const passwdHome = userInfo().homedir
  const inside = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)

  test("every resolver-reachable root points at scratch, not the passwd home", () => {
    const roots: Record<string, string> = {
      quantaHomeDir: quantaHomeDir(),
      benchHome: benchHome(),
      QUANTA_PREFS_HOME: process.env.QUANTA_PREFS_HOME ?? "(unset)",
    }
    for (const [name, value] of Object.entries(roots)) {
      expect(
        inside(value, passwdHome),
        `${name} resolves into the developer's home: ${value}`,
      ).toBe(false)
    }
    const prefixes = scratchPrefixesFor(tmpdir())
    for (const [name, value] of Object.entries(roots)) {
      expect(
        prefixes.some((p) => inside(value, p)),
        `${name} is not under a scratch root: ${value}`,
      ).toBe(true)
    }
  })

  test("the frozen runtime config agrees (the preload reset it after redirecting)", () => {
    const cfg = runtimeConfig()
    expect(cfg.centralConfigDir === undefined || !inside(cfg.centralConfigDir, passwdHome)).toBe(
      true,
    )
    expect(cfg.quantaHome === undefined || !inside(cfg.quantaHome, passwdHome)).toBe(true)
  })
})
