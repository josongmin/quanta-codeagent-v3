# No-go rules

1. Do not infer root from `depth === undefined`.
2. Do not trust `SubagentRequest.depth`, tool input, IPC, CLI, or metadata as lineage authority.
3. Do not call the private agent kernel outside the root/descendant entry owner.
4. Do not add per-producer depth arithmetic after the central admission seam exists.
5. Do not use tool names as the runtime spawn-capability authority.
6. Do not classify `team_create`/`team_delete` as descendant creation.
7. Do not let per-call or legacy config widen the session-pinned host policy.
8. Do not silently choose one value when depth aliases conflict.
9. Do not auto-resume a legacy handle without lineage.
10. Do not start a child before its lineage receipt is durably written.
11. Do not label metrics with session, agent, task, handle, or policy IDs.
12. Do not flip the default from `3` to `1` before all pre-closeout hellgates pass.
13. Do not add a god-module/function allowlist entry to land this work.
14. Do not edit `docs/10.feature-catalog.md` directly; update YAML and run `bun fc build`.

