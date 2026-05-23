/**
 * External-agent import log persistence (ADR-0038, Cluster D Feature 4).
 *
 * Mirrors Codex's `external_agent_session_imports.json`. Writes use a
 * sidecar lock file so concurrent imports cannot race; collision raises
 * {@link ImportLogBusyError} rather than silently merging.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QuantaError } from "@/shared";
/** Default log file location under `~/.quanta`. Caller-supplied `homeDir`
 *  lets tests redirect to a tmpdir. */
export const importLogPath = (homeDir) => join(homeDir, ".quanta", "external_agent_session_imports.json");
const lockPath = (homeDir) => `${importLogPath(homeDir)}.lock`;
/** Thrown when a writer cannot acquire the log file lock — surfaces the
 *  conflict to the caller instead of overwriting. */
export class ImportLogBusyError extends QuantaError {
    lockFile;
    constructor(lockFile) {
        super("import_log_busy", `Import log lock held: ${lockFile}.`);
        this.lockFile = lockFile;
    }
}
/** Read the log. Missing file ⇒ empty log (version 1). */
export const loadImportLog = async (homeDir) => {
    const path = importLogPath(homeDir);
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return { version: 1, entries: [] };
        throw err;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" ||
        parsed === null ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries)) {
        throw new Error(`Malformed import log at ${path}`);
    }
    return parsed;
};
/** Append one entry to the log, atomically (write-temp + rename). Holds an
 *  exclusive lock for the read-modify-write window; concurrent writers get
 *  {@link ImportLogBusyError}. */
export const appendImportLog = async (homeDir, entry) => {
    const path = importLogPath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    const lock = lockPath(homeDir);
    // Acquire — wx flag fails if lock exists.
    try {
        await writeFile(lock, String(process.pid), { flag: "wx" });
    }
    catch (err) {
        const code = err.code;
        if (code === "EEXIST")
            throw new ImportLogBusyError(lock);
        throw err;
    }
    try {
        const current = await loadImportLog(homeDir);
        const next = {
            version: 1,
            entries: [...current.entries, entry],
        };
        const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(tmp, path);
    }
    finally {
        await rm(lock, { force: true });
    }
};
