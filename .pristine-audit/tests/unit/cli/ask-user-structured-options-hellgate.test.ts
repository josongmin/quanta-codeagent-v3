/**
 * Hellgate — ask_user STRUCTURED options 3-hop widening (jul-03 A1,
 * AskUserQuestion parity).
 *
 * The KEY trap: `options` widens from bare `string[]` to
 * `(string | {label, description?, preview?})[]` + a chip `header`, and this
 * MUST survive EVERY hop tool(ask-user.ts) → port(port.ts) → wire(ask-user-
 * wire.ts) → MCP prompter (schemas.ts/EnumRequest). A partial thread drops
 * description/preview at the narrowest hop and still builds green (wired-but-
 * inert). These tests pin the STRUCTURED shape as it lands at the prompter, so
 * a drop at any hop turns RED.
 *
 * Invariants:
 *   1. STRUCT-SURVIVES: a select with `{label,description,preview}` options +
 *      `header` reaches the prompter's `promptEnum` with the STRUCTURED options
 *      (label/description/preview all present) and the header threaded.
 *   2. VALUE-IS-LABEL: the answer surfaced is the option LABEL (not the
 *      description/preview blob).
 *   3. BACK-COMPAT (paired control): a bare-string select reaches the prompter
 *      as bare strings — byte-identical to the pre-widening shape.
 *   4. MULTISELECT parity — structured options survive on the multi path too.
 */
import { describe, expect, test } from "bun:test"
import { askUserPortFromPrompter } from "@/apps/cli/ask-user-wire"
import type { ElicitationPrompter, ElicitationResult, EnumOption } from "@/mcp"
import { type CliPrompterIO, cliPrompter } from "@/mcp"
import { askUserTool } from "@/tool/ask-user"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as unknown as ToolContext
const resultOf = async (it: AsyncIterable<ToolEvent>) => {
  for await (const e of it) if (e.type === "result") return e.result
  throw new Error("no result")
}

/** Capturing prompter — records the exact options + header it was handed, and
 *  answers with the FIRST option's label so we can prove the value is the
 *  label (not the whole struct). */
const capturingPrompter = (): {
  prompter: ElicitationPrompter
  enumSeen: { options: readonly EnumOption[]; header?: string } | null
  multiSeen: { options: readonly EnumOption[]; header?: string } | null
} => {
  const box: {
    enumSeen: { options: readonly EnumOption[]; header?: string } | null
    multiSeen: { options: readonly EnumOption[]; header?: string } | null
  } = { enumSeen: null, multiSeen: null }
  const labelOf = (o: EnumOption): string => (typeof o === "string" ? o : o.label)
  const ok = <T>(value: T): Promise<ElicitationResult<T>> => Promise.resolve({ ok: true, value })
  const prompter: ElicitationPrompter = {
    promptString: (r) => ok(`s:${r.prompt}`),
    promptNumber: () => ok(1),
    promptInteger: () => ok(1),
    promptBoolean: () => ok(true),
    promptEnum: (r) => {
      box.enumSeen = { options: r.options, ...(r.header !== undefined ? { header: r.header } : {}) }
      return ok(labelOf(r.options[0] as EnumOption))
    },
    promptMultiEnum: (r) => {
      box.multiSeen = {
        options: r.options,
        ...(r.header !== undefined ? { header: r.header } : {}),
      }
      return ok([labelOf(r.options[0] as EnumOption)])
    },
    promptSingleEnum: () => ok("x"),
    promptUrl: (r) => ok(r.url),
  }
  return {
    prompter,
    get enumSeen() {
      return box.enumSeen
    },
    get multiSeen() {
      return box.multiSeen
    },
  }
}

describe("ask_user structured options — survive tool→port→prompter", () => {
  test("STRUCT-SURVIVES: {label,description,preview} + header reach promptEnum intact", async () => {
    const cap = capturingPrompter()
    const tool = askUserTool(askUserPortFromPrompter(cap.prompter))
    const r = await resultOf(
      tool.execute(
        {
          kind: "select",
          prompt: "which backend?",
          header: "Backend",
          options: [
            { label: "Postgres", description: "durable relational", preview: "db/pg.ts" },
            { label: "SQLite", description: "embedded" },
          ],
        },
        ctx(),
      ),
    )
    expect(r.ok).toBe(true)
    // The prompter saw the STRUCTURED options — description AND preview survived.
    const seen = cap.enumSeen
    expect(seen).not.toBeNull()
    const first = seen?.options[0]
    expect(typeof first).toBe("object")
    expect(first).toEqual({
      label: "Postgres",
      description: "durable relational",
      preview: "db/pg.ts",
    })
    // The chip header threaded end-to-end.
    expect(seen?.header).toBe("Backend")
    // VALUE-IS-LABEL: the answer is the label, not the struct.
    expect(r.output).toContain("Postgres")
  })

  test("MULTISELECT: structured options survive on the multi path", async () => {
    const cap = capturingPrompter()
    const tool = askUserTool(askUserPortFromPrompter(cap.prompter))
    const r = await resultOf(
      tool.execute(
        {
          kind: "multiselect",
          prompt: "which features?",
          header: "Feats",
          options: [
            { label: "auth", description: "login" },
            { label: "billing", preview: "billing/index.ts" },
          ],
        },
        ctx(),
      ),
    )
    expect(r.ok).toBe(true)
    const seen = cap.multiSeen
    expect(seen?.options[0]).toEqual({ label: "auth", description: "login" })
    expect(seen?.options[1]).toEqual({ label: "billing", preview: "billing/index.ts" })
    expect(seen?.header).toBe("Feats")
  })

  test("BACK-COMPAT (paired control): bare-string select stays bare strings", async () => {
    const cap = capturingPrompter()
    const tool = askUserTool(askUserPortFromPrompter(cap.prompter))
    const r = await resultOf(
      tool.execute({ kind: "select", prompt: "pick", options: ["a", "b"] }, ctx()),
    )
    expect(r.ok).toBe(true)
    // Byte-identical to pre-widening: the options are plain strings, no header.
    expect(cap.enumSeen?.options).toEqual(["a", "b"])
    expect(cap.enumSeen?.header).toBeUndefined()
    expect(r.output).toContain("a")
  })
})

/** Scripted IO for the REAL `cliPrompter` — writes accumulate; reads pop from a
 *  fixed answer script. Mirrors the auto-Other hellgate's helper so we exercise
 *  the SAME menu-render + answer-match path a live user hits. */
const scriptedIo = (answers: string[]): { io: CliPrompterIO; written: () => string } => {
  const out: string[] = []
  const script = [...answers]
  return {
    io: {
      write: (s) => {
        out.push(s)
      },
      read: () => Promise.resolve(script.shift() ?? null),
    },
    written: () => out.join(""),
  }
}

/**
 * SUPPLEMENT (adversarial-audit jul-03): the fake capturing prompter above proves
 * the structured shape THREADS to the prompter, but it never exercises the REAL
 * `cliPrompter`'s menu render (`renderOption`) or answer resolution (`matchEnum` /
 * `enumOptionLabel`). Two live-prompter regressions ship green against the fake:
 *   - dropping `description`/`preview` from the rendered menu (user never sees the
 *     affordance);
 *   - returning the whole struct blob (or JSON) instead of the LABEL on an index
 *     pick.
 * These pins drive the real prompter to red-on-injection both.
 */
describe("ask_user structured options — REAL cliPrompter render + label-return", () => {
  test("RENDER: description AND preview appear in the live menu", async () => {
    const { io, written } = scriptedIo(["1"])
    const p = cliPrompter(io)
    const r = await p.promptEnum({
      prompt: "which backend?",
      options: [
        { label: "Postgres", description: "durable relational", preview: "db/pg.ts" },
        { label: "SQLite", description: "embedded" },
      ],
    })
    expect(r.ok).toBe(true)
    const menu = written()
    // The display-only affordances MUST reach the user (renderOption drop ⇒ red).
    expect(menu).toContain("durable relational")
    expect(menu).toContain("db/pg.ts")
    expect(menu).toContain("Postgres")
  })

  test("VALUE-IS-LABEL (index pick): returns the LABEL, never the struct/blob", async () => {
    const { io } = scriptedIo(["1"]) // pick option 1 by index
    const p = cliPrompter(io)
    const r = await p.promptEnum({
      prompt: "which backend?",
      options: [
        { label: "Postgres", description: "durable relational", preview: "db/pg.ts" },
        { label: "SQLite", description: "embedded" },
      ],
    })
    expect(r.ok).toBe(true)
    // A matchEnum that returned JSON.stringify(o) or o.description would fail here.
    if (r.ok) {
      expect(r.value).toBe("Postgres")
      expect(r.value).not.toContain("durable relational")
      expect(r.value).not.toContain("{")
    }
  })

  test("VALUE-IS-LABEL (label text pick): typing the label resolves to the label", async () => {
    const { io } = scriptedIo(["SQLite"]) // pick by literal label text
    const p = cliPrompter(io)
    const r = await p.promptEnum({
      prompt: "which backend?",
      options: [
        { label: "Postgres", description: "durable relational" },
        { label: "SQLite", description: "embedded" },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("SQLite")
  })

  test("DESCRIPTION/PREVIEW never match as an answer (only the label is pickable)", async () => {
    // Typing the description text must NOT resolve — the base retries then fails.
    const { io } = scriptedIo(["durable relational", "durable relational"])
    const p = cliPrompter(io)
    const r = await p.promptEnum({
      prompt: "which backend?",
      options: [{ label: "Postgres", description: "durable relational" }],
    })
    // Two failed attempts ⇒ withRetry surfaces a non-ok result (never a match).
    expect(r.ok).toBe(false)
  })
})
