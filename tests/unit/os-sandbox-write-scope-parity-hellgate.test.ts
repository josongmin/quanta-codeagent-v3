/**
 * aug-22 — CROSS-BACKEND WRITE-SCOPE PARITY hellgate.
 *
 * WHY THIS FILE EXISTS (the regression class it kills):
 * every OS-sandbox backend used to answer "is path P writable?" from its own
 * per-file reading of `SandboxPolicy`, and each backend's own hellgate pinned
 * that reading. Two of them pinned OPPOSITE contracts and both stayed green
 * forever:
 *   - seatbelt-verbatim-hellgate  "read-only honors explicit scoped extraWritePaths"
 *   - os-sandbox-windows-hellgate "read-only drops extraWritePaths"
 * The divergence was invisible to CI and shipped as a silent, host-dependent
 * failure: `bash(mode:"read")` passes a caller-owned TMPDIR scratch dir through
 * `extraWritePaths` (src/tool/bash/index.ts `createReadModeTempScope`), so on a
 * Linux host WITHOUT bwrap (per-call.ts falls back to landlock-cli) every
 * here-doc / `mktemp` / python `tempfile` in read mode died with EACCES, while
 * the identical command succeeded on macOS and on bwrap hosts.
 *
 * The fix is structural, not per-backend: ONE policy matrix is fed to ALL
 * compilers and the write verdict must agree — with each other AND with the
 * contract table documented on `SandboxPolicy.extraWritePaths`.
 *
 * Not covered here (documented, not silently ignored): the native Landlock
 * backend decides write access in Rust
 * (`crates/linux-sandbox-native/src/policy.rs`), where `extra_write_paths`
 * currently reuses the profile's access set and therefore lands READ-only on
 * `read-only` — a known non-conformance that this TS suite cannot compile.
 * What IS pinned here is the TS half of that backend: `mapPolicyToNapi` must
 * forward the extras verbatim rather than dropping them before the boundary.
 */
import { describe, expect, test } from "bun:test"
import {
  compileBubblewrapArgs,
  compileLandlockCliArgs,
  compileSeatbeltProfile,
  compileWindowsSandboxSpec,
  mapPolicyToNapi,
  type SandboxPolicy,
} from "@/runtime/os-sandbox"

const WS = "/ws"
/** Shape a real caller uses: `createReadModeTempScope` mkdtemps under TMPDIR. */
const SCRATCH = "/tmp/quanta-scratch"
/** Ambient path no policy in the matrix ever names. */
const OUTSIDE = "/etc"

/* ------------------------------------------------------------------ */
/*  per-backend write verdict: "does the compiled artifact grant       */
/*  write access to exactly this path?"                                */
/* ------------------------------------------------------------------ */

/** Seatbelt: a `(allow file-write* ...)` clause naming the path's subpath. */
const seatbeltGrantsWrite = (policy: SandboxPolicy, path: string): boolean => {
  const profile = compileSeatbeltProfile(policy, WS)
  if (profile === null) throw new Error("compileSeatbeltProfile returned null for a compiled arm")
  return profile
    .split("\n")
    .filter((l) => l.startsWith("(allow file-write*"))
    .some((l) => l.includes(`(subpath "${path}")`))
}

/** Bubblewrap: a read-write `--bind p p` pair (NOT `--ro-bind`). */
const bubblewrapGrantsWrite = (policy: SandboxPolicy, path: string): boolean => {
  const args = compileBubblewrapArgs(policy, WS)
  if (args === null) throw new Error("compileBubblewrapArgs returned null for a compiled arm")
  return args.some((tok, i) => tok === "--bind" && args[i + 1] === path && args[i + 2] === path)
}

/** landlock-cli: the path appears in the comma-joined `--rw-paths` list. */
const landlockCliGrantsWrite = (policy: SandboxPolicy, path: string): boolean => {
  const args = compileLandlockCliArgs(policy, WS)
  if (args === null) throw new Error("compileLandlockCliArgs returned null for a compiled arm")
  const idx = args.indexOf("--rw-paths")
  if (idx === -1) return false
  return (args[idx + 1] ?? "").split(",").includes(path)
}

/** Windows: the path carries an explicit write ACL in the compiled spec. */
const windowsGrantsWrite = (policy: SandboxPolicy, path: string): boolean => {
  const spec = compileWindowsSandboxSpec(policy, WS)
  if (spec === null) throw new Error("compileWindowsSandboxSpec returned null for a compiled arm")
  return spec.writePaths.includes(path)
}

const BACKENDS = [
  { name: "seatbelt", grantsWrite: seatbeltGrantsWrite },
  { name: "bubblewrap", grantsWrite: bubblewrapGrantsWrite },
  { name: "landlock-cli", grantsWrite: landlockCliGrantsWrite },
  { name: "windows", grantsWrite: windowsGrantsWrite },
] as const

/* ------------------------------------------------------------------ */
/*  the contract matrix                                                */
/* ------------------------------------------------------------------ */

interface MatrixCase {
  readonly name: string
  readonly policy: SandboxPolicy
  /** Expected write verdict per probe path — the CONTRACT, not a snapshot of
   *  whatever the compilers happen to agree on (mutual agreement alone would
   *  also accept "every backend drops extras", the very bug being fixed). */
  readonly expect: { readonly [path: string]: boolean }
}

const MATRIX: readonly MatrixCase[] = [
  {
    name: "read-only / no extras",
    policy: { profile: "read-only" },
    expect: { [WS]: false, [SCRATCH]: false, [OUTSIDE]: false },
  },
  {
    name: "read-only / extras",
    policy: { profile: "read-only", extraWritePaths: [SCRATCH] },
    // Workspace stays DENIED (that is what read-only means); the caller-owned
    // scratch scope is granted (that is what extraWritePaths means).
    expect: { [WS]: false, [SCRATCH]: true, [OUTSIDE]: false },
  },
  {
    name: "workspace-write / no extras",
    policy: { profile: "workspace-write" },
    expect: { [WS]: true, [SCRATCH]: false, [OUTSIDE]: false },
  },
  {
    name: "workspace-write / extras",
    policy: { profile: "workspace-write", extraWritePaths: [SCRATCH] },
    expect: { [WS]: true, [SCRATCH]: true, [OUTSIDE]: false },
  },
  {
    name: "workspace-write-net / extras (network arm must not move FS scope)",
    policy: { profile: "workspace-write-net", extraWritePaths: [SCRATCH] },
    expect: { [WS]: true, [SCRATCH]: true, [OUTSIDE]: false },
  },
]

describe("HELL-WSP — write scope is identical across every sandbox compiler", () => {
  for (const c of MATRIX) {
    for (const [path, want] of Object.entries(c.expect)) {
      test(`HELL-WSP-A: ${c.name} — write(${path}) === ${want} on ALL backends`, () => {
        const verdicts = BACKENDS.map((b) => ({
          backend: b.name,
          writable: b.grantsWrite(c.policy, path),
        }))
        // Failure message names the divergent backend instead of "expected
        // true, got false" with no attribution.
        expect(verdicts).toEqual(BACKENDS.map((b) => ({ backend: b.name, writable: want })))
      })
    }
  }

  test("HELL-WSP-B: extras are the ONLY thing read-only adds — cross-checked pairwise", () => {
    const bare: SandboxPolicy = { profile: "read-only" }
    const withExtras: SandboxPolicy = { profile: "read-only", extraWritePaths: [SCRATCH] }
    for (const b of BACKENDS) {
      // The scratch scope flips false → true...
      expect({ backend: b.name, before: b.grantsWrite(bare, SCRATCH) }).toEqual({
        backend: b.name,
        before: false,
      })
      expect({ backend: b.name, after: b.grantsWrite(withExtras, SCRATCH) }).toEqual({
        backend: b.name,
        after: true,
      })
      // ...and nothing else does: the workspace stays denied on both.
      expect({ backend: b.name, ws: b.grantsWrite(withExtras, WS) }).toEqual({
        backend: b.name,
        ws: false,
      })
    }
  })

  test("HELL-WSP-C: opt-out arms — every compiler agrees on null (verbatim passthrough)", () => {
    for (const profile of ["off", "danger-full-access"] as const) {
      const policy: SandboxPolicy = { profile, extraWritePaths: [SCRATCH] }
      expect({
        profile,
        seatbelt: compileSeatbeltProfile(policy, WS),
        bubblewrap: compileBubblewrapArgs(policy, WS),
        landlockCli: compileLandlockCliArgs(policy, WS),
        windows: compileWindowsSandboxSpec(policy, WS),
      }).toEqual({
        profile,
        seatbelt: null,
        bubblewrap: null,
        landlockCli: null,
        windows: null,
      })
    }
  })

  test("HELL-WSP-D: relative extras resolve against the workspace on read-only too", () => {
    // Both path-resolving compilers must apply the SAME resolution rule on the
    // read-only arm they used to skip entirely. (bubblewrap / landlock-cli
    // intentionally drop relative extras — they require absolute paths — so
    // this arm covers the two resolvers.)
    const policy: SandboxPolicy = { profile: "read-only", extraWritePaths: ["scratch"] }
    expect(seatbeltGrantsWrite(policy, `${WS}/scratch`)).toBe(true)
    expect(compileWindowsSandboxSpec(policy, WS)?.writePaths).toEqual([`${WS}\\scratch`])
  })

  test("HELL-WSP-E: landlock-native TS mapper forwards read-only extras verbatim", () => {
    // The Rust side (crates/linux-sandbox-native/src/policy.rs) decides the
    // access bits; the TS boundary must not pre-drop the scopes on read-only.
    const napi = mapPolicyToNapi({ profile: "read-only", extraWritePaths: [SCRATCH] }, WS)
    expect(napi.extraWritePaths).toEqual([SCRATCH])
  })
})
