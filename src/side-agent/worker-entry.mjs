/**
 * §4.3 / D1 — the PRODUCTION side-agent CHILD worker (the module a forked
 * side-agent process boots). Launched by `nodeProcessForkPort.fork(modulePath)`
 * and supervised by `createSupervisedProcessDaemon`.
 *
 * IPC protocol (mirror of `SideAgentIpcMessage` in `./process.ts`):
 *   - child → parent  `{ kind: "ready" }`
 *   - parent → child  `{ kind: "charter", version, wakeId, task, maxTurnsPerWake }`
 *   - child → parent  `{ kind: "finding", version, wakeId, summary, detail? }` (0..N)
 *   - child → parent  terminal `{ kind: "no_finding"|"failed"|"cancelled"|"completed", version, wakeId }`
 *   - parent → child  `{ kind: "shutdown" }`
 *
 * LLM null miss → `no_finding`. Import/provider/throw → `failed`. Empty task →
 * `no_finding`. Never emit a synthetic finding for those cases.
 *
 * `QUANTA_SIDE_AGENT_TEST_MODE` is a hermetic OS-rail seam (no_finding|throw|
 * multi|late) — production leaves it unset.
 */

const IPC_VERSION = 1

const send = (msg) => {
  if (typeof process.send === "function") process.send(msg)
}

const llmPassViable = () => {
  const env = process.env
  if (
    typeof env.QUANTA_SIDE_AGENT_LLM_REPLAY === "string" &&
    env.QUANTA_SIDE_AGENT_LLM_REPLAY.length > 0
  ) {
    return true
  }
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY)
}

const wakeIdOf = (charter) => (typeof charter?.wakeId === "number" ? charter.wakeId : 1)

const emitFinding = (wakeId, finding) => {
  send(
    finding.detail !== undefined
      ? {
          kind: "finding",
          version: IPC_VERSION,
          wakeId,
          summary: finding.summary,
          detail: finding.detail,
        }
      : { kind: "finding", version: IPC_VERSION, wakeId, summary: finding.summary },
  )
}

const emitTerminal = (kind, wakeId, extra) => {
  send({ kind, version: IPC_VERSION, wakeId, ...(extra ?? {}) })
}

const runCharterPassLLM = async (charter) => {
  try {
    const mod = await import("./worker-charter-runner.ts")
    return await mod.runCharterPassLLM(charter, process.env)
  } catch (err) {
    const reason = err instanceof Error ? err.message : "import failed"
    return { outcome: "failed", reason }
  }
}

const runCharterPass = (charter) => {
  const task = typeof charter?.task === "string" ? charter.task : ""
  const maxTurns = typeof charter?.maxTurnsPerWake === "number" ? charter.maxTurnsPerWake : 0
  if (task.trim().length === 0) return null

  const pid = process.pid
  const envKeyCount = Object.keys(process.env).length
  const model = process.env.QUANTA_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL
  const hasModelHint = typeof model === "string" && model.length > 0

  const summary = `side-agent process pass: ${task}`.slice(0, 200)
  const note =
    "note: deterministic bounded pass (no LLM call); see worker-entry.mjs header for the LLM swap point."
  const detail = [
    `pid=${pid} (forked child OS process)`,
    `maxTurnsPerWake=${maxTurns}`,
    `inheritedEnvKeys=${envKeyCount}`,
    `modelHint=${hasModelHint ? model : "(none in env)"}`,
    note,
  ].join("\n")
  return { summary, detail }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const handleTestMode = async (mode, wakeId) => {
  if (mode === "no_finding") {
    emitTerminal("no_finding", wakeId)
    return true
  }
  if (mode === "throw") {
    emitTerminal("failed", wakeId, { reason: "test throw" })
    return true
  }
  if (mode === "multi") {
    emitFinding(wakeId, { summary: "multi-a" })
    emitFinding(wakeId, { summary: "multi-b" })
    emitTerminal("completed", wakeId)
    return true
  }
  if (mode === "late") {
    await delay(400)
    emitFinding(wakeId, { summary: "late-finding" })
    emitTerminal("completed", wakeId)
    return true
  }
  return false
}

const handleCharter = async (charter) => {
  const wakeId = wakeIdOf(charter)
  const task = typeof charter?.task === "string" ? charter.task : ""
  if (task.trim().length === 0) {
    emitTerminal("no_finding", wakeId)
    return
  }
  const testMode = process.env.QUANTA_SIDE_AGENT_TEST_MODE
  if (typeof testMode === "string" && testMode.length > 0) {
    if (await handleTestMode(testMode, wakeId)) return
  }
  if (llmPassViable()) {
    const result = await runCharterPassLLM(charter)
    if (result?.outcome === "failed") {
      emitTerminal("failed", wakeId, { reason: result.reason })
      return
    }
    if (result?.outcome === "finding" && result.finding !== undefined) {
      emitFinding(wakeId, result.finding)
      emitTerminal("completed", wakeId)
      return
    }
    emitTerminal("no_finding", wakeId)
    return
  }
  const det = runCharterPass(charter)
  if (det === null) {
    emitTerminal("no_finding", wakeId)
    return
  }
  emitFinding(wakeId, det)
  emitTerminal("completed", wakeId)
}

let charterInFlight = false

process.on("message", (msg) => {
  if (msg && msg.kind === "charter") {
    if (charterInFlight) return
    charterInFlight = true
    void handleCharter(msg).finally(() => {
      charterInFlight = false
    })
    return
  }
  if (msg && msg.kind === "shutdown") {
    process.exit(0)
  }
})

send({ kind: "ready" })
