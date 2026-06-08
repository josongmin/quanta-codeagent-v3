/**
 * §10.3 e2e hellgate — drive @folder + @git through the REAL production
 * mention pipeline end-to-end:
 *
 *   user text → parseMentions → buildDefaultMentionResolver (the composite
 *   root the CLI / unified-agent wire) → buildInjectionFragments →
 *   buildMentionInjectionMessages → the actual <mention> envelope.
 *
 * This is not a unit shape test — it exercises the SAME builder the surfaces
 * call, with real fs (folder) + an injected git provider, and asserts the
 * model-visible envelope carries the folder listing + git body.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  buildInjectionFragments,
  buildMentionInjectionMessages,
  parseMentions,
} from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"

const root = mkdtempSync(join(tmpdir(), "mention-fg-e2e-"))
mkdirSync(join(root, "lib"))
writeFileSync(join(root, "lib", "z.ts"), "z")
writeFileSync(join(root, "lib", "a.ts"), "a")

const gitProvider = async (sub: "status" | "diff" | "log"): Promise<string | null> => {
  if (sub === "status") return "M lib/a.ts\n?? scratch.txt"
  return null
}

const runPipeline = async (text: string, env: Record<string, string | undefined>) => {
  const mentions = parseMentions(text)
  const resolver = buildDefaultMentionResolver({ cwd: root, env, git: gitProvider })
  const frags = await buildInjectionFragments(mentions, resolver)
  const messages = buildMentionInjectionMessages(frags)
  return { mentions, frags, messages }
}

describe("§10.3 e2e — @folder + @git through buildDefaultMentionResolver", () => {
  test("@folder resolves to a real directory listing in the envelope", async () => {
    const { mentions, frags, messages } = await runPipeline("look in @lib/ please", {})
    expect(mentions.map((m) => m.kind)).toEqual(["folder"])
    expect(frags).toHaveLength(1)
    expect(frags[0]?.bodyText).toBe(["a.ts", "z.ts"].join("\n"))
    const envelope = messages[0]?.content?.[0]
    const text = envelope && "text" in envelope ? envelope.text : ""
    expect(text).toContain("kind: folder")
    expect(text).toContain("<mention>")
    expect(text).toContain("a.ts")
  })

  test("@git resolves to the injected status body in the envelope", async () => {
    const { mentions, frags, messages } = await runPipeline("check @git", {})
    expect(mentions[0]?.kind).toBe("git")
    expect(mentions[0]?.target).toBe("status")
    expect(frags[0]?.bodyText).toContain("M lib/a.ts")
    const envelope = messages[0]?.content?.[0]
    const text = envelope && "text" in envelope ? envelope.text : ""
    expect(text).toContain("kind: git")
    expect(text).toContain("M lib/a.ts")
  })

  test("QUANTA_MENTION_FOLDER=off ⇒ @folder resolves to nothing (knob gate)", async () => {
    const { frags } = await runPipeline("look in @lib/", { QUANTA_MENTION_FOLDER: "off" })
    expect(frags).toEqual([])
  })

  test("QUANTA_MENTION_GIT=off ⇒ @git resolves to nothing (knob gate)", async () => {
    const { frags } = await runPipeline("check @git", { QUANTA_MENTION_GIT: "off" })
    expect(frags).toEqual([])
  })

  test("byte-identity: no git provider injected ⇒ @git skipped, no throw", async () => {
    const mentions = parseMentions("check @git")
    const resolver = buildDefaultMentionResolver({ cwd: root, env: {} }) // no git
    const frags = await buildInjectionFragments(mentions, resolver)
    expect(frags).toEqual([])
  })

  test("byte-identity: a text with NO folder/git mention is unaffected", async () => {
    const { mentions, frags } = await runPipeline("read @lib/a.ts now", {})
    // trailing-slash-free path stays a file; with file knob ON it reads the file
    expect(mentions[0]?.kind).toBe("file")
    expect(frags[0]?.bodyText).toBe("a")
  })
})
