// A3 Projects knowledge-base — leaf tool hellgate.
//
// The whole value prop: a written doc's RAW CONTENTS never enter the model
// context (tool ToolResult.output / structured), yet project_search returns a
// hit carrying a doc_uuid the model can act on. This suite pins:
//   - store determinism (injected clock + id-factory, oldest-evicted ring)
//   - the RED-ON-INJECTION sentinel test: a unique token written via
//     project_write is ABSENT from every tool output/structured AND from any
//     model-facing message on EVERY op + EVERY error branch, but search still
//     returns a hit with the doc_uuid.
//   - knowledge{} byte-budget accounting (rag_active flips on a real byte
//     threshold, `force` bypasses — no guessed cutoff).
//   - NO-THROW: a thrown port collapses to ok:false, and its message never
//     echoes the doc text.
//   - default-OFF byte-identity over buildDefaultTools().

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SearchHit, SearchPipeline, SearchQuery } from "@/retrieval/pipeline"
import { buildDefaultTools } from "@/tool/index"
import {
  createProjectsKbStore,
  DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES,
  projectsKbTool,
  renderKnowledge,
} from "@/tool/projects-kb"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// A unique token that must NEVER surface to the model.
const SENTINEL = "ZZ_SECRET_SENTINEL_9c3f1a7b_NEVER_LEAK"

const ctx = (cwd: string): ToolContext =>
  ({ cwd, signal: new AbortController().signal }) as unknown as ToolContext

const runTool = async (
  tool: ReturnType<typeof projectsKbTool>,
  input: Parameters<typeof tool.execute>[0],
  cwd = "/repo",
): Promise<ToolResult> => {
  let last: ToolResult = { ok: false, output: "(no result)" }
  for await (const ev of tool.execute(input, ctx(cwd)) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  return last
}

/** Serialize the WHOLE result (output + structured + failure) into one string
 *  — this is the entire surface that reaches the model context. */
const fullModelSurface = (r: ToolResult): string => JSON.stringify(r)

const writeFixture = (contents: string): { cwd: string; name: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "pkb-"))
  const name = "doc.txt"
  writeFileSync(join(cwd, name), contents)
  return { cwd, name }
}

describe("projects-kb — store (deterministic)", () => {
  test("index mints monotonic doc_uuid with injected id-factory + clock; oldest-evicted ring", () => {
    let t = 1000
    const store = createProjectsKbStore({
      now: () => t,
      idFactory: (s) => `pk-${s}`,
      maxDocs: 2,
    })
    const a = store.index("a.txt", new TextEncoder().encode("alpha"))
    t = 2000
    const b = store.index("b.txt", new TextEncoder().encode("beta"))
    expect(a).toMatchObject({ docUuid: "pk-0", bytes: 5, indexedAt: 1000 })
    expect(b).toMatchObject({ docUuid: "pk-1", bytes: 4, indexedAt: 2000 })
    // ring evicts the oldest
    store.index("c.txt", new TextEncoder().encode("gamma"))
    expect(store.get("pk-0")).toBeUndefined()
    expect(store.get("pk-2")?.name).toBe("c.txt")
    expect(store.size()).toBe(2)
  })

  test("knowledge{} accounts REAL indexed byte-count; rag_active flips at the byte threshold; force bypasses", () => {
    const store = createProjectsKbStore({
      idFactory: (s) => `pk-${s}`,
      ragThresholdBytes: 10,
      maxKnowledgeBytes: 1000,
    })
    let k = store.knowledge(false)
    expect(k.knowledge_size).toBe(0)
    expect(k.max_knowledge_size).toBe(1000)
    expect(k.search_threshold).toBe(10)
    expect(k.rag_active).toBe(false)
    expect(k.remaining_budget).toBe(1000)

    store.index("a", new TextEncoder().encode("1234")) // 4 bytes < 10
    k = store.knowledge(false)
    expect(k.knowledge_size).toBe(4)
    expect(k.rag_active).toBe(false)

    store.index("b", new TextEncoder().encode("567890X")) // +7 = 11 >= 10
    k = store.knowledge(false)
    expect(k.knowledge_size).toBe(11)
    expect(k.rag_active).toBe(true)
    expect(k.remaining_budget).toBe(989)

    // force bypasses the threshold gate: rag stays OFF even over the threshold
    expect(store.knowledge(true).rag_active).toBe(false)
  })

  test("the default rag threshold is a NAMED measure-first knob default (not an inline magic cutoff)", () => {
    // The store's default MUST come from the exported knob default — proving the
    // cutoff is a documented, measure-first, overridable default rather than a
    // guessed literal buried in the store.
    expect(typeof DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES).toBe("number")
    const store = createProjectsKbStore({})
    expect(store.knowledge(false).search_threshold).toBe(DEFAULT_PROJECTS_KB_RAG_THRESHOLD_BYTES)
  })

  test("renderKnowledge is the shared, body-FREE report/status serializer", () => {
    const store = createProjectsKbStore({ ragThresholdBytes: 10, maxKnowledgeBytes: 1000 })
    store.index("secret.txt", new TextEncoder().encode(SENTINEL))
    const line = renderKnowledge(store.knowledge(false))
    // carries the real byte counters …
    expect(line).toMatch(/knowledge_size=/)
    expect(line).toMatch(/rag_active=/)
    // … and NEVER a doc name or body (co-located status line cannot leak KB content)
    expect(line).not.toContain(SENTINEL)
    expect(line).not.toContain("secret.txt")
  })

  // HELLGATE (store-level): the lexical fallback's WHOLE danger is a snippet
  // centered on the matched needle — that is the branch that would leak
  // whatever bytes surround the match. Query a token that sits DIRECTLY
  // adjacent to the sentinel so any snippet-window mutation surfaces it, and
  // pin that NO hit.text carries even a fragment of the body. This is the
  // gating test for the "body-FREE match indicator" invariant the store
  // documents; the prior suite only queried the tool with a token whose window
  // did NOT fully cover the sentinel, so a snippet-leak mutation stayed green.
  test("searchLexical returns a body-FREE match indicator even when the query abuts the sentinel", () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    // Query token "MARKER" sits immediately before the sentinel: any snippet
    // that slices around the match would drag the sentinel into `text`.
    store.index("adj.txt", new TextEncoder().encode(`lead MARKER${SENTINEL}MARKER tail`))
    const hits = store.searchLexical("marker", 10)
    expect(hits.length).toBe(1)
    const hit = hits[0]
    if (hit === undefined) throw new Error("expected one hit")
    expect(hit.doc_uuid).toBe("pk-0")
    // the indicator carries the doc_uuid + a body-FREE match count, NEVER bytes
    expect(hit.text).not.toContain(SENTINEL)
    // and it must not echo the raw QUERY-match region either (belt & braces):
    // the whole serialized hit is body-free.
    expect(JSON.stringify(hit)).not.toContain(SENTINEL)
    // the indicator IS the FIXED body-free format (proves it matched, and that
    // a snippet-leak mutation slicing body bytes into `text` cannot pass).
    expect(hit.text).toMatch(/^match \(\d+× in \d+B\)$/)
  })

  test("searchLexical never surfaces the body when the QUERY IS a token whose match window spans the sentinel", () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    // Two occurrences of the query bracket the sentinel — a match-centered
    // snippet between them would leak the entire secret span.
    store.index(
      "span.txt",
      new TextEncoder().encode(`start NEEDLE ${SENTINEL} NEEDLE end`),
    )
    const hits = store.searchLexical("needle", 10)
    expect(hits.length).toBe(1)
    const hit = hits[0]
    if (hit === undefined) throw new Error("expected one hit")
    expect(JSON.stringify(hits)).not.toContain(SENTINEL)
    // Tight gate: the indicator is the FIXED body-free format — a snippet-leak
    // mutation (which would slice body bytes into `text`) breaks this even when
    // its truncated window does not happen to contain the full sentinel string.
    expect(hit.text).toMatch(/^match \(\d+× in \d+B\)$/)
  })
})

describe("projects-kb — tool: raw contents NEVER enter model context (red-on-injection)", () => {
  test("project_write returns ONLY metadata (doc_uuid + bytes); the sentinel is absent from output+structured", async () => {
    const { cwd, name } = writeFixture(`preamble ${SENTINEL} trailer`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    const res = await runTool(tool, { op: "project_write", local_path: name }, cwd)
    expect(res.ok).toBe(true)
    // metadata IS present
    expect(fullModelSurface(res)).toContain("pk-0")
    expect(res.output).toMatch(/bytes/i)
    // the raw contents are NOT present anywhere the model sees
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("project_search returns a hit with doc_uuid WITHOUT leaking the sentinel body", async () => {
    const { cwd, name } = writeFixture(`the answer includes ${SENTINEL} here`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    // a query that matches on a NON-sentinel token so the search itself does not
    // require the model to know the secret.
    const res = await runTool(tool, { op: "project_search", query: "answer" }, cwd)
    expect(res.ok).toBe(true)
    // a hit references the doc by uuid …
    expect(fullModelSurface(res)).toContain("pk-0")
    // … but the raw sentinel body never leaks into the search result surface.
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("project_read returns metadata only — the doc BODY (sentinel) never enters context", async () => {
    const { cwd, name } = writeFixture(`body ${SENTINEL}`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const res = await runTool(tool, { op: "project_read", doc_uuid: "pk-0" }, cwd)
    expect(res.ok).toBe(true)
    expect(fullModelSurface(res)).toContain("pk-0")
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("project_info surfaces knowledge{} accounting without any doc body", async () => {
    const { cwd, name } = writeFixture(`info ${SENTINEL}`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const res = await runTool(tool, { op: "project_info" }, cwd)
    expect(res.ok).toBe(true)
    expect(fullModelSurface(res)).toMatch(/knowledge_size/)
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("EVERY error branch is leak-proof: a thrown index port collapses to ok:false and NEVER echoes the doc text", async () => {
    const { cwd, name } = writeFixture(`explosive ${SENTINEL} payload`)
    // A KB backend port that throws WITH the doc text embedded in its message —
    // the tool must NOT propagate that message verbatim into model context.
    const store = createProjectsKbStore({
      idFactory: (s) => `pk-${s}`,
      port: {
        indexDoc: (_name, bytes) => {
          throw new Error(`backend blew up on: ${new TextDecoder().decode(bytes)}`)
        },
      },
    })
    const tool = projectsKbTool({ store })
    const res = await runTool(tool, { op: "project_write", local_path: name }, cwd)
    expect(res.ok).toBe(false)
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("project_read of a missing doc_uuid is a leak-proof ok:false (error message carries no body)", async () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    const res = await runTool(tool, { op: "project_read", doc_uuid: "does-not-exist" }, "/repo")
    expect(res.ok).toBe(false)
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("project_write of a jail-escaping local_path is a typed ok:false (no throw past the loop)", async () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    const res = await runTool(
      tool,
      { op: "project_write", local_path: "../../etc/passwd" },
      "/repo",
    )
    expect(res.ok).toBe(false)
  })

  test("project_write of an ABSOLUTE local_path is jailed to a typed ok:false (audit item 5)", async () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    // An absolute path outside the jail root must be refused — resolve() keeps
    // the absolute path, enforceJail rejects it. No throw escapes the loop and
    // nothing was indexed.
    const res = await runTool(tool, { op: "project_write", local_path: "/etc/passwd" }, "/repo")
    expect(res.ok).toBe(false)
    expect(store.size()).toBe(0)
  })

  test("project_write of a NUL-byte local_path is a typed ok:false (path-truncation guard)", async () => {
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    const res = await runTool(tool, { op: "project_write", local_path: "ok.txt\0evil" }, "/repo")
    expect(res.ok).toBe(false)
    expect(store.size()).toBe(0)
  })

  // HELLGATE (tool-level lexical fallback): the tool with NO pipeline falls back
  // to searchLexical; a snippet-leak there would surface the sentinel through
  // ToolResult.output/structured. Query a token abutting the sentinel so the
  // leak window covers the FULL secret; assert absent from the model surface.
  test("project_search lexical fallback never leaks the body when the query abuts the sentinel", async () => {
    const { cwd, name } = writeFixture(`prefix MARK${SENTINEL}MARK suffix`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store }) // NO pipeline ⇒ lexical fallback
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const res = await runTool(tool, { op: "project_search", query: "mark" }, cwd)
    expect(res.ok).toBe(true)
    // a hit references the doc by uuid …
    expect(fullModelSurface(res)).toContain("pk-0")
    // … but the full sentinel body never reaches the model surface.
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
    // Tight gate on the structured hit text: the FIXED body-free indicator —
    // a snippet-leak mutation slicing body bytes into the hit breaks this even
    // when the truncated window omits the full sentinel token.
    const hits = (res.structured as { hits?: { text?: string }[] } | undefined)?.hits ?? []
    expect(hits.length).toBe(1)
    expect(hits[0]?.text).toMatch(/^match \(\d+× in \d+B\)$/)
  })

  test("project_delete removes a doc; subsequent read is ok:false", async () => {
    const { cwd, name } = writeFixture(`del ${SENTINEL}`)
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const del = await runTool(tool, { op: "project_delete", doc_uuid: "pk-0" }, cwd)
    expect(del.ok).toBe(true)
    expect(store.get("pk-0")).toBeUndefined()
    const read = await runTool(tool, { op: "project_read", doc_uuid: "pk-0" }, cwd)
    expect(read.ok).toBe(false)
    expect(fullModelSurface(read)).not.toContain(SENTINEL)
  })
})

describe("projects-kb — project_search delegates to the injected SearchPipeline seam", () => {
  test("hits map SearchHit -> {name, doc_uuid, text} scoped to the KB namespace", async () => {
    const { cwd, name } = writeFixture(`pipeline body ${SENTINEL}`)
    const seen: SearchQuery[] = []
    const pipeline: SearchPipeline = {
      async search(q: SearchQuery) {
        seen.push(q)
        const hits: SearchHit[] = [
          {
            id: "pk-0",
            score: 0.9,
            text: "PUBLIC snippet the pipeline chose to surface",
            source: "semantic",
            metadata: { name: "doc.txt", docUuid: "pk-0" },
          },
        ]
        return { ok: true, value: hits }
      },
    }
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store, pipeline })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const res = await runTool(tool, { op: "project_search", query: "pipeline" }, cwd)
    expect(res.ok).toBe(true)
    // the pipeline was actually invoked (delegation, not a fork)
    expect(seen.length).toBe(1)
    expect(seen[0]?.text).toBe("pipeline")
    // hit references the doc_uuid
    expect(fullModelSurface(res)).toContain("pk-0")
    // and never leaks the on-disk sentinel body
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })

  test("a thrown pipeline collapses to a leak-proof ok:false (fail-soft, NO-THROW)", async () => {
    const { cwd, name } = writeFixture(`x ${SENTINEL}`)
    const pipeline: SearchPipeline = {
      async search() {
        throw new Error("pipeline exploded")
      },
    }
    const store = createProjectsKbStore({ idFactory: (s) => `pk-${s}` })
    const tool = projectsKbTool({ store, pipeline })
    await runTool(tool, { op: "project_write", local_path: name }, cwd)
    const res = await runTool(tool, { op: "project_search", query: "x" }, cwd)
    expect(res.ok).toBe(false)
    expect(fullModelSurface(res)).not.toContain(SENTINEL)
  })
})

describe("projects-kb — default-OFF byte-identity", () => {
  test("projects_kb is NOT in the default tool set (gate unset ⇒ tool absent)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("projects_kb")
  })

  test("projects_kb IS registered when the port is wired", () => {
    const store = createProjectsKbStore({})
    const names = buildDefaultTools({ projectsKb: { store } }).map((t) => t.name)
    expect(names).toContain("projects_kb")
  })

  // Drift guard BOTH directions: wiring the slot must append EXACTLY the one
  // projects_kb tool and perturb NOTHING else — the unwired menu is the wired
  // menu minus projects_kb, in the same order. Catches an accidental reorder /
  // duplicate / drop of any other tool when the A3 slot is present.
  test("wiring the slot appends EXACTLY projects_kb and leaves the rest of the menu byte-identical", () => {
    const store = createProjectsKbStore({})
    const off = buildDefaultTools().map((t) => t.name)
    const on = buildDefaultTools({ projectsKb: { store } }).map((t) => t.name)
    // exactly one net-new tool
    expect(on.length).toBe(off.length + 1)
    expect(on.filter((n) => n === "projects_kb").length).toBe(1)
    // the OFF menu is the ON menu with projects_kb removed — order preserved
    expect(on.filter((n) => n !== "projects_kb")).toEqual(off)
    // and the OFF menu never contained it (no leak into BASE)
    expect(off).not.toContain("projects_kb")
  })
})
