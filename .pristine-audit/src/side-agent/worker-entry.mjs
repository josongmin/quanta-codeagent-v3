/**
 * §4.3 / D1 — the PRODUCTION side-agent CHILD worker (the module a forked
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
 * WHAT THIS CHILD DOES (D1): on a `charter` it runs a REAL LLM-backed bounded
 * subagent pass when an LLM source is available, DEGRADING to a deterministic
 * bounded pass otherwise (so the OS machinery + back-compat hold with no creds).
 *
 *   - LLM pass (the swap point, now TAKEN): when the inherited env carries the
 *     hermetic replay cassette (`QUANTA_SIDE_AGENT_LLM_REPLAY`) OR real model
 *     credentials (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / a model hint), the
 *     child DYNAMICALLY imports the TS composition root
 *     `./worker-charter-runner.ts` (`runCharterPassLLM`) and drives a real
 *     read-biased subagent loop over the charter, mapping `finalText` → finding.
 *     Dynamic `.ts` + `@/…` import works under the bun `execPath` that
 *     `child_process.fork` selects (verified empirically); on a node execPath or
 *     any import/assembly failure the child DEGRADES (below).
 *
 *   - DETERMINISTIC pass (the degrade / no-LLM default): a genuine, hermetic
 *     bounded action — confirms the forked child's pid, the inherited env key
 *     count, the charter task + turn budget — posted as a `finding`. This is the
 *     byte-identical legacy behavior when no LLM source is present, so the
 *     existing OS-fork e2e (which forks WITHOUT replay/creds) stays green.
 *
 * IN-PROCESS PARITY: the in-process backer (`subagentRunnerToSidePass` in
 * `@/agent/side-agent-runner`) runs the SAME read-biased subagent pass per wake;
 * the LLM path here reuses that exact mapping via `runCharterPassLLM`.
 *
 * RUNTIME REQUIREMENT: this file stays a plain `.mjs` with NO top-level `@/…`
 * imports so it boots under EITHER the bun OR node `execPath` that
 * `child_process.fork` selects. The `@/…`-bearing TS runner is reached only via a
 * GUARDED dynamic `import()` inside the LLM branch; any resolver failure (e.g. a
 * node execPath without the tsconfig path-resolver) is caught and degrades.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Post a message to the parent over the IPC channel (no-op if detached). */
const send = (msg) => {
  if (typeof process.send === "function") process.send(msg)
}

/**
 * Does the inherited env make a REAL LLM pass viable? True when the hermetic
 * replay cassette is wired OR real model credentials / a model hint are present.
 * When false, the child runs the deterministic pass (byte-identical legacy).
 */
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

/**
 * Run the REAL LLM-backed pass by dynamically importing the TS composition root.
 * Returns the finding, or `null` (nothing found / could not run). NEVER throws —
 * an import/assembly failure resolves `null` so the caller degrades. The dynamic
 * import is INSIDE this guarded async fn (not top-level) so the `.mjs` keeps
 * booting under any execPath; only the LLM branch reaches `@/…` TS.
 */
const runCharterPassLLM = async (charter) => {
  try {
    const mod = await import("./worker-charter-runner.ts")
    return await mod.runCharterPassLLM(charter, process.env)
  } catch {
    return null
  }
}

/**
 * Run ONE DETERMINISTIC bounded pass for `charter` (the degrade / no-LLM path).
 * Returns a finding `{summary, detail?}`, or `null` when nothing to report. The
 * pass is bounded — it does no I/O beyond reading `process` state and returns
 * synchronously. `degraded` (optional) notes WHY the LLM path was not taken so
 * the finding is honest about what produced it.
 */
const runCharterPass = (charter, degraded) => {
  const task = typeof charter?.task === "string" ? charter.task : ""
  const maxTurns = typeof charter?.maxTurnsPerWake === "number" ? charter.maxTurnsPerWake : 0
  if (task.trim().length === 0) return null

  // Real, hermetic observations about the forked child's actual runtime.
  const pid = process.pid
  const envKeyCount = Object.keys(process.env).length
  const model = process.env.QUANTA_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL
  const hasModelHint = typeof model === "string" && model.length > 0

  const summary = `side-agent process pass: ${task}`.slice(0, 200)
  const note =
    degraded !== undefined
      ? `note: deterministic bounded pass (LLM path unavailable: ${degraded}); see worker-entry.mjs header.`
      : "note: deterministic bounded pass (no LLM call); see worker-entry.mjs header for the LLM swap point."
  const detail = [
    `pid=${pid} (forked child OS process)`,
    `maxTurnsPerWake=${maxTurns}`,
    `inheritedEnvKeys=${envKeyCount}`,
    `modelHint=${hasModelHint ? model : "(none in env)"}`,
    note,
  ].join("\n")
  return { summary, detail }
}

/** Send a finding over IPC (omitting `detail` when absent), or nothing on null. */
const emitFinding = (finding) => {
  if (finding === null || finding === undefined) return
  send(
    finding.detail !== undefined
      ? { kind: "finding", summary: finding.summary, detail: finding.detail }
      : { kind: "finding", summary: finding.summary },
  )
}

/**
 * Handle a `charter`: take the REAL LLM-backed pass when viable, DEGRADING to the
 * deterministic pass when no LLM source is present OR the LLM pass could not run
 * / found nothing. Async so the dynamic-import LLM path can be awaited; errors
 * inside the LLM path resolve `null` (handled in `runCharterPassLLM`) and fall
 * through to the deterministic degrade — NEVER throwing into the supervisor.
 */
const handleCharter = async (charter) => {
  if (llmPassViable()) {
    const llmFinding = await runCharterPassLLM(charter)
    if (llmFinding !== null && llmFinding !== undefined) {
      emitFinding(llmFinding)
      return
    }
    // LLM path was viable but produced nothing (miss / empty / import failure) ⇒
    // degrade so the wake still reports honestly rather than going silent.
    emitFinding(runCharterPass(charter, "pass returned no finding"))
    return
  }
  emitFinding(runCharterPass(charter))
}

process.on("message", (msg) => {
  if (msg && msg.kind === "charter") {
    // Fire-and-forget: the supervisor's protocol is push-on-finding; we await
    // internally and never let a rejection escape (handleCharter is no-throw).
    void handleCharter(msg)
    return
  }
  if (msg && msg.kind === "shutdown") {
    process.exit(0)
  }
})

// Beacon ready once the message handler is wired (the supervisor hands the
// charter only after this).
send({ kind: "ready" })
