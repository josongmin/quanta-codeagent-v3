/**
 * H6 (jun-3-misc §3) — Passive-VCS BUS-WIRE e2e hellgate (the FINAL leg).
 *
 * The sibling `passive-vcs-classify-e2e-hellgate.test.ts` drives the bash tool
 * with a HAND-BUILT ctx carrying a sink. THIS test closes the last gap: it
 * drives the REAL `bash` tool THROUGH the real dispatch `buildToolContext`
 * (`dispatchTool`) with the REAL host adapter (`createPassiveVcsStreamSink`)
 * wired onto `AgentConfig.vcsEventSink`, and asserts the classified `VcsEvent`
 * reaches `config.stream` as an `AgentEvent` (a `recovery` event tagged
 * `reason:"vcs_event"`) with the correct serialized facets.
 *
 * Matrix (all against a throwaway tmp git repo, real git binary):
 *   A. knob ON  + adapter sink, real merge   → exactly one `vcs_event` recovery
 *                                               event on the stream w/ branch
 *                                               "merged" + commit "merge".
 *   B. knob ON  + adapter sink, real commit   → `vcs_event` carries commit + sha.
 *   C. knob OFF + adapter sink                → NO `vcs_event` event +
 *                                               bash `output` byte-identical.
 *   D. knob ON, NO sink wired (config slot)   → NO `vcs_event` event (host opt-in
 *                                               still required) + output identical.
 *   E. knob ON + adapter sink, FAILED git     → NO `vcs_event` (exitCode≠0 guard).
 *   F. knob ON + adapter sink, non-git cmd    → NO `vcs_event` (classifier rejects).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { createPassiveVcsStreamSink } from "@/host/runtime/agent-config-assembler"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"
import { bashTool } from "@/tool/bash"

// ── git repo helpers ──────────────────────────────────────────────────────────

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
}

const tmpDirs: string[] = []
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "passive-vcs-bus-e2e-"))
  tmpDirs.push(dir)
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "t@t"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "a.txt"), "1\n")
  git(dir, ["add", "."])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

/** A recording StreamPort capturing every AgentEvent emitted. */
interface RecordingStream extends StreamPort {
  readonly events: AgentEvent[]
}
const recordingStream = (): RecordingStream => {
  const events: AgentEvent[] = []
  return { events, emit: (e) => void events.push(e) }
}

/** Only the `vcs_event`-tagged recovery events (the H6 facet on the bus). */
const vcsEvents = (
  s: RecordingStream,
): Array<{ type: "recovery"; reason: string; detail?: string }> =>
  s.events.filter(
    (e): e is { type: "recovery"; reason: string; detail?: string } =>
      e.type === "recovery" && e.reason === "vcs_event",
  )

const perm: PermissionContext = { mode: "acceptEdits" }

const bashCall = (command: string): ToolUseBlock => ({
  type: "tool_use",
  id: "bash-1",
  name: "bash",
  input: { command },
})

/** Build a minimal-but-real AgentConfig that drives `dispatchTool` over the
 *  REAL bash tool. `wireSink` ⇒ attach the REAL host adapter onto the stream. */
const cfgFor = (cwd: string, stream: StreamPort, wireSink: boolean): AgentConfig =>
  ({
    registry: new ToolRegistry([bashTool]),
    cwd,
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    stream,
    ...(wireSink ? { vcsEventSink: createPassiveVcsStreamSink(stream) } : {}),
  }) as AgentConfig

/** Drive a single bash command through the real dispatch seam. Returns the
 *  model-facing tool output (preview) for byte-identical assertions. */
const runDispatch = async (
  command: string,
  cwd: string,
  stream: StreamPort,
  wireSink: boolean,
): Promise<{ ok: boolean; preview: string }> => {
  const res = await dispatchTool(bashCall(command), cfgFor(cwd, stream, wireSink), perm)
  return { ok: res.ok, preview: res.preview ?? "" }
}

beforeEach(() => {
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env["QUANTA_PASSIVE_VCS"]
  __resetRuntimeConfig()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/* ================================================================== */
/*  A/B. knob ON + adapter → VcsEvent reaches the stream              */
/* ================================================================== */

describe("A/B. classified VcsEvent reaches config.stream as an AgentEvent", () => {
  test("HELL-BUS-A: real non-ff merge → one `vcs_event` recovery event (merged + merge)", async () => {
    const dir = makeRepo()
    git(dir, ["checkout", "-q", "-b", "feature"])
    writeFileSync(join(dir, "b.txt"), "2\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-q", "-m", "feature change"])
    git(dir, ["checkout", "-q", "main"])

    const stream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    await runDispatch("git merge --no-ff -m 'merge feature' feature", dir, stream, true)

    const evs = vcsEvents(stream)
    expect(evs).toHaveLength(1)
    // The serialized detail carries BOTH the merge commit facet and the merged
    // branch facet, in the fixed commit→branch order.
    expect(evs[0]?.detail).toBe("commit:merge branch:merged")
  })

  test("HELL-BUS-B: real commit → `vcs_event` carries commit kind + sha", async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, "c.txt"), "3\n")
    git(dir, ["add", "."])

    const stream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    await runDispatch("git commit -m 'add c'", dir, stream, true)

    const evs = vcsEvents(stream)
    expect(evs).toHaveLength(1)
    expect(evs[0]?.detail).toMatch(/^commit:commit@[0-9a-f]{7,40}$/)
  })
})

/* ================================================================== */
/*  C/D. default-OFF posture — no event, byte-identical output        */
/* ================================================================== */

describe("C/D. default-OFF byte-identical", () => {
  test("HELL-BUS-C: knob OFF → NO vcs_event + bash output identical to the ON run", async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, "d.txt"), "4\n")
    git(dir, ["add", "."])

    // ON reference run (sink wired): capture the tool output.
    const onStream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    const on = await runDispatch("git status --porcelain", dir, onStream, true)

    // OFF run (sink still wired on config, but the knob gates the hook off).
    const offStream = recordingStream()
    delete process.env["QUANTA_PASSIVE_VCS"]
    __resetRuntimeConfig()
    const off = await runDispatch("git status --porcelain", dir, offStream, true)

    expect(vcsEvents(offStream)).toHaveLength(0)
    // `git status` matches no classifier pattern ⇒ even ON yields nothing here;
    // the load-bearing assertion is the OUTPUT is byte-identical ON vs OFF.
    expect(off.preview).toBe(on.preview)
  })

  test("HELL-BUS-D: knob ON but NO sink wired on config → NO vcs_event (host opt-in)", async () => {
    const dir = makeRepo()
    git(dir, ["checkout", "-q", "-b", "feature"])
    writeFileSync(join(dir, "b.txt"), "2\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-q", "-m", "feature change"])
    git(dir, ["checkout", "-q", "main"])

    const stream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    const r = await runDispatch("git merge --no-ff -m 'merge feature' feature", dir, stream, false)

    expect(r.ok).toBe(true)
    expect(vcsEvents(stream)).toHaveLength(0)
  })
})

/* ================================================================== */
/*  E/F. knob ON negative paths                                       */
/* ================================================================== */

describe("E/F. knob ON negative paths emit NOTHING", () => {
  test("HELL-BUS-E: FAILED git (exitCode≠0) → NO vcs_event", async () => {
    const dir = makeRepo()
    const stream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    const r = await runDispatch("git merge does-not-exist-branch", dir, stream, true)

    expect(r.ok).toBe(false)
    expect(vcsEvents(stream)).toHaveLength(0)
  })

  test("HELL-BUS-F: non-git command echoing a git phrase → NO vcs_event", async () => {
    const dir = makeRepo()
    const stream = recordingStream()
    process.env["QUANTA_PASSIVE_VCS"] = "1"
    __resetRuntimeConfig()
    await runDispatch('echo "Fast-forward main -> main"', dir, stream, true)

    expect(vcsEvents(stream)).toHaveLength(0)
  })
})
