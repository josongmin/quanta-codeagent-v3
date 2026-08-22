import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig } from "@/shared"
import {
  buildArgv,
  computeMaxWorkers,
  defaultNamespace,
  type HarnessConfig,
  harnessFlags,
  hostArch,
  resolveHarnessConfig,
} from "../../src/apps/bench/harness"

const ENV_KEYS = [
  "QUANTA_SWEBENCH_CACHE_LEVEL",
  "QUANTA_SWEBENCH_CLEAN",
  "QUANTA_SWEBENCH_MAX_WORKERS",
  "QUANTA_SWEBENCH_NAMESPACE",
  "QUANTA_SWEBENCH_FORCE_REBUILD",
] as const

const snapshotEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const restoreEnv = (snap: Record<string, string | undefined>): void => {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k]
    else process.env[k] = snap[k]
  }
}

describe("computeMaxWorkers", () => {
  test("1 core ⇒ 1 worker (floor at 1)", () => {
    expect(computeMaxWorkers(1)).toBe(1)
  })
  test("2 cores ⇒ 1 worker (75%=1.5 → floor 1)", () => {
    expect(computeMaxWorkers(2)).toBe(1)
  })
  test("4 cores ⇒ 3 workers", () => {
    expect(computeMaxWorkers(4)).toBe(3)
  })
  test("8 cores ⇒ 4 workers (capped at 4)", () => {
    expect(computeMaxWorkers(8)).toBe(4)
  })
  test("64 cores ⇒ still capped at 4 (Docker I/O bound)", () => {
    expect(computeMaxWorkers(64)).toBe(4)
  })
})

describe("hostArch + defaultNamespace", () => {
  test("hostArch returns arm64/x64/other", () => {
    const a = hostArch()
    expect(["arm64", "x64", "other"]).toContain(a)
  })
  test("defaultNamespace: arm64 pulls prebuilt (avoids local base-image build), x64 builds local", () => {
    expect(defaultNamespace("arm64")).toBe("swebench")
    expect(defaultNamespace("x64")).toBe("none")
    expect(defaultNamespace("other")).toBe("none")
  })
})

describe("resolveHarnessConfig (SOTA defaults)", () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = snapshotEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    restoreEnv(snap)
    __resetRuntimeConfig()
  })

  test("with no env ⇒ SOTA defaults (env, clean=false, namespace=arch-based, forceRebuild=false)", () => {
    const c = resolveHarnessConfig(8)
    expect(c.cacheLevel).toBe("env")
    expect(c.clean).toBe(false)
    // arch-based: arm64 hosts pull prebuilt (swebench), x64 build locally (none).
    expect(c.namespace).toBe(process.arch === "arm64" ? "swebench" : "none")
    expect(c.forceRebuild).toBe(false)
    expect(c.maxWorkers).toBe(4) // 8 cores → capped at 4
  })

  test("QUANTA_SWEBENCH_CACHE_LEVEL=instance is honored", () => {
    process.env.QUANTA_SWEBENCH_CACHE_LEVEL = "instance"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).cacheLevel).toBe("instance")
  })

  test("invalid CACHE_LEVEL falls back to 'env' with a stderr warn", () => {
    process.env.QUANTA_SWEBENCH_CACHE_LEVEL = "nuke"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).cacheLevel).toBe("env")
  })

  test("QUANTA_SWEBENCH_CLEAN=true flips clean on", () => {
    process.env.QUANTA_SWEBENCH_CLEAN = "true"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).clean).toBe(true)
  })

  test("QUANTA_SWEBENCH_MAX_WORKERS=8 overrides the cap", () => {
    process.env.QUANTA_SWEBENCH_MAX_WORKERS = "8"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).maxWorkers).toBe(8)
  })

  test("QUANTA_SWEBENCH_NAMESPACE=swebench keeps registry pull mode", () => {
    process.env.QUANTA_SWEBENCH_NAMESPACE = "swebench"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).namespace).toBe("swebench")
  })

  test("QUANTA_SWEBENCH_NAMESPACE=none forces local build override", () => {
    process.env.QUANTA_SWEBENCH_NAMESPACE = "none"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).namespace).toBe("none")
  })

  test("no QUANTA_SWEBENCH_NAMESPACE ⇒ arch-aware default (matches host)", () => {
    // No env override → defaultNamespace(hostArch()) is used.
    // arm64 host ⇒ "swebench" (pull prebuilt); x64 host ⇒ "none" (local build).
    const expected = process.arch === "arm64" ? "swebench" : "none"
    expect(resolveHarnessConfig(8).namespace).toBe(expected)
  })

  test("QUANTA_SWEBENCH_FORCE_REBUILD=1 flips forceRebuild on", () => {
    process.env.QUANTA_SWEBENCH_FORCE_REBUILD = "1"
    __resetRuntimeConfig()
    expect(resolveHarnessConfig(8).forceRebuild).toBe(true)
  })
})

describe("harnessFlags renders argv tokens", () => {
  test("default config emits expected tokens (no --force_rebuild when off)", () => {
    const c: HarnessConfig = {
      cacheLevel: "env",
      clean: false,
      maxWorkers: 4,
      namespace: "none",
      forceRebuild: false,
    }
    expect(harnessFlags(c)).toEqual([
      "--max_workers",
      "4",
      "--cache_level",
      "env",
      "--clean",
      "False",
    ])
  })

  test("forceRebuild=true appends --force_rebuild True", () => {
    const c: HarnessConfig = {
      cacheLevel: "env",
      clean: false,
      maxWorkers: 4,
      namespace: "none",
      forceRebuild: true,
    }
    const f = harnessFlags(c)
    expect(f).toContain("--force_rebuild")
    expect(f).toContain("True")
  })

  test("clean=true renders 'True', clean=false renders 'False'", () => {
    const on = harnessFlags({
      cacheLevel: "env",
      clean: true,
      maxWorkers: 1,
      namespace: "none",
      forceRebuild: false,
    })
    const off = harnessFlags({
      cacheLevel: "env",
      clean: false,
      maxWorkers: 1,
      namespace: "none",
      forceRebuild: false,
    })
    expect(on.includes("True")).toBe(true)
    expect(off.includes("False")).toBe(true)
  })
})

describe("python-swebench buildArgv consumes HarnessConfig", () => {
  test("SOTA default config: argv contains env/false/none, no --force_rebuild", () => {
    const cfg: HarnessConfig = {
      cacheLevel: "env",
      clean: false,
      maxWorkers: 4,
      namespace: "none",
      forceRebuild: false,
    }
    const argv = buildArgv("python", "/tmp/p.jsonl", "rid", "iid", "ds", cfg)
    expect(argv).toContain("--cache_level")
    expect(argv).toContain("env")
    expect(argv).toContain("--clean")
    expect(argv).toContain("False")
    expect(argv).toContain("--max_workers")
    expect(argv).toContain("4")
    expect(argv).not.toContain("--namespace")
    expect(argv).not.toContain("--force_rebuild")
    expect(argv).toContain("--dataset_name")
    expect(argv).toContain("ds")
  })

  test("OLD-default override (cache_level=none clean=True workers=1) still works", () => {
    const cfg: HarnessConfig = {
      cacheLevel: "none",
      clean: true,
      maxWorkers: 1,
      namespace: "none",
      forceRebuild: false,
    }
    const argv = buildArgv("python", "/tmp/p.jsonl", "rid", "iid", undefined, cfg)
    expect(argv).toContain("none")
    expect(argv).toContain("True")
    expect(argv).toContain("1")
    expect(argv).not.toContain("--dataset_name")
  })

  test("regression: WITHOUT explicit config, argv does NOT carry the old hardcoded 'none' default", () => {
    // The previous code hardcoded --cache_level=none. Resolved config defaults
    // to "env". Verify by checking the default-resolved argv at runtime.
    const snap = snapshotEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    __resetRuntimeConfig()
    try {
      const argv = buildArgv("python", "/tmp/p.jsonl", "rid", "iid", undefined)
      // argv contains --cache_level <something>; "env" is the new default.
      const i = argv.indexOf("--cache_level")
      expect(i).toBeGreaterThan(-1)
      expect(argv[i + 1]).toBe("env")
    } finally {
      restoreEnv(snap)
      __resetRuntimeConfig()
    }
  })
})
