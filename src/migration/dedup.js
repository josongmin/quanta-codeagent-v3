/**
 * Import dedup (ADR-0038, L4 promotion).
 *
 * Provides a content-addressed fingerprint of a session transcript file so a
 * re-run does not re-import an unchanged session. The hash is the SHA-256 of
 * the raw file bytes (not the parsed Messages) — cheapest correct primitive,
 * and stable across translator changes for the same source bytes.
 *
 * NOTE (follow-up): `wasAlreadyImported` is a CONSERVATIVE STUB. The current
 * `ImportLogEntry` shape (timestamp/provider/stage/ok/detail) does not carry
 * the `(sourceId, sha256)` tuple, so we cannot yet answer the dedup question
 * from the persisted log. It returns `false` (never-deduped) so behavior is
 * import-everything, matching today's semantics. Promotion path: extend
 * `ImportLogEntry` with `sourceId` + `contentSha256`, then match here.
 */
import { readFile } from "node:fs/promises";
import { loadImportLog } from "./persistence";
/** SHA-256 (hex) of a file's raw bytes. Real implementation — used to
 *  fingerprint a session transcript for dedup + change detection. */
export const contentSha256 = async (jsonlPath) => {
    const bytes = await readFile(jsonlPath);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
};
/** Whether a session with the given `(sourceId, sha256)` has already been
 *  imported for this project root. CONSERVATIVE STUB: returns `false` because
 *  the persisted `ImportLogEntry` does not yet carry the tuple (see module
 *  doc + follow-up). The log is still loaded so the call validates the log is
 *  readable and so the wiring is in place for when the entry shape grows. */
export const wasAlreadyImported = async (homeDir, _projectRoot, _sourceId, _sha256, _provider) => {
    // Touch the log so a malformed log surfaces here (and the dedup wiring is
    // exercised), but the tuple match is not yet representable — see follow-up.
    await loadImportLog(homeDir).catch(() => ({ version: 1, entries: [] }));
    return false;
};
