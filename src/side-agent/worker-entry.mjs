/**
 * §4.3 — the PRODUCTION side-agent CHILD worker (the module a forked
 * side-agent process boots). Launched by `nodeProcessForkPort.fork(modulePath)`
 * and supervised by `createSupervisedProcessDaemon` (fork → ready → charter →
 * finding(s) → shutdown, with crash-respawn on an unexpected exit).
 *
 * IPC protocol (mirror of `SideAgentIpcMessage` in `./process.ts`):
 *   - child → parent  `{ kind: "ready" }`                        — booted, awaiting charter
 *   - parent → child  `{ kind: "charter", task, maxTurnsPerWake }` — run ONE bounded pass
 *   - child → parent  `{ kind: "finding", summary, detail? }`     — a real finding
 *   - parent → child  `{ kind: "shutdown" }`                      — graceful drain + exit(0)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY DISCLOSURE — WHAT THIS CHILD ACTUALLY DOES (read before trusting it):
 *
 * This worker runs a REAL but DETERMINISTIC bounded pass per charter — it does
 * NOT (yet) drive a full LLM-backed agent loop inside the child. Concretely, on
 * a `charter` it performs genuine, hermetic work:
 *   1. confirms it is executing in the FORKED child OS process (reports its pid),
 *   2. confirms it inherited the parent's environment (the channel by which a
 *      real child would receive model/provider/credentials) by counting the
 *      env keys it can see and noting whether a model/provider hint is present,
 *   3. echoes the charter task + the per-wake turn budget it was handed.
 * It posts that as a structured `finding`, then waits for `shutdown` to exit(0).
 *
 * WHY deterministic, not full-LLM (and what the follow-up is):
 *   Driving a real agent pass requires an assembled `AgentConfig` — an `LLMPort`
 *   built from credentials, a tool registry, a permission gate, a system prompt,
 *   and the full `runAgent`/`buildSessionFeatures` host bootstrap. None of that
 *   exists inside a bare forked child; assembling it standalone from env is a
 *   large host-bootstrap surface that cannot be wired+verified safely within this
 *   task (no keys / hermetic test env here). Rather than fake an agent loop, the
 *   child does the most real bounded action it can. The single, well-marked swap
 *   point for the LLM path is {@link runCharterPass}: replace the deterministic
 *   body with `assembleAgentConfig(...)` + `createSubagentRunner(...)` driven over
 *   the inherited env (the parent already forks `{...process.env, ...spec.env}`,
 *   so credentials are present), mapping the runner's `finalText` to the finding
 *   `summary`/`detail` exactly as `subagentRunnerToSidePass` does in-process.
 *
 * IN-PROCESS PARITY: the in-process backer (`subagentRunnerToSidePass` in
 * `@/agent/side-agent-runner`) DOES run a real read-biased subagent pass per wake.
 * This process backer's per-wake intelligence is the deterministic pass above
 * until that swap point is taken. The OS-process machinery (fork, IPC,
 * supervision, crash-respawn, the multi-daemon registry) is fully real either way.
 *
 * RUNTIME REQUIREMENT: this is a plain `.mjs` (no `@/…` path aliases, no TS), so
 * it is executable by EITHER the bun OR node `execPath` that `child_process.fork`
 * selects — no tsconfig path-resolver dependency. Keep it dependency-free for
 * that reason; do not add `@/…` imports here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Post a message to the parent over the IPC channel (no-op if detached). */
const send = (msg) => {
  if (typeof process.send === "function") process.send(msg)
}

/**
 * Run ONE bounded pass for `charter` and return a finding `{summary, detail?}`,
 * or `null` when the pass found nothing to report.
 *
 * THIS is the LLM swap point (see header). Today: a deterministic pass that does
 * real, hermetic work (process/env/charter introspection). The pass is bounded —
 * it does no I/O beyond reading `process` state and returns synchronously.
 */
const runCharterPass = (charter) => {
  const task = typeof charter?.task === "string" ? charter.task : ""
  const maxTurns = typeof charter?.maxTurnsPerWake === "number" ? charter.maxTurnsPerWake : 0
  if (task.trim().length === 0) return null

  // Real, hermetic observations about the forked child's actual runtime.
  const pid = process.pid
  const envKeyCount = Object.keys(process.env).length
  const model = process.env.QUANTA_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL
  const hasModelHint = typeof model === "string" && model.length > 0

  const summary = `side-agent process pass: ${task}`.slice(0, 200)
  const detail = [
    `pid=${pid} (forked child OS process)`,
    `maxTurnsPerWake=${maxTurns}`,
    `inheritedEnvKeys=${envKeyCount}`,
    `modelHint=${hasModelHint ? model : "(none in env)"}`,
    "note: deterministic bounded pass (no LLM call); see worker-entry.mjs header for the LLM swap point.",
  ].join("\n")
  return { summary, detail }
}

process.on("message", (msg) => {
  if (msg && msg.kind === "charter") {
    const finding = runCharterPass(msg)
    if (finding !== null) {
      send(
        finding.detail !== undefined
          ? { kind: "finding", summary: finding.summary, detail: finding.detail }
          : { kind: "finding", summary: finding.summary },
      )
    }
    return
  }
  if (msg && msg.kind === "shutdown") {
    process.exit(0)
  }
})

// Beacon ready once the message handler is wired (the supervisor hands the
// charter only after this).
send({ kind: "ready" })
