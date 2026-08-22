import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import { statePath } from "../../../../src/apps/cli/internal"
// Import the FSM through the CLI resume shim (`src/apps/cli/resume.ts` re-exports
// the Layer-2 `resolveResume`). Owner-local: this is the CLI resume seam the
// `quantastatepath` (L4) feature relies on for `--resume <path>` / corrupt-state
// recovery — the exact wire (`prior !== null → history/sessionId`, else `[]`)
// that had NO leaf-unit before this hellgate.
import { resolveResume } from "../../../../src/apps/cli/resume"

/**
 * OWNER-LOCAL HELLGATE — `quantastatepath` (L4) resume wire.
 *
 * Gap (audit-confirmed): the path-mode `--resume <path>` branch of
 * `resolveResume` reads a prior transcript via `loadSession` and wires it into
 * the startup state:
 *
 *   const prior = await loadSession(resume)
 *   if (prior !== null) { history = prior.messages; sessionId = prior.sessionId }
 *   else                { history = [];             sessionId = initialSessionId }
 *
 * This is the corrupt-state-recovery seam: a MISSING file (`null`) must NOT
 * hijack the session id, while a VALID prior MUST transfer both fields. Neither
 * transition had an owner-local leaf-unit — id-mode / new-session paths were
 * covered, path-mode was only exercised by e2e/subprocess.
 *
 * We stub the loader via the `loadSessionFn` seam (byte-identical default-OFF:
 * production callers never pass it, so the real disk `loadSession` is used) so
 * the wire is observed in isolation — no filesystem, no session store.
 */

const slog = new StructuredLogger()

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

// A path-like token forces the PATH-MODE branch (contains `/`), so the stub
// loader is consulted (id-mode uses the store, not this seam).
const PATH_TOKEN = "/tmp/prior-session.json"

describe("resolveResume path-mode wire — loadSessionFn seam (owner-local)", () => {
  test("(a) VALID prior ⇒ history=prior.messages AND sessionId=prior.sessionId (both transfer)", async () => {
    const priorMessages = [userText("first turn"), userText("second turn")]
    const r = await resolveResume({
      resume: PATH_TOKEN,
      newSession: false,
      title: undefined,
      cwd: "/work",
      initialSessionId: "init-fresh-id",
      slog,
      // Stub: return a well-formed prior transcript with a DISTINCT sessionId so
      // we can prove the wire adopts the prior id (not the initial one).
      loadSessionFn: async () => ({ sessionId: "prior-session-id", messages: priorMessages }),
    })

    // Real effect: prior transcript is materialized as history (content-equal;
    // reconcileLoadedHistory copies but preserves a clean transcript verbatim).
    expect(r.history).toHaveLength(2)
    expect(r.history).toEqual(priorMessages)
    // Real effect: the PRIOR session id wins — this is the load-bearing bit the
    // red-on-injection step below breaks.
    expect(r.sessionId).toBe("prior-session-id")
    expect(r.sessionId).not.toBe("init-fresh-id")
    // Path-mode is legacy mode: no id-meta, not id-mode.
    expect(r.idMeta).toBeUndefined()
    expect(r.inIdMode).toBe(false)
    expect(r.missingIdError).toBeUndefined()
    expect(r.conflictError).toBeUndefined()
  })

  test("(b) MISSING prior (loader ⇒ null) ⇒ history=[] AND sessionId=initialSessionId (no hijack)", async () => {
    const r = await resolveResume({
      resume: PATH_TOKEN,
      newSession: false,
      title: undefined,
      cwd: "/work",
      initialSessionId: "init-fresh-id",
      slog,
      // Stub: file missing → the loader contract returns null (a fresh convo).
      loadSessionFn: async () => null,
    })

    expect(r.history).toEqual([])
    // The initial id is preserved — a missing prior must NOT mint/adopt a foreign id.
    expect(r.sessionId).toBe("init-fresh-id")
    expect(r.idMeta).toBeUndefined()
    expect(r.inIdMode).toBe(false)
    expect(r.missingIdError).toBeUndefined()
    expect(r.conflictError).toBeUndefined()
  })

  // PAIRED CONTROL: identical inputs EXCEPT the loader result. The two runs
  // diverge on exactly the branch under test (prior !== null), proving the wire
  // — not some ambient default — drives history + sessionId.
  test("paired control: valid-prior vs missing-prior diverge ONLY on the loadSession result", async () => {
    const base = {
      resume: PATH_TOKEN,
      newSession: false,
      title: undefined,
      cwd: "/work",
      initialSessionId: "init-fresh-id",
      slog,
    }
    const withPrior = await resolveResume({
      ...base,
      loadSessionFn: async () => ({ sessionId: "prior-session-id", messages: [userText("hi")] }),
    })
    const withoutPrior = await resolveResume({ ...base, loadSessionFn: async () => null })

    // Same knobs in, opposite branch out.
    expect(withPrior.sessionId).toBe("prior-session-id")
    expect(withoutPrior.sessionId).toBe("init-fresh-id")
    expect(withPrior.history).toHaveLength(1)
    expect(withoutPrior.history).toHaveLength(0)
  })

  // Defensive: a prior whose messages array is EMPTY is still a legitimate
  // resume (an empty-but-present transcript) — history stays [] but the prior
  // sessionId still transfers (the file existed, so its identity is authoritative).
  test("(c) prior with empty messages ⇒ history=[] but sessionId still adopts the prior id", async () => {
    const r = await resolveResume({
      resume: PATH_TOKEN,
      newSession: false,
      title: undefined,
      cwd: "/work",
      initialSessionId: "init-fresh-id",
      slog,
      loadSessionFn: async () => ({ sessionId: "prior-empty-id", messages: [] }),
    })
    expect(r.history).toEqual([])
    // Distinguishes the "empty-but-present" prior (id adopted) from the
    // "missing" prior in case (b) (id NOT adopted) — same empty history, but the
    // sessionId is the discriminator that proves the prior !== null branch ran.
    expect(r.sessionId).toBe("prior-empty-id")
    expect(r.sessionId).not.toBe("init-fresh-id")
    expect(r.inIdMode).toBe(false)
  })
})

describe("statePath — QUANTA_STATE_PATH / --state resolution (owner-local)", () => {
  let argvSnapshot: string[]
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    argvSnapshot = process.argv.slice()
    envSnapshot = { ...process.env }
    delete process.env.QUANTA_STATE_PATH
    process.argv = ["bun", "quanta"]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    process.argv = argvSnapshot
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("default-OFF: no --state / no env ⇒ undefined (byte-identical legacy)", () => {
    expect(statePath()).toBeUndefined()
  })

  test("QUANTA_STATE_PATH override ⇒ resolves to that dir (fresh-readback of the env)", () => {
    // Fresh-readback: set the env, read it back through the real accessor.
    process.env.QUANTA_STATE_PATH = "/custom/state/dir/session.json"
    expect(statePath()).toBe("/custom/state/dir/session.json")
  })

  test("paired control: --state flag WINS over QUANTA_STATE_PATH env", () => {
    // Env alone → env value.
    process.env.QUANTA_STATE_PATH = "/env/path.json"
    expect(statePath()).toBe("/env/path.json")
    // Add the flag → flag value takes precedence (argv scanned first).
    process.argv = ["bun", "quanta", "--state", "/flag/path.json"]
    expect(statePath()).toBe("/flag/path.json")
  })
})
