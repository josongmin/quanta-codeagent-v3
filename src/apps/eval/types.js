/**
 * Eval app — cross-tier shared types.
 *
 * The eval app composes existing slices (RFC §4 apps/eval — composition only,
 * NOT a new slice). Types here are intentionally minimal and local to the app.
 * Every Tier produces `ScenarioResult`s and appends to ONE store
 * (`storage/result-store.ts`) so the `report/` view is a single aggregation.
 */
export {};
