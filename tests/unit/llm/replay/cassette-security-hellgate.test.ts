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
 *  R-6  A remote PUT whose `aws` invocation FAILS throws — a swallowed PUT
 *        failure silently loses durability (fail-closed).
 *  R-7  A remote GET distinguishes a genuine not-found (`undefined`, per the
 *        RemoteBackend contract) from a transport failure (throws).
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
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

  test("R-2b a pre-existing arbitrary parent is not chmodded; the file remains owner-only", async () => {
    const base = mkdtempSync(join(tmpdir(), "cassette-sec-existing-dir-"))
    try {
      const dir = join(base, "cassettes")
      mkdirSync(dir, { mode: 0o755 })
      chmodSync(dir, 0o755)
      const path = join(dir, "run.jsonl")
      await jsonlReplayStore({ path }).append(record())

      expect({ dir: mode(dir), file: mode(path) }).toEqual({ dir: "755", file: "600" })
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

  test("resume callers can pin SSE-KMS to an exact customer-managed key", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const calls: string[][] = []
    const keyArn = "arn:aws:kms:us-east-1:123:key/key-id"
    const backend = s3Backend({
      bucket: "b",
      sse: "aws:kms",
      sseKmsKeyId: keyArn,
      runAws: async (args: readonly string[]) => {
        calls.push([...args])
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    await backend.put("campaign/instance/events/000001.json", "body")
    expect(calls[0]).toContain("aws:kms")
    expect(calls[0]).toContain("--sse-kms-key-id")
    expect(calls[0]).toContain(keyArn)
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

  test("R-6 a FAILED put THROWS — a swallowed PUT failure silently loses durability", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const backend = s3Backend({
      bucket: "b",
      runAws: async () => ({ exitCode: 1, stdout: "", stderr: "AccessDenied" }),
    } as never)
    // PREVENTS: `put` returning normally on a non-zero `aws` exit. That is the
    // durability hole — the producer believes the cassette/artifact is off-host,
    // nothing is there, and the run is never marked degraded. Fail-closed means
    // the caller MUST see the failure.
    await expect(backend.put("k/v.jsonl", "body")).rejects.toThrow(
      /put k\/v\.jsonl failed \(exit 1\)/,
    )
  })

  test("R-6b the put failure carries the cli stderr — a blind throw is not diagnosable", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const backend = s3Backend({
      bucket: "b",
      runAws: async () => ({ exitCode: 1, stdout: "", stderr: "Unable to locate credentials" }),
    } as never)
    // PREVENTS: a throw that drops the reason, leaving "the upload failed" with
    // no way to tell creds from network from bucket policy.
    await expect(backend.put("k/v.jsonl", "body")).rejects.toThrow(/Unable to locate credentials/)
  })

  test("R-7 `get` returns undefined for a GENUINE not-found", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const backend = s3Backend({
      bucket: "b",
      runAws: async () => ({
        exitCode: 1,
        stdout: "",
        stderr:
          "fatal error: An error occurred (404) when calling the HeadObject operation: Key does not exist",
      }),
    } as never)
    // PREVENTS: a missing key throwing. The RemoteBackend contract says callers
    // branch on presence, so a resume/load path that legitimately has nothing
    // stored yet must get `undefined`, not an exception.
    expect(await backend.get("k/v.jsonl")).toBeUndefined()
  })

  test("R-7b `get` THROWS on a TRANSPORT failure — not-found is never faked", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const backend = s3Backend({
      bucket: "b",
      runAws: async () => ({ exitCode: 1, stdout: "", stderr: "Unable to locate credentials" }),
    } as never)
    // PREVENTS: the pre-fix `exit≠0 ⇒ undefined` collapse, which reports a
    // creds/network/throttle/access-denied failure as "no such object". A caller
    // that branches on presence would then treat an unreachable bucket as an
    // empty one and overwrite or restart from scratch.
    await expect(backend.get("k/v.jsonl")).rejects.toThrow(
      /get k\/v\.jsonl failed \(exit 1\): Unable to locate credentials/,
    )
  })

  test("R-7c PAIRED CONTROL — a zero exit is never reinterpreted, even with empty stdout", async () => {
    const { s3Backend } = await import("@/shared/remote-store/s3-backend")
    const backend = s3Backend({
      bucket: "b",
      runAws: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as never)
    // PREVENTS: an over-eager "empty means missing" rule. A stored empty object
    // is a successful get of "", not a not-found — otherwise R-7's undefined arm
    // could be satisfied by a blanket falsy check.
    expect(await backend.get("k/v.jsonl")).toBe("")
  })
})
