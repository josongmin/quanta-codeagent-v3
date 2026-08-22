/**
 * Subagent 6-tool HELL e2e (Cluster E / F15, ADR-0041).
 *
 * Exhaustive contract-only matrix. NO real subprocesses; pure Zod schema
 * round-trip exercising every (tool × success/error × mutation) cell plus
 * cross-tool name collision against the live v3 builtin tool registry.
 *
 * Hard rules:
 *   - Every assertion is exact (no .toBeTruthy()).
 *   - Zod errors are interrogated for the SPECIFIC field path.
 *   - The contract table is asserted to be Object.isFrozen.
 *   - No tool name may collide with the v3 builtin tool registry.
 *
 * Isolation: re-asserts env + __resetRuntimeConfig() in beforeEach — even
 * though this file does not consume runtimeConfig today, the harness keeps
 * the isolation invariant uniform across the cluster.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig } from "@/shared"
import {
  CloseAgentInputSchema,
  CloseAgentOutputSchema,
  ExecCommandInputSchema,
  ExecCommandOutputSchema,
  SendInputInputSchema,
  SendInputOutputSchema,
  SpawnAgentInputSchema,
  SpawnAgentOutputSchema,
  SUBAGENT_6_TOOL_CONTRACTS,
  SUBAGENT_6_TOOL_NAMES,
  type Subagent6ToolName,
  WaitAgentInputSchema,
  WaitAgentOutputSchema,
  WriteStdinInputSchema,
  WriteStdinOutputSchema,
} from "@/subagent/tools-6"
import { defaultTools } from "@/tool"

beforeEach(() => {
  __resetRuntimeConfig()
})

/* ── tiny helpers ───────────────────────────────────────────────────────── */

/** Assert a Zod parse failed AND at least one issue's path includes `field`. */
const expectIssueAtField = (
  result: {
    success: false
    error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }> }
  },
  field: string,
): void => {
  const paths = result.error.issues.map((i) => i.path.join("."))
  const hit = paths.some((p) => p === field || p.startsWith(`${field}.`))
  if (!hit) {
    throw new Error(
      `expected a Zod issue at field '${field}', got paths=[${paths.map((p) => `'${p}'`).join(", ")}]`,
    )
  }
}

/** Assert a Zod parse failed because of an unknown/unrecognised key. */
const expectUnknownKey = (result: {
  success: false
  error: { issues: ReadonlyArray<{ message: string; code?: string }> }
}): void => {
  const hit = result.error.issues.some(
    (i) => i.code === "unrecognized_keys" || /unrecognized|unknown|not allowed/i.test(i.message),
  )
  if (!hit) {
    throw new Error(
      `expected an unrecognised-key issue, got messages=[${result.error.issues
        .map((i) => `'${i.message}'`)
        .join(", ")}]`,
    )
  }
}

/* ── 1. table invariants ────────────────────────────────────────────────── */

describe("SUBAGENT_6_TOOL_CONTRACTS — table invariants", () => {
  test("table length is exactly 6", () => {
    expect(Object.keys(SUBAGENT_6_TOOL_CONTRACTS).length).toBe(6)
    expect(SUBAGENT_6_TOOL_NAMES.length).toBe(6)
  })

  test("all 6 tool names are unique strings", () => {
    const names = SUBAGENT_6_TOOL_NAMES.map((n) => {
      if (typeof n !== "string") throw new Error(`non-string tool name: ${String(n)}`)
      return n
    })
    expect(new Set(names).size).toBe(6)
  })

  test("table keys === names list (exact set equality)", () => {
    expect(Object.keys(SUBAGENT_6_TOOL_CONTRACTS).sort()).toEqual([...SUBAGENT_6_TOOL_NAMES].sort())
  })

  test("every entry has an inputSchema and outputSchema (non-null Zod)", () => {
    for (const name of SUBAGENT_6_TOOL_NAMES) {
      const c = SUBAGENT_6_TOOL_CONTRACTS[name]
      expect(c.inputSchema).toBeDefined()
      expect(c.outputSchema).toBeDefined()
      // .safeParse must be a function on a Zod schema.
      expect(typeof c.inputSchema.safeParse).toBe("function")
      expect(typeof c.outputSchema.safeParse).toBe("function")
    }
  })

  test("every output schema is a discriminated union on `kind: success|error`", () => {
    const success = { kind: "success" } as Record<string, unknown>
    const error = { kind: "error", message: "x" }
    for (const name of SUBAGENT_6_TOOL_NAMES) {
      const out = SUBAGENT_6_TOOL_CONTRACTS[name].outputSchema
      // The error shape (with message) must parse for every tool's output schema.
      expect(out.safeParse(error).success).toBe(true)
      // Missing kind ⇒ fail.
      expect(out.safeParse({}).success).toBe(false)
      // Bogus kind ⇒ fail (discriminator).
      expect(out.safeParse({ kind: "neither", message: "x" }).success).toBe(false)
      // success-only without required fields — must fail for tools that need extras.
      // For send_input the minimum success is {kind, delivered:true}; missing
      // `delivered` should fail.
      if (name === "send_input") {
        expect(out.safeParse(success).success).toBe(false)
      }
    }
  })

  test("SUBAGENT_6_TOOL_CONTRACTS is Object.isFrozen", () => {
    expect(Object.isFrozen(SUBAGENT_6_TOOL_CONTRACTS)).toBe(true)
  })
})

/* ── 2. cross-tool name collision vs. v3 builtin registry ───────────────── */

describe("cross-tool name uniqueness vs. v3 builtin tool registry", () => {
  test("no SUBAGENT_6_TOOL name collides with a defaultTools name", () => {
    const builtin = new Set(defaultTools.map((t) => t.name))
    const collisions: string[] = []
    for (const n of SUBAGENT_6_TOOL_NAMES) {
      if (builtin.has(n)) collisions.push(n)
    }
    if (collisions.length > 0) {
      throw new Error(
        `subagent tool name(s) collide with v3 builtin registry: ${collisions.join(", ")}`,
      )
    }
    expect(collisions.length).toBe(0)
  })
})

/* ── 3. per-tool × success/error matrix ─────────────────────────────────── */

interface SuccessCase {
  readonly name: Subagent6ToolName
  readonly inputSchema: { safeParse: (v: unknown) => unknown }
  readonly outputSchema: { safeParse: (v: unknown) => unknown }
  readonly validInput: Record<string, unknown>
  readonly validSuccessOutput: Record<string, unknown>
  /** Field whose type/missing-ness will be mutated for the negative cases. */
  readonly requiredInputField: string
  /** A value of the wrong type for `requiredInputField`. */
  readonly wrongTypeForField: unknown
  /** A field that MUST appear only in the success branch (never in error). */
  readonly successOnlyField: string
}

const CASES: readonly SuccessCase[] = [
  {
    name: "exec_command",
    inputSchema: ExecCommandInputSchema,
    outputSchema: ExecCommandOutputSchema,
    validInput: { command: "ls", cwd: "/tmp", timeoutMs: 1000 },
    validSuccessOutput: { kind: "success", exitCode: 0, stdout: "", stderr: "" },
    requiredInputField: "cwd",
    wrongTypeForField: 123,
    successOnlyField: "exitCode",
  },
  {
    name: "write_stdin",
    inputSchema: WriteStdinInputSchema,
    outputSchema: WriteStdinOutputSchema,
    validInput: { pid: 1234, data: "hello" },
    validSuccessOutput: { kind: "success", bytesWritten: 5 },
    requiredInputField: "pid",
    wrongTypeForField: "not-a-number",
    successOnlyField: "bytesWritten",
  },
  {
    name: "spawn_agent",
    inputSchema: SpawnAgentInputSchema,
    outputSchema: SpawnAgentOutputSchema,
    validInput: { prompt: "do x" },
    validSuccessOutput: { kind: "success", agentId: "agent_1" },
    requiredInputField: "prompt",
    wrongTypeForField: 42,
    successOnlyField: "agentId",
  },
  {
    name: "wait_agent",
    inputSchema: WaitAgentInputSchema,
    outputSchema: WaitAgentOutputSchema,
    validInput: { agentId: "agent_1" },
    validSuccessOutput: {
      kind: "success",
      status: "completed",
      finalText: "ok",
      turns: 3,
    },
    requiredInputField: "agentId",
    wrongTypeForField: true,
    successOnlyField: "status",
  },
  {
    name: "close_agent",
    inputSchema: CloseAgentInputSchema,
    outputSchema: CloseAgentOutputSchema,
    validInput: { agentId: "agent_1" },
    validSuccessOutput: { kind: "success", wasRunning: false },
    requiredInputField: "agentId",
    wrongTypeForField: 0,
    successOnlyField: "wasRunning",
  },
  {
    name: "send_input",
    inputSchema: SendInputInputSchema,
    outputSchema: SendInputOutputSchema,
    validInput: { agentId: "agent_1", message: "go" },
    validSuccessOutput: { kind: "success", delivered: true },
    requiredInputField: "agentId",
    wrongTypeForField: null,
    successOnlyField: "delivered",
  },
]

describe("per-tool × success-and-error path matrix", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test("valid input round-trips", () => {
        const r = c.inputSchema.safeParse(c.validInput) as { success: boolean }
        expect(r.success).toBe(true)
      })

      test("valid success output round-trips", () => {
        const r = c.outputSchema.safeParse(c.validSuccessOutput) as { success: boolean }
        expect(r.success).toBe(true)
      })

      test("valid error output round-trips (with cause)", () => {
        const r = c.outputSchema.safeParse({
          kind: "error",
          message: "boom",
          cause: "timeout",
        }) as { success: boolean }
        expect(r.success).toBe(true)
      })

      test("valid error output round-trips (without cause — optional)", () => {
        const r = c.outputSchema.safeParse({ kind: "error", message: "boom" }) as {
          success: boolean
        }
        expect(r.success).toBe(true)
      })

      test("error output rejects empty message", () => {
        const r = c.outputSchema.safeParse({ kind: "error", message: "" }) as { success: boolean }
        expect(r.success).toBe(false)
      })

      test("MUTATION: drop required input field ⇒ typed Zod error at that field", () => {
        const broken = { ...c.validInput }
        delete (broken as Record<string, unknown>)[c.requiredInputField]
        const r = c.inputSchema.safeParse(broken) as
          | { success: true }
          | {
              success: false
              error: {
                issues: ReadonlyArray<{
                  path: ReadonlyArray<string | number>
                  message: string
                  code?: string
                }>
              }
            }
        if (r.success) throw new Error(`expected failure for missing ${c.requiredInputField}`)
        expectIssueAtField(r, c.requiredInputField)
      })

      test("MUTATION: wrong type for required input field ⇒ typed Zod error at that field", () => {
        const broken = { ...c.validInput, [c.requiredInputField]: c.wrongTypeForField }
        const r = c.inputSchema.safeParse(broken) as
          | { success: true }
          | {
              success: false
              error: {
                issues: ReadonlyArray<{
                  path: ReadonlyArray<string | number>
                  message: string
                  code?: string
                }>
              }
            }
        if (r.success) {
          throw new Error(`expected failure for wrong-type ${c.requiredInputField}`)
        }
        expectIssueAtField(r, c.requiredInputField)
      })

      test("MUTATION: extra unknown key on input ⇒ rejection (strict)", () => {
        const r = c.inputSchema.safeParse({
          ...c.validInput,
          __unknown_extra__: 1,
        }) as
          | { success: true }
          | {
              success: false
              error: {
                issues: ReadonlyArray<{ message: string; code?: string }>
              }
            }
        if (r.success) throw new Error("expected strict rejection for extra key")
        expectUnknownKey(r)
      })

      test("MUTATION: extra unknown key on success output ⇒ rejection (strict)", () => {
        const r = c.outputSchema.safeParse({
          ...c.validSuccessOutput,
          __unknown__: true,
        }) as
          | { success: true }
          | {
              success: false
              error: { issues: ReadonlyArray<{ message: string; code?: string }> }
            }
        if (r.success) throw new Error("expected strict rejection for extra key on success output")
        expectUnknownKey(r)
      })

      test("DISCRIMINATOR: success-only field cannot appear in error shape", () => {
        // Add the success-only field onto an error payload — must fail because
        // ErrorShape is .strict().
        const bad: Record<string, unknown> = {
          kind: "error",
          message: "boom",
          [c.successOnlyField]: (c.validSuccessOutput as Record<string, unknown>)[
            c.successOnlyField
          ],
        }
        const r = c.outputSchema.safeParse(bad) as { success: boolean }
        expect(r.success).toBe(false)
      })

      test("DISCRIMINATOR: error-only field 'message' cannot appear in success shape", () => {
        const bad = { ...c.validSuccessOutput, message: "boom" } as Record<string, unknown>
        const r = c.outputSchema.safeParse(bad) as { success: boolean }
        expect(r.success).toBe(false)
      })
    })
  }
})

/* ── 4. exec_command vs. write_stdin distinction ───────────────────────── */

describe("exec_command vs. write_stdin — schemas enforce distinct shapes", () => {
  test("write_stdin REQUIRES pid (no PTY session ⇒ rejection)", () => {
    const r = WriteStdinInputSchema.safeParse({ data: "hello" }) as
      | { success: true }
      | {
          success: false
          error: {
            issues: ReadonlyArray<{
              path: ReadonlyArray<string | number>
              message: string
              code?: string
            }>
          }
        }
    if (r.success) throw new Error("expected write_stdin without pid to fail")
    expectIssueAtField(r, "pid")
  })

  test("exec_command does NOT require a PTY session id (no `pid` on input)", () => {
    const r = ExecCommandInputSchema.safeParse({
      command: "ls",
      cwd: "/tmp",
      timeoutMs: 1000,
    }) as { success: boolean }
    expect(r.success).toBe(true)
  })

  test("exec_command rejects an unknown `pid` field on input (strict)", () => {
    // Per the contract, exec_command does NOT take a `pid` on input — that
    // belongs on the OUTPUT when pty:true. Putting it on input must trip the
    // strict guard.
    const r = ExecCommandInputSchema.safeParse({
      command: "ls",
      cwd: "/tmp",
      timeoutMs: 1000,
      pid: 1234,
    }) as
      | { success: true }
      | { success: false; error: { issues: ReadonlyArray<{ message: string; code?: string }> } }
    if (r.success) throw new Error("expected strict rejection for input.pid on exec_command")
    expectUnknownKey(r)
  })

  test("exec_command success output ALLOWS pid (the PTY pid for follow-up write_stdin)", () => {
    const r = ExecCommandOutputSchema.safeParse({
      kind: "success",
      exitCode: 0,
      stdout: "",
      stderr: "",
      pid: 4242,
    }) as { success: boolean }
    expect(r.success).toBe(true)
  })

  test("write_stdin success output exposes bytesWritten (no pid echo)", () => {
    const okOut = WriteStdinOutputSchema.safeParse({
      kind: "success",
      bytesWritten: 5,
    }) as { success: boolean }
    expect(okOut.success).toBe(true)
    // Echoing the pid in the success output is NOT part of the contract.
    const withPid = WriteStdinOutputSchema.safeParse({
      kind: "success",
      bytesWritten: 5,
      pid: 1,
    }) as { success: boolean }
    expect(withPid.success).toBe(false)
  })
})

/* ── 5. spawn → wait → close lifecycle (contract-level) ──────────────────── */

describe("spawn → wait → close lifecycle (id threading)", () => {
  test("agentId from spawn flows through wait and close — all 3 schemas accept the same id", () => {
    const spawnOut = SpawnAgentOutputSchema.safeParse({
      kind: "success",
      agentId: "agent_xyz",
    }) as { success: true; data: { kind: "success"; agentId: string } } | { success: false }
    if (!spawnOut.success) throw new Error("spawn output failed to parse")
    const id = spawnOut.data.agentId
    expect(id).toBe("agent_xyz")

    // wait — accepts the id, plus an optional timeout.
    expect(WaitAgentInputSchema.safeParse({ agentId: id, timeoutMs: 5000 }).success).toBe(true)
    expect(WaitAgentInputSchema.safeParse({ agentId: id }).success).toBe(true)

    // close — accepts the id.
    expect(CloseAgentInputSchema.safeParse({ agentId: id }).success).toBe(true)
  })

  test("wait_agent timeout success: cause:'timeout' on error branch (idempotent semantic)", () => {
    // The contract says: on timeout, wait_agent returns kind:'error' with
    // cause:'timeout' so the caller can re-await or close. Assert both branches
    // parse cleanly.
    const errOut = WaitAgentOutputSchema.safeParse({
      kind: "error",
      message: "timed out after 1000ms",
      cause: "timeout",
    }) as { success: boolean }
    expect(errOut.success).toBe(true)

    const sucOut = WaitAgentOutputSchema.safeParse({
      kind: "success",
      status: "completed",
      finalText: "done",
      turns: 1,
    }) as { success: boolean }
    expect(sucOut.success).toBe(true)
  })

  test("close_agent is idempotent: wasRunning:false on already-settled child parses cleanly", () => {
    const r = CloseAgentOutputSchema.safeParse({ kind: "success", wasRunning: false }) as {
      success: boolean
    }
    expect(r.success).toBe(true)
  })
})

/* ── 6. send_input vs. write_stdin (distinct purposes) ──────────────────── */

describe("send_input is for paused subagents — distinct shape from write_stdin", () => {
  test("send_input rejects `pid` (it routes by agentId, NOT by PTY pid)", () => {
    const r = SendInputInputSchema.safeParse({
      agentId: "agent_1",
      message: "go",
      pid: 1234,
    }) as
      | { success: true }
      | { success: false; error: { issues: ReadonlyArray<{ message: string; code?: string }> } }
    if (r.success) throw new Error("expected strict rejection of pid on send_input")
    expectUnknownKey(r)
  })

  test("write_stdin rejects `agentId` (it routes by pid, NOT by agentId)", () => {
    const r = WriteStdinInputSchema.safeParse({
      agentId: "agent_1",
      data: "hello",
      pid: 1,
    }) as
      | { success: true }
      | { success: false; error: { issues: ReadonlyArray<{ message: string; code?: string }> } }
    if (r.success) throw new Error("expected strict rejection of agentId on write_stdin")
    expectUnknownKey(r)
  })

  test("send_input message: structured conversational text (>= 1 char)", () => {
    expect(SendInputInputSchema.safeParse({ agentId: "a", message: "x" }).success).toBe(true)
    expect(SendInputInputSchema.safeParse({ agentId: "a", message: "" }).success).toBe(false)
  })

  test("write_stdin data: raw bytes — accepts empty string (write_stdin('') is a flush)", () => {
    // The schema only requires a string; empty is legal (a no-op write).
    expect(WriteStdinInputSchema.safeParse({ pid: 1, data: "" }).success).toBe(true)
  })
})
