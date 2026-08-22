import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "../../dataset-family-token"
import { isLiveDataset } from "../../profiles/harness-spec"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import { buildSwebenchShim, ensureBoxSwebenchShimCurrent } from "./ec2-lifecycle"

// aug-22 HIGH-4 — the pip-spec / namespace DERIVATION is the family profile's
// `harnessSpec` port (ec2-lifecycle no longer owns a `family === "live"` compare;
// it calls the profile). These thin helpers drive that port so the historical
// assertions below keep their exact meaning.
const pipSpecFor = (
  datasetName: string,
  override?: string,
  family: DatasetFamily = "verified",
): string =>
  resolveDatasetFamilyProfile(family).harnessSpec({ datasetName, pipSpecOverride: override })
    .pipSpec
const namespaceFor = (
  datasetName: string,
  override?: string,
  family: DatasetFamily = "verified",
): string =>
  resolveDatasetFamilyProfile(family).harnessSpec({ datasetName, namespaceOverride: override })
    .namespace
/** A run is Live iff the dataset NAME looks Live OR the family's own profile says
 *  its harness is the Live fork — the same two signals `isLiveRun` folded, now
 *  read off the profile instead of a string compare. */
const isLiveRun = (datasetName: string, family: DatasetFamily): boolean =>
  pipSpecFor(datasetName, undefined, family) !== "swebench"

// RFC jun-29 — stock PyPI swebench KeyErrors on SWE-bench-Live repos (not in
// MAP_REPO_VERSION_TO_SPECS, measured `KeyError: 'conan-io/conan'`). The box grading shim
// must pull the SWE-bench-Live fork for a Live dataset; Verified/Pro stay on stock.
describe("harnessSpec.pipSpec (Live grading fix)", () => {
  test("SWE-bench-Live dataset ⇒ Live fork", () => {
    expect(pipSpecFor("SWE-bench-Live/SWE-bench-Live", undefined)).toBe(
      "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
    )
  })

  test("Verified / Pro / empty ⇒ stock swebench (byte-identical)", () => {
    expect(pipSpecFor("princeton-nlp/SWE-bench_Verified", undefined)).toBe("swebench")
    expect(pipSpecFor("ScaleAI/SWE-bench_Pro", undefined)).toBe("swebench")
    expect(pipSpecFor("", undefined)).toBe("swebench")
  })

  test("explicit QUANTA_SWEBENCH_PIP_SPEC override wins over derivation", () => {
    expect(pipSpecFor("SWE-bench-Live/SWE-bench-Live", "swebench==4.0.0")).toBe("swebench==4.0.0")
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
      expect(pipSpecFor(name, undefined)).toBe(
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

    expect(pipSpecFor("live-5.jsonl", undefined, "live")).toBe(
      "git+https://github.com/SWE-bench-Live/SWE-bench-Live",
    )
    expect(namespaceFor("live-5.jsonl", undefined, "live")).toBe("starryzhang")
  })

  test("family=verified/pro/undefined ⇒ stock (byte-identical)", () => {
    expect(isLiveRun("pro-5.jsonl", "pro")).toBe(false)
    expect(isLiveRun("verified-5.jsonl", "verified")).toBe(false)
    expect(pipSpecFor("verified-5.jsonl", undefined, "verified")).toBe("swebench")
    expect(namespaceFor("pro-5.jsonl", undefined, "pro")).toBe("swebench")
  })

  test("dataset NAME alone (no family) still detects Live (back-compat)", () => {
    expect(pipSpecFor("SWE-bench-Live/SWE-bench-Live", undefined)).toBe(
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
    // aug-22 HIGH-1: the family is a TYPED argument off the launch config. It
    // used to be read from the LAUNCHING process's ambient env, which only held
    // the right value because the composition root had mirrored argv into it.
    await ensureBoxSwebenchShimCurrent(session, "live")
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(true) // rewrote
    expect(cmds.some((c) => c.includes("import swebench"))).toBe(true) // re-warmed
  })

  test("shim already current (Live want, Live shim) ⇒ NO rewrite (fast no-op)", async () => {
    const fork = "git+https://github.com/SWE-bench-Live/SWE-bench-Live"
    const { session, cmds } = fakeSession(buildSwebenchShim(fork))
    await ensureBoxSwebenchShimCurrent(session, "live")
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false) // untouched
  })

  test("Verified want + Verified shim ⇒ NO rewrite (byte-identical reuse)", async () => {
    const { session, cmds } = fakeSession(buildSwebenchShim("swebench"))
    await ensureBoxSwebenchShimCurrent(session, "verified")
    expect(cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
  })

  // Wiring-proof (aug-22): an ambient env var claiming "live" can no longer flip
  // the shim decision — only the TYPED argument can. Paired control: the SAME
  // fake box goes the other way when the typed family really is live.
  test("ambient QUANTA_SWEBENCH_DATASET_FAMILY is NOT an authority for the shim", async () => {
    const stock = fakeSession(buildSwebenchShim("swebench"))
    await withEnv({ QUANTA_SWEBENCH_DATASET_FAMILY: "live" }, () =>
      ensureBoxSwebenchShimCurrent(stock.session, "verified"),
    )
    expect(stock.cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
    const live = fakeSession(buildSwebenchShim("swebench"))
    await ensureBoxSwebenchShimCurrent(live.session, "live")
    expect(live.cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(true)
  })
})

// audit Live CRITICAL-2: Live publishes prebuilt images under `starryzhang`, not the default
// `swebench` org; grading a Live repo against `swebench` can't find the image (measurement-hole
// counted as a miss). The namespace must auto-derive from the dataset, parallel to the pip-spec.
describe("harnessSpec.namespace (Live image-namespace fix)", () => {
  test("Live dataset (any spelling) ⇒ starryzhang", () => {
    expect(namespaceFor("SWE-bench-Live/SWE-bench-Live", undefined)).toBe("starryzhang")
    expect(namespaceFor("swebench-live.jsonl", undefined)).toBe("starryzhang")
  })

  test("Verified / Pro / empty ⇒ swebench (byte-identical)", () => {
    expect(namespaceFor("princeton-nlp/SWE-bench_Verified", undefined)).toBe("swebench")
    expect(namespaceFor("ScaleAI/SWE-bench_Pro", undefined)).toBe("swebench")
    expect(namespaceFor("", undefined)).toBe("swebench")
  })

  test("explicit QUANTA_SWEBENCH_NAMESPACE override wins", () => {
    expect(namespaceFor("SWE-bench-Live/SWE-bench-Live", "custom-ns")).toBe("custom-ns")
  })
})
