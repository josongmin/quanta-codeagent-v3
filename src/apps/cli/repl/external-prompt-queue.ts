/**
 * `apps/cli/repl/external-prompt-queue.ts` — surface alias.
 *
 * ADR-0303 thin-surface relocation: the generic, abort-aware out-of-band prompt
 * FIFO now lives below `src/apps/**` in `@/runner/orchestrate` (it is reusable
 * runtime semantics with zero terminal coupling — any interactive surface needs
 * the same waiter race logic). The CLI keeps only this one-line binding of the
 * generic queue to its own `CliPromptInput` element type, so every call site
 * (`new ExternalPromptQueue()`, `.push(text)`, `.next(signal)`) is unchanged.
 */
import { ExternalPromptQueue as GenericExternalPromptQueue } from "@/runner/orchestrate"
import type { CliPromptInput } from "./prompt-types"

export class ExternalPromptQueue extends GenericExternalPromptQueue<CliPromptInput> {}
