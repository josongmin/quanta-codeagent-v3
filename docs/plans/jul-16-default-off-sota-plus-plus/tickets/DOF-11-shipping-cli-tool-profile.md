# DOF-11 - shipping CLI tool-profile authority

**Priority:** P1  
**Depends on:** none  
**Owner:** `src/apps/cli/internal/argv.ts` and shared CLI argument authority

The compiled CLI enters `src/apps/cli/index.ts`; its prompt parser does not consume `--tool-profile` values, while the separate host parser does. Consolidate valued-option knowledge so `quanta --tool-profile ask "fix x"` activates the profile and yields prompt `fix x`, never `ask fix x`.

## DoD

- `--tool-profile` and `--tool-profile=<name>` have one validated closed enum
- `/profile` and startup profile mutate/read the same session state
- invalid and missing values fail before REPL/LLM startup
- prompt byte identity holds for unrelated args
- a negative mutation removing the valued flag makes the test RED

## Verification

```sh
bun test tests/unit/apps/agent/cli-args-dispatch-table.test.ts tests/unit/cli/repl-surface-wire-hellgate.test.ts
bun run typecheck:all
```
