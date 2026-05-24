/**
 * HELLGATE — V4A apply_patch `quanta.patch.*` OTel emission proofs.
 *
 * Activates 2 previously-zero-emit vocabulary keys (`quanta.patch.op`,
 * `quanta.patch.fuzzy_match_tier`) by wiring an in-memory {@link SpanSink}
 * around the `applyPatchTool` execute. Adversarial cases enforce:
 *
 *   1. Every declared op literal (`"add" | "update" | "delete" | "move"`)
 *      surfaces on `quanta.patch.op`.
 *   2. Both fuzzy tiers (`"exact" | "whitespace"`) — the only tiers the V4A
 *      applier currently produces — surface on `quanta.patch.fuzzy_match_tier`.
 *      The vocabulary's third literal (`"fuzzy"`) is RESERVED for a future
 *      broader matcher and is intentionally NOT exercised here.
 *   3. NO emitted attribute value contains patch text, hunk content, anchor
 *      strings, file paths, file content, or commit-style diff lines —
 *      counts + categorical labels only (security invariant).
 *   4. Absent sink ⇒ zero emission (default-OFF byte-identical apply).
 *
 * Source under test: src/patch/applier.ts (op + tier dispatch) +
 * src/tool/apply-patch.ts (`buildPatchObserver`) + src/observability/spans.ts
 * (`recordAttrs`).
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetSpanSink,
  type Attrs,
  QUANTA_ATTRS,
  type SpanName,
  type SpanStatus,
  setSpanSink,
} from "@/observability"
import { applyPatchTool } from "@/tool/apply-patch"
import type { ToolContext } from "@/tool/types"

interface CapturedEvent {
  phase: "start" | "end"
  name: SpanName
  attrs: Attrs
  status?: SpanStatus
  durationMs?: number
}

const installCapturingSink = (): CapturedEvent[] => {
  const events: CapturedEvent[] = []
  setSpanSink({
    onStart: (name, attrs) => {
      events.push({ phase: "start", name, attrs })
      return { kind: "test-token", at: events.length }
    },
    onEnd: (_token, name, status, durationMs, attrs) => {
      events.push({ phase: "end", name, attrs, status, durationMs })
    },
  })
  return events
}

const makeJailRoot = (): string => {
  // Create an absolute, real (resolved) jail root so the storage-jail's
  // realpath-based containment check sees the same prefix the tool resolves.
  // We use `mkdtempSync` so each test gets an isolated tree the cleanup hook
  // can blow away wholesale.
  return mkdtempSync(join(tmpdir(), "patch-otel-hellgate-"))
}

const runApplyPatch = async (jailRoot: string, patch: string): Promise<void> => {
  const ctx: ToolContext = {
    cwd: jailRoot,
    signal: new AbortController().signal,
  } as unknown as ToolContext
  for await (const event of applyPatchTool.execute({ patch }, ctx)) {
    // Drain the iterable so the apply actually runs. We don't assert on the
    // result event here — the per-op telemetry is what this hellgate proves.
    void event
  }
}

const eventsWithKey = (events: readonly CapturedEvent[], key: string): CapturedEvent[] =>
  events.filter((e) => Object.hasOwn(e.attrs, key))

const valuesOf = (events: readonly CapturedEvent[], key: string): string[] => {
  const out: string[] = []
  for (const e of events) {
    // The captured attrs are `Readonly<Partial<Record<AttrKey, AttrValue>>>`
    // — a string-typed key is "wider" than the canonical union, so we cast
    // for the lookup. The runtime value still has to pass the
    // `typeof v === "string"` filter below; this is read-only test scaffolding.
    const v = (e.attrs as Readonly<Record<string, unknown>>)[key]
    if (typeof v === "string") out.push(v)
  }
  return out
}

/** Substrings that MUST never appear in any emitted attribute value: file
 *  paths, patch text markers, hunk anchor characters, content lines, secrets.
 *  A regression that routes any of these into a telemetry attribute fails the
 *  scan with a labelled key/value pair. */
const FORBIDDEN_SUBSTRINGS = [
  "*** Begin Patch",
  "*** Update File",
  "*** Add File",
  "*** Delete File",
  "*** Move to",
  "*** End Patch",
  "@@",
  "/etc/passwd",
  "secret-token-xyz",
  "passw0rd",
  ".txt", // any file extension echo
  ".ts",
  ".py",
]

const assertNoLeakage = (events: readonly CapturedEvent[]): void => {
  for (const e of events) {
    for (const [k, v] of Object.entries(e.attrs)) {
      if (typeof v !== "string") continue
      for (const banned of FORBIDDEN_SUBSTRINGS) {
        if (v.includes(banned)) {
          throw new Error(`attr "${k}" leaked forbidden substring "${banned}" via value "${v}"`)
        }
      }
    }
  }
}

describe("V4A patch OTel emission — all 4 ops fire `quanta.patch.op`", () => {
  test('`add` op emits `patch.op="add"`', async () => {
    const jail = makeJailRoot()
    try {
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          "*** Begin Patch\n*** Add File: greeting.dat\n+hello\n+world\n*** End Patch\n",
        )
        expect(readFileSync(join(jail, "greeting.dat"), "utf8")).toBe("hello\nworld")
        const ops = valuesOf(eventsWithKey(events, QUANTA_ATTRS.patch.op), QUANTA_ATTRS.patch.op)
        expect(ops).toContain("add")
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test('`delete` op emits `patch.op="delete"`', async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "target.dat"), "doomed\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(jail, "*** Begin Patch\n*** Delete File: target.dat\n*** End Patch\n")
        const ops = valuesOf(eventsWithKey(events, QUANTA_ATTRS.patch.op), QUANTA_ATTRS.patch.op)
        expect(ops).toContain("delete")
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test('`update` op (in-place edit) emits `patch.op="update"`', async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), "alpha\nbeta\ngamma\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: edit.dat",
            "@@",
            " alpha",
            "-beta",
            "+BETA",
            " gamma",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        const ops = valuesOf(eventsWithKey(events, QUANTA_ATTRS.patch.op), QUANTA_ATTRS.patch.op)
        expect(ops).toContain("update")
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test('`move` op (Update + Move to) emits `patch.op="move"` (not "update")', async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "from.dat"), "alpha\nbeta\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: from.dat",
            "*** Move to: to.dat",
            "@@",
            " alpha",
            "-beta",
            "+BETA",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        const ops = valuesOf(eventsWithKey(events, QUANTA_ATTRS.patch.op), QUANTA_ATTRS.patch.op)
        // The move op MUST surface as `"move"`, not as `"update"`, so a
        // rename-edit is distinguishable in telemetry from an in-place edit.
        expect(ops).toContain("move")
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })
})

describe("V4A patch OTel emission — fuzzy tier coverage", () => {
  test('exact context match emits `fuzzy_match_tier="exact"` + `fuzzy_matched=false`', async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "e.dat"), "one\ntwo\nthree\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: e.dat",
            "@@",
            " one",
            "-two",
            "+TWO",
            " three",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        const hits = eventsWithKey(events, QUANTA_ATTRS.patch.fuzzyMatchTier)
        expect(hits.length).toBeGreaterThanOrEqual(1)
        const tier = hits[0]?.attrs[QUANTA_ATTRS.patch.fuzzyMatchTier]
        expect(tier).toBe("exact")
        // The `fuzzy_matched` bit (ADR-0028 paired with `fuzzy_match_tier`) is
        // FALSE for exact matches and TRUE for whitespace/fuzzy escalations.
        expect(hits[0]?.attrs[QUANTA_ATTRS.patch.fuzzyMatched]).toBe(false)
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test('whitespace-only divergence emits `fuzzy_match_tier="whitespace"` + `fuzzy_matched=true`', async () => {
    const jail = makeJailRoot()
    try {
      // File has leading spaces the patch context omits — the trimmed-tier
      // (`whitespace`) is the strictest match that succeeds.
      writeFileSync(join(jail, "w.dat"), "   alpha\n   beta\n   gamma\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: w.dat",
            "@@",
            " alpha",
            "-beta",
            "+BETA",
            " gamma",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        const hits = eventsWithKey(events, QUANTA_ATTRS.patch.fuzzyMatchTier)
        expect(hits.length).toBeGreaterThanOrEqual(1)
        const tier = hits[0]?.attrs[QUANTA_ATTRS.patch.fuzzyMatchTier]
        expect(tier).toBe("whitespace")
        expect(hits[0]?.attrs[QUANTA_ATTRS.patch.fuzzyMatched]).toBe(true)
        assertNoLeakage(events)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })
})

describe("V4A patch OTel emission — security invariants", () => {
  test("no emitted attr leaks file content / paths / patch text", async () => {
    const jail = makeJailRoot()
    try {
      // Seed two files whose content + path are the canonical "should never
      // appear in telemetry" surface. Both are exercised across add/update/
      // delete/move so every code-path passes through the leak scan.
      mkdirSync(join(jail, "sub"), { recursive: true })
      writeFileSync(
        join(jail, "sub", "creds.dat"),
        "username=admin\npassword=passw0rd\ntoken=secret-token-xyz\n",
      )
      writeFileSync(join(jail, "etc.dat"), "root:x:0:0:root:/root:/bin/bash\n")
      const events = installCapturingSink()
      try {
        // 1. update — touches `etc.dat` content
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: etc.dat",
            "@@",
            "-root:x:0:0:root:/root:/bin/bash",
            "+root:x:0:0:locked:/root:/sbin/nologin",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        // 2. move + edit — touches `sub/creds.dat` content
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: sub/creds.dat",
            "*** Move to: sub/creds.archived.dat",
            "@@",
            " username=admin",
            "-password=passw0rd",
            "+password=ROTATED",
            " token=secret-token-xyz",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        // 3. delete — the archived file
        await runApplyPatch(
          jail,
          "*** Begin Patch\n*** Delete File: sub/creds.archived.dat\n*** End Patch\n",
        )
        // 4. add — a new file with secret-like content
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Add File: secret.dat",
            "+api-key=secret-token-xyz",
            "+session=passw0rd",
            "*** End Patch",
            "",
          ].join("\n"),
        )

        // Sanity: each phase emitted at least one `patch.op` event.
        const opEvents = eventsWithKey(events, QUANTA_ATTRS.patch.op)
        expect(opEvents.length).toBeGreaterThanOrEqual(4)
        // Defence in depth: enumerate every emitted attribute value and
        // assert none of them carries the canonical forbidden substrings.
        assertNoLeakage(events)
        // Belt + braces: assert every emitted value is a primitive scalar.
        // The vocabulary helper (`attrs.ts`) already forbids objects at the
        // validator layer, but a regression that imports outside the
        // canonical builder would slip through — we re-prove here.
        for (const e of events) {
          for (const v of Object.values(e.attrs)) {
            expect(typeof v === "string" || typeof v === "number" || typeof v === "boolean").toBe(
              true,
            )
          }
        }
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })

  test("absent span sink ⇒ zero events captured but apply still mutates disk", async () => {
    const jail = makeJailRoot()
    try {
      writeFileSync(join(jail, "edit.dat"), "alpha\nbeta\n")
      // Do NOT install a sink. The apply must run normally; no observability.
      __resetSpanSink()
      await runApplyPatch(
        jail,
        [
          "*** Begin Patch",
          "*** Update File: edit.dat",
          "@@",
          " alpha",
          "-beta",
          "+BETA",
          "*** End Patch",
          "",
        ].join("\n"),
      )
      expect(readFileSync(join(jail, "edit.dat"), "utf8")).toBe("alpha\nBETA\n")
      // Now flip the sink on and re-apply — proves the seam is alive and
      // the no-emit branch above was sink-driven, not a code-path bug.
      writeFileSync(join(jail, "edit.dat"), "alpha\nbeta\n")
      const events = installCapturingSink()
      try {
        await runApplyPatch(
          jail,
          [
            "*** Begin Patch",
            "*** Update File: edit.dat",
            "@@",
            " alpha",
            "-beta",
            "+BETA",
            "*** End Patch",
            "",
          ].join("\n"),
        )
        expect(eventsWithKey(events, QUANTA_ATTRS.patch.op).length).toBeGreaterThanOrEqual(1)
      } finally {
        __resetSpanSink()
      }
    } finally {
      rmSync(jail, { recursive: true, force: true })
    }
  })
})
