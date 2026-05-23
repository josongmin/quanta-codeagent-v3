import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export class TokenStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = "TokenStoreError";
    }
}
/** Read the token record from disk. Returns `null` when absent. Throws
 *  TokenStoreError on permission / shape failure — we'd rather force a
 *  relogin than load a tampered or world-readable token. */
export const readToken = async (path) => {
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw new TokenStoreError(`read failed: ${e.message}`);
    }
    if (process.platform !== "win32") {
        const s = await stat(path);
        const mode = s.mode & 0o777;
        if ((mode & 0o077) !== 0) {
            throw new TokenStoreError(`token file has loose permissions (mode 0${mode.toString(8)}); ` +
                "expected 0600. Run /login again to regenerate.");
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        throw new TokenStoreError(`json parse failed: ${e.message}`);
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new TokenStoreError("token file is not a JSON object");
    }
    const obj = parsed;
    for (const k of ["access_token", "refresh_token", "expires_at"]) {
        if (typeof obj[k] !== "string") {
            throw new TokenStoreError(`missing/invalid field: ${k}`);
        }
    }
    return {
        access_token: obj.access_token,
        refresh_token: obj.refresh_token,
        expires_at: obj.expires_at,
        ...(typeof obj.id_token === "string" ? { id_token: obj.id_token } : {}),
        ...(typeof obj.account_id === "string" ? { account_id: obj.account_id } : {}),
        ...(typeof obj.plan_type === "string" ? { plan_type: obj.plan_type } : {}),
        ...(typeof obj.last_refresh === "string" ? { last_refresh: obj.last_refresh } : {}),
    };
};
/** Write the token record atomically with 0600 permissions. Atomic =
 *  write-to-tmp + rename, so a reader never sees a half-written file. */
export const writeToken = async (path, t) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(t, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
        await chmod(tmp, 0o600);
    }
    await rename(tmp, path);
};
/** Delete the token file. Idempotent — absent file is fine. */
export const deleteToken = async (path) => {
    try {
        await unlink(path);
    }
    catch (e) {
        if (e.code === "ENOENT")
            return;
        throw new TokenStoreError(`delete failed: ${e.message}`);
    }
};
/** True when the stored `expires_at` is in the past, or within `skewMs` of
 *  now (default 30s — so we don't race a token that's about to expire
 *  mid-flight). Unparseable timestamp ⇒ treat as expired (force relogin
 *  rather than risk a 401 mid-stream). */
export const isExpired = (t, nowMs, skewMs = 30_000) => {
    const exp = Date.parse(t.expires_at);
    if (Number.isNaN(exp))
        return true;
    return exp - skewMs <= nowMs;
};
