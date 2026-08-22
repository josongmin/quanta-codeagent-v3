import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { buildNetworkDispatchGuard } from "@/agent/dispatch-guard"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { webFetchTool } from "@/tool/web"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for NETWORK-EGRESS ENFORCEMENT
 * (`network-egress-enforcement` feature). Prior coverage
 * (`tests/unit/agent/network-egress-wiring-hellgate.test.ts`) drives the
 * enforcement path by calling `dispatchTool(...)` DIRECTLY with a hand-built
 * `ToolUseBlock` — the guard is wired, but `runAgent × scripted-LLM == 0`.
 * NOTHING drove a real loop where a scripted model ISSUES an egress-bearing
 * tool call and the guard fires mid-dispatch, feeding the denial back across
 * the turn boundary.
 *
 * THE WIRED CONTRACT (`preflight-consults.ts#consultDispatchGuard`): the
 * `config.dispatchGuard` built by `buildNetworkDispatchGuard(spec)` is one of
 * the `PRE_FLIGHT_CONSULTS` run inside `dispatchToolInner` BEFORE the tool
 * executes. An off-allowlist host ⇒ `deny` (preview `guard-deny`) or, under
 * `perRequestApproval`, `ask` (collapsed to a deny with preview `guard-ask`) —
 * either way the tool NEVER executes and a synthetic error tool_result is fed
 * to the next turn. An on-list host ⇒ `allow` ⇒ the tool runs.
 *
 * GROUND TRUTH — did the egress attempt actually reach the network? The
 * `web_fetch` tool is built with an INJECTED fetcher that RECORDS every URL it
 * is actually invoked with. The guard sits UPSTREAM of `execute`, so:
 *   - an off-list host that is denied ⇒ the fetcher is NEVER called for it
 *     (`fetchedUrls` does not contain it) — the egress physically did not
 *     happen;
 *   - an on-list host that is allowed ⇒ the fetcher IS called with it
 *     (`fetchedUrls` contains it) — the control egress happened.
 * This is a fetcher-observed split, not just a preview-tag assertion — the
 * strongest reading of "was the egress blocked?".
 *
 * Everything runs through ONE `runAgent`:
 *   turn 1  web_fetch https://evil.example.com   → OFF-LIST → guard denies →
 *                                                   fetcher never called for it.
 *   turn 2  web_fetch https://api.github.com     → ON-LIST (control) → allowed →
 *                                                   fetcher called with it.
 *   turn 3  wrap up.
 */

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const ON_LIST_HOST = "api.github.com"
const OFF_LIST_URL = "https://evil.example.com/exfil"
const ON_LIST_URL = "https://api.github.com/repos"

/** A fetcher double that RECORDS every URL it is invoked with, then returns a
 *  trivial text response. Its record IS the ground truth: an entry means the
 *  egress attempt actually reached the (fake) network. */
const recordingFetcher = (fetchedUrls: string[]): typeof fetch =>
  (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    fetchedUrls.push(url)
    return new Response("fetched-body", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })
  }) as unknown as typeof fetch

/** Registry = all default tools EXCEPT the stock `web_fetch`, plus a `web_fetch`
 *  whose fetcher is our recorder. Same tool name/schema/posture — only the
 *  fetcher seam is swapped, so the loop routes to it identically. */
const registryWithRecordingFetch = (fetchedUrls: string[]): ToolRegistry => {
  const tools = defaultTools.filter((t) => t.name !== "web_fetch")
  tools.push(webFetchTool({ fetcher: recordingFetcher(fetchedUrls) }) as (typeof tools)[number])
  return new ToolRegistry(tools)
}

/** Scripted LLM: two egress calls (off-list then on-list) then done. Records
 *  every tool_result content it SEES on a follow-up turn so we can assert the
 *  denial crossed the turn boundary. */
class EgressLLM implements LLMPort {
  readonly model = "egress-test-model"
  calls = 0
  readonly toolResultsSeen: string[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    for (const m of input.messages)
      for (const b of m.content) if (b.type === "tool_result") this.toolResultsSeen.push(b.content)
    this.calls += 1
    if (this.calls === 1) {
      for (const e of toolUse("f1", "web_fetch", { url: OFF_LIST_URL })) yield e
      return
    }
    if (this.calls === 2) {
      for (const e of toolUse("f2", "web_fetch", { url: ON_LIST_URL })) yield e
      return
    }
    for (const e of text("done")) yield e
  }
}

const allToolResults = (out: {
  messages: import("@/llm").Message[]
}): { content: string; isError: boolean }[] =>
  out.messages.flatMap((m) =>
    m.content.flatMap((b) =>
      b.type === "tool_result" ? [{ content: b.content, isError: b.is_error === true }] : [],
    ),
  )

const perm: PermissionContext = { mode: "bypass" }

describe("network-egress-enforcement — real loop + fake LLM, off-list host denied through dispatch", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("allowlist posture: off-list web_fetch is DENIED before egress; on-list web_fetch RUNS (fetcher-observed split)", async () => {
    const fetchedUrls: string[] = []
    const guard = buildNetworkDispatchGuard({ posture: "allowlist", hosts: [ON_LIST_HOST] })
    expect(guard).toBeDefined()
    const llm = new EgressLLM()

    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: registryWithRecordingFetch(fetchedUrls),
          permission: perm,
          cwd: "/tmp",
          maxTurns: 8,
          ...(guard !== undefined ? { dispatchGuard: guard } : {}),
        }),
      ),
      15_000,
      "egress-allowlist-real-loop",
    )
    expect(out.reason).toBe("completed")

    // GROUND TRUTH on the (fake) network: the off-list host NEVER reached the
    // fetcher — the guard blocked the egress upstream of execute.
    expect(fetchedUrls.some((u) => u.includes("evil.example.com"))).toBe(false)
    // The on-list control DID reach the fetcher — a web_fetch is not blocked per
    // se; ONLY the off-list one is (non-vacuity via the paired control).
    expect(fetchedUrls.some((u) => u.includes("api.github.com"))).toBe(true)

    // Real dispatch surfaced a denial tool_result for the off-list call, and the
    // scripted model SAW it on the follow-up turn (cross-turn feedback).
    const results = allToolResults(out)
    const denied = results.find((r) => r.isError && r.content.includes("network allowlist"))
    expect(denied).toBeDefined()
    expect(llm.toolResultsSeen.some((c) => c.includes("network allowlist"))).toBe(true)
  })

  test("perRequestApproval: off-list web_fetch routes to ASK (collapsed to deny at dispatch) ⇒ still no egress", async () => {
    // ADR-0135 perRequestApproval: an off-list host routes to `ask`. The v1 wire
    // collapses `ask` to a deny (preview `guard-ask`) — so the egress is STILL
    // blocked. Ground truth: the fetcher is never called for the off-list host.
    const fetchedUrls: string[] = []
    const guard = buildNetworkDispatchGuard({
      posture: "allowlist",
      hosts: [ON_LIST_HOST],
      perRequestApproval: true,
    })
    const llm = new EgressLLM()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: registryWithRecordingFetch(fetchedUrls),
          permission: perm,
          cwd: "/tmp",
          maxTurns: 8,
          ...(guard !== undefined ? { dispatchGuard: guard } : {}),
        }),
      ),
      15_000,
      "egress-approval-real-loop",
    )
    expect(out.reason).toBe("completed")
    // Off-list host: no egress (ask ⇒ deny at dispatch). On-list host: egress ran.
    expect(fetchedUrls.some((u) => u.includes("evil.example.com"))).toBe(false)
    expect(fetchedUrls.some((u) => u.includes("api.github.com"))).toBe(true)
    // The denial reason surfaced the per-request-approval phrasing.
    const results = allToolResults(out)
    expect(
      results.some((r) => r.isError && r.content.includes("per-request approval required")),
    ).toBe(true)
  })

  test("CONTROL (non-vacuity): open posture ⇒ NO guard wired ⇒ BOTH hosts reach the fetcher", async () => {
    // `open` posture ⇒ buildNetworkDispatchGuard returns undefined ⇒ the slot
    // stays unset ⇒ dispatch is byte-identical to the pre-wire path. Both the
    // off-list AND the on-list host reach the fetcher. This proves the denial in
    // the allowlist test is the GUARD's doing — not web_fetch independently
    // refusing evil.example.com (both are public https ⇒ SSRF preflight passes).
    const fetchedUrls: string[] = []
    const guard = buildNetworkDispatchGuard({ posture: "open" })
    expect(guard).toBeUndefined()
    const llm = new EgressLLM()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: registryWithRecordingFetch(fetchedUrls),
          permission: perm,
          cwd: "/tmp",
          maxTurns: 8,
          ...(guard !== undefined ? { dispatchGuard: guard } : {}),
        }),
      ),
      15_000,
      "egress-open-control",
    )
    expect(out.reason).toBe("completed")
    // BOTH egress attempts reached the network — the off-list host is only
    // blocked when the allowlist guard is wired (previous tests).
    expect(fetchedUrls.some((u) => u.includes("evil.example.com"))).toBe(true)
    expect(fetchedUrls.some((u) => u.includes("api.github.com"))).toBe(true)
  })
})
