/**
 * ADR-0438 follow-up — INHERITANCE WIRE hellgate.
 *
 * The resolver (`profile-inheritance.ts`) was pure + 17-hellgate-sealed but had
 * NO production consumer: nothing parsed a user `ProfileDefinition`, built a
 * registry, or routed the composition-root profile resolution through
 * `resolveProfileInheritance`. This battery seals the NEW live path:
 *
 *   - `parseUserProfileDefinition` (partial parser, fail-closed)
 *   - `buildProfileDefinitionRegistry` (composition-root env reader, fail-closed)
 *   - `resolvePermissionProfileManager` / `resolvePermissionModeFromProfile`
 *     routing the selected profile THROUGH `resolveProfileInheritance` so a
 *     profile declaring `extends` actually folds base → derived at session start,
 *     and the merged struct flows into the per-thread `TwoLayerManager` slot
 *     (live consumer) + the live `PermissionContext.mode`.
 *
 * Cases:
 *   HELL-PIW-01 user `extends: trusted` w/ narrower network resolves to the
 *               intersection LIVE (manager slot + derived mode).
 *   HELL-PIW-02 managed ceiling is NOT widenable end-to-end (clamp default).
 *   HELL-PIW-03 unknown extends ⇒ fail-closed THROW (no permissive fallback).
 *   HELL-PIW-04 NO user defs ⇒ built-ins byte-identical (reference identity) +
 *               the A2 by-name path is UNCHANGED.
 *   HELL-PIW-05 parser rejects malformed / unknown-key fail-closed.
 *   HELL-PIW-06 registry builder fail-closed: bad JSON / non-object / built-in
 *               name collision / nested unknown key.
 *   HELL-PIW-07 a user def selected by name (not extending) folds onto DEFAULT,
 *               and a deep chain (user → user → built-in) resolves live.
 */

import { describe, expect, test } from "bun:test"
import {
  buildProfileDefinitionRegistry,
  PERMISSION_PROFILE_SESSION_THREAD,
  resolvePermissionModeFromProfile,
  resolvePermissionProfileManager,
} from "@/../src/apps/agent/index"
import {
  NAMED_PROFILES,
  ProfileInheritanceError,
  ProfileValidationError,
  parseUserProfileDefinition,
} from "@/permission"

const THREAD = PERMISSION_PROFILE_SESSION_THREAD

/** Build a process-env view with only the inheritance knobs set (so the test is
 *  isolated from the ambient `process.env`). */
const envWith = (json: string | undefined, selected: string | undefined): NodeJS.ProcessEnv =>
  ({
    ...(json !== undefined ? { QUANTA_PERMISSION_PROFILES_JSON: json } : {}),
    ...(selected !== undefined ? { QUANTA_PERMISSION_PROFILE: selected } : {}),
  }) as NodeJS.ProcessEnv

describe("ADR-0438 inheritance WIRE hellgate", () => {
  test("HELL-PIW-01 user extends:trusted + narrower network resolves to intersection LIVE", () => {
    const json = JSON.stringify({
      "trusted-lan": {
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["lan.internal"] },
      },
    })
    const env = envWith(json, "trusted-lan")
    const registry = buildProfileDefinitionRegistry(env)

    // The LIVE manager (the actual session-start consumer) holds the MERGED
    // profile, not the bare built-in.
    const manager = resolvePermissionProfileManager(undefined, env, registry)
    expect(manager).toBeDefined()
    const live = manager?.getPermissionProfile(THREAD)
    expect(live).toBeDefined()
    // network narrowed allow-all → allow-list with the declared host.
    expect(live?.network.mode).toBe("allow-list")
    expect(live?.network.allowHosts).toEqual(["lan.internal"])
    // the rest of `trusted` is inherited unchanged.
    expect(live?.approval).toEqual(NAMED_PROFILES.trusted.approval)
    expect(live?.sandbox).toEqual(NAMED_PROFILES.trusted.sandbox)

    // ...and the LIVE PermissionContext.mode is derived from the SAME merged
    // profile (trusted approval=auto ⇒ "auto").
    expect(resolvePermissionModeFromProfile(undefined, env, registry)).toBe("auto")
  })

  test("HELL-PIW-01b narrowing approval flips the derived mode (default)", () => {
    const json = JSON.stringify({
      "trusted-confirm": { extends: "trusted", approval: { mode: "always", promptUser: true } },
    })
    const env = envWith(json, "trusted-confirm")
    const registry = buildProfileDefinitionRegistry(env)
    const live = resolvePermissionProfileManager(undefined, env, registry)?.getPermissionProfile(
      THREAD,
    )
    expect(live?.approval.mode).toBe("always")
    // always ⇒ "default" mode (not auto) — the narrowing reaches the live mode.
    expect(resolvePermissionModeFromProfile(undefined, env, registry)).toBe("default")
  })

  test("HELL-PIW-02 managed ceiling is NOT widenable end-to-end", () => {
    // A managed base pins approval=always; the derived child tries to WIDEN it to
    // auto. The resolver clamps back to the ceiling — the widen never reaches the
    // live manager.
    const json = JSON.stringify({
      org: {
        tag: "managed",
        extends: "restricted",
        approval: { mode: "always", promptUser: true },
      },
      "org-lax": { extends: "org", approval: { mode: "auto", promptUser: false } },
    })
    const env = envWith(json, "org-lax")
    const registry = buildProfileDefinitionRegistry(env)
    const live = resolvePermissionProfileManager(undefined, env, registry)?.getPermissionProfile(
      THREAD,
    )
    // The managed ceiling (always) holds — the auto widen is clamped.
    expect(live?.approval.mode).toBe("always")
    expect(live?.approval.promptUser).toBe(true)
    // And the live mode is "default" (always), NOT "auto" — the widen is closed.
    expect(resolvePermissionModeFromProfile(undefined, env, registry)).toBe("default")
  })

  test("HELL-PIW-03 unknown extends ⇒ fail-closed THROW (no permissive fallback)", () => {
    const json = JSON.stringify({ ghost: { extends: "does-not-exist" } })
    const env = envWith(json, "ghost")
    const registry = buildProfileDefinitionRegistry(env)
    expect(() => resolvePermissionProfileManager(undefined, env, registry)).toThrow(
      ProfileInheritanceError,
    )
    expect(() => resolvePermissionModeFromProfile(undefined, env, registry)).toThrow(
      ProfileInheritanceError,
    )
    // Selecting a name absent from BOTH registry + builtins is also fail-closed.
    const env2 = envWith(json, "no-such-profile")
    expect(() => resolvePermissionProfileManager(undefined, env2, registry)).toThrow(
      ProfileInheritanceError,
    )
  })

  test("HELL-PIW-04 NO user defs ⇒ built-ins byte-identical + A2 path unchanged", () => {
    const env = envWith(undefined, "trusted")
    const registry = buildProfileDefinitionRegistry(env)
    // empty registry ⇒ default-OFF.
    expect(Object.keys(registry)).toHaveLength(0)
    const live = resolvePermissionProfileManager(undefined, env, registry)?.getPermissionProfile(
      THREAD,
    )
    // REFERENCE identity — the legacy by-name path returns the same frozen struct.
    expect(live).toBe(NAMED_PROFILES.trusted)
    expect(resolvePermissionModeFromProfile(undefined, env, registry)).toBe("auto")

    // A2 fail-closed posture preserved: an unknown name with NO registry throws
    // the legacy Error (not silently permissive).
    const bad = envWith(undefined, "bogus")
    expect(() => resolvePermissionProfileManager(undefined, bad, {})).toThrow(
      /not a resolvable named permission profile/,
    )

    // Absent profile entirely ⇒ no manager, no mode (byte-identical legacy).
    expect(
      resolvePermissionProfileManager(undefined, envWith(undefined, undefined), {}),
    ).toBeUndefined()
    expect(
      resolvePermissionModeFromProfile(undefined, envWith(undefined, undefined), {}),
    ).toBeUndefined()
  })

  test("HELL-PIW-04b built-in name selected WITH a user registry stays byte-identical", () => {
    // A user def exists (so the inheritance path is taken), but the SELECTED name
    // is a built-in with no chain ⇒ still the same frozen struct.
    const json = JSON.stringify({ "some-other": { extends: "default" } })
    const env = envWith(json, "trusted")
    const registry = buildProfileDefinitionRegistry(env)
    const live = resolvePermissionProfileManager(undefined, env, registry)?.getPermissionProfile(
      THREAD,
    )
    expect(live).toBe(NAMED_PROFILES.trusted)
  })

  test("HELL-PIW-05 parser rejects malformed / unknown-key fail-closed", () => {
    // not JSON
    expect(() => parseUserProfileDefinition("f", "{not json")).toThrow(ProfileValidationError)
    // not an object
    expect(() => parseUserProfileDefinition("f", "[]")).toThrow(ProfileValidationError)
    expect(() => parseUserProfileDefinition("f", "42")).toThrow(ProfileValidationError)
    // unknown top-level key
    expect(() => parseUserProfileDefinition("f", JSON.stringify({ bogus: 1 }))).toThrow(
      /unknown key 'bogus'/,
    )
    // unknown nested key
    expect(() =>
      parseUserProfileDefinition("f", JSON.stringify({ network: { mod: "deny-all" } })),
    ).toThrow(/unknown key 'network.mod'/)
    // bad enum
    expect(() =>
      parseUserProfileDefinition("f", JSON.stringify({ network: { mode: "wide-open" } })),
    ).toThrow(/network.mode must be one of/)
    // bad tag
    expect(() => parseUserProfileDefinition("f", JSON.stringify({ tag: "root" }))).toThrow(
      /tag must be one of/,
    )
    // bad extends shape
    expect(() => parseUserProfileDefinition("f", JSON.stringify({ extends: 5 }))).toThrow(
      /extends must be a non-empty string/,
    )
    expect(() => parseUserProfileDefinition("f", JSON.stringify({ extends: [""] }))).toThrow(
      /extends\[0\] must be a non-empty string/,
    )

    // VALID partial — only the declared axes survive, no unknown keys leak.
    const def = parseUserProfileDefinition(
      "f",
      JSON.stringify({ extends: "trusted", network: { mode: "deny-all" } }),
    )
    expect(def.extends).toBe("trusted")
    expect(def.network).toEqual({ mode: "deny-all" })
    expect(def.approval).toBeUndefined()
    expect(def.sandbox).toBeUndefined()
  })

  test("HELL-PIW-06 registry builder fail-closed paths", () => {
    // bad JSON
    expect(() => buildProfileDefinitionRegistry(envWith("{nope", undefined))).toThrow(
      ProfileValidationError,
    )
    // not an object (array / scalar)
    expect(() => buildProfileDefinitionRegistry(envWith("[]", undefined))).toThrow(
      /must be a JSON object/,
    )
    expect(() => buildProfileDefinitionRegistry(envWith("7", undefined))).toThrow(
      /must be a JSON object/,
    )
    // a key colliding with a built-in name is rejected (built-in authoritative).
    expect(() =>
      buildProfileDefinitionRegistry(
        envWith(JSON.stringify({ trusted: { extends: "default" } }), undefined),
      ),
    ).toThrow(/collides with a built-in profile/)
    // a malformed definition value (unknown nested key) propagates the throw.
    expect(() =>
      buildProfileDefinitionRegistry(envWith(JSON.stringify({ x: { networkk: {} } }), undefined)),
    ).toThrow(/unknown key 'networkk'/)
    // empty / whitespace ⇒ empty registry (default-OFF).
    expect(buildProfileDefinitionRegistry(envWith("   ", undefined))).toEqual({})
    expect(buildProfileDefinitionRegistry(envWith(undefined, undefined))).toEqual({})
  })

  test("HELL-PIW-07 user def with no extends folds onto DEFAULT; deep user chain resolves", () => {
    // No `extends` ⇒ resolution starts from the locked-down DEFAULT, then the
    // declared (narrowing-only) fields apply.
    const lone = JSON.stringify({ tighter: { approval: { mode: "always", promptUser: true } } })
    const envLone = envWith(lone, "tighter")
    const regLone = buildProfileDefinitionRegistry(envLone)
    const liveLone = resolvePermissionProfileManager(
      undefined,
      envLone,
      regLone,
    )?.getPermissionProfile(THREAD)
    // DEFAULT is already deny-all / restricted; approval forced to always.
    expect(liveLone?.approval.mode).toBe("always")
    expect(liveLone?.network.mode).toBe(NAMED_PROFILES.default.network.mode)

    // user → user → built-in chain.
    const chain = JSON.stringify({
      mid: { extends: "trusted", sandbox: { workspaceWrite: false } },
      leaf: { extends: "mid", network: { mode: "deny-all" } },
    })
    const envChain = envWith(chain, "leaf")
    const regChain = buildProfileDefinitionRegistry(envChain)
    const liveChain = resolvePermissionProfileManager(
      undefined,
      envChain,
      regChain,
    )?.getPermissionProfile(THREAD)
    expect(liveChain?.network.mode).toBe("deny-all") // leaf narrows
    expect(liveChain?.sandbox.workspaceWrite).toBe(false) // mid narrows
  })
})
