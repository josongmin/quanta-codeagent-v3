/**
 * `@/apps/terminal/verify-gate` — THIN surface barrel.
 *
 * The verify/converge SSOT (fake-green detection + no-leak taint + bounded converge-to-green) was
 * HOISTED to `@/agent/converge` (jul-3 architecture audit) so BOTH the terminal brain AND the bench
 * driver can reuse ONE implementation instead of three. The terminal surface re-exports it unchanged
 * so every `./verify-gate` consumer (brain-mode; the 2.0 best-of-N pair was retired by TB21-06)
 * stays byte-identical.
 *
 * The core lives at `@/agent` (a layer both surfaces legally import) precisely because the biome
 * fence forbids `src/apps/terminal/**` from reaching `@/runner/batch` — so the shared logic cannot
 * sit on either surface. See `src/agent/converge/index.ts` for the layered modules.
 */

export * from "@/agent/converge"
