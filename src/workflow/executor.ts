/**
 * §25.1 — Deterministic workflow executor. Walks the declarative node tree,
 * spawning subagents through the injected {@link AgentRunPort}, enforcing the
 * concurrency cap, runaway/budget/abort backstops, structured-output retry, and
 * fail-closed duplicate-id detection. No clock/randomness in the core — the only
 * effect is `agentRun`; all decisions are pure functions of the tree + results.
 */

import { errMessage } from "@/shared"
import { Semaphore } from "./semaphore"
import { validateStructured } from "./structured"
import type {
  AgentNode,
  AgentRunResult,
  FanoutNode,
  LoopNode,
  PipelineNode,
  RunWorkflowOptions,
  SkipReason,
  StepFailureReason,
  StepOutcome,
  WorkflowContext,
  WorkflowEvent,
  WorkflowNode,
  WorkflowResult,
} from "./types"

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_RETRIES = 2

const CORRECTIVE =
  "Your previous response did not match the required schema. Respond with ONLY valid JSON " +
  "matching the schema. Validation error: "

/** Internal per-agent outcome: a recorded {@link StepOutcome} OR a skip. */
type AgentRunOutcome = StepOutcome | { readonly skipped: SkipReason }

/** The run's accumulators, the concurrency semaphore, the abort signal and
 *  the emitter every node reports through. */
const wfState = (root: WorkflowNode, opts: RunWorkflowOptions) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and every link mutates in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    agentRuns: 0,
    anyFailure: false,
  }
  const results = new Map<string, StepOutcome>()
  const events: WorkflowEvent[] = []
  const reservedIds = new Set<string>()
  const sem = new Semaphore(opts.concurrency ?? DEFAULT_CONCURRENCY)
  const maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS
  const signal = opts.signal
  const budget = opts.budget

  const emit = (e: WorkflowEvent): void => {
    events.push(e)
    opts.sink?.emit(e)
  }

  const ctx: WorkflowContext = {
    get<T = unknown>(id: string): T | undefined {
      const o = results.get(id)
      return o?.ok ? (o.value as T) : undefined
    },
    has(id: string): boolean {
      return results.get(id)?.ok === true
    },
  }
  return {
    root,
    opts,
    results,
    events,
    reservedIds,
    sem,
    maxAgents,
    signal,
    budget,
    emit,
    ctx,
    mut,
  }
}

/** Outcome recording and the admission gate an agent node passes first. */
const wfRecord = async (sctx: ReturnType<typeof wfState>) => {
  const { results, reservedIds, maxAgents, signal, budget, emit, mut } = sctx

  const recordOk = (id: string, value: unknown, text: string): StepOutcome => {
    const o: StepOutcome = { id, ok: true, value, text }
    results.set(id, o)
    emit({ type: "step_complete", id, ok: true })
    return o
  }
  const recordFail = (id: string, reason: StepFailureReason, error: string): StepOutcome => {
    const o: StepOutcome = { id, ok: false, reason, error }
    results.set(id, o)
    mut.anyFailure = true
    emit({ type: "step_complete", id, ok: false, reason })
    return o
  }
  const skip = (id: string, reason: SkipReason): { readonly skipped: SkipReason } => {
    emit({ type: "step_skipped", id, reason })
    return { skipped: reason }
  }

  // Synchronous gates for an agent node (run before any await so sibling-
  // parallel nodes see each other's reservations and the caps hold). Returns a
  // terminal outcome when the step is gated, or `null` to proceed. Reserves the
  // id (fail-closed on a collision) as a side effect when it proceeds.
  const gateAgent = (node: AgentNode): AgentRunOutcome | null => {
    const id = node.id
    if (signal?.aborted) return skip(id, "aborted")
    if (reservedIds.has(id) || results.has(id)) {
      mut.anyFailure = true
      emit({ type: "step_complete", id, ok: false, reason: "duplicate_id" })
      return { id, ok: false, reason: "duplicate_id", error: `duplicate step id: ${id}` }
    }
    reservedIds.add(id)
    if (budget !== undefined && budget.remaining() <= 0) return skip(id, "budget_exhausted")
    if (mut.agentRuns >= maxAgents) return skip(id, "max_agents")
    return null
  }
  return { recordOk, recordFail, skip, gateAgent }
}

/** One agent dispatch, its retry preparation, and the retry loop. */
const wfDispatch = async (
  sctx: ReturnType<typeof wfState> & Awaited<ReturnType<typeof wfRecord>>,
) => {
  const { opts, sem, signal, emit, ctx, mut, recordOk, recordFail, gateAgent } = sctx

  // One concurrency-capped dispatch + validation. Returns a terminal outcome
  // (`done`) or, on a schema miss, the validation error to retry with (`retry`).
  const runOnce = async (
    node: AgentNode,
    prompt: string,
    id: string,
    label: string,
  ): Promise<{ done: AgentRunOutcome } | { retry: string }> => {
    const release = await sem.acquire()
    let res: AgentRunResult
    try {
      res = await opts.agentRun.run({ prompt, label, ...(signal !== undefined ? { signal } : {}) })
    } catch (e) {
      release()
      return { done: recordFail(id, "agent_error", errMessage(e)) }
    }
    release()
    if (!res.ok) {
      return { done: recordFail(id, "agent_error", res.errorMessage ?? "agent returned not-ok") }
    }
    if (node.schema === undefined) return { done: recordOk(id, res.text, res.text) }
    const v = validateStructured(node.schema, res.text)
    if (v.ok) return { done: recordOk(id, v.value, res.text) }
    return { retry: v.error }
  }

  // Preamble before a retry attempt (attempt > 0): bail if aborted, else charge
  // the extra dispatch. Returns a terminal outcome to stop, or `null` to go on.
  const prepRetry = (attempt: number, id: string): StepOutcome | null => {
    if (attempt === 0) return null
    if (signal?.aborted) return recordFail(id, "aborted", "aborted before retry")
    mut.agentRuns += 1
    return null
  }

  // The retry loop: dispatch, validate, re-prompt on a schema miss up to
  // `maxRetries`. Each dispatch is concurrency-capped via `runOnce`.
  const dispatchWithRetry = async (
    node: AgentNode,
    basePrompt: string,
    id: string,
    label: string,
  ): Promise<AgentRunOutcome> => {
    const maxRetries = node.schema === undefined ? 0 : (node.maxRetries ?? DEFAULT_RETRIES)
    let lastErr = "no JSON found in agent output"
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const bail = prepRetry(attempt, id)
      if (bail !== null) return bail
      const prompt = attempt === 0 ? basePrompt : `${basePrompt}\n\n${CORRECTIVE}${lastErr}`
      const r = await runOnce(node, prompt, id, label)
      if ("done" in r) return r.done
      lastErr = r.retry
    }
    return recordFail(id, "schema_invalid", lastErr)
  }

  // --- agent node: the single concurrency-limited, gated, retrying primitive ---
  const runAgentNode = async (node: AgentNode): Promise<AgentRunOutcome> => {
    const id = node.id
    const label = node.label ?? id
    const gated = gateAgent(node)
    if (gated !== null) return gated
    emit({ type: "step_start", id, label })
    let basePrompt: string
    try {
      basePrompt = typeof node.prompt === "function" ? node.prompt(ctx) : node.prompt
    } catch (e) {
      return recordFail(id, "builder_threw", errMessage(e))
    }
    mut.agentRuns += 1 // reserve the attempt-0 dispatch (synchronous)
    return dispatchWithRetry(node, basePrompt, id, label)
  }
  return { runOnce, prepRetry, dispatchWithRetry, runAgentNode }
}

/** The node executors — pipeline item, fan-out, pipeline, loop — and the
 *  dispatcher that routes a node to one of them. */
const wfExec = async (
  sctx: ReturnType<typeof wfState> &
    Awaited<ReturnType<typeof wfRecord>> &
    Awaited<ReturnType<typeof wfDispatch>>,
) => {
  const { root, signal, emit, ctx, skip, runAgentNode } = sctx

  // --- pipeline: per-item staged flow, NO barrier between stages ------------
  const runPipelineItem = async (
    stages: PipelineNode["stages"],
    item: unknown,
    index: number,
  ): Promise<void> => {
    let prev: unknown
    let shortCircuited = false
    for (const make of stages) {
      let stageNode: AgentNode
      try {
        stageNode = make(prev, item, index)
      } catch {
        break // a stage builder threw and we have no id to attach — drop the item
      }
      if (shortCircuited) {
        skip(stageNode.id, "pipeline_short_circuit")
        continue
      }
      const outcome = await runAgentNode(stageNode)
      if ("skipped" in outcome || !outcome.ok) {
        shortCircuited = true // this item's remaining stages are skipped
        continue
      }
      prev = outcome.value
    }
  }

  const execFanout = async (node: FanoutNode): Promise<void> => {
    let items: ReadonlyArray<unknown>
    try {
      items = node.over(ctx)
    } catch {
      return // over() threw — no id to attach; the fan-out produces nothing
    }
    const built = items.map((it, i) => {
      try {
        return node.body(it, i)
      } catch {
        return undefined // a body builder threw — drop that item
      }
    })
    if ((node.mode ?? "parallel") === "sequential") {
      for (const b of built) if (b !== undefined) await execNode(b)
    } else {
      await Promise.all(built.map((b) => (b !== undefined ? execNode(b) : Promise.resolve())))
    }
  }

  const execPipeline = async (node: PipelineNode): Promise<void> => {
    let items: ReadonlyArray<unknown>
    try {
      items = node.over(ctx)
    } catch {
      return
    }
    await Promise.all(items.map((item, i) => runPipelineItem(node.stages, item, i)))
  }

  const execLoop = async (node: LoopNode): Promise<void> => {
    for (let i = 0; i < node.maxIterations; i++) {
      if (signal?.aborted) break
      let body: WorkflowNode
      try {
        body = node.body(i, ctx)
      } catch {
        break
      }
      await execNode(body)
      if (node.until !== undefined && safeUntil(node.until)) break
    }
  }

  // A throwing predicate stops the loop (fail-safe — never spin on a bug).
  const safeUntil = (until: (c: WorkflowContext) => boolean): boolean => {
    try {
      return until(ctx)
    } catch {
      return true
    }
  }

  // --- generic tree walk ----------------------------------------------------
  const execNode = async (node: WorkflowNode): Promise<void> => {
    switch (node.type) {
      case "agent":
        await runAgentNode(node)
        return
      case "sequence":
        for (const child of node.children) await execNode(child)
        return
      case "parallel":
        await Promise.all(node.children.map((c) => execNode(c)))
        return
      case "phase":
        emit({ type: "phase_enter", name: node.name })
        await execNode(node.body)
        return
      case "fanout":
        await execFanout(node)
        return
      case "pipeline":
        await execPipeline(node)
        return
      case "loop":
        await execLoop(node)
        return
    }
  }

  await execNode(root)

  return { runPipelineItem, execFanout, execPipeline, execLoop, safeUntil, execNode }
}

/** Assemble the chained builders. */
export const runWorkflow = async (
  root: WorkflowNode,
  opts: RunWorkflowOptions,
): Promise<WorkflowResult> => {
  const p0 = wfState(root, opts)
  const p1 = await wfRecord({ ...p0 })
  const p2 = await wfDispatch({ ...p0, ...p1 })
  const p3 = await wfExec({ ...p0, ...p1, ...p2 })
  const { results, events, mut } = { ...p0, ...p1, ...p2, ...p3 }
  return { ok: !mut.anyFailure, results, events, agentRuns: mut.agentRuns }
}
