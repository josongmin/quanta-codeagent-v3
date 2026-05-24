import { describe, test } from "bun:test"

const isDarwin = (): boolean => process.platform === "darwin"

/**
 * `describe` that runs only on darwin. On other platforms the suite is
 * registered with `describe.skip` so test output records a polite skip
 * instead of a silent pass.
 */
export const describeOnDarwin = isDarwin() ? describe : describe.skip

/**
 * `test` that runs only on darwin. Non-darwin platforms skip with a
 * polite recorded entry.
 */
export const itOnDarwin = isDarwin() ? test : test.skip
