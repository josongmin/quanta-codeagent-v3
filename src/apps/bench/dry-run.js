/** Build the plan from an already-loaded corpus. Never runs an LLM. */
export const buildDryRunPlan = (corpusRoot, instances, cfg) => {
    const selected = cfg.limit === null ? instances : instances.slice(0, cfg.limit);
    return {
        corpusRoot: corpusRoot || "(unset)",
        total: instances.length,
        selected: selected.length,
        n: cfg.n,
        limit: cfg.limit,
        pythonHarness: cfg.pythonHarness,
        sample: selected.slice(0, 10).map((i) => i.id),
    };
};
/** Render a DryRunPlan as the lines the CLI prints (also asserted by tests). */
export const formatDryRunPlan = (plan) => [
    "dry-run plan (NO LLM will be called)",
    `  corpus: ${plan.corpusRoot}`,
    `  instances: ${plan.total} loaded, ${plan.selected} selected${plan.limit === null ? "" : ` (--limit ${plan.limit})`}`,
    `  best-of-n: ${plan.n}`,
    `  verifier: ${plan.pythonHarness ? "official python swebench harness" : "local testCmd"}`,
    `  sample ids: ${plan.sample.join(", ") || "(none)"}`,
];
