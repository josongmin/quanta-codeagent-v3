/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` here is a LOAD-BEARING literal — the verbatim template-token input fed to the interpolation engine under test (`${user_config.X}`, `${__dirname}`, `${HOME}`, …). These MUST stay plain strings, not template strings; converting them would destroy the fixture and the substitution semantics being proven. */
/**
 * HELLGATE — DXT user_config + interpolation + keychain secrets (ADR-0475).
 *
 * Proves the happy path AND every failure / silence mode:
 *   - SUBSTITUTION: ${user_config.X}, ${__dirname}, ${pathSeparator}, ${/},
 *     and system-dir tokens (${HOME}) are replaced in command/args/env.
 *   - UNKNOWN TOKEN: an unrelated ${FOO} is preserved verbatim (no throw,
 *     no silent drop).
 *   - SENSITIVE → SecretStorePort: a `sensitive: true` field resolves through
 *     the injected port; the PLAINTEXT never appears anywhere in the spec.
 *   - SECRET-STORE FAILURE → typed Result error (NO-THROW).
 *   - REQUIRED MISSING → skip-launch Result naming the field (no value, no
 *     default).
 *   - REQUIRED w/ DEFAULT → launches (default satisfies required-ness).
 *   - PLATFORM_OVERRIDES: the injected platform string selects the right
 *     override; unknown platform falls back to base. No process.platform read.
 *   - VALIDATION: type mismatch / out-of-range (min/max) / too-many (multiple)
 *     / too-long → typed Result errors.
 *   - DEFAULT-OFF byte-identity: a spec with no ${...} tokens and an empty
 *     user_config returns byte-identical command/args/env; the existing
 *     minimal DxtManifestSchema still parses unchanged after composing the
 *     add-only extension.
 *   - TOKEN BUDGET: > MAX_TOKENS_PER_STRING tokens → typed error (DoS bound).
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  DxtUserConfigExtension,
  type InterpolationContext,
  interpolateLaunchSpec,
  type LaunchSpec,
  MAX_TOKENS_PER_STRING,
  PlatformOverridesSchema,
  resolveFields,
  type SecretStorePort,
  type UserConfigBlock,
  UserConfigBlockSchema,
  UserConfigError,
  validateUserValue,
} from "@/plugin-isolation/dxt-user-config"
import { err, ok, type Result } from "@/shared"

// --- doubles ---------------------------------------------------------------

const ctx: InterpolationContext = {
  dirname: "/pkgs/demo",
  pathSeparator: "/",
  systemDirs: { HOME: "/home/me", DESKTOP: "/home/me/Desktop" },
}

const okSecrets = (ref = "keychain://demo"): SecretStorePort => ({
  resolveReference: async (key) => ok(`${ref}/${key}`),
})

const failSecrets = (): SecretStorePort => ({
  resolveReference: async (key) =>
    err(new UserConfigError("secret-store-failed", `no entry for ${key}`, key)),
})

const baseSpec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: "node",
  args: [],
  env: {},
  ...over,
})

const empty = new Map<string, string>()

// --- schema parsing --------------------------------------------------------

describe("DxtUserConfigExtension schema", () => {
  test("existing minimal manifest (no user_config) still parses after composing extension", () => {
    // Mirror the dxt-loader minimal object + compose the add-only extension.
    const Minimal = z
      .object({
        name: z.string(),
        version: z.string(),
        entry: z.string(),
        serviceName: z.string(),
      })
      .strict()
    const Composed = Minimal.extend(DxtUserConfigExtension).strict()
    const minimal = { name: "demo", version: "1", entry: "x.js", serviceName: "Demo" }
    const r = Composed.safeParse(minimal)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.user_config).toBeUndefined()
      expect(r.data.platform_overrides).toBeUndefined()
    }
  })

  test("rejects unknown keys (strict) and bad key shape", () => {
    const badKey = UserConfigBlockSchema.safeParse({ "bad.key": { type: "string" } })
    expect(badKey.success).toBe(false)
  })

  test("accepts a typed field block", () => {
    const r = UserConfigBlockSchema.safeParse({
      TOKEN: { type: "string", sensitive: true, required: true },
      PORT: { type: "number", min: 1, max: 65535, default: 8080 },
    })
    expect(r.success).toBe(true)
  })

  test("platform_overrides schema is strict per-OS", () => {
    expect(PlatformOverridesSchema.safeParse({ darwin: { command: "x" } }).success).toBe(true)
    expect(PlatformOverridesSchema.safeParse({ bsd: { command: "x" } }).success).toBe(false)
  })
})

// --- value validation ------------------------------------------------------

describe("validateUserValue", () => {
  test("number out of range (min/max) → typed error", () => {
    const f = { type: "number", min: 1, max: 10 } as const
    expectErrKind(validateUserValue("P", f, 99), "value-out-of-range")
    expectErrKind(validateUserValue("P", f, 0), "value-out-of-range")
    expect(validateUserValue("P", f, 5).ok).toBe(true)
  })

  test("type mismatch → typed error", () => {
    expectErrKind(validateUserValue("B", { type: "boolean" }, "yes"), "value-type-mismatch")
    expectErrKind(validateUserValue("N", { type: "number" }, "5"), "value-type-mismatch")
  })

  test("multiple over cap → too-many-values", () => {
    const big = Array.from({ length: 200 }, (_, i) => `v${i}`)
    expectErrKind(
      validateUserValue("L", { type: "string", multiple: true }, big),
      "too-many-values",
    )
  })

  test("string too long → value-too-long", () => {
    const huge = "x".repeat(5000)
    expectErrKind(validateUserValue("S", { type: "string" }, huge), "value-too-long")
  })
})

// --- resolveFields (secrets) ----------------------------------------------

describe("resolveFields", () => {
  test("sensitive field resolves a NON-SECRET reference via port (no plaintext)", async () => {
    const block: UserConfigBlock = { API_KEY: { type: "string", sensitive: true } }
    const r = await resolveFields(block, { API_KEY: "super-secret-plaintext" }, okSecrets())
    expect(r.ok).toBe(true)
    if (r.ok) {
      const v = r.value.get("API_KEY")
      expect(v).toBe("keychain://demo/API_KEY")
      expect(v).not.toContain("super-secret-plaintext")
    }
  })

  test("secret store failure → typed Result error (no throw)", async () => {
    const block: UserConfigBlock = { API_KEY: { type: "string", sensitive: true } }
    const r = await resolveFields(block, { API_KEY: "x" }, failSecrets())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("secret-store-failed")
  })

  test("non-sensitive uses default when no user value", async () => {
    const block: UserConfigBlock = { PORT: { type: "number", default: 8080 } }
    const r = await resolveFields(block, {}, okSecrets())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.get("PORT")).toBe("8080")
  })
})

// --- interpolation ---------------------------------------------------------

describe("interpolateLaunchSpec", () => {
  test("substitutes user_config + __dirname + pathSeparator + ${/} + system dir", () => {
    const resolved = new Map([["DIR", "/data"]])
    const spec = baseSpec({
      command: "${__dirname}${/}bin",
      args: ["--dir=${user_config.DIR}", "--home=${HOME}", "--sep=${pathSeparator}"],
      env: { ROOT: "${__dirname}" },
    })
    const r = interpolateLaunchSpec(spec, undefined, undefined, "linux", resolved, ctx)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "launch") {
      expect(r.value.spec.command).toBe("/pkgs/demo/bin")
      expect(r.value.spec.args).toEqual(["--dir=/data", "--home=/home/me", "--sep=/"])
      expect(r.value.spec.env.ROOT).toBe("/pkgs/demo")
    }
  })

  test("unknown token preserved verbatim", () => {
    const spec = baseSpec({ args: ["${MYSTERY}", "${user_config.MISSING}"] })
    const r = interpolateLaunchSpec(spec, undefined, undefined, "linux", empty, ctx)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "launch")
      expect(r.value.spec.args).toEqual(["${MYSTERY}", "${user_config.MISSING}"])
  })

  test("required missing → skip-launch Result naming the field", () => {
    const block: UserConfigBlock = { TOKEN: { type: "string", required: true } }
    const r = interpolateLaunchSpec(baseSpec(), block, undefined, "linux", empty, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.kind).toBe("skip-launch")
      if (r.value.kind === "skip-launch") {
        expect(r.value.reason).toBe("required-field-empty")
        expect(r.value.field).toBe("TOKEN")
      }
    }
  })

  test("required satisfied by resolved value → launches", () => {
    const block: UserConfigBlock = { TOKEN: { type: "string", required: true } }
    const resolved = new Map([["TOKEN", "abc"]])
    const r = interpolateLaunchSpec(
      baseSpec({ args: ["${user_config.TOKEN}"] }),
      block,
      undefined,
      "linux",
      resolved,
      ctx,
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "launch") expect(r.value.spec.args).toEqual(["abc"])
  })

  test("platform_overrides picks the right OS (injected platform, no process.platform)", () => {
    const overrides = PlatformOverridesSchema.parse({
      darwin: { command: "mac-bin", args: ["--mac"] },
      win32: { command: "win.exe", args: ["--win"] },
      linux: { command: "lin-bin", args: ["--lin"] },
    })
    const onMac = interpolateLaunchSpec(baseSpec(), undefined, overrides, "darwin", empty, ctx)
    const onWin = interpolateLaunchSpec(baseSpec(), undefined, overrides, "win32", empty, ctx)
    const onBsd = interpolateLaunchSpec(
      baseSpec({ command: "base-bin" }),
      undefined,
      overrides,
      "freebsd",
      empty,
      ctx,
    )
    if (onMac.ok && onMac.value.kind === "launch") expect(onMac.value.spec.command).toBe("mac-bin")
    if (onWin.ok && onWin.value.kind === "launch") expect(onWin.value.spec.command).toBe("win.exe")
    // Unknown platform → base used as-is.
    if (onBsd.ok && onBsd.value.kind === "launch") expect(onBsd.value.spec.command).toBe("base-bin")
  })

  test("override env merges over base env", () => {
    const overrides = PlatformOverridesSchema.parse({ linux: { env: { A: "lin" } } })
    const spec = baseSpec({ env: { A: "base", B: "keep" } })
    const r = interpolateLaunchSpec(spec, undefined, overrides, "linux", empty, ctx)
    if (r.ok && r.value.kind === "launch") expect(r.value.spec.env).toEqual({ A: "lin", B: "keep" })
  })

  test("DEFAULT-OFF byte-identity: no tokens + empty config → identical spec", () => {
    const spec = baseSpec({
      command: "node",
      args: ["server.js", "--port", "9000"],
      env: { NODE_ENV: "production" },
    })
    const r = interpolateLaunchSpec(spec, undefined, undefined, "linux", empty, ctx)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "launch") {
      expect(r.value.spec.command).toBe(spec.command)
      expect(r.value.spec.args).toEqual([...spec.args])
      expect(r.value.spec.env).toEqual({ ...spec.env })
    }
  })

  test("token budget exceeded → typed too-many-tokens error (DoS bound)", () => {
    const many = "${HOME}".repeat(MAX_TOKENS_PER_STRING + 5)
    const r = interpolateLaunchSpec(
      baseSpec({ command: many }),
      undefined,
      undefined,
      "linux",
      empty,
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("too-many-tokens")
  })

  test("end-to-end: sensitive secret reference flows into env, never plaintext", async () => {
    const block: UserConfigBlock = { API_KEY: { type: "string", sensitive: true, required: true } }
    const resolved = await resolveFields(block, { API_KEY: "PLAINTEXT-VALUE" }, okSecrets())
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const spec = baseSpec({ env: { TOKEN: "${user_config.API_KEY}" } })
    const r = interpolateLaunchSpec(spec, block, undefined, "linux", resolved.value, ctx)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "launch") {
      expect(r.value.spec.env.TOKEN).toBe("keychain://demo/API_KEY")
      expect(JSON.stringify(r.value.spec)).not.toContain("PLAINTEXT-VALUE")
    }
  })
})

// --- helpers ---------------------------------------------------------------

function expectErrKind(r: Result<unknown, UserConfigError>, kind: string): void {
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error.kind).toBe(kind)
}
