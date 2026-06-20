/**
 * Hellgate — T-1 AuthPool manifest + resolver (jun-20 multi-auth fleet).
 *
 * Pins the contract the multi-account fleet stands on:
 *  - single-auth path is byte-identical when no pool is configured,
 *  - malformed manifests fail FAST (dup labels, empty labels, maxParallel<=0),
 *  - the resolver never reads token file CONTENTS (dry-run must stay blind).
 */
import { describe, expect, test } from "bun:test"
import {
  type AuthSource,
  describeAuthSource,
  parseAuthPoolManifest,
  resolveAuthLaunchFile,
  resolveAuthSource,
  selectAuthSourceLabel,
} from "@/apps/bench/auth-pool"

const GOOD_YAML = `
accounts:
  - label: acct-a
    auth_file: /home/me/.quanta/auth/chatgpt-a.json
    max_parallel: 6
    max_boxes: 1
    cooldown_base_sec: 90
  - label: acct-b
    auth_file: /home/me/.quanta/auth/chatgpt-b.json
    max_parallel: 6
`

describe("T-1 parseAuthPoolManifest", () => {
  test("parses a well-formed YAML manifest into typed accounts", () => {
    const src = parseAuthPoolManifest(GOOD_YAML)
    expect(src.kind).toBe("pool")
    if (src.kind !== "pool") throw new Error("expected pool")
    expect(src.accounts.map((a) => a.label)).toEqual(["acct-a", "acct-b"])
    expect(src.accounts[0]?.authFile).toBe("/home/me/.quanta/auth/chatgpt-a.json")
    expect(src.accounts[0]?.maxParallel).toBe(6)
    expect(src.accounts[0]?.maxBoxes).toBe(1)
    expect(src.accounts[0]?.cooldownBaseSec).toBe(90)
    // optional fields absent ⇒ undefined, not coerced
    expect(src.accounts[1]?.maxBoxes).toBeUndefined()
  })

  test("accepts JSON too (YAML superset) — camelCase keys", () => {
    const src = parseAuthPoolManifest(
      JSON.stringify({ accounts: [{ label: "x", authFile: "/a.json", maxParallel: 3 }] }),
    )
    if (src.kind !== "pool") throw new Error("expected pool")
    expect(src.accounts[0]?.maxParallel).toBe(3)
  })

  // RED if validation is dropped — duplicate labels would silently collide leases.
  test("rejects duplicate account labels", () => {
    const dup = `
accounts:
  - { label: same, auth_file: /a.json, max_parallel: 2 }
  - { label: same, auth_file: /b.json, max_parallel: 2 }
`
    expect(() => parseAuthPoolManifest(dup)).toThrow(/duplicate account label "same"/)
  })

  test("rejects empty / missing label", () => {
    const empty = `accounts:\n  - { label: "", auth_file: /a.json, max_parallel: 2 }`
    expect(() => parseAuthPoolManifest(empty)).toThrow(/label/)
  })

  test("rejects maxParallel <= 0", () => {
    const zero = `accounts:\n  - { label: a, auth_file: /a.json, max_parallel: 0 }`
    expect(() => parseAuthPoolManifest(zero)).toThrow(/max_parallel|maxParallel/)
    const neg = `accounts:\n  - { label: a, auth_file: /a.json, max_parallel: -1 }`
    expect(() => parseAuthPoolManifest(neg)).toThrow(/max_parallel|maxParallel/)
  })

  test("rejects non-integer maxParallel", () => {
    const frac = `accounts:\n  - { label: a, auth_file: /a.json, max_parallel: 2.5 }`
    expect(() => parseAuthPoolManifest(frac)).toThrow(/max_parallel|maxParallel/)
  })

  test("rejects empty accounts array and missing accounts key", () => {
    expect(() => parseAuthPoolManifest("accounts: []")).toThrow(/non-empty "accounts"/)
    expect(() => parseAuthPoolManifest("other: 1")).toThrow(/non-empty "accounts"/)
  })

  test("rejects missing auth_file", () => {
    expect(() => parseAuthPoolManifest(`accounts:\n  - { label: a, max_parallel: 2 }`)).toThrow(
      /auth_file|authFile/,
    )
  })
})

describe("T-1 resolveAuthSource", () => {
  test("unset pool ⇒ legacy single path, byte-identical to QUANTA_BENCH_AUTH_FILE", () => {
    const src = resolveAuthSource({ env: { QUANTA_BENCH_AUTH_FILE: "/custom/a.json" } })
    expect(src).toEqual({ kind: "single", authFile: "/custom/a.json" } satisfies AuthSource)
  })

  test("no env at all ⇒ single with the default ~/.quanta path (HOME-derived)", () => {
    const src = resolveAuthSource({ env: { HOME: "/home/u" } })
    expect(src).toEqual({
      kind: "single",
      authFile: "/home/u/.quanta/auth/chatgpt.json",
    } satisfies AuthSource)
  })

  test("--auth-file flag wins over QUANTA_BENCH_AUTH_FILE", () => {
    const src = resolveAuthSource({
      env: { QUANTA_BENCH_AUTH_FILE: "/env.json" },
      authFileArg: "/flag.json",
    })
    expect(src).toEqual({ kind: "single", authFile: "/flag.json" })
  })

  test("QUANTA_BENCH_AUTH_POOL selects pool; --auth-pool flag wins over env", () => {
    const dir = `/tmp/qbap-${process.pid}`
    const fs = require("node:fs") as typeof import("node:fs")
    fs.mkdirSync(dir, { recursive: true })
    const envManifest = `${dir}/env.yaml`
    const flagManifest = `${dir}/flag.yaml`
    fs.writeFileSync(envManifest, `accounts:\n  - { label: env, auth_file: /e.json, max_parallel: 1 }`)
    fs.writeFileSync(flagManifest, `accounts:\n  - { label: flag, auth_file: /f.json, max_parallel: 1 }`)

    const viaEnv = resolveAuthSource({ env: { QUANTA_BENCH_AUTH_POOL: envManifest } })
    if (viaEnv.kind !== "pool") throw new Error("expected pool from env")
    expect(viaEnv.accounts[0]?.label).toBe("env")

    const viaFlag = resolveAuthSource({
      env: { QUANTA_BENCH_AUTH_POOL: envManifest },
      authPoolArg: flagManifest,
    })
    if (viaFlag.kind !== "pool") throw new Error("expected pool from flag")
    expect(viaFlag.accounts[0]?.label).toBe("flag")
  })

  test("empty-string pool env is ignored (treated as unset) ⇒ single", () => {
    const src = resolveAuthSource({
      env: { QUANTA_BENCH_AUTH_POOL: "", QUANTA_BENCH_AUTH_FILE: "/a.json" },
    })
    expect(src).toEqual({ kind: "single", authFile: "/a.json" })
  })
})

describe("T-5 selectAuthSourceLabel", () => {
  test("pinning a pool source keeps only the named account", () => {
    const src = parseAuthPoolManifest(GOOD_YAML)
    const pinned = selectAuthSourceLabel(src, "acct-b")
    expect(pinned).toEqual({
      kind: "pool",
      accounts: [
        expect.objectContaining({
          label: "acct-b",
          authFile: "/home/me/.quanta/auth/chatgpt-b.json",
        }),
      ],
    })
  })

  test("pinning an unknown label fails fast", () => {
    const src = parseAuthPoolManifest(GOOD_YAML)
    expect(() => selectAuthSourceLabel(src, "missing")).toThrow(/unknown account label "missing"/)
  })

  test("pinning a disabled account fails fast", () => {
    const src = parseAuthPoolManifest(`
accounts:
  - { label: acct-a, auth_file: /a.json, max_parallel: 2 }
  - { label: acct-b, auth_file: /b.json, max_parallel: 2, disabled: true }
`)
    expect(() => selectAuthSourceLabel(src, "acct-b")).toThrow(/account label "acct-b" is disabled/)
  })

  test("--auth-label is rejected in single-auth mode", () => {
    expect(() =>
      selectAuthSourceLabel({ kind: "single", authFile: "/single.json" }, "acct-a"),
    ).toThrow(/requires auth pool mode/i)
  })
})

describe("T-5 resolveAuthLaunchFile", () => {
  test("single-auth returns the one auth file", () => {
    expect(resolveAuthLaunchFile({ kind: "single", authFile: "/single.json" })).toBe("/single.json")
  })

  test("pool auto-pick chooses the first enabled account", () => {
    const src = parseAuthPoolManifest(`
accounts:
  - { label: acct-a, auth_file: /a.json, max_parallel: 2, disabled: true }
  - { label: acct-b, auth_file: /b.json, max_parallel: 2 }
`)
    expect(resolveAuthLaunchFile(src)).toBe("/b.json")
  })

  test("all-disabled pool fails fast instead of falling back to a disabled account", () => {
    const src = parseAuthPoolManifest(`
accounts:
  - { label: acct-a, auth_file: /a.json, max_parallel: 2, disabled: true }
  - { label: acct-b, auth_file: /b.json, max_parallel: 2, disabled: true }
`)
    expect(() => resolveAuthLaunchFile(src)).toThrow(/no enabled accounts available/i)
  })
})

describe("T-1 describeAuthSource is token-blind", () => {
  test("summary carries labels but never reads or prints file contents", () => {
    const poolSrc = parseAuthPoolManifest(GOOD_YAML)
    const line = describeAuthSource(poolSrc)
    expect(line).toContain("acct-a")
    expect(line).toContain("acct-b")
    // It only ever holds the path, never the token — assert no token-shaped bytes.
    expect(line).not.toMatch(/access_token|refresh_token|eyJ/)
  })
})
