/**
 * Track A2 — named-permission-profile session-start WIRE hellgate.
 *
 * The registry + `TwoLayerManager.setPermissionProfileByName` already existed
 * but NOTHING in production resolved an operator-supplied name at session start.
 * This battery seals the composition-root wire: the env knob
 * `QUANTA_PERMISSION_PROFILE` + the `--permission-profile <name>` CLI flag now
 * resolve fail-closed and apply through the existing by-name manager path,
 * publishing the manager on the assembled base.
 *
 *   HELL-A2W-01  parser accepts `--permission-profile default|restricted|trusted`.
 *   HELL-A2W-02  parser rejects an unknown `--permission-profile` value (exit-64).
 *   HELL-A2W-03  absent flag ⇒ no `permissionProfile` field on AgentArgs.
 *   HELL-A2W-04  buildBaseFromArgs: known env name ⇒ manager published + profile
 *                registered under the session thread (resolves to the registry struct).
 *   HELL-A2W-05  buildBaseFromArgs: flag WINS over a conflicting env value.
 *   HELL-A2W-06  buildBaseFromArgs: unknown env name ⇒ THROWS (fail-closed,
 *                NOT a silent permissive fallback).
 *   HELL-A2W-07  buildBaseFromArgs: absent flag + absent env ⇒ slot OMITTED
 *                (byte-identical legacy — field not present on the base).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentArgsError, parseAgentArgs } from "@/../src/apps/agent/cli-args"
import { buildBaseFromArgs, PERMISSION_PROFILE_SESSION_THREAD } from "@/../src/apps/agent/index"
import { NAMED_PROFILE_NAMES, NAMED_PROFILES, type TwoLayerManager } from "@/permission"

describe("Track A2 wire — CLI parser", () => {
  test("HELL-A2W-01 accepts each named profile", () => {
    for (const name of NAMED_PROFILE_NAMES) {
      const args = parseAgentArgs(["--mode", "interactive", "--permission-profile", name])
      expect(args.permissionProfile).toBe(name)
    }
  })

  test("HELL-A2W-02 rejects an unknown profile value (fail-closed at parse)", () => {
    expect(() =>
      parseAgentArgs(["--mode", "interactive", "--permission-profile", "wide-open"]),
    ).toThrow(AgentArgsError)
  })

  test("HELL-A2W-03 absent flag ⇒ no permissionProfile field", () => {
    const args = parseAgentArgs(["--mode", "interactive"])
    expect(args.permissionProfile).toBeUndefined()
  })
})

describe("Track A2 wire — buildBaseFromArgs composition root", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY
  const prevProfile = process.env.QUANTA_PERMISSION_PROFILE
  const prevProvider = process.env.QUANTA_PROVIDER

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
    delete process.env.QUANTA_PERMISSION_PROFILE
  })
  afterEach(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
    if (prevProfile === undefined) delete process.env.QUANTA_PERMISSION_PROFILE
    else process.env.QUANTA_PERMISSION_PROFILE = prevProfile
    if (prevProvider === undefined) delete process.env.QUANTA_PROVIDER
    else process.env.QUANTA_PROVIDER = prevProvider
  })

  test("HELL-A2W-04 known env name ⇒ manager published + profile registered", () => {
    process.env.QUANTA_PERMISSION_PROFILE = "trusted"
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as {
      permissionProfileManager?: TwoLayerManager
    }
    const mgr = base.permissionProfileManager
    expect(mgr).toBeDefined()
    // The profile resolved under the session thread is the registry struct.
    expect(mgr?.getPermissionProfile(PERMISSION_PROFILE_SESSION_THREAD)).toBe(
      NAMED_PROFILES.trusted,
    )
  })

  test("HELL-A2W-05 flag WINS over a conflicting env value", () => {
    process.env.QUANTA_PERMISSION_PROFILE = "trusted"
    const base = buildBaseFromArgs({
      mode: "interactive",
      dials: {},
      permissionProfile: "restricted",
    }) as { permissionProfileManager?: TwoLayerManager }
    expect(
      base.permissionProfileManager?.getPermissionProfile(PERMISSION_PROFILE_SESSION_THREAD),
    ).toBe(NAMED_PROFILES.restricted)
  })

  test("HELL-A2W-06 unknown env name ⇒ throws (fail-closed, no silent fallback)", () => {
    process.env.QUANTA_PERMISSION_PROFILE = "wide-open"
    expect(() => buildBaseFromArgs({ mode: "interactive", dials: {} })).toThrow(
      /not a resolvable named permission profile/,
    )
  })

  test("HELL-A2W-07 absent flag + absent env ⇒ slot OMITTED (byte-identical)", () => {
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as {
      permissionProfileManager?: TwoLayerManager
    }
    expect("permissionProfileManager" in base).toBe(false)
    expect(base.permissionProfileManager).toBeUndefined()
  })
})
