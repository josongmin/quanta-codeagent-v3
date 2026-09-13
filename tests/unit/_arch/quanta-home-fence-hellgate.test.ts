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
import { tmpdir } from "node:os"
import { join } from "node:path"
import { benchHome } from "@/runner/batch/corpus/paths"
import { quantaHomeDir } from "@/shared/quanta-home"
import { runtimeConfig } from "@/shared/runtime-config"
import {
  decideQuantaHomeFence,
  FENCED_ROOTS,
  OUTRANKING_ROOTS,
  scratchPrefixesFor,
  staleScratchRoots,
} from "../../_support/quanta-home-fence"

const SCRATCH = "/tmp/quanta-test-home/4242"
const PREFIXES = scratchPrefixesFor("/var/folders/xy/T")
const decide = (env: Record<string, string | undefined>) =>
  decideQuantaHomeFence({ env, scratchRoot: SCRATCH, scratchPrefixes: PREFIXES })

describe("quanta-home fence — the policy", () => {
  test("an empty environment becomes a fresh operator: HOME, and the Quanta home under it", () => {
    expect(decide({})).toEqual({
      set: {
        HOME: join(SCRATCH, "home"),
        QUANTA_HOME: join(SCRATCH, "home", ".quanta"),
        QUANTA_PREFS_HOME: join(SCRATCH, "prefs-home"),
      },
      unset: [],
    })
  })

  test("a real HOME is replaced — a relocated Quanta home beside it is a mid-migration operator", () => {
    // The shape the first version produced: QUANTA_HOME at scratch, HOME real. The memory
    // probe then read `<HOME>/.quanta/memory/memory.sqlite` in place.
    const d = decide({ HOME: "/Users/me", QUANTA_HOME: "/tmp/w/home/.quanta" })
    expect(d.set.HOME).toBe(join(SCRATCH, "home"))
  })

  test("an operator's exported real roots do not aim the suite at their home", () => {
    const d = decide({
      HOME: "/Users/me",
      QUANTA_CONFIG_DIR: "/Users/me/.quanta",
      QUANTA_BENCH_HOME: "/Users/me/Library/quanta-codeagent-v3/bench",
      QUANTA_HOME: "/Users/me/relocated",
      QUANTA_PREFS_HOME: "/Users/me",
    })
    expect([...d.unset].sort()).toEqual(["QUANTA_BENCH_HOME", "QUANTA_CONFIG_DIR"])
    expect(d.set).toEqual({
      HOME: join(SCRATCH, "home"),
      QUANTA_HOME: join(SCRATCH, "home", ".quanta"),
      QUANTA_PREFS_HOME: join(SCRATCH, "prefs-home"),
    })
  })

  test("blank counts as unset, because every resolver reads blank as absent", () => {
    const d = decide({ HOME: " ", QUANTA_CONFIG_DIR: "  ", QUANTA_HOME: "" })
    expect(d.unset).toEqual(["QUANTA_CONFIG_DIR"])
    expect(d.set.HOME).toBe(join(SCRATCH, "home"))
    expect(d.set.QUANTA_HOME).toBe(join(SCRATCH, "home", ".quanta"))
  })

  test("a shard worker's roots are kept — the worker's TMPDIR is a SIBLING of its home", () => {
    // `run-test-shards.ts`: runRoot under the runner's tmpdir; worker TMPDIR=<root>/tmp,
    // HOME=<root>/home, QUANTA_HOME=<root>/home/.quanta. Matching only tmpdir() threw
    // these away, because <root>/home is not under <root>/tmp.
    const root = "/var/folders/y6/abc123/T/quanta-test-shards-Q1/worker-0"
    const workerPrefixes = scratchPrefixesFor(`${root}/tmp`)
    const d = decideQuantaHomeFence({
      env: {
        HOME: `${root}/home`,
        QUANTA_HOME: `${root}/home/.quanta`,
        QUANTA_PREFS_HOME: `${root}/prefs-home`,
      },
      scratchRoot: `${root}/tmp/quanta-test-home/7`,
      scratchPrefixes: workerPrefixes,
    })
    expect(d).toEqual({ set: {}, unset: [] })
  })

  test("roots a runner already pointed at scratch are kept, including the macOS alias", () => {
    const d = decide({
      HOME: "/private/var/folders/xy/T/worker/home",
      QUANTA_HOME: "/private/var/folders/xy/T/worker/home/.quanta",
      QUANTA_PREFS_HOME: "/tmp/w/prefs",
      QUANTA_CONFIG_DIR: "/var/folders/xy/T/cfg",
    })
    expect(d).toEqual({ set: {}, unset: [] })
  })

  test("a kept scratch HOME with a non-scratch Quanta home gets the home's own .quanta", () => {
    const d = decide({ HOME: "/tmp/w/home", QUANTA_HOME: "/Users/me/.quanta" })
    expect(d.set).toEqual({
      QUANTA_HOME: "/tmp/w/home/.quanta",
      QUANTA_PREFS_HOME: join(SCRATCH, "prefs-home"),
    })
  })

  test("a path that only LOOKS like scratch is not scratch", () => {
    // Prefix-by-string would accept `/tmpfoo` and `/tmp/../Users/me`; the user-temp
    // pattern must not accept a lookalike outside `/var/folders/<a>/<b>/T`.
    const d = decide({
      HOME: "/tmp/../Users/me",
      QUANTA_HOME: "/tmpfoo/home",
      QUANTA_PREFS_HOME: "/var/folders/xy/Tmp/prefs",
    })
    expect(Object.keys(d.set).sort()).toEqual(["HOME", "QUANTA_HOME", "QUANTA_PREFS_HOME"])
  })

  test("the fenced key sets are what the resolvers actually read", () => {
    expect([...OUTRANKING_ROOTS]).toEqual(["QUANTA_CONFIG_DIR", "QUANTA_BENCH_HOME"])
    expect([...FENCED_ROOTS]).toEqual(["HOME", "QUANTA_HOME", "QUANTA_PREFS_HOME"])
  })
})

describe("quanta-home fence — stale roots of killed runs", () => {
  test("only numeric roots of DEAD pids are returned; a live pid is never touched", () => {
    const alive = new Set([100, 300])
    expect(staleScratchRoots(["100", "200", "300", "notes", "400x"], (p) => alive.has(p))).toEqual([
      "200",
    ])
  })
})

describe("quanta-home fence — the canary, from inside a real test process", () => {
  // The account's home from the user database, NOT `os.userInfo().homedir`: in Bun that
  // follows the startup HOME (measured), so under a probe HOME it names the probe and the
  // canary would compare a root against itself.
  const passwdHome = Bun.spawnSync(["sh", "-c", 'eval "printf %s ~$(id -un)"']).stdout.toString()

  const inside = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)

  test("every resolver-reachable root points at scratch, not the passwd home", () => {
    expect(passwdHome.startsWith("/"), `no passwd home resolved: ${passwdHome}`).toBe(true)
    const roots: Record<string, string> = {
      // `env.HOME` is what the memory factory's pre-relocation probe reads; left real, it
      // opened the developer's existing store in place.
      HOME: process.env.HOME ?? "(unset)",
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
