import { homedir } from "node:os";
import { join } from "node:path";
/** Resolve the home directory used for quanta state. Mirrors the seam used
 *  by `src/apps/cli/slash-commands.ts` (`QUANTA_PREFS_HOME` env override
 *  before `os.homedir()/.quanta`) so a single env knob isolates tests
 *  across every quanta surface. */
export const resolveQuantaHome = (env) => {
    const override = env.QUANTA_PREFS_HOME;
    if (override !== undefined && override !== "")
        return override;
    return join(homedir(), ".quanta");
};
/** Disk path for the ChatGPT-OAuth token JSON. */
export const chatgptTokenPath = (home) => join(home, "auth", "chatgpt.json");
