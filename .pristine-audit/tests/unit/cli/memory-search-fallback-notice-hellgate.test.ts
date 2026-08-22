/**
 * WS-G item 3 (UUX-5-10) — `/memory search` silently fell back to LEXICAL
 * ranking when the embedder threw (offline / quota): the operator saw ranked
 * results with no hint that semantic recall was off. Fix: one warn notice on
 * the operator-notice bus at the fallback catch.
 *
 * Red-on-injection: a throwing embedder must still return exit 0 (fallback
 * preserved — never fail the slash) AND emit exactly one warn notice. Paired
 * control: a healthy embedder emits nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import { memoryCmd } from "../../../src/apps/cli/memory-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import { EMBED_DIM, type EmbedderPort, InMemoryStore } from "../../../src/memory"

let tmp: string
const notices: OperatorNotice[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mem-fallback-"))
  installOperatorNoticeSink((n) => notices.push(n))
})

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  notices.length = 0
  rmSync(tmp, { recursive: true, force: true })
})

const buildCtx = (embedder: EmbedderPort): { ctx: SlashContext; err: () => string } => {
  let err = ""
  const store = new InMemoryStore()
  const ctx: SlashContext = {
    out: () => {},
    err: (s: string) => {
      err += s
    },
    cwd: tmp,
    memory: { store, embedder },
  } as unknown as SlashContext
  return { ctx, err: () => err }
}

describe("/memory search lexical-fallback notice (UUX-5-10)", () => {
  test("throwing embedder ⇒ exit 0 (fallback kept) + one warn notice", async () => {
    const { ctx } = buildCtx({
      embed: async () => {
        throw new Error("quota exceeded")
      },
    })
    const code = await memoryCmd.run(["search", "hello"], ctx)
    expect(code).toBe(0)
    const warns = notices.filter((n) => n.source === "/memory")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe("warn")
    expect(warns[0]?.message).toContain("semantic search unavailable")
    expect(warns[0]?.message).toContain("lexical")
  })

  test("paired control: healthy embedder emits NO notice", async () => {
    const { ctx } = buildCtx({
      embed: async (texts) => texts.map(() => new Array(EMBED_DIM).fill(0.1)),
    })
    const code = await memoryCmd.run(["search", "hello"], ctx)
    expect(code).toBe(0)
    expect(notices).toHaveLength(0)
  })
})
