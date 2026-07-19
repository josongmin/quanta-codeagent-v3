/**
 * Hellgate — TOOL-CONTRACT CONFORMANCE harness for EVERY tool added this
 * session, driven through the REAL `Tool.execute` async iterator.
 *
 * The `Tool` contract (`src/tool/types.ts`) demands of every `execute`:
 *
 *   1. EXACTLY-ONE terminal `{type:"result"}` event (progress events may
 *      precede it). Zero results HANGS the dispatch loop; two CORRUPTS it.
 *   2. NO-THROW — neither `execute()` nor its async iterator may reject. A
 *      port that throws MUST be caught and mapped to an `ok:false` result.
 *      We inject a THROWING host port for every port-backed tool and assert
 *      the iterator yields a result instead of rejecting.
 *   3. ABORT taxonomy — a pre-aborted `ctx.signal` yields a clean `ok:false`
 *      result (never a throw, never a hang).
 *   4. FAILURE mode taxonomy — `failure.mode` is `rejected` (model's fault,
 *      retryable by changing input) vs `error` (system, not the model's fault).
 *
 * This harness IS the deliverable: it pins the contract for ALL session tools
 * at once. A real divergence is a FINDING the source fix must turn green.
 *
 * Tools covered: pty_* (6), mcp_list_resources / mcp_read_resource /
 * mcp_list_prompts / mcp_get_prompt (4), mcp_connector_list /
 * mcp_connector_install (2), communicate_update (1), side_agent_* (4),
 * coverage_check (1), prompt_cache_status (1), image_gen (1),
 * xlsx_write / docx_write / pptx_write (3), xlsx_read / docx_read (2).
 */

import { describe, expect, test } from "bun:test"
import { defaultTools, type Tool, ToolRegistry, type ToolContext, type ToolEvent, type ToolResult } from "@/tool"
import { createCommunicateUpdateTool } from "@/tool/communicate-update"
import { coverageCheckTool } from "@/tool/coverage_check"
import { docxWriteTool, pptxWriteTool, xlsxWriteTool } from "@/tool/document/authoring"
import { docxReadTool } from "@/tool/document/docx-read"
import { xlsxReadTool } from "@/tool/document/xlsx-read"
import { imageGenTool } from "@/tool/image-gen"
import { mcpResourcesTools } from "@/tool/mcp_resources"
import { mcpTasksTools } from "@/tool/mcp_tasks"
import { mcpConnectorTools } from "@/tool/mcp-connector"
import { pollDeferredTool } from "@/tool/poll_deferred"
import { promptCacheStatusTool } from "@/tool/prompt_cache_status"
import { ptyTools } from "@/tool/pty"
import { shadowVerifyTool } from "@/tool/shadow-verify"
import { sideAgentTools } from "@/tool/side-agent"

// ── harness ──────────────────────────────────────────────────────────────

const ctxLive = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })
const ctxAborted = (): ToolContext => {
  const ac = new AbortController()
  ac.abort()
  return { cwd: "/tmp", signal: ac.signal }
}

interface DrainOutcome {
  threw: boolean
  error?: unknown
  results: ToolResult[]
  progressCount: number
}

/** Drive an `execute` to completion, capturing EVERY event + any rejection.
 *  This is the single point that exercises the iterator contract: it never
 *  lets a throw escape so the assertions can inspect it. */
const drain = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<DrainOutcome> => {
  const results: ToolResult[] = []
  let progressCount = 0
  try {
    for await (const ev of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") results.push(ev.result)
      else progressCount += 1
    }
  } catch (error) {
    return { threw: true, error, results, progressCount }
  }
  return { threw: false, results, progressCount }
}

/** The three universal conformance assertions for a non-aborted, port-throwing
 *  call: the iterator must NOT reject, and it must yield EXACTLY one result. */
const expectOneResultNoThrow = (o: DrainOutcome): ToolResult => {
  expect(o.threw, `iterator rejected: ${String(o.error)}`).toBe(false)
  expect(o.results.length, "must yield exactly one terminal result").toBe(1)
  return o.results[0] as ToolResult
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

describe("default tool auto-discovery conformance", () => {
  test("every registered default tool advertises a complete model-facing contract without a hand-maintained list", () => {
    const registry = new ToolRegistry(defaultTools)
    const discovered = registry.all()
    expect(discovered.length).toBeGreaterThanOrEqual(20) // anti-vacuum floor
    expect(new Set(discovered.map((tool) => tool.name)).size).toBe(discovered.length)

    const advertised = new Map(registry.specs().map((spec) => [spec.name, spec]))
    for (const tool of discovered) {
      const spec = advertised.get(tool.name)
      expect(spec, `${tool.name} must be advertised by the live registry`).toBeDefined()
      expect(tool.description.trim().length, `${tool.name} needs a model-facing description`).toBeGreaterThan(0)
      expect(spec?.input_schema, `${tool.name} needs an input schema`).toBeDefined()
      expect(typeof tool.isReadOnly()).toBe("boolean")
      expect(typeof tool.isConcurrencySafe({} as never)).toBe("boolean")
    }
  })
})

// ── throwing-port factories ────────────────────────────────────────────────

const BOOM = new Error("boom: port exploded")

const throwingPtyPort = () =>
  ({
    list: () => Promise.reject(BOOM),
    attach: () => Promise.reject(BOOM),
    write: () => Promise.reject(BOOM),
    read: () => Promise.reject(BOOM),
    resize: () => Promise.reject(BOOM),
    detach: () => Promise.reject(BOOM),
    kill: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingResourcesPort = () =>
  ({
    listResources: () => Promise.reject(BOOM),
    readResource: () => Promise.reject(BOOM),
    listPrompts: () => Promise.reject(BOOM),
    getPrompt: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingConnectorPort = () =>
  ({
    list: () => {
      throw BOOM
    },
    install: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingDaemonPort = () =>
  ({
    spawn: () => {
      throw BOOM
    },
    findings: () => {
      throw BOOM
    },
    list: () => {
      throw BOOM
    },
    stop: () => {
      throw BOOM
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingObserver = () =>
  ({
    snapshot: () => {
      throw BOOM
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingImagePort = () =>
  ({
    generate: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

// jun-06 no-throw ratchet fixes — throwing ports for the tools whose execute
// bodies were the round-3 class (port await with NO try/catch) and have now
// been wrapped. These drive the FIX through the real iterator: a throwing port
// must yield exactly one ok:false result, never reject.
const throwingTasksPort = () =>
  ({
    list: () => Promise.reject(BOOM),
    getInfo: () => Promise.reject(BOOM),
    getResult: () => Promise.reject(BOOM),
    cancel: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingShadowPort = () =>
  ({
    verify: () => Promise.reject(BOOM),
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

const throwingDeferredRegistry = () =>
  ({
    await: () => Promise.reject(BOOM),
    poll: () => {
      throw BOOM
    },
    register: () => {
      throw BOOM
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural throwing double
  }) as any

// ── pty_* (6) ───────────────────────────────────────────────────────────────

describe("pty_* contract conformance", () => {
  const valid: Record<string, unknown> = {
    pty_list: {},
    pty_attach: { handle: "pty:1" },
    pty_write: { handle: "pty:1", data: "x" },
    pty_read: { handle: "pty:1" },
    pty_resize: { handle: "pty:1", cols: 80, rows: 24 },
    pty_kill: { handle: "pty:1" },
  }

  for (const name of Object.keys(valid)) {
    test(`${name}: throwing port → one ok:false result, no iterator reject`, async () => {
      const tool = byName(ptyTools(throwingPtyPort()), name)
      const o = await drain(tool, valid[name], ctxLive())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })

    test(`${name}: pre-aborted ctx → one clean ok:false result`, async () => {
      const tool = byName(ptyTools(throwingPtyPort()), name)
      const o = await drain(tool, valid[name], ctxAborted())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })
  }
})

// ── mcp_resources (4) ─────────────────────────────────────────────────────────

describe("mcp_resources contract conformance", () => {
  const valid: Record<string, unknown> = {
    mcp_list_resources: {},
    mcp_read_resource: { uri: "file:///x" },
    mcp_list_prompts: {},
    mcp_get_prompt: { name: "p" },
  }

  for (const name of Object.keys(valid)) {
    test(`${name}: throwing port → one ok:false result, no iterator reject`, async () => {
      const tool = byName(mcpResourcesTools(throwingResourcesPort()), name)
      const o = await drain(tool, valid[name], ctxLive())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })

    test(`${name}: pre-aborted ctx → one clean ok:false result`, async () => {
      const tool = byName(mcpResourcesTools(throwingResourcesPort()), name)
      const o = await drain(tool, valid[name], ctxAborted())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })
  }
})

// ── mcp_connector (2) ──────────────────────────────────────────────────────────

describe("mcp_connector contract conformance", () => {
  const valid: Record<string, unknown> = {
    mcp_connector_list: {},
    mcp_connector_install: { id: "ctx7" },
  }

  for (const name of Object.keys(valid)) {
    test(`${name}: throwing port → one ok:false result, no iterator reject`, async () => {
      const tool = byName(mcpConnectorTools(throwingConnectorPort()), name)
      const o = await drain(tool, valid[name], ctxLive())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })

    test(`${name}: pre-aborted ctx → one clean ok:false result`, async () => {
      const tool = byName(mcpConnectorTools(throwingConnectorPort()), name)
      const o = await drain(tool, valid[name], ctxAborted())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })
  }
})

// ── side_agent (4) ─────────────────────────────────────────────────────────────

describe("side_agent contract conformance", () => {
  const valid: Record<string, unknown> = {
    side_agent_spawn: {
      task: "watch",
      trigger: { kind: "interval", every_ms: 1000 },
      max_wakes: 1,
      max_turns_per_wake: 1,
    },
    side_agent_list: {},
    side_agent_stop: { id: "sa-1" },
    side_agent_findings: {},
  }

  for (const name of Object.keys(valid)) {
    test(`${name}: throwing registry → one ok:false result, no iterator reject`, async () => {
      const tool = byName(sideAgentTools(throwingDaemonPort()), name)
      const o = await drain(tool, valid[name], ctxLive())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })

    test(`${name}: pre-aborted ctx → one clean ok:false result`, async () => {
      const tool = byName(sideAgentTools(throwingDaemonPort()), name)
      const o = await drain(tool, valid[name], ctxAborted())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })
  }
})

// ── prompt_cache_status (1) ────────────────────────────────────────────────────

describe("prompt_cache_status contract conformance", () => {
  test("throwing observer → one ok:false result, mode error, no iterator reject", async () => {
    const tool = promptCacheStatusTool(throwingObserver())
    const o = await drain(tool, {}, ctxLive())
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })

  test("pre-aborted ctx → one rejected result", async () => {
    const tool = promptCacheStatusTool(throwingObserver())
    const o = await drain(tool, {}, ctxAborted())
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
  })
})

// ── image_gen (1) ──────────────────────────────────────────────────────────────

describe("image_gen contract conformance", () => {
  test("throwing provider → one ok:false (mode error), no iterator reject", async () => {
    const tool = imageGenTool({ port: throwingImagePort() })
    const o = await drain(tool, { prompt: "a cat", outputPath: "out/cat.png" }, ctxLive())
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })

  test("pre-aborted ctx → one clean ok:false result", async () => {
    const tool = imageGenTool({ port: throwingImagePort() })
    const o = await drain(tool, { prompt: "a cat", outputPath: "out/cat.png" }, ctxAborted())
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(false)
  })
})

// ── communicate_update (1) — pure, no port ─────────────────────────────────────

describe("communicate_update contract conformance", () => {
  test("throwing sink → still exactly one ok:true result, no iterator reject", async () => {
    const tool = createCommunicateUpdateTool()
    const ctx: ToolContext = {
      ...ctxLive(),
      progressSink: {
        emit: () => {
          throw BOOM
        },
      },
    }
    const o = await drain(tool, { current_step: "step 1" }, ctx)
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(true)
  })

  test("absent sink → one ok:true result", async () => {
    const tool = createCommunicateUpdateTool()
    const o = await drain(tool, { current_step: "step 1" }, ctxLive())
    const r = expectOneResultNoThrow(o)
    expect(r.ok).toBe(true)
  })
})

// ── coverage_check / readers / writers — abort + invalid taxonomy ───────────────
// These tools touch the FS via the jail chokepoint (no injectable throwing port
// in the harness), so the conformance lens here is: pre-abort yields one clean
// result, invalid input yields one rejected/ok:false result, and a missing /
// jail-escaping path yields a single typed result (never a throw, never a hang).

describe("fs-backed tools contract conformance", () => {
  const cases: { tool: Tool; valid: unknown; abortable: boolean }[] = [
    {
      tool: coverageCheckTool as Tool,
      valid: { coverageJsonPath: "../../../etc/passwd" },
      abortable: true,
    },
    { tool: xlsxReadTool as Tool, valid: { path: "nope.xlsx" }, abortable: false },
    { tool: docxReadTool as Tool, valid: { path: "nope.docx" }, abortable: false },
    {
      tool: xlsxWriteTool as Tool,
      valid: { path: "../escape.xlsx", sheets: [{ name: "s", rows: [["a"]] }] },
      abortable: true,
    },
    {
      tool: docxWriteTool as Tool,
      valid: { path: "../escape.docx", paragraphs: [] },
      abortable: true,
    },
    {
      tool: pptxWriteTool as Tool,
      valid: { path: "../escape.pptx", slides: [{ title: "t" }] },
      abortable: true,
    },
  ]

  for (const { tool, valid, abortable } of cases) {
    test(`${tool.name}: valid-shape call → one result, never throws/hangs`, async () => {
      const o = await drain(tool, valid, ctxLive())
      expectOneResultNoThrow(o)
    })

    test(`${tool.name}: invalid input → one ok:false result`, async () => {
      const o = await drain(tool, { bogus: 1 }, ctxLive())
      const r = expectOneResultNoThrow(o)
      expect(r.ok).toBe(false)
    })

    if (abortable) {
      test(`${tool.name}: pre-aborted ctx → one clean ok:false result`, async () => {
        const o = await drain(tool, valid, ctxAborted())
        const r = expectOneResultNoThrow(o)
        expect(r.ok).toBe(false)
      })
    }
  }
})

// ── mcp_tasks (3) + shadow_verify (1) + poll_deferred (1) ───────────────────
// jun-06 no-throw ratchet — these execute bodies awaited an INJECTED port with
// NO try/catch (the round-3 class). Now guarded; a throwing port must yield ONE
// ok:false result and the iterator must never reject. The static ratchet in
// `tool-no-throw-contract-guard.test.ts` proves no NEW tool regresses; THESE
// drive the fixed bodies through the real iterator at runtime.

describe("mcp_tasks contract conformance (no-throw fix)", () => {
  const valid: Record<string, unknown> = {
    list_mcp_tasks: {},
    get_mcp_task: { taskId: "t1" },
    cancel_mcp_task: { taskId: "t1" },
  }
  for (const name of Object.keys(valid)) {
    test(`${name}: throwing port → one ok:false result, no iterator reject`, async () => {
      const tool = byName(mcpTasksTools(throwingTasksPort()), name)
      const r = expectOneResultNoThrow(await drain(tool, valid[name], ctxLive()))
      expect(r.ok).toBe(false)
    })
    test(`${name}: pre-aborted ctx → one clean ok:false result`, async () => {
      const tool = byName(mcpTasksTools(throwingTasksPort()), name)
      const r = expectOneResultNoThrow(await drain(tool, valid[name], ctxAborted()))
      expect(r.ok).toBe(false)
    })
  }
})

describe("shadow_verify contract conformance (no-throw fix)", () => {
  const validInput = { patch: "@@ -1 +1 @@", checks: ["lint"] }
  test("throwing port → one ok:false (mode error), no iterator reject", async () => {
    const tool = shadowVerifyTool(throwingShadowPort())
    const r = expectOneResultNoThrow(await drain(tool, validInput, ctxLive()))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })
  test("pre-aborted ctx → one clean ok:false result", async () => {
    const tool = shadowVerifyTool(throwingShadowPort())
    const r = expectOneResultNoThrow(await drain(tool, validInput, ctxAborted()))
    expect(r.ok).toBe(false)
  })
})

describe("poll_deferred contract conformance (no-throw fix)", () => {
  test("throwing registry (blocking await) → one ok:false result, no iterator reject", async () => {
    const tool = pollDeferredTool(throwingDeferredRegistry())
    const r = expectOneResultNoThrow(await drain(tool, { handle: "h1", awaitMs: 5 }, ctxLive()))
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })
  test("throwing registry (sync poll) → one ok:false result, no iterator reject", async () => {
    const tool = pollDeferredTool(throwingDeferredRegistry())
    const r = expectOneResultNoThrow(await drain(tool, { handle: "h1" }, ctxLive()))
    expect(r.ok).toBe(false)
  })
})
