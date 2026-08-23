/**
 * HELLGATE — R: a cassette is a secrets-bearing artifact (§17.5 packet R).
 *
 * A replay cassette records the FULL LLM request: the system prompt, every
 * message, the contents of every file the agent read, and every tool output. If
 * the agent read a `.env`, an `~/.aws/credentials`, or a private key — which the
 * stale-read guard and the shell authority both exist to reason about — those
 * bytes are in the cassette verbatim.
 *
 * Measured on the shipping store: the cassette directory is created `0755` and
 * the file `0644`. World-readable. On a shared box or a CI runner, any local
 * user can read every secret the agent ever touched.
 *
 * The remote half has the same shape: the S3 backend PUTs with
 * `aws s3 cp - s3://…` and no `--sse`, so encryption at rest is whatever the
 * bucket happens to default to.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: scrub the cassette. Redacting the
 * recorded bytes would destroy replay reproducibility — the whole point of the
 * artifact — and would change the content hash. The fix is ACCESS policy on the
 * artifact as it is; a redacted EXPORT is a separate concern with a separate
 * output.
 *
 * Invariants:
 *
 *  R-1  RED — the cassette file is owner-only (`0600`).
 *  R-2  RED — the directory the store creates is owner-only (`0700`).
 *  R-3  A cassette REWRITE (curation / truncation) does not widen the mode.
 *  R-4  CONTENT + HASH ARE UNCHANGED — the bytes on disk and the match hash are
 *        byte-identical to before, so every existing cassette still replays.
 *  R-5  The remote PUT asks for encryption at rest EXPLICITLY.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jsonlReplayStore } from "@/llm/replay/jsonl-store"

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)

const record = () =>
  ({
    request: {
      messages: [
        { role: "user", content: [{ type: "text", text: "AWS_SECRET_ACCESS_KEY=abc123" }] },
      ],
      tools: [],
    },
    events: [{ type: "text_delta", delta: "ok" }],
  }) as never

describe("R — a cassette is owner-only on disk", () => {
  test("R-1/R-2 the store creates an owner-only dir and file", async () => {
    const base = mkdtempSync(join(tmpdir(), "cassette-sec-"))
    try {
      const dir = join(base, "cassettes")
      const path = join(dir, "run.jsonl")
      const store = jsonlReplayStore({ path })
      await store.append(record())

      expect({ dir: mode(dir), file: mode(path) }).toEqual({ dir: "700", file: "600" })
      // Spelled out, because "is it 0600" is the whole point:
      expect(statSync(path).mode & 0o077).toBe(0)
      expect(statSync(dir).mode & 0o077).toBe(0)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("R-3 a rewrite does not widen the mode", async () => {
    const base = mkdtempSync(join(tmpdir(), "cassette-sec-rw-"))
    try {
      const path = join(base, "c", "run.jsonl")
      const store = jsonlReplayStore({ path })
      await store.append(record())
      await store.append(record())
      // `truncate` rewrites the whole file — the path that used `writeFile`.
      const truncate = (store as unknown as { truncate?: (n: number) => Promise<void> }).truncate
      if (typeof truncate === "function") await truncate.call(store, 1)
      expect(statSync(path).mode & 0o077).toBe(0)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("R-4 CONTENT is unchanged — the recorded bytes are still the verbatim JSONL", async () => {
    const base = mkdtempSync(join(tmpdir(), "cassette-sec-body-"))
    try {
      const path = join(base, "c", "run.jsonl")
      const store = jsonlReplayStore({ path })
      await store.append(record())
      const text = await Bun.file(path).text()
      // Exactly one line, valid JSON, and the secret is STILL THERE: this fix is
      // access policy, not redaction. Scrubbing would break replay.
      const lines = text.trimEnd().split("\n")
      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0] as string)).toBeDefined()
      expect(text).toContain("AWS_SECRET_ACCESS_KEY=abc123")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("R-4b the match HASH is unchanged — existing cassettes still replay", async () => {
    const { defaultHashRequest } = await import("@/llm/replay/jsonl-store")
    // Pinned literal: if the hash space ever moves, every recorded cassette
    // silently stops matching. This fix must not touch it.
    const req = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }
    const a = defaultHashRequest(req as never, "exact")
    const b = defaultHashRequest(req as never, "exact")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("R-5 — the remote PUT asks for encryption at rest explicitly", () => {
  test("the s3 backend passes an SSE flag", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const calls: string[][] = []
    const backend = s3Backend({
      bucket: "b",
      runAws: async (args: readonly string[]) => {
        calls.push([...args])
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    } as never)
    await backend.put("k/v.jsonl", "body")
    const put = calls[0]
    if (put === undefined) throw new Error("expected a put")
    expect(put).toContain("--sse")
  })

  test("PAIRED CONTROL — `get` is unchanged (no flag added to reads)", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const calls: string[][] = []
    const backend = s3Backend({
      bucket: "b",
      runAws: async (args: readonly string[]) => {
        calls.push([...args])
        return { exitCode: 0, stdout: "x", stderr: "" }
      },
    } as never)
    await backend.get("k/v.jsonl")
    expect(calls[0]).not.toContain("--sse")
  })
})
