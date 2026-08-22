/**
 * HELLGATE — edit-fresh-hash CHAIN, FULL AGENT-LOOP e2e (jul-13 edit-fresh-hash).
 *
 * The pure helpers (`freshHashNote` / `refreshStaleReadBaseline`) and the tool's
 * isolated `execute` are sealed elsewhere. This battery proves the *missing* seam:
 * the fresh-hash CHAIN survives END-TO-END through the REAL `runAgent` turn loop +
 * REAL dispatch + REAL `edit` tool + the DEFAULT-ON mtime stale-read guard — NOT
 * `tool.execute` in isolation.
 *
 * THE CRUX (the scripted LLM REACTS, never hardcodes): the feature is DEFAULT-ON,
 * so a successful `edit` appends `fresh sha256: <hex>` to its tool_result AND
 * refreshes the stale-read baseline. The scripted model:
 *   turn 1 — emits an `edit` (no expected_hash);
 *   turn 2 — PARSES the incoming `input.messages` for the last edit tool_result,
 *            EXTRACTS the advertised `fresh sha256: <hex>`, and emits a SECOND
 *            `edit` to the SAME file with `expected_hash = <that hex>` and NO
 *            intervening `read` — exactly what a real model would do;
 *   turn 3 — end_turn.
 * ASSERT: both edits LAND on disk and the second edit's tool_result is a SUCCESS
 * (not `stale_precondition`, not `stale_read`) — proving the real dispatch's fresh
 * hash was consumed by the (scripted) model AND accepted by the real dispatch
 * UNDER the default-ON mtime guard (the baseline the first commit refreshed).
 *
 * NON-VACUITY (paired control): the identical two-turn scenario where turn 2
 * supplies the PRE-EDIT (stale) hash ⇒ the second edit FAILS `stale_precondition`
 * and does NOT land. Plus a load-bearing OFF control: `QUANTA_EDIT_FRESH_HASH=off`
 * ⇒ the tool_result carries NO `fresh sha256` line at all.
 *
 * HARNESS mirrors `cursor-gap-e2e.test.ts` / `delta-token-loop-wire-e2e-hellgate`:
 * REAL `runAgent` (@/agent) with a scripted `LLMPort` + a real `ToolRegistry`
 * holding the REAL default-port `editTool` (@/tool/edit) over a REAL tmpdir file.
 * A real `ReadFileState` is wired into `AgentConfig.readFileState` so the
 * DEFAULT-ON mtime guard is LIVE in the loop (the host mints one per session).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { sha256Hex } from "@/storage"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"
import { editTool } from "@/tool/edit"
import { ReadFileState } from "@/tool/stale-read-guard"

// ── knob harness (QUANTA_EDIT_FRESH_HASH is DEFAULT-ON; opt-out === "off") ────
const withFreshHash = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const KEY = "QUANTA_EDIT_FRESH_HASH"
  const saved = process.env[KEY]
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  __resetRuntimeConfig()
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
    __resetRuntimeConfig()
  }
}

// ── doubles ──────────────────────────────────────────────────────────────────
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const editUseScript = (id: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name: "edit" },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** Concatenate every tool_result block's plain-text `content` across a
 *  StreamInput's messages, in order — the surface a real model reads. The loop
 *  feeds each executed tool's result back as a `tool_result` block in the NEXT
 *  stream() call's `input.messages`. */
const toolResultTexts = (input: StreamInput | undefined): string[] =>
  (input?.messages ?? [])
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => b.content)

/** Extract the LAST advertised `fresh sha256: <hex>` from the tool_results the
 *  loop fed back — precisely how a real model would recover the digest to chain
 *  it as the next edit's `expected_hash`. Returns null when no hash was
 *  advertised (the OFF path). */
const extractFreshHash = (input: StreamInput | undefined): string | null => {
  const all = toolResultTexts(input).join("\n")
  const matches = [...all.matchAll(/fresh sha256: ([0-9a-f]{64})/g)]
  const last = matches.at(-1)
  return last ? (last[1] as string) : null
}

/**
 * The REACTIVE scripted model. It does NOT hardcode the fresh hash: on the
 * `expected_hash`-supplying turn it PARSES the incoming `input.messages`, pulls
 * the advertised `fresh sha256`, and emits the chained edit with a caller-derived
 * `expected_hash`. `hashChooser` maps the extracted-fresh-hash ⇒ the hash the
 * chained edit actually supplies (identity for the success path; a stale hash for
 * the paired control) — so the control differs ONLY in the value the model reuses,
 * everything else being byte-identical.
 */
class ChainingEditLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly extracted: (string | null)[] = []
  readonly model = "scripted"
  private turn = 0
  constructor(
    private readonly file: string,
    private readonly firstEdit: { old_string: string; new_string: string },
    private readonly secondEdit: { old_string: string; new_string: string },
    private readonly hashChooser: (freshHash: string | null) => string | undefined,
    /** OPTIONAL side-effect fired just before turn-2's edit is emitted (e.g. an
     *  out-of-band external file modification to exercise the live mtime guard). */
    private readonly beforeTurn2?: () => void,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const t = this.turn++
    if (t === 0) {
      // Turn 1: first edit, NO expected_hash.
      for (const ev of editUseScript("e1", { path: this.file, ...this.firstEdit })) yield ev
      return
    }
    if (t === 1) {
      // Turn 2: REACT to the tool_result — extract the advertised fresh hash and
      // chain the second edit with a caller-chosen expected_hash. NO intervening
      // read tool_use (the whole point: the advertised hash makes a re-read
      // unnecessary and the refreshed baseline keeps the mtime guard from vetoing).
      const fresh = extractFreshHash(input)
      this.extracted.push(fresh)
      this.beforeTurn2?.()
      const expected_hash = this.hashChooser(fresh)
      const secondInput =
        expected_hash === undefined
          ? { path: this.file, ...this.secondEdit }
          : { path: this.file, ...this.secondEdit, expected_hash }
      for (const ev of editUseScript("e2", secondInput)) yield ev
      return
    }
    // Turn 3+: close out.
    for (const ev of textScript("done")) yield ev
  }
}

// ── real tmpdir file + a real per-session ReadFileState (mtime guard LIVE) ─────
let dir: string
let file: string
const INITIAL = "line-A: alpha\nline-B: beta\nline-C: gamma\n"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fresh-hash-e2e-"))
  file = join(dir, "target.txt")
  writeFileSync(file, INITIAL)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry([editTool]),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("chain two edits to the same file")],
  system: "test-system",
  cwd: dir,
  maxTurns: 6,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  // DEFAULT-ON stale-read guard LIVE in the real loop: one ReadFileState per
  // session, exactly as the host mints it. The first edit's refresh records the
  // post-write mtime here; the chained edit's pre-commit guard reads it back.
  readFileState: new ReadFileState(),
  ...over,
})

const FIRST = { old_string: "alpha", new_string: "ALPHA-1" }
const SECOND = { old_string: "beta", new_string: "BETA-2" }
const EXPECTED_BOTH = "line-A: ALPHA-1\nline-B: BETA-2\nline-C: gamma\n"

// ════════════════════════════════════════════════════════════════════════════
// (1) SUCCESS — the fresh hash produced by real dispatch is consumed by the
//     (scripted) model and accepted by real dispatch under the default-ON guard.
// ════════════════════════════════════════════════════════════════════════════
describe("edit-fresh-hash CHAIN survives the REAL runAgent loop (default-ON)", () => {
  test("turn-2 chains the advertised fresh sha256 ⇒ BOTH edits land, 2nd is SUCCESS", async () => {
    await withFreshHash(undefined, async () => {
      // Default-ON: no env set. identity chooser ⇒ the model reuses EXACTLY the
      // advertised fresh hash as the next edit's expected_hash.
      const llm = new ChainingEditLLM(file, FIRST, SECOND, (fresh) => fresh ?? undefined)
      const out = await runAgent(baseCfg({ llm }))

      // (a) The model actually SAW and extracted a real 64-hex fresh hash from the
      //     first edit's tool_result — proving the note reached it through the loop.
      expect(llm.extracted.length).toBe(1)
      expect(llm.extracted[0]).toMatch(/^[0-9a-f]{64}$/)

      // (b) BOTH edits LANDED on disk (real filesystem, real edit tool).
      expect(readFileSync(file, "utf8")).toBe(EXPECTED_BOTH)

      // (c) The second edit's tool_result is a SUCCESS — NOT stale_precondition,
      //     NOT stale_read. This is the load-bearing assertion: the chained
      //     expected_hash matched real on-disk bytes AND the refreshed mtime
      //     baseline let the default-ON guard pass without a re-read.
      const results = toolResultTexts(
        // the LAST stream() input carries BOTH edit tool_results.
        llm.inputs.at(-1),
      )
      const secondResult = results.at(-1) ?? ""
      // A successful edit reports "Replaced N occurrence(s)" AND (default-ON) its
      // OWN fresh-hash note — the failure paths carry neither.
      expect(secondResult).toContain("Replaced")
      expect(secondResult).toContain("fresh sha256")
      expect(secondResult).not.toContain("stale_precondition")
      expect(secondResult).not.toMatch(/re-read the file/i)
      // The transcript the loop returns carries no error on the second edit.
      const transcript = JSON.stringify(out.messages)
      expect(transcript).not.toContain("stale_precondition")
    })
  })

  test("the fresh hash the model chained EQUALS sha256(post-first-edit bytes)", async () => {
    await withFreshHash(undefined, async () => {
      const llm = new ChainingEditLLM(file, FIRST, SECOND, (fresh) => fresh ?? undefined)
      await runAgent(baseCfg({ llm }))
      // The advertised hash is the sha256 of the file state AFTER the first edit
      // (alpha→ALPHA-1) and BEFORE the second — i.e. the exact precondition the
      // chained edit needed. Recompute it independently and compare.
      const afterFirst = INITIAL.replace("alpha", "ALPHA-1")
      expect(llm.extracted[0]).toBe(sha256Hex(afterFirst))
    })
  })

  // MTIME-GUARD load-bearing witness. The stale-read guard is DEFAULT-ON and LIVE
  // in this loop (readFileState wired). It only has a baseline to check AFTER a
  // read/refresh records one. Here we make edit-1's REFRESH the source of edit-2's
  // baseline, then FORCE an mtime-forward EXTERNAL modification between the two
  // edits so the guard has a genuine chance to veto:
  //   - default-ON: edit-1 refreshes the baseline to post-edit-1 mtime; we then
  //     touch the file's mtime FORWARD (external write) before edit-2 — so edit-2
  //     SHOULD be vetoed `stale_read`. This proves the guard is genuinely LIVE and
  //     checking a real baseline (not inert) in the loop.
  // The chooser omits expected_hash so the ONLY gate edit-2 faces is the mtime
  // guard (isolating it from the hash precondition).
  test("mtime-guard is LIVE: an external mtime-forward between edits vetoes edit-2 (stale_read)", async () => {
    await withFreshHash(undefined, async () => {
      const rfs = new ReadFileState()
      // A model that, before emitting turn-2's edit, mutates the file OUT OF BAND
      // and advances its mtime past the baseline edit-1's refresh recorded — a real
      // external modification. The chained edit carries NO expected_hash so the
      // mtime guard is the SOLE arbiter (isolating the guard from the hash gate).
      const llm = new ChainingEditLLM(
        file,
        FIRST,
        SECOND,
        () => undefined,
        () => {
          const cur = readFileSync(file, "utf8")
          writeFileSync(file, cur)
          const future = Date.now() / 1000 + 60
          utimesSync(file, future, future)
        },
      )
      await runAgent(baseCfg({ llm, readFileState: rfs }))

      // Edit-1 landed; edit-2 was VETOED by the live mtime guard (external write
      // advanced mtime past the refreshed baseline) — proving the guard is LIVE and
      // checking a REAL baseline in the loop, not inert.
      const onDisk = readFileSync(file, "utf8")
      expect(onDisk).toContain("ALPHA-1")
      expect(onDisk).not.toContain("BETA-2")
      const secondResult = toolResultTexts(llm.inputs.at(-1)).at(-1) ?? ""
      expect(secondResult).toMatch(/modified on disk after you last read it/i)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// (2) PAIRED CONTROL — non-vacuity: a STALE expected_hash MUST fail + not land.
// ════════════════════════════════════════════════════════════════════════════
describe("paired control — a STALE expected_hash is REJECTED (success path is not vacuous)", () => {
  test("turn-2 reuses the PRE-EDIT hash ⇒ 2nd edit stale_precondition, does NOT land", async () => {
    await withFreshHash(undefined, async () => {
      const preEditHash = sha256Hex(INITIAL)
      // The control differs ONLY in the value the model reuses: instead of the
      // advertised fresh hash it supplies the PRE-EDIT hash (what a model would
      // wrongly carry if the fresh-hash note did not exist / it re-used an old
      // read). Everything else is byte-identical to the success scenario.
      const llm = new ChainingEditLLM(file, FIRST, SECOND, () => preEditHash)
      const out = await runAgent(baseCfg({ llm }))

      // The model STILL saw a real fresh hash (the note is default-ON) — the
      // control is not "the note was missing", it is "the model chained the WRONG
      // value" — proving the success test's green comes from the CORRECT value.
      expect(llm.extracted[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(preEditHash).not.toBe(llm.extracted[0])

      // The second edit FAILED the precondition and its mutation did NOT land:
      // only the FIRST edit is on disk.
      const onDisk = readFileSync(file, "utf8")
      expect(onDisk).toBe(INITIAL.replace("alpha", "ALPHA-1"))
      expect(onDisk).not.toContain("BETA-2")

      const secondResult = toolResultTexts(llm.inputs.at(-1)).at(-1) ?? ""
      expect(secondResult).toContain("stale_precondition")
      expect(JSON.stringify(out.messages)).toContain("stale_precondition")
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// (3) OFF control — DEFAULT-ON is load-bearing: opt-out drops the fresh-hash note.
// ════════════════════════════════════════════════════════════════════════════
describe("QUANTA_EDIT_FRESH_HASH=off ⇒ NO fresh sha256 note (default-ON is load-bearing)", () => {
  test("opt-out: the first edit's tool_result carries no `fresh sha256` line", async () => {
    await withFreshHash("off", async () => {
      // With the feature OFF the model can extract nothing; it chains no
      // expected_hash (undefined chooser) so the second edit is a plain edit.
      const llm = new ChainingEditLLM(file, FIRST, SECOND, () => undefined)
      await runAgent(baseCfg({ llm }))

      // The note is absent from EVERY tool_result the loop fed back.
      const allResults = llm.inputs.flatMap((i) => toolResultTexts(i)).join("\n")
      expect(allResults).not.toContain("fresh sha256")
      expect(llm.extracted[0]).toBeNull()
      // Sanity: with the note gone the two edits (no precondition on either) still
      // both land — the OFF path is a working plain edit, so the missing note is
      // the ONLY observable difference.
      expect(readFileSync(file, "utf8")).toBe(EXPECTED_BOTH)
    })
  })
})
