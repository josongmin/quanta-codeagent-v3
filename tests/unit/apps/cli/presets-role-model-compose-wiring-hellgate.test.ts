/**
 * §9.6 `/presets` (opusplan parity) — role→model resolver compose-passthrough
 * WIRING hellgate (the LAST byte of `/presets` activation).
 *
 * A `/presets <name>` select mutates ONE `StickyPresetResolver` (`ctx.presets`);
 * the agent loop's role→model resolution consults `AgentConfig.roleModelResolver`
 * (ADR-0256, `resolveChildLlm` in `@/agent/subagent-runner-overrides`). The
 * surface bridges the two by wrapping its SINGLE resolver
 * (`buildPresetRoleModelResolver(presetResolver)`) into an
 * `AgentConfig.roleModelResolver` and threading it DOWN the runtime compose seam
 * (mirroring `objective` exactly):
 *
 *   compose.roleModelResolver               (RuntimeFacadeComposeOptions.roleModelResolver)
 *     ─▶ context-state patch                 (PASS_THROUGH_COMPOSE_KEYS ∋ "roleModelResolver")
 *        ─▶ runtime-context snapshot         (RuntimeContextSnapshot.roleModelResolver)
 *           ─▶ per-turn RuntimeBase          (buildSnapshot / base.roleModelResolver)
 *              ─▶ assembled AgentConfig      (buildAgentConfigFromBase `...rest` spread)
 *                 ─▶ resolveChildLlm         (parent.roleModelResolver.resolve(role, …))
 *
 * The CLI runtime-facade's per-turn assembler is `buildAgentConfigFromBase`
 * (context-binding/turn-runner.ts → base.ts), NOT `assembleAgentConfig`. Since
 * `roleModelResolver` is a real `AgentConfig` field (not a duck-typed augment), it
 * survives the `...rest` spread untouched — so the whole chain is pinned by driving
 * the EXACT ops each private/exported hop performs and reading the sentinel back.
 *
 * The identity that matters is the RESOLVER instance (so a `/presets` select on the
 * shared `presetResolver` is observed on the NEXT role resolution). Every hop
 * assertion is `===`; the end-to-end assertions drive the REAL `resolveChildLlm`.
 *
 * OFF byte-identity (the whole point of default-OFF):
 *   • NO preset selected ⇒ the adapter's `resolve(role, fallback)` returns the
 *     caller `fallback` VERBATIM ⇒ `resolveChildLlm`'s `resolved === parentModel`
 *     guard returns `parent.llm` UNCHANGED (no candidate lookup, no swap).
 *   • NO resolver at all (compose absent) ⇒ cfg omits `roleModelResolver` ⇒
 *     `resolveChildLlm`'s `parent.roleModelResolver !== undefined` guard is false ⇒
 *     `parent.llm` verbatim.
 *
 * Red-on-injection (proven by in-tree revert): drop `whenDefined("roleModelResolver",
 * base.roleModelResolver)` from context-binding/base.ts ⇒ the snapshot + e2e legs go
 * RED (the resolver never reaches the assembled cfg ⇒ `resolveChildLlm` stops
 * swapping).
 */
import { describe, expect, test } from "bun:test"
import { resolveChildLlm } from "@/agent/subagent-runner-overrides"
import type { AgentConfig } from "@/agent/types"
import { buildPresetRoleModelResolver } from "@/apps/cli/repl/ctx-adapters/preset-role-resolver-adapter"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import {
  buildAgentConfigFromBase,
  buildSnapshot,
} from "@/host/runtime/internal/context-binding/base"
import { createStickyPresetResolver, type LLMPort, type StickyPresetResolver } from "@/llm"
import type { RoleModelResolver } from "@/llm/role-model-override"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import type { SubagentRequest } from "@/subagent/types"

// ── minimal doubles ─────────────────────────────────────────────────────────────
// The compose seam reads only stream/cwd/llm/permission/registry/messages off the
// base; everything else is opaque to the roleModelResolver slot. No sessionId ⇒
// hermetic (no global session-resource-registry mutation).

const stubStream = () => ({ emit: (_e: unknown) => void 0 })

// `opusplan` binds executor→claude-sonnet-4-6, reviewer→claude-opus-4-8,
// default→claude-sonnet-4-6 (see BUILTIN_MODEL_PRESETS). Distinct sentinel ports
// keyed by those ids let resolveChildLlm's `swapToCandidate` prove the swap by
// PORT IDENTITY, not by model-string equality (which would be vacuous).
const PARENT_MODEL = "parent-model"
const parentPort: LLMPort = { model: PARENT_MODEL } as unknown as LLMPort
const opusPort: LLMPort = { model: "claude-opus-4-8" } as unknown as LLMPort
const sonnetPort: LLMPort = { model: "claude-sonnet-4-6" } as unknown as LLMPort

const baseConfig = (extra: Partial<RuntimeAgentConfigBase> = {}): RuntimeAgentConfigBase =>
  ({
    stream: stubStream(),
    cwd: "/repo",
    llm: parentPort,
    permission: { mode: "default" },
    registry: { all: () => [], has: () => false },
    messages: [],
    // The parent enables opus + sonnet as delegation candidates (fail-closed
    // otherwise); a role resolving to one of these swaps to its PORT.
    modelCandidates: [
      { id: "claude-opus-4-8", port: opusPort },
      { id: "claude-sonnet-4-6", port: sonnetPort },
    ],
    ...extra,
  }) as unknown as RuntimeAgentConfigBase

const resolverOf = (carrier: unknown): RoleModelResolver | undefined =>
  (carrier as { roleModelResolver?: RoleModelResolver }).roleModelResolver

const cfgFromBase = (base: RuntimeAgentConfigBase): AgentConfig =>
  // The EXACT CLI turn assembler (context-binding/turn-runner → base.ts).
  // `buildAgentConfigFromBase` takes the wider `RuntimeBase` (RuntimeAgentConfigBase
  // + host augments); the base double is a structural subset, so widen at the seam
  // (mirrors context-binding.ts `args.base as RuntimeBase`).
  buildAgentConfigFromBase({ base: base as never, messages: [] })

const roleReq = (role: string): SubagentRequest =>
  ({ prompt: "x", depth: 1, role }) as unknown as SubagentRequest

/* ================================================================== */
/*  1. compose PASS_THROUGH leg — the EXACT op applyRuntimeFacade…    */
/*     runs per PASS_THROUGH key (binding.patch({ roleModelResolver }))*/
/* ================================================================== */

describe("compose-passthrough · PASS_THROUGH_COMPOSE_KEYS ∋ roleModelResolver (observable)", () => {
  // `applyRuntimeFacadeComposeOptions` (module-private in sdk/runtime/context.ts)
  // loops PASS_THROUGH_COMPOSE_KEYS and calls `binding.patch({ [key]: value })`.
  // Driving `patch({ roleModelResolver })` on the REAL binding is that exact op;
  // `RuntimeContextPatch`'s Pick MUST include "roleModelResolver" for it to survive
  // the immutable patch → snapshot rebuild. A future edit dropping the key from
  // PASS_THROUGH_COMPOSE_KEYS OR the Pick makes this a no-op ⇒ RED.

  test("HELL-PRESET-patch-passthrough: binding.patch({ roleModelResolver }) surfaces the SAME instance on the snapshot", () => {
    const sentinel = buildPresetRoleModelResolver(createStickyPresetResolver())
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    const patched = binding.patch({ roleModelResolver: sentinel } as never)
    expect(resolverOf(patched.snapshot)).toBe(sentinel) // identity, not deep-equal
  })

  test("HELL-PRESET-patch-absent-control: NO patch ⇒ snapshot carries no roleModelResolver (paired control)", () => {
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    expect(resolverOf(binding.snapshot)).toBeUndefined()
  })

  test("HELL-PRESET-patch-distinct: two DIFFERENT sentinels patch to their OWN instances (identity is real, not a fixed singleton)", () => {
    const a = buildPresetRoleModelResolver(createStickyPresetResolver())
    const b = buildPresetRoleModelResolver(createStickyPresetResolver())
    expect(a).not.toBe(b)
    const binding = createRuntimeContextBindingFromAgentConfigBase({ base: baseConfig() })
    expect(resolverOf(binding.patch({ roleModelResolver: a } as never).snapshot)).toBe(a)
    expect(resolverOf(binding.patch({ roleModelResolver: b } as never).snapshot)).toBe(b)
  })
})

/* ================================================================== */
/*  2. snapshot ← base link (buildSnapshot, exported)                 */
/* ================================================================== */

describe("buildSnapshot · base.roleModelResolver ⇒ snapshot.roleModelResolver (same instance)", () => {
  test("HELL-PRESET-snapshot-identity: buildSnapshot surfaces base.roleModelResolver as the SAME instance", () => {
    const sentinel = buildPresetRoleModelResolver(createStickyPresetResolver())
    const snap = buildSnapshot(baseConfig({ roleModelResolver: sentinel }) as never)
    expect(resolverOf(snap)).toBe(sentinel)
  })

  test("HELL-PRESET-snapshot-absent-control: no base.roleModelResolver ⇒ snapshot omits the key (whenDefined, byte-identical default)", () => {
    const snap = buildSnapshot(baseConfig() as never)
    expect(resolverOf(snap)).toBeUndefined()
    expect(Object.hasOwn(snap as object, "roleModelResolver")).toBe(false)
  })
})

/* ================================================================== */
/*  3. base ⇒ cfg via the REAL CLI turn assembler                     */
/*     (buildAgentConfigFromBase, exported)                           */
/* ================================================================== */

describe("compose chain · base.roleModelResolver ⇒ assembled cfg.roleModelResolver (same instance)", () => {
  test("HELL-PRESET-e2e-cfg-identity: a composed resolver on the base reaches cfg.roleModelResolver as the SAME instance", () => {
    const sentinel = buildPresetRoleModelResolver(createStickyPresetResolver())
    const cfg = cfgFromBase(baseConfig({ roleModelResolver: sentinel }))
    expect(resolverOf(cfg)).toBe(sentinel)
  })

  test("HELL-PRESET-e2e-cfg-absent: NO composed resolver ⇒ cfg omits roleModelResolver (paired control — pass-through is the ONLY reason it appears)", () => {
    const cfg = cfgFromBase(baseConfig())
    expect(resolverOf(cfg)).toBeUndefined()
  })
})

/* ================================================================== */
/*  4. END-TO-END — preset select ⇒ resolveChildLlm swaps the child's */
/*     LLM to the preset's per-role model (the WHOLE POINT)           */
/* ================================================================== */

describe("resolveChildLlm · a SELECTED preset changes which model a role runs", () => {
  // Build the WHOLE production chain: shared preset resolver → adapter → composed
  // base → real cfg → real resolveChildLlm. A `/presets opusplan` select on the
  // SHARED resolver must be observed by resolveChildLlm on the next role resolution.

  const buildChain = (): {
    presets: StickyPresetResolver
    cfg: AgentConfig
  } => {
    const presets = createStickyPresetResolver()
    const cfg = cfgFromBase(
      baseConfig({ roleModelResolver: buildPresetRoleModelResolver(presets) }),
    )
    return { presets, cfg }
  }

  test("HELL-PRESET-swap-reviewer: opusplan selected ⇒ reviewer role resolves to the OPUS candidate PORT (real swap)", () => {
    const { presets, cfg } = buildChain()
    expect(presets.select("opusplan").ok).toBe(true)
    // reviewer → claude-opus-4-8 → the opus candidate port (identity, not equality).
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(opusPort)
  })

  test("HELL-PRESET-swap-executor: opusplan selected ⇒ executor role resolves to the SONNET candidate PORT", () => {
    const { presets, cfg } = buildChain()
    presets.select("opusplan")
    expect(resolveChildLlm(cfg, roleReq("executor"))).toBe(sonnetPort)
  })

  test("HELL-PRESET-live-select-observed: the SAME resolver instance observes a LATER /presets select (shared-instance semantics)", () => {
    const { presets, cfg } = buildChain()
    // Before any select ⇒ role falls through to parent (verbatim), so parent.llm.
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(parentPort)
    // A /presets select on the SHARED resolver is observed on the NEXT resolution.
    presets.select("opusplan")
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(opusPort)
    // …and a /presets clear returns it to the parent verbatim.
    presets.clear()
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(parentPort)
  })
})

/* ================================================================== */
/*  5. OFF BYTE-IDENTITY — no selection ⇒ parent model verbatim       */
/* ================================================================== */

describe("OFF byte-identity · no preset / no resolver ⇒ resolveChildLlm returns parent.llm verbatim", () => {
  test("HELL-PRESET-off-no-selection: resolver present but NO preset selected ⇒ resolve returns fallback verbatim ⇒ resolveChildLlm returns parent.llm (no candidate lookup, no swap)", () => {
    // The adapter is wired (a live seam), but with no preset picked its `resolve`
    // returns the caller `fallback` VERBATIM ⇒ resolveChildLlm's
    // `resolved === parentModel` guard returns parent.llm UNCHANGED.
    const cfg = cfgFromBase(
      baseConfig({ roleModelResolver: buildPresetRoleModelResolver(createStickyPresetResolver()) }),
    )
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(parentPort)
  })

  test("HELL-PRESET-off-no-resolver: NO resolver wired (compose absent) ⇒ cfg omits roleModelResolver ⇒ resolveChildLlm's presence guard is false ⇒ parent.llm verbatim", () => {
    const cfg = cfgFromBase(baseConfig())
    expect(resolverOf(cfg)).toBeUndefined()
    expect(resolveChildLlm(cfg, roleReq("reviewer"))).toBe(parentPort)
  })

  test("HELL-PRESET-off-empty-role: resolver present, preset selected, but EMPTY role string ⇒ resolveChildLlm's `role.length > 0` guard is false ⇒ parent.llm (never consults the resolver)", () => {
    const presets = createStickyPresetResolver()
    presets.select("opusplan")
    const cfg = cfgFromBase(
      baseConfig({ roleModelResolver: buildPresetRoleModelResolver(presets) }),
    )
    expect(resolveChildLlm(cfg, roleReq(""))).toBe(parentPort)
  })
})
