import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type AssembleRequestPartial, buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { __resetRuntimeConfig } from "@/shared"

/**
 * BYTE-IDENTICAL HELLGATE for the composition-root → declarative slot-registry
 * refactor (`refactor/composition-slot-registry`).
 *
 * The refactor folds ~25 default-OFF slot resolvers (`buildBaseFromArgs`) and
 * ~20 ordered capability mutators (`assembleAgentConfig` /
 * `wireOptionalCapabilitySlots`) into loop-driven registries WITHOUT changing
 * the assembled `AgentConfig` for ANY input. A subtle bug — a dropped slot, a
 * changed spread order, a flipped `!== undefined` vs truthiness guard — breaks
 * every agent. This test is the safety net.
 *
 * WHAT IT SNAPSHOTS — a STABLE STRUCTURAL FINGERPRINT of the assembled config:
 *   - the ORDERED list of populated top-level keys (JS preserves object
 *     insertion order, so the conditional-spread ORDER in the object literal /
 *     the registry loop is load-bearing — a reordered slot changes this list),
 *   - a SHAPE TAG per key: `fn` for ports (functions), `arr[N]` for arrays,
 *     `obj{...ordered-subkeys-with-shapes}` for objects (recursively, bounded),
 *     and the literal JSON for serializable scalars (`maxTurns`,
 *     `permission.mode`, per-slot booleans). This catches a conditional-spread
 *     guard that subtly changed (a nested field appearing/disappearing) even
 *     when the top-level key set is unchanged.
 *
 * Ports are live objects (fresh identity every call), so we compare by
 * PRESENCE + STRUCTURE, never identity. The fingerprint is deep-stable: two
 * runs of the SAME input on the SAME code produce the byte-identical string.
 *
 * MATRIX: all-off default; each major feature-gate on individually; several
 * realistic multi-feature combos; partial-flag (CLI `--flag`) variations.
 * Both the pre-assembler (`buildBaseFromArgs`) AND the full assembler
 * (`assembleAgentConfig`) are fingerprinted end-to-end.
 *
 * NON-VACUOUS: the `perturbation` block proves the fingerprint goes RED when a
 * single slot is dropped / reordered / its guard flipped (a hand-built config
 * mutated to simulate each refactor-hazard).
 *
 * The GREEN baseline strings are captured from the CURRENT (pre-refactor) code
 * and MUST remain byte-identical after the refactor.
 */

// ───────────────────────── fingerprint machinery ─────────────────────────

/** Length cap for verbatim string rendering. Enum-like config strings
 *  (`"acceptEdits"`, `"frozen"`, `"interactive"`, provider names) render
 *  verbatim so a FLIPPED guard that changes an enum/boolean is caught; long
 *  strings (the system prompt, the ambient `llm.env` copy) are STRUCTURAL —
 *  their exact bytes are volatile / not affected by the slot-registry refactor —
 *  so they collapse to a length category. */
const STR_VERBATIM_MAX = 200

/**
 * Recursively derive a deep-stable shape tag. This is a STRUCTURE fingerprint:
 * it captures key-presence, key-ORDER (insertion order — load-bearing for the
 * spread/loop order), and value TYPE at every node. It deliberately does NOT
 * capture volatile scalar VALUES (timestamps like `budgetMeter.startedAtMs`,
 * mutable counters, the ambient env copy) — none of those are changed by moving
 * slot AGGREGATION into a loop, and folding them in would make the guard
 * unstable across identical code (a false-RED after the refactor).
 *
 *   - numbers → `num` (TYPE only: a timestamp and `maxTurns` both render `num`;
 *     the refactor hazards — dropped/reordered slot, flipped presence guard —
 *     are all key/type/order changes, never a scalar-value change),
 *   - booleans → verbatim (`bool:true`) — a flipped guard often surfaces as a
 *     boolean sub-field toggling,
 *   - short strings → verbatim — enum/mode/posture strings must match exactly,
 *   - long strings → `str[len]` (structural length category),
 *   - functions → `fn` (ports; compared by presence, never identity),
 *   - arrays → `arr[<per-element tags>]` (length + element shapes),
 *   - objects → `obj{<ordered key=tag>}` (recursively, depth-bounded).
 * Depth-bounded so a deep port graph / class instance collapses to its ordered
 * own-key set at the leaf rather than walking forever.
 */
/**
 * Tag for a NON-recursive value — every leaf kind, i.e. everything except an
 * array or a plain object. Returns `null` for those two so {@link shapeTag} can
 * keep only the recursive arms. Split out purely to keep each function under
 * the cognitive-complexity ceiling; the tags are byte-identical to the ones the
 * single combined function produced, which is what the committed snapshot pins.
 */
const leafTag = (value: unknown): string | null => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  const t = typeof value
  if (t === "function") return "fn"
  if (t === "boolean") return `bool:${String(value)}`
  if (t === "bigint") return "bigint"
  if (t === "number") return "num"
  if (t === "symbol") return "sym"
  if (t !== "string") return null
  const s = value as string
  // The `cwd` slot bakes an ABSOLUTE repo path (`cwd = opts.cwd ?? process.cwd()`),
  // which differs per checkout/worktree/CI and is NOT touched by the slot-registry
  // refactor — render it as a STABLE sentinel (same rationale as the `env` bag)
  // so a regen from a worktree does not poison main and the fingerprint stays
  // machine-independent.
  if (s === process.cwd()) return "str:<cwd>"
  return s.length <= STR_VERBATIM_MAX ? `str:${JSON.stringify(s)}` : `str[${s.length}]`
}

const shapeTag = (value: unknown, depth: number): string => {
  const leaf = leafTag(value)
  if (leaf !== null) return leaf
  if (Array.isArray(value)) {
    if (depth <= 0) return `arr[${value.length}]`
    return `arr[${value.map((v) => shapeTag(v, depth - 1)).join(",")}]`
  }
  // object
  if (depth <= 0) {
    // collapse to the ordered own-key set (no values) so a class instance / deep
    // port graph still contributes its KEY shape without infinite recursion.
    return `obj{${Object.keys(value as object).join(",")}}`
  }
  const obj = value as Record<string, unknown>
  const parts = Object.keys(obj).map((k) =>
    // The ambient `env` bag (a copy of process.env threaded into the LLM port) has
    // a VOLATILE key set that varies by invocation environment (OLDPWD, PWD,
    // CLAUDE_EFFORT, npm_package_*, _ …) and is NOT touched by the slot-registry
    // refactor — render it as a STABLE sentinel so the fingerprint stays
    // environment-independent (else the snapshot false-fires across machines/CI).
    k === "env" && obj[k] !== null && typeof obj[k] === "object"
      ? "env=<ambient-env-bag>"
      : `${k}=${shapeTag(obj[k], depth - 1)}`,
  )
  return `obj{${parts.join(",")}}`
}

/** Fingerprint the WHOLE config: the ordered top-level key list PLUS a
 *  shape-tag per key. Top-level keys are walked at full order; each value is
 *  shape-tagged to a bounded depth (3 — enough to catch a slot-guard change on a
 *  nested field like `permission.mode` / `focusChain.reinjectEveryN`, without
 *  serializing entire port implementations). */
const fingerprint = (cfg: Record<string, unknown>): string => {
  const keys = Object.keys(cfg)
  const lines = keys.map((k) => `${k} :: ${shapeTag(cfg[k], 3)}`)
  return `KEYS[${keys.length}]: ${keys.join(",")}\n${lines.join("\n")}`
}

// ───────────────────────── env harness ─────────────────────────

/** Every env knob any branch of `buildBaseFromArgs` / the assembler reads. Each
 *  is snapshotted + STRIPPED before each case so the ambient shell can neither
 *  pre-enable nor mask a gate, and a fake provider key is injected so
 *  `tryCreateLLM` returns a real Phase-1 adapter (no wire call at construction). */
const DRIVEN = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "QUANTA_PROVIDER",
  "QUANTA_IDENTITY",
  "QUANTA_IDENTITY_MODE",
  "QUANTA_RETRIEVAL_HYBRID",
  "QUANTA_MCP_CAPS",
  "QUANTA_AUTOMATION",
  "QUANTA_AUTORUN_POLICY",
  "QUANTA_SANDBOX",
  "QUANTA_NETWORK_PROXY",
  "QUANTA_PREWARM",
  "QUANTA_LSP_PREWARM",
  "QUANTA_LSP_TOOLS",
  "QUANTA_BENCH_LSP",
  "QUANTA_OBSERVABILITY",
  "QUANTA_PERMISSION_PROFILE",
  "QUANTA_REMEMBER_PATTERNS",
  "QUANTA_REMEMBER_PATTERNS_DANGEROUS",
  "QUANTA_FILE_HISTORY",
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_MEMORY",
  "QUANTA_SUBAGENT",
  "QUANTA_INDEX",
  "QUANTA_PIPELINE",
  "QUANTA_ENV_DEFAULT",
  // assembler-side capability gates
  "QUANTA_BROWSER_TOOL",
  "QUANTA_APPSHOT",
  "QUANTA_OBJECTIVE_TOOLS",
  "QUANTA_SUBAGENT_MAILBOX",
  "QUANTA_SUBAGENT_BG",
  "QUANTA_STALE_READ_GUARD",
  "QUANTA_EDIT_REPAIR_LOOP",
  "QUANTA_SKILL_MCP_DEPS",
  "QUANTA_PROMPT_CACHE_STATUS",
  "QUANTA_PASSIVE_VCS",
  "QUANTA_SIDE_AGENT",
  "QUANTA_BUDGET_LEDGER",
  "QUANTA_PII_REDACTION",
  "QUANTA_TEAM_PEER_MSG",
  "QUANTA_PEER_MSG_SURFACE",
] as const

const saved: Record<string, string | undefined> = {}

const stripAll = (): void => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
}
const restoreAll = (): void => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

beforeEach(() => {
  stripAll()
  // Deterministic baseline: a fake key so the LLM is real; keep memory/subagent
  // light so unrelated wires don't add noise.
  process.env.OPENAI_API_KEY = "sk-test-hellgate-fixed"
  process.env.QUANTA_MEMORY = "off"
  process.env.QUANTA_SUBAGENT = "0"
  __resetRuntimeConfig()
})

afterEach(() => {
  restoreAll()
  __resetRuntimeConfig()
})

/** Apply an env-gate bag on top of the deterministic baseline, reset the
 *  runtime-config cache so the new env is read, and build BOTH the pre-assembler
 *  base and the fully-assembled interactive config. Returns their two
 *  fingerprints. `mode` defaults to interactive. */
const buildFor = (
  gates: Record<string, string>,
  partial: Partial<AssembleRequestPartial> = {},
): { base: string; assembled: string } => {
  for (const [k, v] of Object.entries(gates)) process.env[k] = v
  __resetRuntimeConfig()
  const p: AssembleRequestPartial = {
    mode: "interactive",
    dials: {},
    ...partial,
  }
  const base = buildBaseFromArgs(p)
  const assembled = assembleAgentConfig(
    { mode: p.mode, base, ...(p.dials !== undefined ? { dials: p.dials } : {}) },
    process.env,
  )
  return {
    base: fingerprint(base as unknown as Record<string, unknown>),
    assembled: fingerprint(assembled as unknown as Record<string, unknown>),
  }
}

// ───────────────────────── the input matrix ─────────────────────────
//
// NAME → (env-gate bag, partial-flags). Each case fingerprints the CURRENT code;
// the same name MUST produce the byte-identical fingerprint after the refactor.

const MATRIX: ReadonlyArray<{
  name: string
  gates: Record<string, string>
  partial?: Partial<AssembleRequestPartial>
}> = [
  { name: "all-off default", gates: {} },
  // ── each major feature-gate on individually (env side) ──
  { name: "identity env", gates: { QUANTA_IDENTITY: "1" } },
  { name: "retrieval hybrid", gates: { QUANTA_RETRIEVAL_HYBRID: "1" } },
  { name: "mcp caps full", gates: { QUANTA_MCP_CAPS: "full" } },
  { name: "automation on", gates: { QUANTA_AUTOMATION: "on" } },
  { name: "sandbox", gates: { QUANTA_SANDBOX: "workspace-write" } },
  { name: "network proxy", gates: { QUANTA_NETWORK_PROXY: "1" } },
  { name: "prewarm", gates: { QUANTA_PREWARM: "1" } },
  { name: "lsp prewarm (nav on)", gates: { QUANTA_LSP_TOOLS: "full", QUANTA_LSP_PREWARM: "1" } },
  { name: "observability on", gates: { QUANTA_OBSERVABILITY: "on" } },
  { name: "remember patterns", gates: { QUANTA_REMEMBER_PATTERNS: "1" } },
  {
    name: "remember patterns dangerous",
    gates: { QUANTA_REMEMBER_PATTERNS: "1", QUANTA_REMEMBER_PATTERNS_DANGEROUS: "1" },
  },
  { name: "file history", gates: { QUANTA_FILE_HISTORY: "1" } },
  { name: "artifact store", gates: { QUANTA_ARTIFACT_STORE: "1" } },
  { name: "index on", gates: { QUANTA_INDEX: "on" } },
  { name: "pipeline none", gates: { QUANTA_PIPELINE: "none" } },
  { name: "env default posture", gates: { QUANTA_ENV_DEFAULT: "1" } },
  // ── assembler-side capability gates individually ──
  { name: "objective tools", gates: { QUANTA_OBJECTIVE_TOOLS: "1" } },
  { name: "mailbox", gates: { QUANTA_SUBAGENT_MAILBOX: "1" } },
  { name: "stale-read guard off", gates: { QUANTA_STALE_READ_GUARD: "off" } },
  { name: "edit repair loop", gates: { QUANTA_EDIT_REPAIR_LOOP: "1" } },
  { name: "prompt cache status", gates: { QUANTA_PROMPT_CACHE_STATUS: "1" } },
  { name: "passive vcs", gates: { QUANTA_PASSIVE_VCS: "1" } },
  { name: "pii redaction", gates: { QUANTA_PII_REDACTION: "1" } },
  // ── partial-flag (CLI `--flag`) variations (base side) ──
  { name: "sticky model flag", gates: {}, partial: { stickyModel: true } },
  { name: "tool profile flag", gates: {}, partial: { toolProfile: "minimal" } },
  { name: "focus chain flag", gates: {}, partial: { focusChainEvery: 3 } },
  { name: "fork session flag", gates: {}, partial: { forkSession: true } },
  { name: "delegate modes flag", gates: {}, partial: { delegateModes: ["explore"] } },
  { name: "identity mode flag", gates: {}, partial: { identityMode: "default" } },
  { name: "batch mode", gates: {}, partial: { mode: "batch" } },
  // ── realistic multi-feature combos ──
  {
    name: "combo: obs + artifact + file-history + patterns",
    gates: {
      QUANTA_OBSERVABILITY: "on",
      QUANTA_ARTIFACT_STORE: "1",
      QUANTA_FILE_HISTORY: "1",
      QUANTA_REMEMBER_PATTERNS: "1",
    },
  },
  {
    name: "combo: automation + mcp-full + sandbox + network-proxy",
    gates: {
      QUANTA_AUTOMATION: "on",
      QUANTA_MCP_CAPS: "full",
      QUANTA_SANDBOX: "workspace-write",
      QUANTA_NETWORK_PROXY: "1",
    },
  },
  {
    name: "combo: assembler caps (objective+mailbox+prompt-cache+edit-repair+pii)",
    gates: {
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_SUBAGENT_MAILBOX: "1",
      QUANTA_PROMPT_CACHE_STATUS: "1",
      QUANTA_EDIT_REPAIR_LOOP: "1",
      QUANTA_PII_REDACTION: "1",
    },
  },
  {
    name: "combo: base flags + env gates together",
    gates: { QUANTA_ARTIFACT_STORE: "1", QUANTA_OBSERVABILITY: "on" },
    partial: { stickyModel: true, focusChainEvery: 5, toolProfile: "minimal" },
  },
]

// ───────────────────────── the byte-identical guard ─────────────────────────
//
// The GREEN baseline is the committed `.snap` file: captured from the
// CURRENT (pre-refactor) code, it pins the fingerprint for every matrix case.
// `toMatchSnapshot` persists on first run and RED-fires on any drift thereafter,
// so the refactor MUST reproduce every fingerprint byte-for-byte.

describe("composition slot-registry — byte-identical hellgate", () => {
  for (const { name, gates, partial } of MATRIX) {
    test(`fingerprint stable — ${name}`, () => {
      const fp = buildFor(gates, partial)
      expect(fp.base).toMatchSnapshot(`${name} :: base`)
      expect(fp.assembled).toMatchSnapshot(`${name} :: assembled`)
    })
  }
})

// ───────────────────────── non-vacuity proof (red-on-injection) ──────────────
//
// Prove the fingerprint DETECTS the three refactor hazards: a dropped slot, a
// reordered slot, and a flipped conditional-spread guard. We build a real config,
// then MUTATE a structural clone the way each hazard would, and assert the
// fingerprint DIFFERS. If any of these did NOT differ, the guard would be vacuous
// (it would silently pass a broken refactor).

describe("fingerprint is non-vacuous (detects refactor hazards)", () => {
  const realConfig = (): Record<string, unknown> => {
    process.env.QUANTA_ARTIFACT_STORE = "1"
    process.env.QUANTA_FILE_HISTORY = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs({ mode: "interactive", dials: {}, focusChainEvery: 4 })
    return base as unknown as Record<string, unknown>
  }

  test("DROPPED slot ⇒ fingerprint differs (key removed)", () => {
    const cfg = realConfig()
    const fp0 = fingerprint(cfg)
    expect(cfg.focusChain).toBeDefined() // sanity: the slot IS present
    const { focusChain: _dropped, ...without } = cfg
    const fp1 = fingerprint(without)
    expect(fp1).not.toBe(fp0)
  })

  test("REORDERED slots ⇒ fingerprint differs (insertion order changed)", () => {
    const cfg = realConfig()
    const fp0 = fingerprint(cfg)
    // Rebuild the SAME key/value set in a different insertion order.
    const entries = Object.entries(cfg)
    const swapped = Object.fromEntries(
      [entries[1], entries[0], ...entries.slice(2)].filter((e) => e !== undefined),
    )
    const fp1 = fingerprint(swapped)
    expect(fp1).not.toBe(fp0)
  })

  test("FLIPPED guard (nested field appears) ⇒ fingerprint differs", () => {
    const cfg = realConfig()
    const fp0 = fingerprint(cfg)
    // Simulate a guard that changed `!== undefined` → truthiness such that a
    // previously-omitted nested field now appears on an existing slot.
    const clone: Record<string, unknown> = {
      ...cfg,
      focusChain: { ...(cfg.focusChain as object), extraLeakedField: true },
    }
    const fp1 = fingerprint(clone)
    expect(fp1).not.toBe(fp0)
  })

  test("CHANGED scalar TYPE (permission.mode enum) ⇒ fingerprint differs", () => {
    const cfg = realConfig()
    const fp0 = fingerprint(cfg)
    // A flipped guard that swaps the permission mode enum (a short verbatim
    // string) is caught — this is the class of change the slot registry could
    // introduce via a mis-ordered permission slot.
    const clone: Record<string, unknown> = { ...cfg, permission: { mode: "bypass" } }
    const fp1 = fingerprint(clone)
    expect(fp1).not.toBe(fp0)
  })
})

/**
 * Config-semantic SCALAR exactness. The structural fingerprint renders numbers
 * as TYPE only (for stability against volatile timestamps), so the handful of
 * load-bearing numeric/enum scalars that MUST stay byte-exact across the
 * refactor are asserted directly here. `maxTurns` flows through the untouched
 * preamble (`p.dials?.maxTurns ?? 30`) and `permission.mode` through the
 * permission slot — a slot-registry bug that corrupted either would slip past
 * the type-only fingerprint, so this closes that gap.
 */
describe("config-semantic scalars stay byte-exact", () => {
  test("default: maxTurns=30, permission.mode=acceptEdits", () => {
    __resetRuntimeConfig()
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} }) as unknown as {
      maxTurns: number
      permission: { mode: string }
    }
    expect(base.maxTurns).toBe(30)
    expect(base.permission.mode).toBe("acceptEdits")
  })

  test("explicit dial override survives (maxTurns=17)", () => {
    __resetRuntimeConfig()
    const base = buildBaseFromArgs({
      mode: "interactive",
      dials: { maxTurns: 17 },
    }) as unknown as { maxTurns: number }
    expect(base.maxTurns).toBe(17)
  })
})
