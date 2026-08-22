/**
 * S-flip — gated default-flip hellgate for `QUANTA_SANDBOX`.
 *
 * Frontier gap (REPORT-jun26-tool-impl-vs-frontier.md §3 item-18, §4 fix-2):
 * Codex ships the OS sandbox ON by default (`workspace-write`); quanta ships
 * the engine COLD — unset / "default" installs nothing. All compilers,
 * plumbing, and the Codex `workspace-write` parity fixture already exist; the
 * only gap is the default.
 *
 * This is a GATED default-flip, NOT a blanket n=1 flip (measure-first):
 *   - new knob `QUANTA_SANDBOX_DEFAULT` (bool, default-OFF, lenient gateOn).
 *   - knob OFF  ⇒ BYTE-IDENTICAL to today: unset / "default" → passthrough
 *     (slot undefined / profile undefined). Reversible.
 *   - knob ON   ⇒ unset / "default" resolves to `workspace-write`
 *     (auto-detect backend handled by the slot's wrap()).
 *   - `QUANTA_SANDBOX=off` ALWAYS wins (explicit opt-out, even with knob ON).
 *   - an explicit profile ALWAYS wins (knob never downgrades it).
 *
 * red-on-injection: every ON-path assertion FAILS against the pre-flip
 * resolvers (which hard-code unset/"default" → undefined regardless of the
 * knob). The OFF-path assertions are the byte-identity safety net.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetShellSandbox,
  getShellSandbox,
  installShellSandbox,
  resolveSandboxProfileFromEnv,
} from "@/runtime"
import { buildCliOsSandbox } from "../../../src/apps/cli/sandbox-wire"

const envOf = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

afterEach(() => __resetShellSandbox())

/* ================================================================== */
/*  A. knob OFF — byte-identical passthrough (safety net)              */
/* ================================================================== */

describe("A. QUANTA_SANDBOX_DEFAULT OFF ⇒ byte-identical to pre-flip", () => {
  const offKnob = ["", "0", "off", "false"] as const
  const passthroughSandbox = ["", "default"] as const

  for (const knob of offKnob) {
    for (const sb of passthroughSandbox) {
      test(`HELL-A[knob="${knob || "EMPTY"}",QUANTA_SANDBOX="${sb || "EMPTY"}"]: profile undefined`, () => {
        const env = envOf({ QUANTA_SANDBOX_DEFAULT: knob, QUANTA_SANDBOX: sb })
        expect(resolveSandboxProfileFromEnv(env)).toBeUndefined()
        __resetShellSandbox()
        installShellSandbox(buildCliOsSandbox(env))
        expect(getShellSandbox()).toBeUndefined()
      })
    }
  }

  test("HELL-A[knob UNSET, QUANTA_SANDBOX UNSET]: profile undefined (default surface)", () => {
    const env = envOf({})
    expect(resolveSandboxProfileFromEnv(env)).toBeUndefined()
    __resetShellSandbox()
    installShellSandbox(buildCliOsSandbox(env))
    expect(getShellSandbox()).toBeUndefined()
  })
})

/* ================================================================== */
/*  B. knob ON — unset / "default" flips to workspace-write           */
/* ================================================================== */

describe("B. QUANTA_SANDBOX_DEFAULT ON ⇒ unset/default → workspace-write", () => {
  const onKnob = ["1", "on", "true", "yes"] as const
  const passthroughSandbox = ["", "default"] as const

  for (const knob of onKnob) {
    for (const sb of passthroughSandbox) {
      test(`HELL-B[knob="${knob}",QUANTA_SANDBOX="${sb || "EMPTY"}"]: profile workspace-write`, () => {
        const env = envOf({ QUANTA_SANDBOX_DEFAULT: knob, QUANTA_SANDBOX: sb })
        expect(resolveSandboxProfileFromEnv(env)).toBe("workspace-write")
        __resetShellSandbox()
        const slot = buildCliOsSandbox(env)
        installShellSandbox(slot)
        expect(slot).toBeDefined()
        expect(slot?.policy.profile).toBe("workspace-write")
      })
    }
  }

  test("HELL-B[knob ON, QUANTA_SANDBOX UNSET]: flips to workspace-write", () => {
    const env = envOf({ QUANTA_SANDBOX_DEFAULT: "1" })
    expect(resolveSandboxProfileFromEnv(env)).toBe("workspace-write")
    const slot = buildCliOsSandbox(env)
    expect(slot?.policy.profile).toBe("workspace-write")
  })
})

/* ================================================================== */
/*  C. explicit opt-out / explicit profile ALWAYS win over the knob    */
/* ================================================================== */

describe("C. explicit QUANTA_SANDBOX always wins over the default-flip knob", () => {
  test('HELL-C1: QUANTA_SANDBOX="off" passes through even with knob ON', () => {
    const env = envOf({ QUANTA_SANDBOX_DEFAULT: "1", QUANTA_SANDBOX: "off" })
    // env.ts resolver returns "off" (explicit opt-out sentinel), wire returns
    // undefined slot — both mean NO sandbox is installed.
    expect(resolveSandboxProfileFromEnv(env)).toBe("off")
    __resetShellSandbox()
    installShellSandbox(buildCliOsSandbox(env))
    expect(getShellSandbox()).toBeUndefined()
  })

  test('HELL-C2: explicit "read-only" is not downgraded by the knob', () => {
    const env = envOf({ QUANTA_SANDBOX_DEFAULT: "1", QUANTA_SANDBOX: "read-only" })
    expect(resolveSandboxProfileFromEnv(env)).toBe("read-only")
    const slot = buildCliOsSandbox(env)
    expect(slot?.policy.profile).toBe("read-only")
  })

  test('HELL-C3: explicit "danger-full-access" survives the knob', () => {
    const env = envOf({ QUANTA_SANDBOX_DEFAULT: "1", QUANTA_SANDBOX: "danger-full-access" })
    expect(resolveSandboxProfileFromEnv(env)).toBe("danger-full-access")
    const slot = buildCliOsSandbox(env)
    expect(slot?.policy.profile).toBe("danger-full-access")
  })
})
