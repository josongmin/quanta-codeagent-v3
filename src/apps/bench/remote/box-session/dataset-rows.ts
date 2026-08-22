/**
 * LEAF — the preflight refusal error.
 *
 * ## What used to be here, and why it is gone
 *
 * This module was the JSONL-only dataset row reader (`readParsedDatasetRows` /
 * `loadParsedDatasetRowsOrThrow`), extracted so the profile layer could validate
 * rows without importing its own consumer. PMX-02 removed it: it was a SECOND
 * parser of the dataset file beside the run path's, and a JSONL-only one, so a
 * family whose corpus is an official JSON array would have had every remote
 * preflight silently see ZERO rows — "unreadable dataset" or, worse for the
 * ProMax gold-leak check, "no rows carry gold" on a file that is entirely gold.
 *
 * Dataset reading now has exactly ONE owner, `DatasetFamilyProfile.readCorpus`,
 * reached through `profiles/corpus-read.ts`. What remains here is the refusal
 * TYPE, which stays in this leaf so the profile-layer shape checks can throw it
 * without importing a consumer.
 *
 * Imports nothing.
 */

export class RemoteDatasetPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RemoteDatasetPreflightError"
  }
}
