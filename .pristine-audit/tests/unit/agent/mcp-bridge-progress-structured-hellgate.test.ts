/** §19.2 / §19.4 — MCP ingestion completion: structuredContent passthrough +
 *  streaming progress bridge. Plus §19.4 `parseProgress` and §19.5
 *  tools/list_changed routing (the pure parse/route seams).
 *
 *  Invariants pinned:
 *   - §19.2: a server `structuredContent` flows to `ToolResult.structured`;
 *     ABSENT ⇒ no `structured` key (byte-identical to the legacy result).
 *   - §19.4: inbound progress ticks are relayed as ordered `ToolEvent.progress`
 *     BEFORE the final result; a throwing call is still mapped to `ok:false`
 *     (never throws out of the generator); a tick AFTER the opening line.
 *   - §19.4 parse: token/`progress` validation, `total`/`message` handling,
 *     oversized-message DoS cap.
 *   - §19.5: `notifications/tools/list_changed` parses + routes to the observer.
 */

import { describe, expect, test } from "bun:test"
import { mcpToolToTool } from "@/agent"
import type { McpCallResult, McpClient, McpProgress, McpProgressHandler, McpToolDef } from "@/mcp"
import { isProgressMethod, PROGRESS_MAX_MESSAGE_CHARS, parseProgress } from "@/mcp"
import {
  isResourceNotificationMethod,
  type McpResourceNotification,
  parseResourceNotification,
  routeResourceNotification,
  TOOLS_LIST_CHANGED_METHOD,
} from "@/mcp/resources/notifications"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }
const def: McpToolDef = { name: "do_thing", description: "d", inputSchema: { type: "object" } }

const drainAll = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}
const lastResult = (evs: ToolEvent[]): ToolResult => {
  const r = [...evs].reverse().find((e) => e.type === "result")
  if (r === undefined || r.type !== "result") throw new Error("no result")
  return r.result
}

/** Fake client: scripts progress ticks (fired synchronously inside callTool)
 *  then resolves with `result`. Casts to McpClient (only callTool is used). */
const scriptedClient = (ticks: McpProgress[], result: McpCallResult): McpClient =>
  ({
    callTool: async (
      _n: string,
      _a: unknown,
      opts?: { onProgress?: McpProgressHandler },
    ): Promise<McpCallResult> => {
      for (const t of ticks) opts?.onProgress?.(t)
      return result
    },
  }) as unknown as McpClient

const throwingClient = (): McpClient =>
  ({
    callTool: async (): Promise<McpCallResult> => {
      throw new Error("boom")
    },
  }) as unknown as McpClient

describe("§19.2 — structuredContent → ToolResult.structured", () => {
  test("server structuredContent flows to ToolResult.structured", async () => {
    const client = scriptedClient([], { ok: true, content: "txt", structured: { rows: [1, 2] } })
    const res = lastResult(await drainAll(mcpToolToTool(client, def, "srv").execute({}, ctx)))
    expect(res.structured).toEqual({ rows: [1, 2] })
    expect(res.output).toBe("txt")
  })

  test("absent structuredContent ⇒ no structured key (byte-identical)", async () => {
    const client = scriptedClient([], { ok: true, content: "txt" })
    const res = lastResult(await drainAll(mcpToolToTool(client, def, "srv").execute({}, ctx)))
    expect("structured" in res).toBe(false)
  })
})

describe("§19.4 — streaming progress bridge (opt-in via { progress: true })", () => {
  test("inbound ticks relay as ordered progress events BEFORE the result", async () => {
    const ticks: McpProgress[] = [
      { progressToken: 1, progress: 3, total: 10 },
      { progressToken: 1, progress: 7, total: 10, message: "halfway" },
    ]
    const client = scriptedClient(ticks, { ok: true, content: "done" })
    const evs = await drainAll(
      mcpToolToTool(client, def, "srv", { progress: true }).execute({}, ctx),
    )
    const kinds = evs.map((e) => e.type)
    // opening "calling…" progress, then 2 relayed progress, then the result.
    expect(kinds).toEqual(["progress", "progress", "progress", "result"])
    const progressMsgs = evs.filter((e) => e.type === "progress").map((e) => e.message)
    expect(progressMsgs[1]).toContain("3/10 (30%)")
    expect(progressMsgs[2]).toContain("7/10 (70%)")
    expect(progressMsgs[2]).toContain("halfway")
    expect(lastResult(evs).output).toBe("done")
  })

  test("a throwing call is mapped to ok:false (never throws out of the generator)", async () => {
    const evs = await drainAll(
      mcpToolToTool(throwingClient(), def, "srv", { progress: true }).execute({}, ctx),
    )
    const res = lastResult(evs)
    expect(res.ok).toBe(false)
    expect(res.output).toContain("boom")
  })

  test("DEFAULT-OFF: no progress opt ⇒ onProgress NOT forwarded, no ticks relayed", async () => {
    // The scripted client would fire ticks IF given an onProgress sink; with
    // progress off the bridge passes `undefined`, so callTool gets no sink and
    // the wire carries no `_meta` ⇒ only opening progress + result.
    let sawSink = false
    const client = {
      callTool: async (
        _n: string,
        _a: unknown,
        opts?: { onProgress?: McpProgressHandler },
      ): Promise<McpCallResult> => {
        sawSink = opts?.onProgress !== undefined
        return { ok: true, content: "x" }
      },
    } as unknown as McpClient
    const evs = await drainAll(mcpToolToTool(client, def, "srv").execute({}, ctx))
    expect(sawSink).toBe(false)
    expect(evs.map((e) => e.type)).toEqual(["progress", "result"])
  })
})

describe("§19.4 — parseProgress validation + DoS cap", () => {
  test("valid {progressToken, progress} parses", () => {
    expect(parseProgress({ progressToken: "t", progress: 5 })).toEqual({
      progressToken: "t",
      progress: 5,
    })
  })
  test("missing token / non-finite progress ⇒ null", () => {
    expect(parseProgress({ progress: 5 })).toBeNull()
    expect(parseProgress({ progressToken: 1, progress: Number.NaN })).toBeNull()
    expect(parseProgress({ progressToken: 1, progress: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseProgress("nope")).toBeNull()
  })
  test("total kept only when finite; message kept when string", () => {
    expect(parseProgress({ progressToken: 1, progress: 1, total: 9, message: "m" })).toEqual({
      progressToken: 1,
      progress: 1,
      total: 9,
      message: "m",
    })
    expect(parseProgress({ progressToken: 1, progress: 1, total: Number.NaN })).toEqual({
      progressToken: 1,
      progress: 1,
    })
  })
  test("oversized message is length-capped (no large retain)", () => {
    const huge = "x".repeat(PROGRESS_MAX_MESSAGE_CHARS + 5000)
    const p = parseProgress({ progressToken: 1, progress: 1, message: huge })
    expect(p?.message?.length).toBe(PROGRESS_MAX_MESSAGE_CHARS)
  })
  test("isProgressMethod recognizes only notifications/progress", () => {
    expect(isProgressMethod("notifications/progress")).toBe(true)
    expect(isProgressMethod("notifications/resources/updated")).toBe(false)
  })
})

describe("§19.5 — tools/list_changed routing", () => {
  test("parses to a parameterless tools_list_changed event", () => {
    expect(parseResourceNotification(TOOLS_LIST_CHANGED_METHOD, {})).toEqual({
      kind: "tools_list_changed",
    })
  })
  test("isResourceNotificationMethod recognizes it", () => {
    expect(isResourceNotificationMethod(TOOLS_LIST_CHANGED_METHOD)).toBe(true)
  })
  test("routes to the observer", () => {
    const seen: McpResourceNotification[] = []
    routeResourceNotification(
      { onNotification: (e) => seen.push(e) },
      TOOLS_LIST_CHANGED_METHOD,
      {},
    )
    expect(seen).toEqual([{ kind: "tools_list_changed" }])
  })
  test("a throwing observer cannot crash the router", () => {
    expect(() =>
      routeResourceNotification(
        {
          onNotification: () => {
            throw new Error("bad sink")
          },
        },
        TOOLS_LIST_CHANGED_METHOD,
        {},
      ),
    ).not.toThrow()
  })
})
