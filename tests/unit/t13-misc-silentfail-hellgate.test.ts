/**
 * T13 — silent-failure battery. Eight independent audited defects, each pinned
 * by the adversarial case that the band-aid masked:
 *
 *  (a) gh_pr_open: a THROWN/exit>1 git failure must surface "could not run git",
 *      NOT the legit-negative "detached HEAD?" / "not on origin" remediation.
 *  (b) cloud-branch-snapshot: a size-probe FAILURE must fail CLOSED (over-cap,
 *      reason=estimate-unavailable), never collapse to 0 ("assume small").
 *  (c) custom-3p jsonl seed: a row whose endpoint scheme mismatches its kind is
 *      DROPPED (the same guard register()/update() enforce), not silently seeded.
 *  (d) http-sse send(): a connection-level POST failure on a REQUEST rejects its
 *      pending entry PROMPTLY (correlated by id), not after the full timeout.
 *  (e) responses-continuation-store: the unsupported-resume marker is evicted in
 *      lockstep with the entry map (clear + over-cap eviction) — no unbounded Set.
 *  (f) chatgpt-oauth: a silent model swap is LOGGED (which model actually ran).
 *  (g) mcp-bridge: LoadMcpToolsOpts is ONE interface (no declaration merge).
 *  (h) dispatch-seam-guard: doc claim "wiring deferred" is false — guard is wired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlCustom3pRegistry } from "@/connectors/custom-3p/jsonl-store"
import type { HealthProbe } from "@/connectors/custom-3p/port"
import {
  createInMemoryFileLock,
  type GitProcessPort,
  type GitProcessResult,
  type SnapshotClock,
  SnapshotErrorThrown,
  snapshotDirtyToCloudBranch,
} from "@/git/cloud-branch-snapshot"
import type { LLMPort, StreamEvent as ToolStreamEvent, StreamInput as ToolStreamInput } from "@/llm"
import { defaultResponsesContinuationStore } from "@/llm"
import { __resetCatalogCacheForTest, ChatGPTOAuthAdapter } from "@/llm/adapters/chatgpt-oauth"
import type { StreamEvent, StreamInput } from "@/llm/types"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { HttpSseMcpTransport } from "@/mcp/transports/http-sse"
import { __resetLoggerRateLimit, __resetTerminalIo, setTerminalIo } from "@/shared"
import type { GhRunResult } from "@/tool/gh"
import { ghPrOpenTool } from "@/tool/gh"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ── (a) gh_pr_open — distinguish git failure from legit negative ──────────────

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })
const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolResult> => {
  let r: ToolResult | undefined
  for await (const e of it) if (e.type === "result") r = e.result
  if (!r) throw new Error("no result")
  return r
}
const gitOk = (stdout: string, exitCode = 0): GitRunResult => ({ stdout, stderr: "", exitCode })

const streamText = (t: string): ToolStreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
class FakeAuthor implements LLMPort {
  readonly model = "fake-author"
  async *stream(_input: ToolStreamInput): AsyncIterable<ToolStreamEvent> {
    for (const e of streamText("feat: x\n\nbody")) yield e
  }
}
const gh = (r: Partial<GhRunResult>): ((...a: unknown[]) => Promise<GhRunResult>) => {
  return async () => ({ code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })
}

describe("(a) gh_pr_open distinguishes git failure from legit negative", () => {
  test("rev-parse --abbrev-ref THROWS ⇒ 'could not run git', NOT 'detached HEAD'", async () => {
    const git: GitRunner = {
      async run(args) {
        if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) throw new Error("ENOENT git")
        return gitOk("")
      },
    }
    const res = await drain(ghPrOpenTool(gh({}) as never, git, new FakeAuthor()).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("could not run git")
    // The band-aid would have said this instead:
    expect(res.output).not.toContain("detached HEAD")
  })

  test("rev-parse --abbrev-ref exit>1 (not-a-repo) ⇒ 'could not run git'", async () => {
    const git: GitRunner = {
      async run(args) {
        if (args[0] === "rev-parse" && args.includes("--abbrev-ref"))
          return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }
        return gitOk("")
      },
    }
    const res = await drain(ghPrOpenTool(gh({}) as never, git, new FakeAuthor()).execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("could not run git")
    expect(res.output).toContain("not a git repository")
  })

  test("origin-verify exit>1 ⇒ git-failed surfaced, NOT the 'push it first' hint", async () => {
    const git: GitRunner = {
      async run(args) {
        if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return gitOk("feat/x\n")
        if (args[0] === "rev-parse" && args.includes("--verify"))
          return { stdout: "", stderr: "fatal: bad object store", exitCode: 128 }
        if (args[0] === "diff") return gitOk("diff --git a/x b/x\n+y", 1)
        if (args[0] === "log") return gitOk("c1 wip")
        return gitOk("")
      },
    }
    const res = await drain(
      ghPrOpenTool(gh({ code: 0, stdout: "url" }) as never, git, new FakeAuthor()).execute(
        {},
        ctx(),
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("could not run git")
    expect(res.output).not.toContain("git push -u origin")
  })

  test("origin-verify exit==1 is STILL the legit 'not on origin' negative", async () => {
    const git: GitRunner = {
      async run(args) {
        if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return gitOk("feat/x\n")
        if (args[0] === "rev-parse" && args.includes("--verify"))
          return { stdout: "", stderr: "", exitCode: 1 }
        if (args[0] === "diff") return gitOk("diff --git a/x b/x\n+y", 1)
        if (args[0] === "log") return gitOk("c1 wip")
        return gitOk("")
      },
    }
    const res = await drain(
      ghPrOpenTool(gh({ code: 0 }) as never, git, new FakeAuthor()).execute({}, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("git push -u origin feat/x")
  })
})

// ── (b) cloud-branch-snapshot — fail closed on probe failure ──────────────────

const clockAt = (ms: number): SnapshotClock => ({ now: () => ms })
const sgit = (
  responses: { match: (a: readonly string[]) => boolean; result: GitProcessResult }[],
): GitProcessPort => ({
  run: async (args) => {
    for (const r of responses) if (r.match(args)) return r.result
    return { stdout: "", stderr: "", exitCode: 0 }
  },
})

describe("(b) cloud-branch-snapshot fails CLOSED on size-probe failure", () => {
  const baseResponses = (): {
    match: (a: readonly string[]) => boolean
    result: GitProcessResult
  }[] => [
    {
      match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir",
      result: { stdout: ".git", stderr: "", exitCode: 0 },
    },
    {
      match: (a) => a[0] === "symbolic-ref",
      result: { stdout: "refs/heads/main", stderr: "", exitCode: 0 },
    },
    { match: (a) => a[0] === "status", result: { stdout: " M file.ts", stderr: "", exitCode: 0 } },
    // numstat probe FAILS:
    {
      match: (a) => a[0] === "diff" && a.includes("--numstat"),
      result: { stdout: "", stderr: "diff exploded", exitCode: 1 },
    },
  ]

  test("probe exit!=0 ⇒ diff-too-large with reason 'estimate-unavailable' (NOT assumed small)", async () => {
    let thrown: unknown
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: sgit(baseResponses()),
        clockPort: clockAt(Date.UTC(2026, 4, 24)),
        fileLockPort: createInMemoryFileLock(),
        repoCwd: "/repo",
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SnapshotErrorThrown)
    const detail = (thrown as SnapshotErrorThrown).detail
    expect(detail.kind).toBe("diff-too-large")
    if (detail.kind === "diff-too-large") {
      expect(detail.reason).toBe("estimate-unavailable")
      // The band-aid returned 0 ⇒ 0 <= cap ⇒ snapshot proceeds. Fail-closed
      // must report bytes ABOVE the cap.
      expect(detail.bytes).toBeGreaterThan(detail.cap)
    }
  })

  test("probe SUCCESS under cap still proceeds (no false-positive rejection)", async () => {
    const responses = baseResponses()
    responses[3] = {
      match: (a) => a[0] === "diff" && a.includes("--numstat"),
      result: { stdout: "1\t2\tfile.ts", stderr: "", exitCode: 0 },
    }
    const all = [
      ...responses,
      {
        match: (a: readonly string[]) => a[0] === "branch" && a[1] !== "-D",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "stash" && a[1] === "push",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) =>
          a[0] === "checkout" && a[1] !== "--force" && !a.includes("main"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "stash" && a[1] === "pop",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "add",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "commit",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "push",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "rev-parse" && a[1] === "HEAD",
        result: { stdout: "sha1", stderr: "", exitCode: 0 },
      },
      {
        match: (a: readonly string[]) => a[0] === "checkout" && a.includes("main"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]
    const res = await snapshotDirtyToCloudBranch({
      gitPort: sgit(all),
      clockPort: clockAt(Date.UTC(2026, 4, 24)),
      fileLockPort: createInMemoryFileLock(),
      repoCwd: "/repo",
    })
    expect(res.sha).toBe("sha1")
  })
})

// ── (c) custom-3p jsonl seed — enforce endpoint-scheme guard ──────────────────

const okProbe: HealthProbe = async () => ({ verdict: "ok", checkedAt: 0, latencyMs: 1 })

describe("(c) custom-3p jsonl seed drops scheme-mismatched rows", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "t13-c3p-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("mcp row with an http:// endpoint is dropped (guard parity with register)", async () => {
    const path = join(dir, "custom-3p.jsonl")
    // mcp endpoints must be ws://|wss://|stdio: — http:// is a scheme mismatch.
    const poisoned = {
      spec: {
        id: "bad",
        displayName: "Bad",
        kind: "mcp",
        endpoint: "http://evil.example",
        auth: "none",
      },
      state: "configured",
    }
    const good = {
      spec: {
        id: "good",
        displayName: "Good",
        kind: "mcp",
        endpoint: "wss://ok.example",
        auth: "none",
      },
      state: "configured",
    }
    await writeFile(path, `${JSON.stringify(poisoned)}\n${JSON.stringify(good)}\n`, { mode: 0o600 })
    const reg = createJsonlCustom3pRegistry({ path, healthProbe: okProbe })
    const ids = (await reg.list()).map((s) => String(s.id))
    expect(ids).toContain("good")
    expect(ids).not.toContain("bad")
  })

  test("llm row with a ws:// endpoint is dropped", async () => {
    const path = join(dir, "custom-3p.jsonl")
    const poisoned = {
      spec: { id: "bad2", displayName: "Bad2", kind: "llm", endpoint: "ws://nope", auth: "none" },
      state: "configured",
    }
    await writeFile(path, `${JSON.stringify(poisoned)}\n`, { mode: 0o600 })
    const reg = createJsonlCustom3pRegistry({ path, healthProbe: okProbe })
    expect((await reg.list()).length).toBe(0)
  })
})

// ── (d) http-sse send() — prompt reject on connection-level POST failure ──────

describe("(d) http-sse correlates a connection-level POST failure to the request id", () => {
  test("fetch REJECTS on a request payload ⇒ a JSON-RPC error response for that id is emitted promptly", async () => {
    const received: JsonRpcMessage[] = []
    const fetchFn = (_url: string, init: { method: string }): Promise<never> => {
      if (init.method === "POST") return Promise.reject(new Error("ECONNREFUSED"))
      // standalone GET / DELETE — never resolve to anything useful here.
      return new Promise<never>(() => {})
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "t13-d",
      openServerStream: false,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    t.onMessage((m) => received.push(m))
    await t.start()
    const enqueueErr = t.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} })
    expect(enqueueErr).toBeNull()
    // The reject is surfaced on the next microtask(s), NOT after a 30s timeout.
    await new Promise((r) => setTimeout(r, 5))
    const errResp = received.find((m) => "id" in m && (m as { id?: unknown }).id === 7) as
      | { id: number; error?: { message: string } }
      | undefined
    expect(errResp).toBeDefined()
    expect(errResp?.error?.message).toContain("ECONNREFUSED")
    await t.close()
  })

  test("a NOTIFICATION (no id) fails silently — no synthetic response to mis-correlate", async () => {
    const received: JsonRpcMessage[] = []
    const fetchFn = (_url: string, init: { method: string }): Promise<never> => {
      if (init.method === "POST") return Promise.reject(new Error("ECONNREFUSED"))
      return new Promise<never>(() => {})
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "t13-d2",
      openServerStream: false,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    t.onMessage((m) => received.push(m))
    await t.start()
    t.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
    await t.close()
  })

  // Sibling of the connection-level fast-fail above. A server HTTP non-2xx
  // (here 500) to a REQUEST-bearing POST carries no response body delivering the
  // awaited reply, so before the fix the pending entry waited the FULL
  // per-request timeout. The fix synthesizes the SAME -32000 error envelope for
  // the request id so the client rejects PROMPTLY. WITHOUT the fix the old code
  // just `logger.warn(...); return`, so no id-7 message is ever emitted and this
  // assertion (errResp defined within 5ms) FAILS.
  test("HTTP 500 on a request payload ⇒ a JSON-RPC error response for that id is emitted promptly (not at timeout)", async () => {
    const received: JsonRpcMessage[] = []
    let bodyCancelled = false
    const errBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true
      },
    })
    const fetchFn = (_url: string, init: { method: string }): Promise<unknown> => {
      if (init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: (_n: string) => null },
          text: () => Promise.resolve("internal error"),
          body: errBody,
        })
      }
      // standalone GET / DELETE — never resolve to anything useful here.
      return new Promise<never>(() => {})
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "t13-d3",
      openServerStream: false,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    t.onMessage((m) => received.push(m))
    await t.start()
    const enqueueErr = t.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} })
    expect(enqueueErr).toBeNull()
    // Surfaced on the next microtask(s), NOT after a 30s timeout.
    await new Promise((r) => setTimeout(r, 5))
    const errResp = received.find((m) => "id" in m && (m as { id?: unknown }).id === 7) as
      | { id: number; error?: { code: number; message: string } }
      | undefined
    expect(errResp).toBeDefined()
    // Identical wire shape to the connection-level sibling: code -32000, message
    // carries the HTTP status so the caller can tell the two failure modes apart.
    expect(errResp?.error?.code).toBe(-32000)
    expect(errResp?.error?.message).toContain("500")
    // The error body is drained/discarded, not left half-read behind the socket.
    expect(bodyCancelled).toBe(true)
    await t.close()
  })

  // A non-2xx with NO id (notification POST) must NOT mint a synthetic response —
  // there is no pending entry to reject, and a fabricated id would mis-correlate.
  test("HTTP 500 on a NOTIFICATION (no id) emits nothing — no synthetic response", async () => {
    const received: JsonRpcMessage[] = []
    const fetchFn = (_url: string, init: { method: string }): Promise<unknown> => {
      if (init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: (_n: string) => null },
          text: () => Promise.resolve(""),
          body: null,
        })
      }
      return new Promise<never>(() => {})
    }
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "t13-d4",
      openServerStream: false,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    t.onMessage((m) => received.push(m))
    await t.start()
    t.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBe(0)
    await t.close()
  })
})

// ── (e) responses-continuation-store — bound the unsupported-resume Set ───────

describe("(e) responses-continuation-store evicts the resume marker in lockstep", () => {
  test("clear(routeKey) PRESERVES the route marker; only clearAll() resets it", () => {
    // "resume unsupported" is a stable property of the ROUTE, not of a single
    // cached entry, so it must persist across clear(route) (pinned by
    // responses-continuation-wrapping). The unbounded-Set concern is handled by
    // lockstep eviction in evictIfOver — see the over-cap test below.
    const store = defaultResponsesContinuationStore()
    store.markResumeUnsupported("k1")
    expect(store.canResume("k1")).toBe(false)
    store.clear("k1")
    expect(store.canResume("k1")).toBe(false) // marker survives a single-route clear
    store.clearAll()
    expect(store.canResume("k1")).toBe(true) // only clearAll resets it
  })

  test("over-cap eviction also evicts the resume marker for the evicted key", () => {
    const store = defaultResponsesContinuationStore({ maxEntries: 2 })
    const entry = (routeKey: string) => ({
      routeKey,
      responseId: `r-${routeKey}`,
      requestFingerprint: "fp",
      inputItems: [],
      outputItems: [],
      resumable: true,
    })
    store.put(entry("a"))
    store.markResumeUnsupported("a")
    expect(store.canResume("a")).toBe(false)
    // Push past the cap so "a" is evicted (oldest-first).
    store.put(entry("b"))
    store.put(entry("c"))
    expect(store.get("a")).toBeNull()
    // The marker for the evicted key is gone too — a re-put of "a" is clean.
    expect(store.canResume("a")).toBe(true)
  })
})

// ── (f) chatgpt-oauth — log the silent model substitution ─────────────────────

const FIXED_NOW = Date.parse("2026-05-23T12:00:00.000Z")
const futureExpiry = new Date(FIXED_NOW + 24 * 3600_000).toISOString()
const catalogResponse = (models: readonly { model: string; is_default?: boolean }[]): Response =>
  new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
const sseResponse = (chunks: readonly string[]): Response => {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}
const emptyStreamInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})
const collect = async (gen: AsyncIterable<StreamEvent>): Promise<void> => {
  for await (const _ of gen) void _
}

describe("(f) chatgpt-oauth logs the model substitution (not silent)", () => {
  let dir: string
  let codexHome: string
  let stderrLines: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "t13-cgo-"))
    codexHome = await mkdtemp(join(tmpdir(), "t13-cgo-codex-"))
    __resetCatalogCacheForTest()
    __resetLoggerRateLimit()
    stderrLines = []
    setTerminalIo({ stdout: () => {}, stderr: (c: string) => stderrLines.push(c) })
  })
  afterEach(async () => {
    __resetTerminalIo()
    await rm(dir, { recursive: true, force: true })
    await rm(codexHome, { recursive: true, force: true })
  })

  test("configured model absent from catalog ⇒ a warn names the model that actually ran", async () => {
    const { writeToken, chatgptTokenPath } = await import("@/auth/chatgpt-oauth")
    await writeToken(chatgptTokenPath(dir), {
      access_token: "at-test",
      refresh_token: "rt-test",
      expires_at: futureExpiry,
      account_id: "acct-1",
      plan_type: "pro",
    })
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/codex/models")) {
        // Catalog has ONLY a different model + a default — forces a swap.
        return catalogResponse([{ model: "gpt-5-codex", is_default: true }])
      }
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        'data: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        "data: [DONE]\n\n",
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "model-that-does-not-exist",
      env: { QUANTA_PREFS_HOME: dir, CODEX_HOME: codexHome },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    await collect(a.stream(emptyStreamInput()))
    const joined = stderrLines.join("")
    expect(joined).toContain("model-that-does-not-exist")
    expect(joined).toContain("gpt-5-codex")
    expect(joined.toLowerCase()).toContain("not in catalog")
  })
})

// ── (g)/(h) static-contract assertions (compile-time + doc) ───────────────────

describe("(g) LoadMcpToolsOpts is a single interface", () => {
  test("both knobs coexist on ONE shape (no divergent declaration-merge)", async () => {
    // If the duplicate declaration were back, TS would merge them; this object
    // literal typed as the import must accept BOTH keys with their distinct
    // signatures — a single consolidated interface.
    const { McpClient } = await import("@/mcp")
    void McpClient
    type Opts = import("@/agent/mcp-bridge").LoadMcpToolsOpts
    const o: Opts = {}
    expect(Object.keys(o)).toEqual([])
    // Structural proof: the two optional members are addressable (assigned real
    // factories — exactOptionalPropertyTypes forbids an explicit `undefined`).
    const probe: Opts = {
      transportFor: () => ({}) as never,
      supervisorDepsFor: () => ({}) as never,
    }
    expect("transportFor" in probe && "supervisorDepsFor" in probe).toBe(true)
  })
})

describe("(h) dispatch-seam-guard is wired (doc + behaviour)", () => {
  test("guard denies a plan-mode mutating tool and allows read-only", async () => {
    const { checkDispatchAllowed } = await import("@/agent/dispatch-seam-guard")
    const planMutating = checkDispatchAllowed({ collaborationMode: "plan" }, { name: "git_commit" })
    expect(planMutating.ok).toBe(false)
    const def = checkDispatchAllowed({ collaborationMode: "default" }, { name: "git_commit" })
    expect(def.ok).toBe(true)
  })
})
