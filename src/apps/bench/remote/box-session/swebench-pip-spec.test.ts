import { describe, expect, test } from "bun:test"
import {
  buildSwebenchShim,
  ensureBoxSwebenchShimCurrent,
  isLiveDataset,
  isLiveRun,
  resolveSwebenchNamespace,
  resolveSwebenchPipSpec,
} from "./ec2-lifecycle"

// RFC jun-29 — stock PyPI swebench KeyErrors on SWE-bench-Live repos (not in
// MAP_REPO_VERSION_TO_SPECS, measured `KeyError: 'conan-io/conan'`). The box grading shim
// must pull the SWE-bench-Live fork for a Live dataset; Verified/Pro stay on stock.
describe("resolveSwebenchPipSpec (Live grading fix)", () => {
  test("SWE-bench-Live dataset ⇒ Live fork", () => {
    expect(resolveSwebenchPipSpec("SWE-bench-Live/SWE-bench-Live", undefined)).toBe(
      "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
    )
  })

  test("Verified / Pro / empty ⇒ stock swebench (byte-identical)", () => {
    expect(resolveSwebenchPipSpec("princeton-nlp/SWE-bench_Verified", undefined)).toBe("swebench")
    expect(resolveSwebenchPipSpec("ScaleAI/SWE-bench_Pro", undefined)).toBe("swebench")
    expect(resolveSwebenchPipSpec("", undefined)).toBe("swebench")
  })

  test("explicit QUANTA_SWEBENCH_PIP_SPEC override wins over derivation", () => {
    expect(resolveSwebenchPipSpec("SWE-bench-Live/SWE-bench-Live", "swebench==4.0.0")).toBe(
      "swebench==4.0.0",
    )
  })

  // audit HIGH-3: the earlier exact `includes("SWE-bench-Live")` silently fell back to
  // stock on any case/spelling drift → KeyError counted as a model MISS (worst direction).
  test("case/spelling variants of a Live dataset STILL pull the fork", () => {
    for (const name of [
      "SWE-bench-Live/SWE-bench-Live",
      "swebench-live.jsonl",
      "SWE-bench-live",
      "swe_bench_live",
      "/home/u/SWE_bench_Live.jsonl",
    ]) {
      expect(isLiveDataset(name)).toBe(true)
      expect(resolveSwebenchPipSpec(name, undefined)).toBe(
        "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
      )
    }
  })

  test("Verified / Pro names never read as Live (no false-positive)", () => {
    for (const name of [
      "princeton-nlp/SWE-bench_Verified",
      "ScaleAI/SWE-bench_Pro",
      "alive.jsonl",
    ]) {
      expect(isLiveDataset(name)).toBe(false)
    }
  })

  // audit r2 (a): the trailing `(?![a-z])` blocks `swebench-live` matching inside a longer word.
  test("`swebench-liveness` substring does NOT read as Live (boundary)", () => {
    expect(isLiveDataset("my-swebench-liveness-check")).toBe(false)
    expect(isLiveDataset("swebench-live")).toBe(true) // exact still matches
  })
})

// audit r2 BUG#1: the full-remote launch passes a LOCAL jsonl path (not the HF id) and signals
// Live via the FAMILY. Keying only off the dataset name made the fix inert — isLiveRun keys off
// EITHER signal, and the derivations take the family so a `--dataset-family live` run pulls the
// fork + starryzhang even with a non-Live (or empty) dataset name.
describe("isLiveRun + family-aware derivations (full-remote inert-fix)", () => {
  test("family=live forces Live even with a local path / empty name", () => {
    expect(isLiveRun("live-5.jsonl", "live")).toBe(true)
    expect(isLiveRun("", "live")).toBe(true)
    expect(isLiveRun("", "LIVE")).toBe(true) // case-insensitive family
    expect(resolveSwebenchPipSpec("live-5.jsonl", undefined, "live")).toBe(
      "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
    )
    expect(resolveSwebenchNamespace("live-5.jsonl", undefined, "live")).toBe("starryzhang")
  })

  test("family=verified/pro/undefined ⇒ stock (byte-identical)", () => {
    expect(isLiveRun("pro-5.jsonl", "pro")).toBe(false)
    expect(isLiveRun("verified-5.jsonl", undefined)).toBe(false)
    expect(resolveSwebenchPipSpec("verified-5.jsonl", undefined, "verified")).toBe("swebench")
    expect(resolveSwebenchNamespace("pro-5.jsonl", undefined, "pro")).toBe("swebench")
  })

  test("dataset NAME alone (no family) still detects Live (back-compat)", () => {
    expect(resolveSwebenchPipSpec("SWE-bench-Live/SWE-bench-Live", undefined)).toBe(
      "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
    )
  })
})

describe("buildSwebenchShim", () => {
  test("shq-quotes the spec into the uvx --from token", () => {
    expect(buildSwebenchShim("swebench")).toContain("--from 'swebench' ")
    expect(buildSwebenchShim("git+https://github.com/SWE-bench-Live/SWE-bench-Live")).toContain(
      "--from 'git+https://github.com/SWE-bench-Live/SWE-bench-Live' ",
    )
  })
})

// audit r2 BUG#2: a reused warm box keeps the shim from its ORIGINAL bootstrap. The self-heal
// must rewrite the shim when the on-box `--from` differs from what this run wants.
describe("ensureBoxSwebenchShimCurrent — stale-shim self-heal on reuse", () => {
  // Minimal fake BoxSession capturing ssh commands; replays a canned `cat ~/swebench-python`.
  const fakeSession = (onBoxShim: string) => {
    const cmds: string[] = []
    const session = {
      log: () => {},
      ssh: async (cmd: string) => {
        cmds.push(cmd)
        if (cmd.startsWith("cat ~/swebench-python"))
          return { code: 0, stdout: onBoxShim, stderr: "" }
        return { code: 0, stdout: "1.2.3", stderr: "" } // write / warm succeed
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal BoxSession stub for a pure-ish unit
    } as any
    return { session, cmds }
  }
  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      await fn()
    } finally {
      for (const k of Object.keys(env)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  }

  test("Verified box reused for a Live run ⇒ shim REWRITTEN (no KeyError)", async () => {
    const { session, cmds } = fakeSession(buildSwebenchShim("swebench"))
    await withEnv({ QUANTA_SWEBENCH_DATASET_FAMILY: "live" }, () =>
      ensureBoxSwebenchShimCurrent(session),
    )
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(true) // rewrote
    expect(cmds.some((c) => c.includes("import swebench"))).toBe(true) // re-warmed
  })

  test("shim already current (Live want, Live shim) ⇒ NO rewrite (fast no-op)", async () => {
    const fork = "git+https://github.com/SWE-bench-Live/SWE-bench-Live"
    const { session, cmds } = fakeSession(buildSwebenchShim(fork))
    await withEnv({ QUANTA_SWEBENCH_DATASET_FAMILY: "live" }, () =>
      ensureBoxSwebenchShimCurrent(session),
    )
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false) // untouched
  })

  test("Verified want + Verified shim ⇒ NO rewrite (byte-identical reuse)", async () => {
    const { session, cmds } = fakeSession(buildSwebenchShim("swebench"))
    await ensureBoxSwebenchShimCurrent(session)
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
  })
})

// audit Live CRITICAL-2: Live publishes prebuilt images under `starryzhang`, not the default
// `swebench` org; grading a Live repo against `swebench` can't find the image (measurement-hole
// counted as a miss). The namespace must auto-derive from the dataset, parallel to the pip-spec.
describe("resolveSwebenchNamespace (Live image-namespace fix)", () => {
  test("Live dataset (any spelling) ⇒ starryzhang", () => {
    expect(resolveSwebenchNamespace("SWE-bench-Live/SWE-bench-Live", undefined)).toBe("starryzhang")
    expect(resolveSwebenchNamespace("swebench-live.jsonl", undefined)).toBe("starryzhang")
  })

  test("Verified / Pro / empty ⇒ swebench (byte-identical)", () => {
    expect(resolveSwebenchNamespace("princeton-nlp/SWE-bench_Verified", undefined)).toBe("swebench")
    expect(resolveSwebenchNamespace("ScaleAI/SWE-bench_Pro", undefined)).toBe("swebench")
    expect(resolveSwebenchNamespace("", undefined)).toBe("swebench")
  })

  test("explicit QUANTA_SWEBENCH_NAMESPACE override wins", () => {
    expect(resolveSwebenchNamespace("SWE-bench-Live/SWE-bench-Live", "custom-ns")).toBe("custom-ns")
  })
})
