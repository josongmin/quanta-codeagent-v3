/**
 * `/memory` slash command tests.
 *
 * Test seam: the command depends ONLY on the injected
 * `SlashContext.memory.{store, embedder?, env?}` shape. We seed a fresh
 * `InMemoryStore` per test and drive `runSlashCommand("/memory …", ctx)`.
 * No `process.env` mutation is needed — env knobs flow through `state.env`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isMemorySlashEnabled,
  type MemorySlashState,
  memoryCmd,
} from "../../src/apps/cli/memory-cmd"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import { EMBED_DIM, type EmbedderPort, InMemoryStore, type MemoryEntry } from "../../src/memory"

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (cwd: string, memory?: MemorySlashState): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        captured.out += s
      },
      err: (s) => {
        captured.err += s
      },
      cwd,
      ...(memory !== undefined ? { memory } : {}),
    },
  }
  return captured
}

const seedEntry = (
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "text">,
): MemoryEntry => ({
  kind: "observation",
  tags: [],
  tier: "semantic",
  importance: 0.5,
  createdAt: 1700000000000,
  ...overrides,
})

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mem-cmd-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* env gate                                                            */
/* ------------------------------------------------------------------ */

describe("isMemorySlashEnabled", () => {
  test("default ON (env source empty / undefined var)", () => {
    expect(isMemorySlashEnabled({})).toBe(true)
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: undefined })).toBe(true)
  })

  test("explicit '0' / 'off' / 'false' / 'no' ⇒ OFF", () => {
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "0" })).toBe(false)
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "off" })).toBe(false)
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "FALSE" })).toBe(false)
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "no" })).toBe(false)
  })

  test("any other non-falsy value ⇒ ON", () => {
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "1" })).toBe(true)
    expect(isMemorySlashEnabled({ QUANTA_MEMORY_SLASH: "yes" })).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

describe("/memory: surface wiring", () => {
  test("ctx.memory absent ⇒ 'not wired' + exit 0 (default-OFF parity)", async () => {
    const cap = buildCtx(tmp)
    const code = await runSlashCommand("/memory", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
    expect(cap.err).toBe("")
  })

  test("memoryCmd metadata: name + category", () => {
    expect(memoryCmd.name).toBe("/memory")
    expect(memoryCmd.category).toBe("session")
  })
})

/* ------------------------------------------------------------------ */
/* /memory (recent)                                                    */
/* ------------------------------------------------------------------ */

describe("/memory (no args ⇒ recent)", () => {
  test("empty store: 0-of-0 + (no entries) hint", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Recent memories (0 of 0)")
    expect(cap.out).toContain("(no entries)")
  })

  test("12 entries, recent shows top 10 by createdAt desc", async () => {
    const seeds: MemoryEntry[] = []
    for (let i = 0; i < 12; i += 1) {
      seeds.push(
        seedEntry({
          id: `m${i.toString().padStart(3, "0")}`,
          text: `entry ${i}`,
          createdAt: 1700000000000 + i * 1000,
        }),
      )
    }
    const store = new InMemoryStore(seeds)
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Recent memories (10 of 12)")
    // newest (m011) is in, oldest (m000) is OUT of top-10
    expect(cap.out).toContain("m011")
    expect(cap.out).not.toContain("m000")
  })
})

/* ------------------------------------------------------------------ */
/* /memory list                                                        */
/* ------------------------------------------------------------------ */

describe("/memory list", () => {
  test("list with no filter shows all (≤ cap)", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "a1", text: "alpha", createdAt: 1700000000001 }),
      seedEntry({ id: "b2", text: "beta", createdAt: 1700000000002 }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory list", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Memories (2 of 2)")
    expect(cap.out).toContain("alpha")
    expect(cap.out).toContain("beta")
  })

  test("--tier=episodic filters", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "ep1", text: "episodic-1", tier: "episodic", createdAt: 1700000000001 }),
      seedEntry({ id: "se1", text: "semantic-1", tier: "semantic", createdAt: 1700000000002 }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory list --tier=episodic", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("tier=episodic")
    expect(cap.out).toContain("episodic-1")
    expect(cap.out).not.toContain("semantic-1")
  })

  test("QUANTA_MEMORY_LIST_MAX caps the page size", async () => {
    const seeds: MemoryEntry[] = []
    for (let i = 0; i < 8; i += 1) {
      seeds.push(seedEntry({ id: `m${i}`, text: `e${i}`, createdAt: 1700000000000 + i }))
    }
    const store = new InMemoryStore(seeds)
    const cap = buildCtx(tmp, { store, env: { QUANTA_MEMORY_LIST_MAX: "3" } })
    const code = await runSlashCommand("/memory list", cap.ctx)
    expect(code).toBe(0)
    // shown=3 of 8 total
    expect(cap.out).toContain("(3 of 8)")
  })

  test("invalid --tier ⇒ exit 1 + error to stderr", async () => {
    const store = new InMemoryStore([seedEntry({ id: "x", text: "x" })])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory list --tier=bogus", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("invalid --tier")
  })
})

/* ------------------------------------------------------------------ */
/* /memory search                                                      */
/* ------------------------------------------------------------------ */

describe("/memory search", () => {
  test("missing query ⇒ exit 1", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory search", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("expected a query string")
  })

  test("lexical recall finds substring hits (no embedder)", async () => {
    const store = new InMemoryStore([
      seedEntry({
        id: "gp1",
        text: "prefer git diff --no-ext-diff for determinism",
        tags: ["git"],
      }),
      seedEntry({ id: "fz2", text: "fuzzy matching with ripgrep", tags: ["search"] }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory search git", cap.ctx)
    expect(code).toBe(0)
    // "git" matches both via lexical scoring, but the determinism entry mentions it more directly
    expect(cap.out).toContain("gp1")
    expect(cap.out).toContain('Search "git"')
  })

  test("embedder throw ⇒ graceful lexical fallback (no crash)", async () => {
    const store = new InMemoryStore([seedEntry({ id: "x1", text: "memory entry alpha" })])
    const failingEmbedder: EmbedderPort = {
      embed: () => Promise.reject(new Error("network down")),
    }
    const cap = buildCtx(tmp, { store, embedder: failingEmbedder, env: {} })
    const code = await runSlashCommand("/memory search alpha", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("x1")
  })

  test("embedder happy path: vector passed into recall (no crash)", async () => {
    const vec = new Array(EMBED_DIM).fill(0) as number[]
    vec[0] = 1
    const happy: EmbedderPort = {
      embed: () => Promise.resolve([vec]),
    }
    const store = new InMemoryStore([seedEntry({ id: "v1", text: "vector lookup target" })])
    const cap = buildCtx(tmp, { store, embedder: happy, env: {} })
    const code = await runSlashCommand("/memory search target", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("v1")
  })
})

/* ------------------------------------------------------------------ */
/* /memory show                                                        */
/* ------------------------------------------------------------------ */

describe("/memory show", () => {
  test("by full id renders all sections", async () => {
    const store = new InMemoryStore([
      seedEntry({
        id: "dist-0042",
        text: "prefer git diff --no-ext-diff for env determinism\nwhen bench harness captures git output",
        tags: ["git", "env", "determinism"],
        importance: 0.92,
        createdAt: Date.UTC(2026, 4, 20, 14, 23),
      }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory show dist-0042", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("dist-0042")
    expect(cap.out).toContain("Tier:")
    expect(cap.out).toContain("Score:    0.92")
    expect(cap.out).toContain("Content")
    expect(cap.out).toContain("Tags")
    expect(cap.out).toContain("git, env, determinism")
  })

  test("by id-prefix when unique", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "abc12345", text: "alpha" }),
      seedEntry({ id: "xyz98765", text: "omega" }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory show abc", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("abc12345")
    expect(cap.out).toContain("alpha")
  })

  test("ambiguous id-prefix ⇒ exit 1", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "abc1", text: "one" }),
      seedEntry({ id: "abc2", text: "two" }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory show abc", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("ambiguous")
  })

  test("unknown id ⇒ exit 1", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory show nope", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("no entry matches")
  })
})

/* ------------------------------------------------------------------ */
/* /memory delete                                                      */
/* ------------------------------------------------------------------ */

describe("/memory delete", () => {
  test("without --yes ⇒ preview + does NOT delete", async () => {
    const store = new InMemoryStore([seedEntry({ id: "delme", text: "to be deleted" })])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory delete delme", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("would delete")
    expect(cap.out).toContain("re-run with --yes")
    // still in store
    expect(await store.get("delme")).toBeDefined()
  })

  test("with --yes ⇒ actually deletes", async () => {
    const store = new InMemoryStore([seedEntry({ id: "delme", text: "bye" })])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory delete delme --yes", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("removed delme")
    expect(await store.get("delme")).toBeUndefined()
  })

  test("missing id arg ⇒ exit 1", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory delete", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("expected an id")
  })

  test("ambiguous prefix ⇒ exit 1 + nothing deleted", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "amb1", text: "one" }),
      seedEntry({ id: "amb2", text: "two" }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory delete amb --yes", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("ambiguous")
    expect(await store.get("amb1")).toBeDefined()
    expect(await store.get("amb2")).toBeDefined()
  })
})

/* ------------------------------------------------------------------ */
/* /memory stats                                                       */
/* ------------------------------------------------------------------ */

describe("/memory stats", () => {
  test("counts per tier + content bytes", async () => {
    const store = new InMemoryStore([
      seedEntry({ id: "ep1", text: "abc", tier: "episodic" }),
      seedEntry({ id: "se1", text: "wxyz", tier: "semantic" }),
      seedEntry({ id: "se2", text: "lm", tier: "semantic" }),
    ])
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory stats", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Total:      3 entries")
    // 3 + 4 + 2 = 9 bytes
    expect(cap.out).toContain("Total size: 9 bytes")
    // shape-stable per-tier rows (always emits both defined tiers)
    expect(cap.out).toContain("episodic")
    expect(cap.out).toContain("semantic")
  })
})

/* ------------------------------------------------------------------ */
/* /memory --help / unknown sub                                        */
/* ------------------------------------------------------------------ */

describe("/memory help + unknown sub", () => {
  test("--help prints subcommand inventory", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory --help", cap.ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("/memory list")
    expect(cap.out).toContain("/memory search")
    expect(cap.out).toContain("/memory delete")
    expect(cap.out).toContain("/memory stats")
  })

  test("unknown sub ⇒ exit 1 + help", async () => {
    const store = new InMemoryStore()
    const cap = buildCtx(tmp, { store, env: {} })
    const code = await runSlashCommand("/memory wat", cap.ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("unknown subcommand")
  })
})
