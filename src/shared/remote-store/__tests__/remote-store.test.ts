import { describe, expect, it } from "bun:test"
import type { RemoteBackend } from "../backend"
import {
  isResumeEligible,
  type ResumeReceipt,
  type RunAwsResult,
  readReceipt,
  s3Backend,
  segmentStore,
  writeReceipt,
} from "../index"

/**
 * Map-backed fake {@link RemoteBackend} that also COUNTS put calls and records
 * every (path, body) so tests can assert the EXACT write pattern (e.g. one
 * put per segment, no whole-file re-PUT). `get` honors the not-found contract
 * (undefined, never throw).
 */
interface FakeBackend extends RemoteBackend {
  readonly puts: { path: string; body: string }[]
  readonly putCount: () => number
  readonly store: Map<string, string>
}

const fakeBackend = (): FakeBackend => {
  const store = new Map<string, string>()
  const puts: { path: string; body: string }[] = []
  return {
    store,
    puts,
    putCount: () => puts.length,
    async put(path, body) {
      puts.push({ path, body })
      store.set(path, body)
    },
    async get(path) {
      return store.get(path)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

describe("segment-store", () => {
  it("lists seqs ascending regardless of write order", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    // Write out of order on purpose.
    await ss.putSegment(3, "third")
    await ss.putSegment(1, "first")
    await ss.putSegment(2, "second")
    expect(await ss.listSegments()).toEqual([1, 2, 3])
  })

  it("writes exactly one object per putSegment at a distinct zero-padded path (no re-PUT)", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(3, "third")
    expect(be.putCount()).toBe(1)
    await ss.putSegment(1, "first")
    expect(be.putCount()).toBe(2)
    await ss.putSegment(2, "second")
    expect(be.putCount()).toBe(3)
    // Each put landed at its own zero-padded key — never a whole-file re-PUT.
    const paths = be.puts.map((p) => p.path).sort()
    expect(paths).toEqual([
      "camp/inst/events/000001.json",
      "camp/inst/events/000002.json",
      "camp/inst/events/000003.json",
    ])
    // The bodies are exactly as supplied, keyed to their seq.
    const byPath = new Map(be.puts.map((p) => [p.path, p.body]))
    expect(byPath.get("camp/inst/events/000001.json")).toBe("first")
    expect(byPath.get("camp/inst/events/000003.json")).toBe("third")
  })

  it("getSegment returns the body for that seq (and undefined when missing)", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(3, "third")
    await ss.putSegment(1, "first")
    await ss.putSegment(2, "second")
    expect(await ss.getSegment(2)).toBe("second")
    expect(await ss.getSegment(99)).toBeUndefined()
  })

  it("concat joins all segment bodies in ascending seq order, preserving each body exactly", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(3, "third")
    await ss.putSegment(1, "first")
    await ss.putSegment(2, '{"a":1}\nwith-internal-newline')
    const joined = await ss.concat()
    expect(joined).toBe('first\n{"a":1}\nwith-internal-newline\nthird')
  })

  it("concat on an empty store is the empty string", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    expect(await ss.concat()).toBe("")
  })

  it("FIX4: concat THROWS when a LISTED segment vanished (hole = corruption, not benign)", async () => {
    // list reports 1,2,3 but get for seq 2 returns undefined ⇒ the segment
    // disappeared after listing. Replaying a silently-truncated transcript is
    // worse than failing loudly, so concat must throw (fail-closed).
    const be = fakeBackend()
    const holed: RemoteBackend = {
      ...be,
      async list() {
        return [
          "camp/inst/events/000001.json",
          "camp/inst/events/000002.json",
          "camp/inst/events/000003.json",
        ]
      },
      async get(path) {
        if (path === "camp/inst/events/000002.json") return undefined
        if (path === "camp/inst/events/000001.json") return "b1"
        if (path === "camp/inst/events/000003.json") return "b3"
        return undefined
      },
    }
    const ss = segmentStore(holed, "camp/inst")
    expect(await ss.listSegments()).toEqual([1, 2, 3])
    await expect(ss.concat()).rejects.toThrow(/2/)
  })

  it("FIX5: sorts seqs NUMERICALLY, not lexically (2,10,1,100 ⇒ 1,2,10,100)", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(2, "two")
    await ss.putSegment(10, "ten")
    await ss.putSegment(1, "one")
    await ss.putSegment(100, "hundred")
    // A lexicographic .sort() would yield [1,10,100,2]; numeric must be [1,2,10,100].
    expect(await ss.listSegments()).toEqual([1, 2, 10, 100])
    expect(await ss.concat()).toBe("one\ntwo\nten\nhundred")
  })

  it("FIX5: putSegment/getSegment preserve a trailing newline verbatim", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(1, "body\n")
    expect(await ss.getSegment(1)).toBe("body\n")
  })

  it("FIX5: an empty-string body round-trips and concats as an empty segment", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(1, "")
    await ss.putSegment(2, "x")
    // empty body is a real, present segment — not a hole; getSegment returns "".
    expect(await ss.getSegment(1)).toBe("")
    expect(await ss.listSegments()).toEqual([1, 2])
    // concat joins ""+"x" with a newline ⇒ "\nx" (the empty seg is preserved).
    expect(await ss.concat()).toBe("\nx")
  })

  it("scopes listSegments to its own key (ignores other bases)", async () => {
    const be = fakeBackend()
    const a = segmentStore(be, "camp/instA")
    const b = segmentStore(be, "camp/instB")
    await a.putSegment(1, "a1")
    await b.putSegment(5, "b5")
    expect(await a.listSegments()).toEqual([1])
    expect(await b.listSegments()).toEqual([5])
  })
})

describe("resume-receipt", () => {
  const sample: ResumeReceipt = {
    key: "camp/inst",
    campaignId: "camp",
    instanceId: "inst",
    latestSeq: 42,
    degraded: false,
    updatedAt: "2026-06-27T00:00:00.000Z",
    meta: { runId: "r-1", attempt: 2 },
  }

  it("round-trips all fields through write -> read at the canonical path", async () => {
    const be = fakeBackend()
    await writeReceipt(be, "camp/inst", sample)
    // Written at the canonical resume-state path.
    expect(be.puts.map((p) => p.path)).toEqual(["camp/inst/resume-state.json"])
    const got = await readReceipt(be, "camp/inst")
    expect(got).toEqual(sample)
  })

  it("readReceipt returns undefined when the object is missing", async () => {
    const be = fakeBackend()
    expect(await readReceipt(be, "camp/inst")).toBeUndefined()
  })

  it("readReceipt returns undefined (never throws) on malformed JSON", async () => {
    const be = fakeBackend()
    // Inject a backend whose get returns garbage for the receipt path.
    const garbage: RemoteBackend = {
      ...be,
      async get() {
        return "}{ this is not json"
      },
    }
    let result: ResumeReceipt | undefined
    await expect(
      (async () => {
        result = await readReceipt(garbage, "camp/inst")
      })(),
    ).resolves.toBeUndefined()
    expect(result).toBeUndefined()
  })

  it("isResumeEligible is FAIL-CLOSED for undefined and degraded", () => {
    expect(isResumeEligible(undefined)).toBe(false)
    expect(isResumeEligible({ ...sample, degraded: true })).toBe(false)
    expect(isResumeEligible({ ...sample, degraded: false })).toBe(true)
  })

  it("RED-on-injection: flipping degraded flips eligibility", () => {
    const ok: ResumeReceipt = { ...sample, degraded: false }
    const bad: ResumeReceipt = { ...sample, degraded: true }
    expect(isResumeEligible(ok)).toBe(true)
    expect(isResumeEligible(bad)).toBe(false)
    // Real eligibility assertion: the only-flipped-bit receipt is rejected, and
    // re-flipping it back is accepted — the gate keys off `degraded`, nothing else.
    expect(isResumeEligible({ ...bad, degraded: false })).toBe(true)
  })

  it("FIX1: degraded ABSENT (falsy, not strict false) is ineligible — fail-closed", () => {
    // A receipt that lost the degraded bit must NOT pass as if non-degraded.
    const degradedAbsent = {
      key: "camp/inst",
      campaignId: "camp",
      instanceId: "inst",
      updatedAt: "2026-06-27T00:00:00.000Z",
      latestSeq: 0,
    } as unknown as ResumeReceipt
    expect(isResumeEligible(degradedAbsent)).toBe(false)
  })

  it('FIX1: degraded as the STRING "false" is ineligible (not coerced truthy/falsy)', () => {
    const stringFalse = { ...sample, degraded: "false" } as unknown as ResumeReceipt
    expect(isResumeEligible(stringFalse)).toBe(false)
  })

  it("FIX1: latestSeq NaN / missing / negative is ineligible", () => {
    expect(isResumeEligible({ ...sample, latestSeq: Number.NaN })).toBe(false)
    const seqMissing = { ...sample } as Partial<ResumeReceipt>
    delete seqMissing.latestSeq
    expect(isResumeEligible(seqMissing as unknown as ResumeReceipt)).toBe(false)
    expect(isResumeEligible({ ...sample, latestSeq: -1 })).toBe(false)
    // non-integer
    expect(isResumeEligible({ ...sample, latestSeq: 1.5 })).toBe(false)
  })

  it("FIX1: required string fields missing/empty ⇒ ineligible", () => {
    expect(isResumeEligible({ ...sample, key: "" })).toBe(false)
    expect(isResumeEligible({ ...sample, campaignId: "" })).toBe(false)
    expect(isResumeEligible({ ...sample, instanceId: "" })).toBe(false)
    expect(isResumeEligible({ ...sample, updatedAt: "" })).toBe(false)
    const keyMissing = { ...sample } as Partial<ResumeReceipt>
    delete keyMissing.key
    expect(isResumeEligible(keyMissing as unknown as ResumeReceipt)).toBe(false)
  })

  it("FIX1: a fully well-formed degraded:false receipt is eligible", () => {
    expect(isResumeEligible(sample)).toBe(true)
  })

  it('FIX1: readReceipt of a {"degraded":"false"} blob (mistyped) ⇒ undefined', async () => {
    const be = fakeBackend()
    const blob: RemoteBackend = {
      ...be,
      async get() {
        return JSON.stringify({ degraded: "false" })
      },
    }
    expect(await readReceipt(blob, "camp/inst")).toBeUndefined()
  })

  it("FIX1: readReceipt of a structurally-malformed (missing fields) blob ⇒ undefined", async () => {
    const be = fakeBackend()
    const blob: RemoteBackend = {
      ...be,
      async get() {
        // valid JSON, wrong shape (latestSeq mistyped, fields missing)
        return JSON.stringify({ key: "camp/inst", latestSeq: "42", degraded: false })
      },
    }
    expect(await readReceipt(blob, "camp/inst")).toBeUndefined()
  })
})

describe("s3-backend", () => {
  interface AwsCall {
    args: readonly string[]
    stdin?: string
  }
  const recordingRunAws = (
    responses: RunAwsResult[],
  ): {
    runAws: (args: readonly string[], stdin?: string) => Promise<RunAwsResult>
    calls: AwsCall[]
  } => {
    const calls: AwsCall[] = []
    let i = 0
    return {
      calls,
      runAws: async (args, stdin) => {
        calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) })
        return responses[i++] ?? { stdout: "", exitCode: 0 }
      },
    }
  }

  it("put builds `aws s3 cp - s3://<bucket>/<path>` with body on stdin", async () => {
    const { runAws, calls } = recordingRunAws([{ stdout: "", exitCode: 0 }])
    const be = s3Backend({ bucket: "bkt", runAws })
    await be.put("camp/inst/events/000001.json", "payload-body")
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.args).toContain("s3")
    expect(c.args).toContain("cp")
    expect(c.args).toContain("-")
    expect(c.args).toContain("s3://bkt/camp/inst/events/000001.json")
    // body is passed on stdin, not as an argv token.
    expect(c.stdin).toBe("payload-body")
    expect(c.args).not.toContain("payload-body")
  })

  it("put threads --region when set", async () => {
    const { runAws, calls } = recordingRunAws([{ stdout: "", exitCode: 0 }])
    const be = s3Backend({ bucket: "bkt", region: "ap-northeast-2", runAws })
    await be.put("p", "b")
    expect(calls[0]!.args).toContain("--region")
    expect(calls[0]!.args).toContain("ap-northeast-2")
  })

  it("get builds `aws s3 cp s3://<bucket>/<path> -` and returns stdout on exit 0", async () => {
    const { runAws, calls } = recordingRunAws([{ stdout: "the-object-body", exitCode: 0 }])
    const be = s3Backend({ bucket: "bkt", runAws })
    const got = await be.get("camp/inst/resume-state.json")
    expect(got).toBe("the-object-body")
    const c = calls[0]!
    expect(c.args).toContain("s3")
    expect(c.args).toContain("cp")
    expect(c.args).toContain("s3://bkt/camp/inst/resume-state.json")
    expect(c.args).toContain("-")
    // s3 source precedes the `-` dest sink.
    const srcIdx = c.args.indexOf("s3://bkt/camp/inst/resume-state.json")
    const dashIdx = c.args.lastIndexOf("-")
    expect(srcIdx).toBeLessThan(dashIdx)
  })

  it("get returns undefined on a GENUINE not-found (NoSuchKey in stderr), never throws", async () => {
    const { runAws } = recordingRunAws([
      { stdout: "", exitCode: 1, stderr: "fatal error: An error occurred (NoSuchKey) ..." },
    ])
    const be = s3Backend({ bucket: "bkt", runAws })
    expect(await be.get("missing/key")).toBeUndefined()
  })

  it("FIX2: get returns undefined for other not-found phrasings (404 / does not exist)", async () => {
    const a = recordingRunAws([{ stdout: "", exitCode: 1, stderr: "HTTP 404 Not Found" }])
    expect(await s3Backend({ bucket: "bkt", runAws: a.runAws }).get("k")).toBeUndefined()
    const b = recordingRunAws([
      { stdout: "", exitCode: 1, stderr: "The specified key does not exist." },
    ])
    expect(await s3Backend({ bucket: "bkt", runAws: b.runAws }).get("k")).toBeUndefined()
  })

  it("FIX2: get THROWS (transport failure) on a non-not-found non-zero exit (creds)", async () => {
    const { runAws } = recordingRunAws([
      { stdout: "", exitCode: 255, stderr: "Unable to locate credentials" },
    ])
    const be = s3Backend({ bucket: "bkt", runAws })
    await expect(be.get("camp/inst/resume-state.json")).rejects.toThrow(
      /Unable to locate credentials/,
    )
  })

  it("FIX3: put THROWS on non-zero exit (must not swallow upload failure)", async () => {
    const { runAws } = recordingRunAws([
      { stdout: "", exitCode: 1, stderr: "AccessDenied: not authorized to PutObject" },
    ])
    const be = s3Backend({ bucket: "bkt", runAws })
    await expect(be.put("camp/inst/events/000001.json", "body")).rejects.toThrow(/AccessDenied/)
  })

  it("list parses FULL keys from realistic `aws s3 ls --recursive` output", async () => {
    // aws s3 ls --recursive columns: <date> <time> <size> <key>
    const lsOut = [
      "2026-06-27 08:10:01         12 camp/inst/events/000001.json",
      "2026-06-27 08:10:02         34 camp/inst/events/000002.json",
      "2026-06-27 08:10:03        128 camp/inst/resume-state.json",
      "",
    ].join("\n")
    const { runAws, calls } = recordingRunAws([{ stdout: lsOut, exitCode: 0 }])
    const be = s3Backend({ bucket: "bkt", runAws })
    const keys = await be.list("camp/inst/")
    expect([...keys].sort()).toEqual([
      "camp/inst/events/000001.json",
      "camp/inst/events/000002.json",
      "camp/inst/resume-state.json",
    ])
    const c = calls[0]!
    expect(c.args).toContain("s3")
    expect(c.args).toContain("ls")
    expect(c.args).toContain("--recursive")
    expect(c.args).toContain("s3://bkt/camp/inst/")
  })

  it("FIX5: list parses a key CONTAINING A SPACE (slices past first 3 cols, keeps remainder)", async () => {
    const lsOut = ["2026-06-27 08:10:01         12 camp/inst/has space/file.json", ""].join("\n")
    const { runAws } = recordingRunAws([{ stdout: lsOut, exitCode: 0 }])
    const be = s3Backend({ bucket: "bkt", runAws })
    const keys = await be.list("camp/inst/")
    expect(keys).toEqual(["camp/inst/has space/file.json"])
    expect(keys[0]).toContain("has space")
  })

  it("list returns [] on non-zero exit", async () => {
    const { runAws } = recordingRunAws([{ stdout: "boom", exitCode: 255 }])
    const be = s3Backend({ bucket: "bkt", runAws })
    expect(await be.list("camp/")).toEqual([])
  })

  it("segment-store composes over the s3 backend end-to-end (keys land in S3 namespace)", async () => {
    // Stateful fake aws: cp - (put) writes, ls --recursive lists, cp <src> - reads.
    const objects = new Map<string, string>()
    const runAws = async (
      args: readonly string[],
      stdin?: string,
    ): Promise<{ stdout: string; exitCode: number }> => {
      const a = [...args]
      if (a.includes("cp") && a[a.length - 1] === "-") {
        // get: cp s3://... -
        const src = a[a.indexOf("cp") + 1]!.replace("s3://bkt/", "")
        const body = objects.get(src)
        return body === undefined ? { stdout: "", exitCode: 1 } : { stdout: body, exitCode: 0 }
      }
      if (a.includes("cp") && a[a.indexOf("cp") + 1] === "-") {
        // put: cp - s3://...
        const dest = a[a.indexOf("cp") + 2]!.replace("s3://bkt/", "")
        objects.set(dest, stdin ?? "")
        return { stdout: "", exitCode: 0 }
      }
      if (a.includes("ls")) {
        const prefix = a[a.indexOf("ls") + 1]!.replace("s3://bkt/", "")
        const lines = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => `2026-06-27 08:00:00  10 ${k}`)
        return { stdout: lines.join("\n"), exitCode: 0 }
      }
      return { stdout: "", exitCode: 0 }
    }
    const be = s3Backend({ bucket: "bkt", runAws })
    const ss = segmentStore(be, "camp/inst")
    await ss.putSegment(2, "B")
    await ss.putSegment(1, "A")
    expect(await ss.listSegments()).toEqual([1, 2])
    expect(await ss.concat()).toBe("A\nB")
    expect([...objects.keys()].sort()).toEqual([
      "camp/inst/events/000001.json",
      "camp/inst/events/000002.json",
    ])
  })
})
