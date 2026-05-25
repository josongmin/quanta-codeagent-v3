/**
 * ADR-0288/0289 — `@/remote` slice barrel.
 *
 * Public surface for the remote execution plane (E6 productization). Currently
 * re-exports the runner sub-slice — future sub-slices (e.g. git-remote
 * integration, PR auto-attach) can land alongside without rewriting consumers.
 */

export * from "./runner"
