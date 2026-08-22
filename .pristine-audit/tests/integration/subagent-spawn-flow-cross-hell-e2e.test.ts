/**
 * Subagent spawn-flow CROSS-feature HELL e2e (Cluster E / F15+F16+F17 + B-envelope).
 *
 * A single fake spawner simulates a subagent spawn that touches:
 *   - F15 (tools-6):    builds a `spawn_agent` payload through SpawnAgentInputSchema.
 *   - F16 (role):       applies `getToolPolicyForRole(role)` to compute the
 *                       toolFilter (allowed kinds → tool-name list).
 *   - F17 (nicknames):  assigns a nickname via `assignNickname(parentTaskId)`.
 *   - Cluster B:        encodes a `thread_spawn` envelope record and round-trips
 *                       it through `encodeSessionLine` / `decodeSessionLine`.
 *
 * Then we run 100 spawns with round-robin roles ('explorer'|'worker'|'none')
 * and assert: every payload validates, every nickname matches `assignNickname`
 * EXACTLY, every role's policy is correctly applied, and an injected faulty
 * spawn does NOT corrupt global state (subsequent spawns still work).
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { decodeSessionLine, encodeSessionLine, type SessionEnvelopeRecord } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { assignNickname, MAESTRO_NICKNAMES, nextSequentialNickname } from "@/subagent/nicknames"
import {
  type AgentRole,
  getToolPolicyForRole,
  roleAllowsKind,
  TOOL_KINDS,
  type ToolKind,
  UnknownAgentRoleError,
} from "@/subagent/role"
import { type SpawnAgentInput, SpawnAgentInputSchema } from "@/subagent/tools-6"

beforeEach(() => {
  __resetRuntimeConfig()
})

/* ── synthetic "tool-name by kind" map (test-only) ──────────────────────── */
/* The slice contract intentionally keeps the per-tool-kind name mapping out
 * of the production module (kinds are abstract buckets). For this CROSS test
 * we declare ONE representative tool name per kind locally — the test only
 * cares that the spawner's `toolFilter` reflects the role's allow set. */
const KIND_TO_REPRESENTATIVE_TOOL: Readonly<Record<ToolKind, string>> = {
  read: "read",
  edit: "edit",
  shell: "bash",
  network: "fetch",
  subagent: "agent",
  memory: "update_working_state",
  lsp: "lsp_workspace_symbol",
}

/* ── the fake spawner ──────────────────────────────────────────────────── */

interface SpawnedRecord {
  readonly role: AgentRole
  readonly parentTaskId: string
  readonly nickname: string
  readonly payload: SpawnAgentInput
  readonly allowedToolNames: ReadonlyArray<string>
  readonly threadSpawnRecord: SessionEnvelopeRecord
}

/** Spawn a child according to (role, parentTaskId), producing a Zod-validated
 *  spawn_agent payload, a deterministic nickname, the policy-derived
 *  toolFilter, and a `thread_spawn` envelope record. Throws on unknown role. */
const spawnFake = (input: {
  role: AgentRole
  parentTaskId: string
  parentSessionId: string
}): SpawnedRecord => {
  const { role, parentTaskId, parentSessionId } = input

  // F17 — nickname (deterministic).
  const nickname = assignNickname(parentTaskId)

  // F16 — policy lookup (throws UnknownAgentRoleError on bad role).
  const policy = getToolPolicyForRole(role)
  const allowedKinds: ReadonlyArray<ToolKind> =
    policy.allowedToolKinds.length === 0 && policy.deniedToolKinds.length === 0
      ? TOOL_KINDS // 'none' = inherit ⇒ all kinds allowed
      : policy.allowedToolKinds
  const allowedToolNames: string[] = []
  for (const k of allowedKinds) {
    const name = KIND_TO_REPRESENTATIVE_TOOL[k]
    if (name === undefined) {
      throw new Error(`internal: no representative tool for kind '${k}'`)
    }
    allowedToolNames.push(name)
  }

  // F15 — build & validate the spawn_agent payload (strict).
  const payloadCandidate = {
    prompt: `child '${nickname}' for parent '${parentTaskId}'`,
    agent_type: role,
    tool_filter: allowedToolNames,
    max_depth: 3,
  }
  const parsed = SpawnAgentInputSchema.safeParse(payloadCandidate)
  if (!parsed.success) {
    throw new Error(
      `spawn_agent payload failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    )
  }
  const payload = parsed.data

  // Cluster B — thread_spawn envelope record.
  const threadSpawnRecord: SessionEnvelopeRecord = {
    type: "thread_spawn",
    schema_version: 1,
    parent_session_id: parentSessionId,
    parent_turn_id: `turn_${parentTaskId}`,
    child_session_id: `sess_${nickname}_${parentTaskId}`,
    child_task_kind: role,
    spawned_at: "2026-05-21T00:00:00.000Z",
  }

  return {
    role,
    parentTaskId,
    nickname,
    payload,
    allowedToolNames,
    threadSpawnRecord,
  }
}

/* ── 1. 100 spawns × 3 roles round-robin ───────────────────────────────── */

/** Compute the expected (allowed, denied) split for a given role. */
const expectedSplit = (
  role: AgentRole,
): { readonly allowed: ReadonlyArray<string>; readonly denied: ReadonlyArray<string> } => {
  const allowed: string[] = []
  const denied: string[] = []
  for (const k of TOOL_KINDS) {
    const repr = KIND_TO_REPRESENTATIVE_TOOL[k]
    if (roleAllowsKind(role, k)) allowed.push(repr)
    else denied.push(repr)
  }
  return { allowed, denied }
}

/** Assert the per-spawn toolFilter matches the expected role policy. */
const assertToolFilterMatchesPolicy = (rec: SpawnedRecord): void => {
  const { allowed, denied } = expectedSplit(rec.role)
  if (rec.role === "none") {
    expect([...rec.allowedToolNames].sort()).toEqual(
      [...Object.values(KIND_TO_REPRESENTATIVE_TOOL)].sort(),
    )
    return
  }
  expect([...rec.allowedToolNames].sort()).toEqual([...allowed].sort())
  for (const d of denied) {
    expect(rec.allowedToolNames.includes(d)).toBe(false)
  }
}

/** Encode → decode → re-encode envelope and assert byte-identical + parent
 *  relationship preserved. */
const assertEnvelopeRoundTrip = (
  rec: SpawnedRecord,
  parentSessionId: string,
  parentTaskId: string,
): void => {
  const line = encodeSessionLine(rec.threadSpawnRecord)
  expect(line.endsWith("\n")).toBe(true)
  expect(line.indexOf("\n")).toBe(line.length - 1)
  const decoded = decodeSessionLine(line.slice(0, -1))
  if (!decoded.ok) {
    throw new Error(`envelope decode failed: ${decoded.error.message}`)
  }
  const reLine = encodeSessionLine(decoded.value)
  expect(reLine).toBe(line)
  if (decoded.value.type !== "thread_spawn") {
    throw new Error(`decoded record is not thread_spawn: type='${decoded.value.type}'`)
  }
  expect(decoded.value.parent_session_id).toBe(parentSessionId)
  expect(decoded.value.parent_turn_id).toBe(`turn_${parentTaskId}`)
  expect(decoded.value.child_task_kind).toBe(rec.role)
}

/** Per-iteration assertion bundle. */
const assertOneSpawn = (
  rec: SpawnedRecord,
  parentSessionId: string,
  parentTaskId: string,
): void => {
  // (a) nickname is in the pool.
  expect(MAESTRO_NICKNAMES).toContain(rec.nickname)
  // (b) nickname is EXACTLY what assignNickname(parentTaskId) returns.
  expect(rec.nickname).toBe(assignNickname(parentTaskId))
  // (c) spawn_agent payload validates strict.
  expect(SpawnAgentInputSchema.safeParse(rec.payload).success).toBe(true)
  // (d) role policy is correctly applied.
  assertToolFilterMatchesPolicy(rec)
  // (e) envelope round-trips byte-equally; parent linkage preserved.
  assertEnvelopeRoundTrip(rec, parentSessionId, parentTaskId)
}

describe("100 spawns round-robin ('explorer','worker','none')", () => {
  const ROLES_RR: ReadonlyArray<AgentRole> = ["explorer", "worker", "none"]
  const PARENT_SESSION = "sess_root_001"

  test("every spawn validates, nickname matches, policy applied, envelope round-trips", () => {
    const records: SpawnedRecord[] = []
    for (let i = 0; i < 100; i++) {
      const role = ROLES_RR[i % 3] as AgentRole
      const parentTaskId = `task_${i.toString().padStart(4, "0")}`
      const rec = spawnFake({ role, parentTaskId, parentSessionId: PARENT_SESSION })
      records.push(rec)
      assertOneSpawn(rec, PARENT_SESSION, parentTaskId)
    }
    expect(records.length).toBe(100)

    // Distribution check: 3 roles × 100 ⇒ 34/33/33 (round-robin starting at index 0).
    const byRole = new Map<AgentRole, number>([
      ["explorer", 0],
      ["worker", 0],
      ["none", 0],
    ])
    for (const r of records) byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1)
    expect(byRole.get("explorer")).toBe(34)
    expect(byRole.get("worker")).toBe(33)
    expect(byRole.get("none")).toBe(33)
  })
})

/* ── 2. faulty spawn does NOT corrupt subsequent good spawns ────────────── */

describe("fault isolation — bad role throws, subsequent spawns succeed", () => {
  test("an invalid role throws UnknownAgentRoleError mid-pipeline, then good spawns still work", () => {
    // Good spawn first.
    const goodA = spawnFake({
      role: "explorer",
      parentTaskId: "task_pre_fault",
      parentSessionId: "sess_root",
    })
    expect(goodA.nickname).toBe(assignNickname("task_pre_fault"))

    // Faulty spawn — must throw.
    let threw: unknown = null
    try {
      spawnFake({
        // biome-ignore lint/suspicious/noExplicitAny: bypassing TS to test runtime guard
        role: "invalid" as any,
        parentTaskId: "task_fault",
        parentSessionId: "sess_root",
      })
    } catch (e) {
      threw = e
    }
    if (!(threw instanceof UnknownAgentRoleError)) {
      throw new Error(`expected UnknownAgentRoleError, got ${String(threw)}`)
    }
    expect(threw.message.includes("invalid")).toBe(true)

    // Subsequent good spawns must still work (no global state corruption).
    const goodB = spawnFake({
      role: "worker",
      parentTaskId: "task_post_fault",
      parentSessionId: "sess_root",
    })
    expect(goodB.nickname).toBe(assignNickname("task_post_fault"))
    expect(SpawnAgentInputSchema.safeParse(goodB.payload).success).toBe(true)
    // worker's denied set must NOT appear in toolFilter.
    expect(goodB.allowedToolNames.includes("fetch")).toBe(false) // network
    expect(goodB.allowedToolNames.includes("agent")).toBe(false) // subagent
    expect(goodB.allowedToolNames.includes("lsp_workspace_symbol")).toBe(false) // lsp
  })
})

/* ── 3. determinism: same (role, parentTaskId) twice ⇒ identical result ─── */

describe("end-to-end determinism", () => {
  test("two spawns with identical inputs produce byte-identical envelopes", () => {
    const a = spawnFake({
      role: "explorer",
      parentTaskId: "task_det_001",
      parentSessionId: "sess_X",
    })
    const b = spawnFake({
      role: "explorer",
      parentTaskId: "task_det_001",
      parentSessionId: "sess_X",
    })
    expect(a.nickname).toBe(b.nickname)
    expect(JSON.stringify(a.payload)).toBe(JSON.stringify(b.payload))
    expect(encodeSessionLine(a.threadSpawnRecord)).toBe(encodeSessionLine(b.threadSpawnRecord))
  })
})

/* ── 4. nickname collision survival: 40 distinct parentTaskIds covers all  */

describe("nickname pool coverage via sequential allocator", () => {
  test("nextSequentialNickname + 39 spawns ⇒ unique nicknames; 40th draw is null", () => {
    const used = new Set<string>()
    for (let i = 0; i < 39; i++) {
      const n = nextSequentialNickname(used)
      if (n === null) throw new Error(`unexpected null at draw ${i}`)
      used.add(n)
      // Build a valid spawn payload that embeds the nickname — proves the
      // 6-tool schema and the nickname pool stay compatible (string min(1)).
      const r = SpawnAgentInputSchema.safeParse({
        prompt: `child '${n}'`,
        agent_type: "explorer",
      })
      expect(r.success).toBe(true)
    }
    expect(used.size).toBe(39)
    expect(nextSequentialNickname(used)).toBeNull()
  })
})
