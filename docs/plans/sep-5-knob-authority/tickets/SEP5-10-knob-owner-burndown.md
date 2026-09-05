# SEP5-10 — knob read-authority classification and raw-env burn-down

**Priority:** P2
**Status:** LANDED
**Depends on:** SEP5-00
**Finding coverage:** D27, D28

## Goal

Route each knob through the correct temporal authority and reduce raw
`process.env.QUANTA_*` reads without converting startup/live gates into stale
snapshots. Clarify inventory metadata so `home` is not mistaken for a current
typed implementation.

## Frozen baseline

```text
KNOB_INVENTORY                 353
RUNTIME_CONFIG_KNOBS          192
env-key intersection            0
inventory home=runtime-config 228
raw process.env actual/ceiling 43 / 43
CLI_KNOBS ∩ CLI_FEATURE_GATES   7
runner knobs ∩ runtime knobs     4
```

Recompute these values at ticket start; they are snapshot-specific.

## Read-authority taxonomy

```ts
export type KnobReadAuthority =
  | "startup-seed"       // entrypoint mutates env before config freeze
  | "runtime-config"     // frozen typed snapshot
  | "injected-env"       // call-time behavior intentionally accepts env
  | "composition-gate"   // app/host availability decision
  | "runner-knob"        // mutates AgentConfig through the knob pipeline
  | "bench"
  | "credential-exempt"

export interface KnobInventoryEntry {
  readonly targetHome: KnobHome
  readonly readAuthority: KnobReadAuthority
  // existing key/kind/default/group/describe/readSite
}
```

Renaming `home` to `targetHome` is preferred. If compatibility requires keeping
`home`, add `readAuthority` and update its documentation; do not duplicate both
fields indefinitely.

## Candidate-specific decisions

- `QUANTA_GOAL` in `apps/cli/index.ts` is a startup preset mutation before the
  runtime config is consumed. Keep it as `startup-seed`; do not replace it with a
  previously frozen `runtimeConfig()` read.
- `QUANTA_SESSION_REGISTRY_SQLITE_PATH` and `...DISK_DIR` already have typed
  runtime-config fields. Change `renderCleanupDryRun` to accept/inject those
  resolved values or a runtime-config snapshot rather than reading globals.
- For the seven CLI knob/gate overlaps, select one declaration owner and derive
  help, default seeding, and lookup projections from it. Do not remove one list
  until all three projections are covered.
- The four runner/runtime dual-channel keys are documented apply no-ops. Keep
  them only if one channel owns discovery and the other owns mutation; otherwise
  remove the inert declaration after a behavior test.

## Write set

| File/path | Change |
|---|---|
| `src/config/knob-inventory/types.ts` | Add/rename metadata for target vs current read authority |
| `src/config/knob-inventory/*.ts` | Populate the new closed field for all 353 entries |
| `src/config/knob-inventory.ts` | Correct contract documentation and projections |
| `src/apps/cli/session-registry-cmd.ts` | Inject typed registry paths into cleanup dry-run |
| `src/apps/cli/index.ts` | Retain and document startup-seed authority; no blind replacement |
| `src/apps/cli/cli-knobs.ts` / `cli-feature-gates.ts` / `cli-seeded-gates.ts` | Derive the seven overlapping declarations from one owner where semantics match |
| runner knob manifests | Remove only proven inert duplicate declarations |
| `tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts` | Tighten the actual ceiling after removals |
| `tests/unit/knob-read-authority-parity.test.ts` | New closed-universe metadata and runtime projection test |

## Implementation batches

1. Add the closed taxonomy and classify every current inventory entry. Validation
   fails on missing/unknown authority.
2. Migrate the two session-registry cleanup reads through injected typed values.
3. Recompute raw count and tighten below 45; never edit the ceiling upward.
4. Resolve the seven CLI overlaps one by one with help+seed+read tests.
5. Resolve the four runner/runtime entries one by one, retaining documented
   dual-channel cases.
6. Refresh audit counts from runtime arrays.

## RED rails

- An inventory row without `readAuthority` fails.
- A `runtime-config` authority lacks a matching typed field/read.
- A `startup-seed` is evaluated after the config snapshot.
- Session cleanup ignores injected registry paths or reads `process.env`
  directly.
- Removing a CLI declaration drops its `/help` row or default seed.
- A newly introduced raw read exceeds the tightened ceiling.
- Runtime/inventory scans assert a non-zero known population and fail on an
  injected orphan/duplicate.

## Test and ratchet implementation

- Reflect the runtime/config arrays directly. At ticket start, freeze the
  recomputed inventory and runtime cardinalities; require every inventory entry
  to have exactly one valid `readAuthority`, unique key, and classified target
  owner. Do not hard-code the historical 353/192 as permanent truth.
- Extract the parity validator as a pure testable function. Clone the live
  inventory three times and inject one missing authority, one duplicate key, and
  one orphan runtime knob. Require rejection naming exactly the injected key;
  assert the live population floor before mutations.
- For session-registry cleanup, inject typed sqlite/disk paths, then set
  conflicting `process.env` values after construction. The dry-run must use only
  injected values. A mutation restoring the direct env read must select the
  conflicting path and fail.
- For each of seven CLI overlaps, table-test help rendering, default seed, and
  effective lookup from the canonical declaration. Removing any projection must
  fail its row; require all seven rows until each is explicitly retired.
- For each four runner/runtime overlaps, assert the documented discovery owner
  and mutation owner, or assert removal from both channels. A no-op declaration
  cannot count as behavior.
- Recompute the raw-env actual count after migration and lower
  `no-raw-process-env-knob-ratchet-hellgate.test.ts` to that number only after
  the removals are present. Mutation by adding one prohibited raw read must
  exceed the new ceiling. The ceiling is never raised.

## Proof rails

```sh
bun test tests/unit/knob-read-authority-parity.test.ts
bun test tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts
bun test tests/unit/cli/help-env-seeded-gates-parity.hellgate.test.ts
bun test tests/unit/cli/cli-feature-gate-seed-inheritance.hellgate.test.ts
bun test tests/unit/runtime-config-knobs*.test.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- All inventory entries state current read authority separately from target
  ownership.
- Session-registry cleanup uses its typed/injected values.
- Raw count and ceiling both decrease from the frozen baseline.
- CLI help/seed/read behavior remains derived and complete.
- Intentional dual-channel entries are explicit and tested, not inferred from
  duplicate keys.

## Stop conditions

- A migration changes call-time/live semantics to a stale frozen snapshot.
- A secret or credential is added to the general knob inventory.
- The raw ceiling is raised or a new unpinned rule/category is introduced.
- Bulk metadata generation guesses owners without reviewing read sites.
