/**
 * ★ CONTRACT — T01 (May-31 bugbash): the carried boundary surfaces consume the
 *   shared abort/deadline primitive so a cancelled operation STOPS underlying
 *   work, not merely resolves the caller promise early.
 *
 * HELLGATE — adversarial boundary cancellation proofs. Each case drives a real
 * boundary adapter and asserts the UNDERLYING work is actually torn down or
 * never started — and that the timeout path returns a TYPED reason:
 *
 *   - shadow-verify apply (L3 C-9): a cancelled apply returns `aborted` and
 *     NEVER touches the scratch fs (patch application is gated, not run).
 *   - shadow-verify open  (L3 C-10): a cancelled open NEVER spawns the worktree.
 *   - STT (L9 H4): a hung provider connection times out with a TYPED `timeout`
 *     reason (and the underlying fetch signal is aborted); a caller-cancel maps
 *     to `aborted`.
 *   - MCP HTTP-SSE (L9 H12): `close()` aborts the in-flight POST + cancels its
 *     SSE reader — the socket does not leak past close.
 */

import { describe, expect, test } from "bun:test"
import { createV4AApplyPort } from "@/agent/shadow-verify-adapters/apply-v4a"
import { createScratchWorktreePort } from "@/agent/shadow-verify-adapters/scratch-worktree"
import { HttpSseMcpTransport } from "@/mcp/transports/http-sse"
import { createDeepgramAdapter } from "@/media/stt/deepgram-adapter"
import { createWhisperAdapter } from "@/media/stt/openai-whisper-adapter"

const wavBlob = () => ({ mime: "audio/wav" as const, bytes: new Uint8Array([1, 2, 3, 4]) })

describe("shadow-verify apply — cancellation gated, never touches the scratch fs", () => {
  test("an already-aborted signal returns 'aborted' and does NOT apply the patch", async () => {
    const port = createV4AApplyPort()
    const c = new AbortController()
    c.abort()
    // A patch that WOULD blow up if parsed/applied — proof the gate fires first.
    const r = await port.apply("/nonexistent/scratch/root", "garbage patch text", c.signal)
    expect(r.ok).toBe(false)
    expect(r.error).toBe("aborted")
  })

  test("a live signal still applies (no false-positive gate)", async () => {
    const port = createV4AApplyPort()
    const c = new AbortController()
    // Invalid patch ⇒ parse/apply error, but NOT 'aborted' — proves the gate is
    // not over-firing.
    const r = await port.apply("/tmp", "not a v4a patch", c.signal)
    expect(r.ok).toBe(false)
    expect(r.error).not.toBe("aborted")
  })
})

describe("shadow-verify open — cancellation gated, never spawns the worktree", () => {
  test("an already-aborted signal throws a typed AbortError before any git I/O", async () => {
    // repoRoot points nowhere real; if the gate failed we'd hit git I/O. The
    // gate must throw BEFORE `createPersistentWorktree` is reached.
    const port = createScratchWorktreePort("/definitely/not/a/repo")
    const c = new AbortController()
    c.abort()
    let caught: unknown
    try {
      await port.open(c.signal)
    } catch (e) {
      caught = e
    }
    expect((caught as { name?: string })?.name).toBe("AbortError")
  })
})

describe("STT adapters — deadline + caller signal wired through the primitive", () => {
  test("deepgram: a hung connection times out with a TYPED 'timeout' reason and aborts the fetch", async () => {
    let fetchSignalAborted = false
    // A fetch that never resolves unless its signal aborts (models a hung server).
    const fetchFn = (_i: string | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_res, reject) => {
        init?.signal?.addEventListener("abort", () => {
          fetchSignalAborted = true
          const e = new Error("aborted") as Error & { name: string }
          e.name = "AbortError"
          reject(e)
        })
      })
    const adapter = createDeepgramAdapter({ apiKey: "k", fetchFn })
    const r = await adapter.transcribe(wavBlob(), { timeoutMs: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("timeout")
    // PROOF: the deadline actually severed the underlying request.
    expect(fetchSignalAborted).toBe(true)
  })

  test("whisper: a caller-cancel maps to a TYPED 'aborted' reason", async () => {
    const c = new AbortController()
    const fetchFn = (_i: string | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_res, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted") as Error & { name: string }
          e.name = "AbortError"
          reject(e)
        })
      })
    const adapter = createWhisperAdapter({ apiKey: "k", fetchFn })
    const p = adapter.transcribe(wavBlob(), { signal: c.signal, timeoutMs: 10_000 })
    c.abort()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("aborted")
  })

  test("deepgram: already-aborted caller signal short-circuits to 'aborted' without fetching", async () => {
    let called = false
    const fetchFn = (): Promise<Response> => {
      called = true
      return Promise.resolve(new Response())
    }
    const c = new AbortController()
    c.abort()
    const adapter = createDeepgramAdapter({ apiKey: "k", fetchFn })
    const r = await adapter.transcribe(wavBlob(), { signal: c.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("aborted")
    expect(called).toBe(false)
  })
})

describe("MCP HTTP-SSE — close() aborts the in-flight POST and cancels its SSE reader", () => {
  test("a POST streaming an unbounded SSE body is severed by close()", async () => {
    let postSignalAborted = false
    let readerCancelled = false

    // A ReadableStream-ish SSE body that never ends until the reader is cancelled.
    const makeBody = (): ReadableStream<Uint8Array> => {
      let cancelled = false
      return {
        getReader() {
          return {
            read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
              if (cancelled) return { done: true }
              // Hang forever (server streaming an unbounded body) until cancel.
              return new Promise<{ done: boolean }>(() => {})
            },
            cancel: async (): Promise<void> => {
              cancelled = true
              readerCancelled = true
            },
            releaseLock: (): void => {},
          }
        },
      } as unknown as ReadableStream<Uint8Array>
    }

    const fetchFn = (
      _url: string,
      init: { method: string; signal?: AbortSignal },
    ): Promise<{
      ok: boolean
      status: number
      headers: { get(n: string): string | null }
      text(): Promise<string>
      body: ReadableStream<Uint8Array> | null
    }> => {
      // The POST: track its signal and answer with an unbounded SSE body.
      if (init.method === "POST") {
        init.signal?.addEventListener("abort", () => {
          postSignalAborted = true
        })
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n === "content-type" ? "text/event-stream" : null) },
          text: () => Promise.resolve(""),
          body: makeBody(),
        })
      }
      // Standalone GET / DELETE: trivially empty.
      return Promise.resolve({
        ok: true,
        status: 202,
        headers: { get: () => null },
        text: () => Promise.resolve(""),
        body: null,
      })
    }

    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "test",
      openServerStream: false,
      // biome-ignore lint/suspicious/noExplicitAny: test fetch seam shape match
      fetch: fetchFn as any,
    })
    await t.start()
    // Fire a POST (send is sync; the POST runs in the background).
    t.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    // Let the POST start + begin draining the SSE body.
    await new Promise((r) => setTimeout(r, 5))
    // Close — must abort the in-flight POST and cancel its reader.
    await t.close()
    // Give the abort propagation a tick.
    await new Promise((r) => setTimeout(r, 5))

    expect(postSignalAborted).toBe(true)
    expect(readerCancelled).toBe(true)
  })

  test("send() after close() is rejected (no new in-flight work)", async () => {
    const t = new HttpSseMcpTransport({
      url: "https://mcp.example",
      name: "test",
      openServerStream: false,
    })
    await t.start()
    await t.close()
    const e = t.send({ jsonrpc: "2.0", id: 2, method: "ping" })
    expect(e).toBeInstanceOf(Error)
  })
})
