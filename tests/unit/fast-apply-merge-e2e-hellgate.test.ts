/**
 * jun-7-misc 06 (ADR ≥0497) E2E hellgate — model-based fast-apply MERGE rung,
 * driven through the REAL seam chain end-to-end.
 *
 * WHY THIS IS DISTINCT FROM `edit-fast-apply-merge-rung-hellgate.test.ts`:
 *   Those tests inject a HAND-ROLLED `FastApplyMergeSeam` mock and exercise only
 *   the CONSUMER's edit-scoped verification. This test wires the REAL producer —
 *   `createFastApplyMerge` from `@/agent/fast-apply-fallback` — as `ctx.fastApplyMerge`
 *   and drives it through the REAL `makeEditTool` → `planEdit` → `tryFastApplyMergeRung`
 *   → `commitEdit` path. The ONLY fake is the `SideConversationLike.dispatch` (the
 *   actual LLM network round-trip) and the `ApplyRoleResolverLike` (the model-id
 *   resolution) — those two ARE the provider boundary; everything else is the
 *   real code that ships:
 *
 *     editTool.execute (real)
 *       → planEdit (real)
 *         → applyExactEdit / applyFuzzyEdit (real deterministic ladder, miss)
 *         → tryFastApplyMergeRung (real)
 *           → ctx.fastApplyMerge.apply  ==  createFastApplyMerge(...).apply (REAL)
 *               → buildMergePrompt (real)            — the actual prompt the model sees
 *               → sideConversation.dispatch (FAKE)   — the only seam, = the LLM call
 *               → extractMergedFile (real)           — real fence parsing
 *               → verifyMergeStructural (real)       — real runner-level structural gate
 *           → verifyEditScopedMerge (real)           — real consumer edit-scoped gate
 *         → commitEdit (real)                        — the SAME gated write any edit takes
 *
 * REAL-PATH ASSERTION (gap closed): with the knob ON (port wired with the real
 * runner over a fake LLM that returns a correct ```merged``` reply), an edit whose
 * old_string is ABSENT from the file — which today returns a typed `not_found`
 * mismatch — now LANDS: the merged bytes are written to disk through the real
 * `commitEdit`, and the fake LLM was driven with the REAL `buildMergePrompt`
 * output (asserted: the prompt names the elision convention and embeds the original
 * file + the derived sketch). That is the model-based fast-apply mechanism working
 * through its real seam, not a mock of it.
 *
 * DEFAULT-OFF BYTE-IDENTITY: the SAME real edit tool, SAME input, with NO
 * `ctx.fastApplyMerge` wired (knob unset) returns the byte-for-byte legacy
 * `not_found` mismatch and performs ZERO writes and ZERO LLM dispatches — the
 * real runner is never constructed, never called, never allocates a prompt.
 *
 * RED-ON-INJECTION: the real runner's structural verify + the consumer's
 * edit-scoped verify must fail LOUDLY when the LLM hallucinates. A reply that
 * drops the file to empty, copies the elision marker instead of expanding it, or
 * omits new_string is REJECTED by the real verification chain — fail-closed to
 * the legacy mismatch, file UNCHANGED, no write. Neutering either gate flips
 * these to a disk write (proven by the guard-integrity reasoning below).
 */

import { describe, expect, test } from "bun:test"
import {
  type ApplyRoleResolverLike,
  createFastApplyMerge,
  type SideConversationLike,
} from "@/agent/fast-apply-fallback"
import type { FileInfo, FileSystemPort } from "@/storage"
import type { ToolContext, ToolDiffSink, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import type { FastApplyMergeSeam } from "@/tool/types"

/** Recording in-memory FS so we can prove fail-closed paths perform NO write and
 *  the accept path writes EXACTLY once via the real `commitEdit`. */
const makeFs = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: Array<{ path: string; content: string }> = []
  const fs: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push({ path, content })
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }
  return { fs, files, writes }
}

/** The ONLY faked seam: the apply-model resolver. Mirrors the real
 *  composition-root contract — a role MISS returns `applyModel` (the operator-set
 *  id), NEVER the main chat model. Records the resolution so we can assert the
 *  apply role (not the chat model) drove the call. */
const makeRoleResolver = (): {
  resolver: ApplyRoleResolverLike
  resolved: Array<{ role: string; fallback: string }>
} => {
  const resolved: Array<{ role: string; fallback: string }> = []
  const resolver: ApplyRoleResolverLike = {
    resolve(role: "apply", applyModel: string): string {
      resolved.push({ role, fallback: applyModel })
      // Real adapter behavior: the "apply" role resolves to the operator-set
      // apply model id (no fall-through to the chat model).
      return applyModel
    },
  }
  return { resolver, resolved }
}

/** The ONLY other faked seam: the LLM side-conversation. This IS the network
 *  boundary — it stands in for the actual provider round-trip. It RECORDS the
 *  prompt the REAL `buildMergePrompt` produced so the test can prove the real
 *  prompt drove the call, and returns whatever the scenario dictates. */
const makeLlm = (
  reply: (prompt: string) => { ok: boolean; text: string } | "throw",
): { sideConversation: SideConversationLike; dispatches: string[] } => {
  const dispatches: string[] = []
  const sideConversation: SideConversationLike = {
    async dispatch(req: { prompt: string; model: string }): Promise<{ ok: boolean; text: string }> {
      dispatches.push(req.prompt)
      const r = reply(req.prompt)
      if (r === "throw") throw new Error("provider exploded")
      return r
    },
  }
  return { sideConversation, dispatches }
}

/** Construct the REAL merge port exactly as the composition root would (the
 *  duck-typed `FastApplyPort` is structurally the `FastApplyMergeSeam` the tool
 *  consumes). `APPLY_MODEL` is the operator-set `QUANTA_FAST_APPLY_MODEL`. */
const APPLY_MODEL = "fake-cheap-apply-model"
const buildRealPort = (
  llm: SideConversationLike,
  resolver: ApplyRoleResolverLike,
): FastApplyMergeSeam =>
  createFastApplyMerge({
    roleResolver: resolver,
    sideConversation: llm,
    applyModel: APPLY_MODEL,
  })

const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/",
  signal: new AbortController().signal,
  // Positive real-runner cases use an explicit host review authority. Normal
  // production composition currently omits it and therefore remains fail-closed.
  fastApplyMergeReview: { approve: async () => true },
  ...over,
})

const run = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const ORIGINAL = "import {alpha} from 'x'\nconst beta = 1\ngamma()\n"

describe("jun-7-misc 06 fast-apply MERGE rung E2E hellgate (REAL runner + REAL edit tool)", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // REAL-PATH (gap closed): the model-based fast-apply mechanism lands an edit
  // the deterministic ladder could not, driving the REAL runner end-to-end.
  // ───────────────────────────────────────────────────────────────────────────
  test("E2E-01 ON: an unanchored edit LANDS via the real merge runner + real commit", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver, resolved } = makeRoleResolver()
    // The fake LLM merges the edit correctly (resolves the elisions): it returns
    // the full file with `const beta = 1` rewritten to `const beta = 42`.
    const merged = "import {alpha} from 'x'\nconst beta = 42\ngamma()\n"
    // A real model emits the full file (ending in its own trailing `\n`) and then
    // the closing fence on its OWN line — i.e. `<file>\n` followed by `\n```. The
    // real `extractMergedFile` treats the LAST `\n` before the fence as the
    // structural delimiter, so to round-trip a file that genuinely ends in `\n`
    // the reply carries the file's `\n` PLUS the delimiter `\n` (`${merged}\n```).
    const { sideConversation, dispatches } = makeLlm(() => ({
      ok: true,
      text: `Here is the merge:\n\`\`\`merged\n${merged}\n\`\`\`\n`,
    }))
    const port = buildRealPort(sideConversation, resolver)
    const tool = makeEditTool(fs)

    // `old_string` is ABSENT verbatim (note the spacing) so exact AND fuzzy miss
    // — today this is a hard `not_found`. The merge rung is the recovery.
    const res = await run(
      tool,
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port }),
    )

    // The edit SUCCEEDED through the real merge runner.
    expect(res.ok).toBe(true)
    // The merged bytes reached disk through the REAL `commitEdit` (exactly one write).
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toBe("app.ts")
    expect(writes[0]?.content).toBe(merged)
    expect(files.get("app.ts")).toBe(merged)

    // PROOF the REAL runner drove the LLM: exactly one dispatch, and the prompt is
    // the REAL `buildMergePrompt` output — it names the elision convention, embeds
    // the verbatim original, and carries the derived sketch's new text.
    expect(dispatches.length).toBe(1)
    const prompt = dispatches[0] ?? ""
    expect(prompt).toContain("fast APPLY model")
    expect(prompt).toContain("// ... existing code ...")
    expect(prompt).toContain(ORIGINAL) // original embedded verbatim
    expect(prompt).toContain("const beta = 42") // derived sketch's new region

    // PROOF the apply ROLE (not the main chat model) resolved the model id.
    expect(resolved.length).toBe(1)
    expect(resolved[0]?.role).toBe("apply")
    expect(resolved[0]?.fallback).toBe(APPLY_MODEL)
  })

  test("E2E-02 ON: an approved merge reaches the normal post-write diff sink", async () => {
    const { fs, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    const merged = "import {alpha} from 'x'\nconst beta = 42\ngamma()\n"
    const { sideConversation } = makeLlm(() => ({
      ok: true,
      text: `\`\`\`merged\n${merged}\n\`\`\``,
    }))
    const port = buildRealPort(sideConversation, resolver)
    const tool = makeEditTool(fs)

    // The explicit review already approved this proposal. Wire the real tool-diff
    // sink to prove normal post-write observation still receives the committed edit.
    const diffs: Array<{ before: string; after: string; path: string }> = []
    const res = await run(
      tool,
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({
        fastApplyMerge: port,
        toolCallId: "tc-1",
        toolDiff: {
          capture(d: { toolCallId: string; before: string; after: string; path: string }) {
            diffs.push({ before: d.before, after: d.after, path: d.path })
          },
        } satisfies ToolDiffSink,
      }),
    )
    expect(res.ok).toBe(true)
    // The diff sink saw the verbatim before/after — the merge is a surfaced
    // proposal through the gated path, not a blind side-channel write.
    expect(diffs.length).toBe(1)
    expect(diffs[0]?.before).toBe(ORIGINAL)
    expect(diffs[0]?.after).toBe(merged)
    expect(writes.length).toBe(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // DEFAULT-OFF BYTE-IDENTITY: same real tool, same input, NO port wired.
  // ───────────────────────────────────────────────────────────────────────────
  test("E2E-03 OFF (knob unset ⇒ no port): byte-identical legacy not_found, ZERO write, ZERO dispatch", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver, resolved } = makeRoleResolver()
    const { sideConversation, dispatches } = makeLlm(() => ({ ok: true, text: "irrelevant" }))
    // Build the real port BUT DO NOT wire it onto ctx (simulates the knob unset:
    // the composition root never constructs/attaches the port).
    void buildRealPort(sideConversation, resolver)
    const tool = makeEditTool(fs)

    const res = await run(
      tool,
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf(), // <-- no fastApplyMerge
    )

    // Byte-identical legacy mismatch.
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    // ZERO writes, file untouched.
    expect(writes.length).toBe(0)
    expect(files.get("app.ts")).toBe(ORIGINAL)
    // ZERO provider dispatch, ZERO role resolution — the runner was never reached.
    expect(dispatches.length).toBe(0)
    expect(resolved.length).toBe(0)
  })

  test("E2E-03b port without host review is fail-closed before real provider dispatch", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver, resolved } = makeRoleResolver()
    const { sideConversation, dispatches } = makeLlm(() => ({ ok: true, text: "unreachable" }))
    const port = buildRealPort(sideConversation, resolver)

    const res = await run(
      makeEditTool(fs),
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port, fastApplyMergeReview: undefined }),
    )

    expect(res.ok).toBe(false)
    expect(files.get("app.ts")).toBe(ORIGINAL)
    expect(writes).toHaveLength(0)
    expect(dispatches).toHaveLength(0)
    expect(resolved).toHaveLength(0)
  })

  test("E2E-04 OFF byte-identity: the not_found output equals the no-port baseline EXACTLY", async () => {
    // Drive the SAME real tool with the SAME input twice: once with a wired port
    // whose LLM returns an UNUSABLE reply (so the rung fails-closed), once with no
    // port at all. The final `output` + `failure` must be byte-for-byte identical —
    // proving the merge rung adds NO drift to the legacy mismatch surface.
    const inputArgs = {
      path: "app.ts",
      old_string: "const  beta  =  1",
      new_string: "const beta = 42",
    }

    const a = makeFs({ "app.ts": ORIGINAL })
    const noPortRes = await run(makeEditTool(a.fs), inputArgs, ctxOf())

    const b = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    // LLM returns empty ⇒ real `extractMergedFile` → null ⇒ runner ok:false ⇒
    // rung returns null ⇒ same legacy mismatch.
    const { sideConversation } = makeLlm(() => ({ ok: true, text: "" }))
    const port = buildRealPort(sideConversation, resolver)
    const wiredFailRes = await run(makeEditTool(b.fs), inputArgs, ctxOf({ fastApplyMerge: port }))

    expect(wiredFailRes.output).toBe(noPortRes.output)
    expect(wiredFailRes.failure).toEqual(noPortRes.failure)
    expect(a.writes.length).toBe(0)
    expect(b.writes.length).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // RED-ON-INJECTION: the real verification chain fails LOUDLY on hallucination.
  // Each drives the REAL runner (real extract + real structural verify) AND the
  // REAL consumer (real edit-scoped verify) — fail-closed, file UNCHANGED, no write.
  // ───────────────────────────────────────────────────────────────────────────
  test("E2E-05 RED: LLM drops the file to empty ⇒ real structural verify rejects ⇒ no write", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    // Hallucinated empty merge.
    const { sideConversation } = makeLlm(() => ({ ok: true, text: "```merged\n```" }))
    const port = buildRealPort(sideConversation, resolver)

    const res = await run(
      makeEditTool(fs),
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes.length).toBe(0)
    expect(files.get("app.ts")).toBe(ORIGINAL)
  })

  test("E2E-06 RED: LLM copies the elision marker (drops real code) ⇒ rejected ⇒ no write", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    // The apply model COPIED the `// ... existing code ...` sketch instead of
    // expanding it — real code (the import + gamma) is gone, the marker leaks.
    const hallucination = "// ... existing code ...\nconst beta = 42\n// ... existing code ...\n"
    const { sideConversation } = makeLlm(() => ({
      ok: true,
      text: `\`\`\`merged\n${hallucination}\`\`\``,
    }))
    const port = buildRealPort(sideConversation, resolver)

    const res = await run(
      makeEditTool(fs),
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port }),
    )
    // The REAL runner's `verifyMergeStructural` rejects the leftover marker; even
    // if a buggy port did not, the consumer's edit-scoped marker guard does.
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes.length).toBe(0)
    expect(files.get("app.ts")).toBe(ORIGINAL)
  })

  test("E2E-07 RED: LLM merge omits new_string (no landed signal) ⇒ rejected ⇒ no write", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    // A plausible-looking but WRONG merge: it changed something else and never
    // introduced `const beta = 42` — the edit never landed.
    const wrong = "import {alpha} from 'x'\nconst beta = 1\ndelta()\n"
    const { sideConversation } = makeLlm(() => ({
      ok: true,
      text: `\`\`\`merged\n${wrong}\`\`\``,
    }))
    const port = buildRealPort(sideConversation, resolver)

    const res = await run(
      makeEditTool(fs),
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes.length).toBe(0)
    expect(files.get("app.ts")).toBe(ORIGINAL)
  })

  test("E2E-08 RED: provider throws ⇒ real runner NO-THROW ⇒ fail-closed ⇒ no write, turn survives", async () => {
    const { fs, files, writes } = makeFs({ "app.ts": ORIGINAL })
    const { resolver } = makeRoleResolver()
    const { sideConversation } = makeLlm(() => "throw")
    const port = buildRealPort(sideConversation, resolver)

    // Must NOT throw into the turn (the runner collapses the provider throw to
    // ok:false; the consumer collapses any port throw to null).
    const res = await run(
      makeEditTool(fs),
      { path: "app.ts", old_string: "const  beta  =  1", new_string: "const beta = 42" },
      ctxOf({ fastApplyMerge: port }),
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
    expect(writes.length).toBe(0)
    expect(files.get("app.ts")).toBe(ORIGINAL)
  })
})
