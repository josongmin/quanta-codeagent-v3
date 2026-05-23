/** Compaction config dependency. Present when memory/store is on (preserving
 *  the prior `compaction: {}` default) OR a dedicated summarizer model is set;
 *  carries `summarizerLlm` when configured. Absent when neither ⇒ omitted
 *  entirely (byte-identical to the pre-knob default path). */
export const compactionDep = (d) => {
    if (!d.store && !d.summarizerLlm)
        return undefined;
    return d.summarizerLlm ? { summarizerLlm: d.summarizerLlm } : {};
};
/** Assemble the per-turn `AgentConfig`. Every conditional spread is preserved
 *  verbatim (same keys, same gating) — this is a pure relocation so the wired
 *  knobs are byte-identical; it only moves the chain off `main`/`session`. */
export const assembleConfig = (messages, d) => {
    const compaction = compactionDep(d);
    return {
        llm: d.llm,
        registry: d.registry,
        stream: d.stream,
        permission: d.permission,
        messages,
        system: d.system,
        cwd: d.cwd,
        maxTurns: d.maxTurns,
        signal: d.signal,
        onConfirm: d.onConfirm,
        // Store/sessionId gated on memory; compaction is now decoupled so a
        // dedicated summarizer model works without a store. Store-only ⇒
        // `compaction: {}` exactly as before (byte-identical).
        ...(d.store ? { store: d.store, sessionId: d.sessionId } : {}),
        ...(compaction ? { compaction } : {}),
        ...(d.embedder ? { embedder: d.embedder } : {}),
        ...(d.memoryConfig ? { memory: d.memoryConfig } : {}),
        ...(d.planMode ? { planMode: true } : {}),
        ...(d.metrics ? { metrics: d.metrics } : {}),
        ...(d.run ? { run: d.run } : {}),
        ...(d.subagentConfig ? { subagent: d.subagentConfig } : {}),
        ...(d.skillsConfig ? { skills: d.skillsConfig } : {}),
        ...(d.compactionBreakerConfig ? { compactionBreaker: d.compactionBreakerConfig } : {}),
        ...(d.verifyGuardConfig ? { verifyGuard: d.verifyGuardConfig } : {}),
        ...(d.onShellEvent !== undefined ? { onShellEvent: d.onShellEvent } : {}),
        ...(d.workMetricsSink !== undefined ? { workMetricsSink: d.workMetricsSink } : {}),
    };
};
