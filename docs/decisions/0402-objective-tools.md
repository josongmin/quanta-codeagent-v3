# ADR-0402 — Objective LLM tools (`objective_set` / `objective_update` / `objective_get`)

**Status:** Accepted (2026-05-28)
**Companion to:** ADR-0394 (first-class per-thread `Objective` substrate — MODEL ONLY wave).
**Slice:** `src/tool/objective/` (new tool slice, 1 file) + `src/agent/tier1/objective.ts`
(new composition-root builder) + 3 surgical wire edits (`features.ts` import +
push, `tier1/index.ts` re-export, `types.ts` slot + Pick).
**Default-OFF:** Yes — `config.objective` absent ⇒ builder returns `[]`,
the 3 tools are NOT registered, the ToolRegistry stays byte-identical.

## Context

ADR-0394 shipped the per-thread `Objective` substrate (`ObjectivePort` with
`set/get/updateStatus/addBlocker/clearBlocker/setNextActions/markCriterion/
recordUsage/list/toSnapshot/fromSnapshot`) and the in-memory reference store
(`createObjectiveStore`) as a closed slice. That wave was MODEL ONLY — no
agent / dispatch / prompt / tool / feature seam referenced it. The slice
allocated nothing until a host called `createObjectiveStore()`.

What was missing: an LLM-facing surface so the AGENT ITSELF can declare its
objective, surface blockers, and list next actions. Without that, the
substrate is operator-only — a host can build an objective object, but the
model running the turn cannot read or write it. This loses the structural
win the substrate was built for (compaction-preserve, resume re-hydrate,
subagent-result attribution) because nothing in the model loop touches the
typed object.

## Decision

Add THREE synchronous tools, wired through the same default-OFF Tier-1 seam
as the synchronous `delegate` (ADR-0393) and the background subagent trio
(ADR-0140):

1. **New tool slice `src/tool/objective/`** (slice-fence clean — imports
   `@/agent/objective` types only, `../types` for Tool / ToolContext /
   ToolEvent / ToolResult, and `zod`. NEVER `@/agent` core).

   - `index.ts` — three tools sharing one closed `ObjectivePort`:
     - `objective_set` — set/replace per-thread objective with `goal`
       (1-2 sentences), optional `success_criteria[]`, optional `budget`
       (`max_tokens?` / `max_turns?`).
     - `objective_update` — partial mutate via a 6-arm `op` discriminated
       union: `status` / `addBlocker` / `clearBlocker` / `nextActions` /
       `markCriterion` / `recordUsage`. Each variant routes to exactly one
       port method.
     - `objective_get` — read the current objective. Returns `ok:false`
       with `"no objective set for thread <id>"` when the thread has none.

   All three tools:
   - **HITL tier**: `pre-approval-ok` (information-class — no destructive
     side effect; no FS / shell / network). The 3 tools are gateable through
     the standard tier without forcing a confirm.
   - **NO-THROW**: schema validation via `safeParse` catches malformed input
     (missing `thread_id` / unknown `op.kind` / bad enum) at the boundary;
     port calls are wrapped in `try/catch` so a hostile port that throws
     surfaces as `{ ok: false, output: "<tool> error: <message>" }`. A tool
     NEVER bubbles past the loop.
   - **Output**: `objective_set` / `objective_update` echo the NEW state
     (goal + status + blockers count + criteria + nextActions + budget);
     `objective_get` returns the same render, or a typed `ok:false` string.

2. **New Tier-1 builder `src/agent/tier1/objective.ts`** — `buildObjectiveBlock(config)
   ⇒ Tool[]`. Returns `[]` when `config.objective` is `undefined`, otherwise
   returns the 3 tools from `objectiveTools(port)`. Mirrors the
   `buildDelegateBlock` / `buildSubagentBgBlock` pattern.

3. **Wire (3 shared-file diffs)**:

   - `src/agent/types.ts`:
     - new `import type { ObjectivePort } from "./objective"`.
     - new `readonly objective?: ObjectivePort` on `AgentConfig` (helper-
       only port slot, paragraph documenting wire contract).
     - new `"objective"` entry in the `FeaturesConfig` Pick union (next to
       the other Wave-1 port slots — `budgetLedger` / `conversationCheckpoint`
       / `responsesContinuation`).

   - `src/agent/features.ts`:
     - `buildObjectiveBlock` added to the existing tier1 named-import block.
     - one new push line in `buildSessionFeatures`: `extraTools.push(...buildObjectiveBlock(config))`
       between `buildDelegateBlock` and `buildBudgetBlock` (grouping with
       the other "port-slot ⇒ tools" builders).

   - `src/agent/tier1/index.ts`:
     - one new export: `export { buildObjectiveBlock } from "./objective"`
       (alphabetical, between `buildForkSessionBlock` and `buildPlanExitBlock`).

## Schemas

```typescript
// objective_set
z.object({
  thread_id: z.string().min(1),
  goal: z.string().min(1),
  success_criteria: z.array(z.string()).optional(),
  budget: z.object({
    max_tokens: z.number().optional(),
    max_turns: z.number().optional(),
  }).optional(),
})

// objective_update
z.object({
  thread_id: z.string().min(1),
  op: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("status"), status: z.enum(["active","blocked","completed"]) }),
    z.object({ kind: z.literal("addBlocker"), reason: z.string(),
               waiting_on: z.enum(["user","tool","network","child_agent"]) }),
    z.object({ kind: z.literal("clearBlocker"), blocker_id: z.string() }),
    z.object({ kind: z.literal("nextActions"), actions: z.array(z.string()) }),
    z.object({ kind: z.literal("markCriterion"), criterion_id: z.string(), met: z.boolean() }),
    z.object({ kind: z.literal("recordUsage"), tokens: z.number().optional(), turns: z.number().optional() }),
  ]),
})

// objective_get
z.object({ thread_id: z.string().min(1) })
```

The `op` union is CLOSED — `safeParse` rejects unknown `kind` at the
boundary, so the port is never called with a malformed update.

## Default-OFF / byte-identical

`config.objective` absent ⇒ `buildObjectiveBlock` returns `[]` ⇒ the 3 tools
are NOT registered ⇒ the ToolRegistry the loop builds is structurally
identical to the pre-ADR registry ⇒ every legacy caller is byte-identical
(RFC §1.2). Importing `@/tool/objective` allocates nothing at module load
(only type imports + pure tool factories); the tools are not instantiated
until `objectiveTools(port)` is called from the tier-1 builder.

## Status derivation (substrate invariant — unchanged)

The 3 tools never override the ADR-0394 status derivation rule. They simply
relay caller intent (`updateStatus`, `addBlocker`, etc.) and re-render
`port.get()` output for the model. Specifically:

- `objective_update { kind: "status", status: "blocked" }` is a NO-OP on the
  underlying explicit status (the substrate stores only `"active"|"completed"`
  as explicit intent; `"blocked"` is derived from `blockers.length > 0`).
  This is intentional and the substrate's contract — the tool surfaces this
  honestly: the next `objective_get` reads the derived status, not the
  attempted assignment.
- `objective_update { kind: "addBlocker", … }` ⇒ status becomes `"blocked"`
  on the next read (highest priority).
- Auto-completion (all criteria met) still requires ≥1 criterion.

## NO-THROW contract

Every tool's `execute` wraps the port call in a try/catch and yields a
typed `{ ok: false, output: "<tool> error: <message>" }` instead of
throwing. The substrate's port is itself no-throw (ADR-0394), but a hostile
mock port that DOES throw must still be absorbed. The hellgate proves both
the substrate-no-throw path AND the throwing-fake-port path collapse to
`ok:false`.

## Surface contract

- The 3 tools land in `extraTools` next to the other Tier-1 port-slot
  tools. The dispatch seam treats them like every other tool — same
  registry, same admissibility gate, same hitl-tier path.
- The agent loop / prompt / dispatch are UNCHANGED. The model decides when
  to call these tools (the descriptions guide it: "use at the START of
  work" / "to surface blockers" / "to read the current objective").
- Operator wire: the composition root builds the port once per session
  (`createObjectiveStore()`) and threads it through `AgentConfig.objective`.

## Tests

`tests/unit/objective-tools-hellgate.test.ts` — 30 cases / 62 expects:

- **A. WIRE** (8): tier1 barrel re-exports the builder; `AgentConfig`
  accepts the slot; `FeaturesConfig` Pick includes `"objective"`; slot
  absent ⇒ no tools in extraTools; slot wired ⇒ all 3 land; builder binds
  to the SAME port (set + get round-trip routes through it); builder
  returns `[]` when absent / 3 when present.
- **B. SCHEMA** (6): each malformed-input class (empty goal / missing
  thread_id / unknown op.kind / bad waiting_on enum / bad status enum /
  missing thread_id on get) yields ok:false at the safeParse boundary.
- **C. OP VARIANT ROUND-TRIP** (7): each of the 6 `op` variants
  (`status` / `addBlocker` / `clearBlocker` / `nextActions` /
  `markCriterion` / `recordUsage`) round-trips through the wired port +
  `recordUsage` accepts tokens-only.
- **D. NO-THROW + OUTPUT** (7): throwing port (set/get/addBlocker)
  surfaces as ok:false; `objective_get` unknown thread returns the typed
  "no objective" string; rendered output contains goal + status; the get
  output contains blockers count + nextActions; `objective_update` echoes
  the new state.
- **E. HITL TIER** (2): all 3 tools declare `pre-approval-ok`; `get` is
  read-only, `set`/`update` are not.

## Wire matrix

| File                                            | Change                                                                          |
|-------------------------------------------------|----------------------------------------------------------------------------------|
| `src/tool/objective/index.ts`                   | NEW — 3 tools + `objectiveTools(port)` builder                                  |
| `src/agent/tier1/objective.ts`                  | NEW — `buildObjectiveBlock(config)` ⇒ `Tool[]`                                  |
| `src/agent/tier1/index.ts`                      | +1 line — `export { buildObjectiveBlock } from "./objective"`                   |
| `src/agent/features.ts`                         | +1 import entry + 3 lines (push + comment in `buildSessionFeatures`)            |
| `src/agent/types.ts`                            | +1 import + 1 field on `AgentConfig` + 1 entry in `FeaturesConfig` Pick         |
| `tests/unit/objective-tools-hellgate.test.ts`   | NEW — 30 hellgate cases / 62 expects                                            |
| `tools/feature-catalog/features/09-integration/objective-tools.yaml` | NEW — fc catalog row                                       |

## Consequences

**Positive:**
- The `Objective` substrate is now agent-reachable. The model can declare
  goal, surface blockers, list next actions through typed tools — closing
  the loop ADR-0394 opened.
- Slice fence preserved: the tool slice imports only `@/agent/objective`
  (the closed substrate slice) and never reaches `@/agent` core.
- Default-OFF byte-identical for every legacy caller.

**Deferred:**
- Compaction-preserve: a future ADR will fold the objective snapshot into
  compaction so summarizers do not erase declared goal/blockers/nextActions.
- Resume re-hydrate: a future ADR will rehydrate the objective via
  `fromSnapshot` at session restore.
- Subagent attribution: future ADR will attribute subagent results to the
  parent thread's objective (`markCriterion` / `recordUsage`).
- Prompt surface: a future ADR may render the current objective inline in
  the per-turn reminder. Today the model must call `objective_get` to read
  it (cheap — pure read).

**Negative:**
- Three more tools in the registry when the port is wired. Each only
  registered when the host explicitly opts in.
