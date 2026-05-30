#!/usr/bin/env bun
/**
 * ADR-0132 Phase E — reactor cron watcher.
 *
 * Out-of-process companion to the agent loop. Drives `TriggerSourcePort`
 * polling on a cadence (cron or systemd timer); each fired trigger is sent
 * to the live CLI surface over the per-session reactor socket. The CLI host
 * remains the authority for the self-wake guards (`env` / quiet window /
 * prior outcome) because only the host knows current session state.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildSystemPrompt, loadMcpTools, lspDiagnosticsTool, lspNavToolList, } from "@/agent";
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint";
import { startAutomationEngineTicker } from "@/agent/loop-helpers";
import { pickProvider, tryCreateLLM } from "@/llm";
import { StructuredLogger } from "@/observability";
import { createCiTriggerSource, createInMemorySeenRuns, createPrCommentTriggerSource, REACTOR_ENV_FLAG, } from "@/reactor";
import { buildCompactionBreakerConfigCore, buildEmbedderCore, buildMemoryConfigCore, buildSearchPipelineFromEnv, buildSkillsConfigCore, buildStoreCore, buildSubagentConfigCore, buildSummarizerLlmCore, buildToolingCore, buildVerifyGuardConfigCore, parseRecallTiers, } from "@/runner/assemble";
import { buildSharedExecutionPlaneSessionDeps } from "@/runner/session-execution-plane";
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto";
import { resolveSandboxProfileFromEnv } from "@/runtime";
import { assembleAutomation } from "@/scheduler/runtime-wire";
import { JsonlRecorder } from "@/stream";
import { automationUpdateTool, gitTools } from "@/tool";
import { runMode as runDaemonMode } from "../src/apps/agent/mode-presets/daemon";
import { readMcpConfig } from "../src/apps/cli/internal";
import { publishReactorWatchTrigger, reactorWatchSocketPath, } from "../src/apps/cli/reactor-watch-bridge";
import { buildSimulatedMessage } from "../src/reactor/self-wake";
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const HELP_TEXT = `reactor-watch — ADR-0132 cron watcher

USAGE:
  bun run scripts/reactor-watch.ts --pr <ref> --session-id <id>
                                   [--delivery <socket|daemon>]
                                   [--socket-path <path>] [--daemon-log-path <path>]
                                   [--seen-runs-path <path>] [--watermarks-path <path>]
                                   [--no-pr-comments] [--interval-ms <n>]
                                   [--once] [--dry-run] [--help]

OPTIONS:
  --pr <ref>           PR identifier accepted by 'gh' (number / URL / slug#n).
                       Required UNLESS --help.
  --session-id <id>    Live CLI session id that owns the reactor socket.
                       Also used as the stable daemon supervisor session id.
                       Required unless --dry-run or --help.
  --delivery <kind>    Trigger delivery backend. "socket" (default) targets
                       a live REPL bridge. "daemon" runs the detached daemon
                       preset in-process, one trigger at a time.
  --socket-path <path> Override the per-session reactor socket path.
                       Default: ~/.quanta/reactor-<session-id>.sock
  --daemon-log-path <path>
                       JSONL event log for detached daemon delivery.
                       Default: ~/.quanta/reactor-daemon-<session-id>.jsonl
  --seen-runs-path <path>
                       Persist completed CI run ids across restarts.
                       Default: ~/.quanta/reactor-seen-runs-<pr>.json
  --watermarks-path <path>
                       Persist PR-comment watermarks across restarts.
                       Default: ~/.quanta/reactor-watermarks-<pr>.json
  --no-pr-comments     Disable PR-comment polling; watch CI completion only.
  --interval-ms <n>    Poll cadence in ms. Default ${DEFAULT_INTERVAL_MS}. Min ${MIN_INTERVAL_MS}.
  --once               Poll a single time and exit. Useful for cron drivers.
  --dry-run            Print triggers as JSONL to stdout. Does NOT enable
                       self-wake; the env-flag guard is bypassed.
  --help               Show this help.

ENV:
  ${REACTOR_ENV_FLAG}=1  Required to actually wake the agent. Without it
                            the watcher polls but never enqueues a turn,
                            even outside --dry-run.
`;
const takeOptionalValue = (argv, i) => argv[i + 1];
const setValueArg = (state, key, argv, i) => {
    const value = takeOptionalValue(argv, i);
    if (value === undefined)
        return i;
    state[key] = value;
    return i + 1;
};
const setIntervalArg = (state, argv, i) => {
    const value = takeOptionalValue(argv, i);
    if (value === undefined)
        return i;
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n >= MIN_INTERVAL_MS)
        state.intervalMs = n;
    return i + 1;
};
const setDeliveryArg = (state, argv, i) => {
    const value = takeOptionalValue(argv, i);
    if (value === "socket" || value === "daemon")
        state.delivery = value;
    return value === undefined ? i : i + 1;
};
const applyArgToken = (state, argv, i) => {
    switch (argv[i]) {
        case "--help":
        case "-h":
            state.help = true;
            return i;
        case "--once":
            state.once = true;
            return i;
        case "--dry-run":
            state.dryRun = true;
            return i;
        case "--no-pr-comments":
            state.prComments = false;
            return i;
        case "--pr":
            return setValueArg(state, "prRef", argv, i);
        case "--session-id":
            return setValueArg(state, "sessionId", argv, i);
        case "--socket-path":
            return setValueArg(state, "socketPath", argv, i);
        case "--daemon-log-path":
            return setValueArg(state, "daemonLogPath", argv, i);
        case "--seen-runs-path":
            return setValueArg(state, "seenRunsPath", argv, i);
        case "--watermarks-path":
            return setValueArg(state, "watermarksPath", argv, i);
        case "--interval-ms":
            return setIntervalArg(state, argv, i);
        case "--delivery":
            return setDeliveryArg(state, argv, i);
        default:
            return i;
    }
};
export const parseArgs = (argv) => {
    const state = {
        prRef: undefined,
        sessionId: undefined,
        socketPath: undefined,
        seenRunsPath: undefined,
        watermarksPath: undefined,
        daemonLogPath: undefined,
        intervalMs: DEFAULT_INTERVAL_MS,
        delivery: "socket",
        prComments: true,
        once: false,
        dryRun: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        i = applyArgToken(state, argv, i);
    }
    return state;
};
const sanitizePrToken = (prRef) => {
    const cleaned = prRef.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-.]+/, "_");
    return cleaned.length > 0 ? cleaned : "pr";
};
const sanitizeSessionToken = (sessionId) => {
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-.]+/, "_");
    return cleaned.length > 0 ? cleaned : "session";
};
export const reactorWatchSeenRunsPath = (prRef, home = homedir()) => join(home.replace(/\/+$/, ""), ".quanta", `reactor-seen-runs-${sanitizePrToken(prRef)}.json`);
export const reactorWatchWatermarksPath = (prRef, home = homedir()) => join(home.replace(/\/+$/, ""), ".quanta", `reactor-watermarks-${sanitizePrToken(prRef)}.json`);
export const reactorDaemonLogPath = (sessionId, home = homedir()) => join(home.replace(/\/+$/, ""), ".quanta", `reactor-daemon-${sanitizeSessionToken(sessionId)}.jsonl`);
const normalizeSeenRuns = (parsed) => {
    if (Array.isArray(parsed)) {
        return parsed.filter((value) => typeof value === "string");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return [];
    const runIds = parsed.runIds;
    return Array.isArray(runIds)
        ? runIds.filter((value) => typeof value === "string")
        : [];
};
export const loadSeenRunsSeed = async (path) => {
    try {
        const raw = await readFile(path, "utf8");
        return normalizeSeenRuns(JSON.parse(raw));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return [];
        return [];
    }
};
const normalizeWatermarkSnapshot = (parsed) => {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return {};
    const raw = parsed.watermarks;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return {};
    const entries = Object.entries(raw).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string");
    return Object.fromEntries(entries);
};
export const loadWatermarkSnapshot = async (path) => {
    try {
        const raw = await readFile(path, "utf8");
        return normalizeWatermarkSnapshot(JSON.parse(raw));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return {};
        return {};
    }
};
export const persistWatermarkSnapshot = async (path, snapshot) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ watermarks: snapshot }, null, 2)}\n`, "utf8");
    await rename(tmp, path);
};
export const createFileBackedWatermarkStore = (path) => ({
    load: async (key) => (await loadWatermarkSnapshot(path))[key],
    save: async (key, value) => {
        const next = { ...(await loadWatermarkSnapshot(path)), [key]: value };
        await persistWatermarkSnapshot(path, next);
    },
});
export const persistSeenRunsSnapshot = async (path, store) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ runIds: store.snapshot() }, null, 2)}\n`, "utf8");
    await rename(tmp, path);
};
const prCommentWatermarkKey = (repoSlug, prNumber) => `${repoSlug}#${prNumber}`;
const parsePrUrlContext = (url) => {
    const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/i.exec(url.trim());
    if (m === null)
        return undefined;
    const prNumber = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0)
        return undefined;
    return { repoSlug: m[1], prNumber };
};
const parseSlugRefContext = (prRef) => {
    const m = /^([^#]+\/[^#]+)#(\d+)$/.exec(prRef.trim());
    if (m === null)
        return undefined;
    const prNumber = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0)
        return undefined;
    return { repoSlug: m[1], prNumber };
};
const safeJsonObject = (raw) => {
    try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== "object" || Array.isArray(v))
            return undefined;
        return v;
    }
    catch {
        return undefined;
    }
};
export const resolvePrCommentContext = async (opts) => {
    const direct = parseSlugRefContext(opts.prRef) ?? parsePrUrlContext(opts.prRef);
    if (direct !== undefined) {
        return {
            ...direct,
            watermarkKey: prCommentWatermarkKey(direct.repoSlug, direct.prNumber),
        };
    }
    const res = await opts.ghCliPort.run(["pr", "view", opts.prRef, "--json", "url,number"], opts.repoCwd, opts.signal);
    if (res.exitCode !== 0)
        return undefined;
    const parsed = safeJsonObject(res.stdout);
    if (parsed === undefined)
        return undefined;
    const urlCtx = typeof parsed.url === "string" && parsed.url.length > 0
        ? parsePrUrlContext(parsed.url)
        : undefined;
    if (urlCtx === undefined)
        return undefined;
    const prNumber = typeof parsed.number === "number" && Number.isFinite(parsed.number) && parsed.number > 0
        ? Math.floor(parsed.number)
        : urlCtx.prNumber;
    return {
        repoSlug: urlCtx.repoSlug,
        prNumber,
        watermarkKey: prCommentWatermarkKey(urlCtx.repoSlug, prNumber),
    };
};
const ghCliPort = (_repoCwd) => ({
    run: async (args, cwd, signal) => {
        const child = Bun.spawn(["gh", ...args], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            ...(signal !== undefined ? { signal } : {}),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { stdout, stderr, exitCode };
    },
});
/**
 * One-shot poll for the watcher. Returns the triggers that fired AND the
 * decision the watcher took (`enqueued` if self-wake injected, `dry-run` if
 * the dry-run flag short-circuited, `env-off` if the flag guard fired).
 *
 * Pure-shape helper so the same code runs under `--once` and inside the
 * recurring `setInterval` body.
 */
export const pollOnce = async (opts) => {
    const triggers = await opts.source.poll();
    if (triggers.length === 0)
        return { triggers, action: "no-trigger" };
    if (opts.dryRun)
        return { triggers, action: "dry-run" };
    if (opts.env.get(REACTOR_ENV_FLAG) !== "1") {
        return { triggers, action: "env-off" };
    }
    return { triggers, action: "enqueued" };
};
export const createQueuedMessageDelivery = (opts) => {
    const renderTriggerMessage = opts.renderTriggerMessage ?? buildSimulatedMessage;
    const queue = [];
    let activeDrain;
    let closed = false;
    const drain = async () => {
        try {
            while (queue.length > 0) {
                const item = queue[0];
                if (item === undefined)
                    continue;
                try {
                    await opts.runMessage(item.message);
                    item.resolve();
                }
                catch (error) {
                    item.reject(error);
                }
                finally {
                    queue.shift();
                }
            }
        }
        finally {
            activeDrain = undefined;
            if (queue.length > 0 && !closed)
                activeDrain = drain();
        }
    };
    const ensureDrain = () => {
        if (activeDrain === undefined)
            activeDrain = drain();
        return activeDrain;
    };
    const enqueueMessage = (message) => new Promise((resolve, reject) => {
        if (closed) {
            reject(new Error("queued delivery is closed"));
            return;
        }
        queue.push({ message, resolve, reject });
        void ensureDrain();
    });
    return {
        enqueueMessage,
        deliverTrigger: (trigger) => enqueueMessage(renderTriggerMessage(trigger)),
        close: async () => {
            closed = true;
            await activeDrain;
            await opts.onClose?.();
        },
    };
};
const parsePositiveInt = (raw) => {
    if (raw === undefined || raw === "")
        return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};
const buildDaemonStore = (envSource) => buildStoreCore({
    ...(envSource.QUANTA_MEMORY !== undefined ? { kind: envSource.QUANTA_MEMORY } : {}),
    ...(envSource.QUANTA_MEMORY_PATH !== undefined ? { path: envSource.QUANTA_MEMORY_PATH } : {}),
});
const buildDaemonEmbedder = (envSource, store) => buildEmbedderCore({
    store,
    disabled: envSource.QUANTA_MEMORY_EMBED === "off",
    ...(envSource.OPENAI_API_KEY !== undefined ? { apiKey: envSource.OPENAI_API_KEY } : {}),
    ...(envSource.OPENAI_BASE_URL !== undefined ? { baseURL: envSource.OPENAI_BASE_URL } : {}),
    ...(envSource.QUANTA_MEMORY_EMBED_MODEL !== undefined
        ? { model: envSource.QUANTA_MEMORY_EMBED_MODEL }
        : {}),
});
const buildDaemonMemoryConfig = (envSource, store) => {
    const rawLimit = envSource.QUANTA_MEMORY_RECALL_LIMIT;
    const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const recallTiers = parseRecallTiers(envSource.QUANTA_MEMORY_RECALL_TIERS);
    return buildMemoryConfigCore({
        store,
        ...(Number.isFinite(limit) ? { recallLimit: limit } : {}),
        ...(envSource.QUANTA_MEMORY_DISTILL === "off" ? { distill: false } : {}),
        ...(envSource.QUANTA_MEMORY_CONSOLIDATE === "off" ? { consolidate: false } : {}),
        ...(envSource.QUANTA_MEMORY_SELF_EDIT === "off" ? { selfEditTools: false } : {}),
        ...(recallTiers !== undefined ? { recallTiers } : {}),
    });
};
const buildDaemonSubagentConfig = (envSource) => buildSubagentConfigCore({
    enabled: envSource.QUANTA_SUBAGENT !== undefined,
    ...(parsePositiveInt(envSource.QUANTA_SUBAGENT_MAX_DEPTH) !== undefined
        ? { maxDepth: parsePositiveInt(envSource.QUANTA_SUBAGENT_MAX_DEPTH) }
        : {}),
});
const buildDaemonSkillsConfig = (envSource) => buildSkillsConfigCore({
    enabled: envSource.QUANTA_SKILLS === "1" || envSource.QUANTA_SKILLS_DIR !== undefined,
    ...(envSource.QUANTA_SKILLS_DIR !== undefined ? { dir: envSource.QUANTA_SKILLS_DIR } : {}),
});
const buildDaemonCompactionBreakerConfig = (envSource) => buildCompactionBreakerConfigCore({
    ...(envSource.QUANTA_COMPACT_BREAKER === "off" ? { disabled: true } : {}),
    ...(parsePositiveInt(envSource.QUANTA_COMPACT_BREAKER_REACTIVE_MAX) !== undefined
        ? { reactiveMax: parsePositiveInt(envSource.QUANTA_COMPACT_BREAKER_REACTIVE_MAX) }
        : {}),
    ...(parsePositiveInt(envSource.QUANTA_COMPACT_BREAKER_PROACTIVE_MAX) !== undefined
        ? { proactiveMax: parsePositiveInt(envSource.QUANTA_COMPACT_BREAKER_PROACTIVE_MAX) }
        : {}),
});
const buildDaemonVerifyGuardConfig = (envSource) => buildVerifyGuardConfigCore({
    enabled: envSource.QUANTA_VERIFY_GUARD !== undefined,
    ...(parsePositiveInt(envSource.QUANTA_VERIFY_GUARD_MAX_TRIPS) !== undefined
        ? { maxTrips: parsePositiveInt(envSource.QUANTA_VERIFY_GUARD_MAX_TRIPS) }
        : {}),
});
const loadDaemonMcp = async (slog, envSource) => {
    const mcpConfigs = await readMcpConfig(slog, envSource);
    return mcpConfigs.length > 0 ? await loadMcpTools(mcpConfigs) : { tools: [], clients: [] };
};
const buildDaemonAutomationSlot = (input, envSource) => assembleAutomation({ get: (name) => envSource[name] }, {
    agentLoop: {
        enqueueUserMessage: async (message) => {
            await input.enqueueUserMessage(message);
        },
    },
}) ?? undefined;
const buildDaemonTooling = (opts) => {
    const { input, envSource, slog, mcpTools, automationSlot } = opts;
    const lspTools = envSource.QUANTA_LSP === "1" ? [lspDiagnosticsTool()] : [];
    const lspNavTools = envSource.QUANTA_LSP_TOOLS === "full" ? lspNavToolList() : [];
    const gitToolList = envSource.QUANTA_GIT_TOOLS === "1" ? gitTools() : [];
    const store = buildDaemonStore(envSource);
    const embedder = buildDaemonEmbedder(envSource, store);
    const memoryConfig = buildDaemonMemoryConfig(envSource, store);
    const subagentConfig = buildDaemonSubagentConfig(envSource);
    const skillsConfig = buildDaemonSkillsConfig(envSource);
    const compactionBreakerConfig = buildDaemonCompactionBreakerConfig(envSource);
    const verifyGuardConfig = buildDaemonVerifyGuardConfig(envSource);
    const searchWire = buildSearchPipelineFromEnv(envSource, input.cwd);
    const extraTools = [
        ...(searchWire !== null ? [searchWire.tool] : []),
        ...(automationSlot !== undefined ? [automationUpdateTool(automationSlot.engine)] : []),
    ];
    return buildToolingCore({
        store,
        embedder,
        sessionId: input.sessionId,
        memoryConfig,
        subagentConfig,
        skillsConfig,
        compactionBreakerConfig,
        verifyGuardConfig,
        mcpTools,
        lspTools,
        lspNavTools,
        gitToolList,
        ...(extraTools.length > 0 ? { extraTools } : {}),
        ...(searchWire !== null ? { searchPipeline: searchWire.pipeline } : {}),
        slog,
        ...(envSource.QUANTA_MEMORY !== undefined ? { memoryKindLabel: envSource.QUANTA_MEMORY } : {}),
        ...(resolveSandboxProfileFromEnv(envSource) !== undefined
            ? { sandboxProfile: resolveSandboxProfileFromEnv(envSource) }
            : {}),
    });
};
const buildDaemonSurfaceDeps = async (input, envSource, slog) => {
    const { tools: mcpTools, clients: mcpClients } = await loadDaemonMcp(slog, envSource);
    const automationSlot = buildDaemonAutomationSlot(input, envSource);
    const tooling = buildDaemonTooling({
        input,
        envSource,
        slog,
        mcpTools,
        automationSlot,
    });
    return { tooling, automationSlot, mcpClients };
};
const buildDaemonSessionDeps = (opts) => ({
    llm: opts.llm,
    registry: opts.tooling.registry,
    stream: opts.stream,
    permission: { mode: "acceptEdits" },
    system: buildSystemPrompt(opts.input.cwd),
    cwd: opts.input.cwd,
    maxTurns: 40,
    signal: opts.signal,
    onConfirm: async () => false,
    store: opts.tooling.store,
    sessionId: opts.input.sessionId,
    embedder: opts.tooling.embedder,
    memoryConfig: opts.tooling.memoryConfig,
    planMode: false,
    metrics: undefined,
    run: undefined,
    subagentConfig: opts.tooling.subagentConfig,
    skillsConfig: opts.tooling.skillsConfig,
    compactionBreakerConfig: opts.tooling.compactionBreakerConfig,
    verifyGuardConfig: opts.tooling.verifyGuardConfig,
    summarizerLlm: opts.summarizerLlm,
    onShellEvent: undefined,
    workMetricsSink: undefined,
    ...(opts.tooling.searchPipeline !== undefined
        ? { searchPipeline: opts.tooling.searchPipeline }
        : {}),
    ...(opts.automationSlot !== undefined ? { automationEngine: opts.automationSlot } : {}),
});
const projectDaemonToolingOptionals = (tooling) => ({
    ...(tooling.store !== undefined ? { store: tooling.store } : {}),
    ...(tooling.embedder !== undefined ? { embedder: tooling.embedder } : {}),
    ...(tooling.memoryConfig !== undefined ? { memory: tooling.memoryConfig } : {}),
    ...(tooling.subagentConfig !== undefined ? { subagent: tooling.subagentConfig } : {}),
    ...(tooling.skillsConfig !== undefined ? { skills: tooling.skillsConfig } : {}),
    ...(tooling.compactionBreakerConfig !== undefined
        ? { compactionBreaker: tooling.compactionBreakerConfig }
        : {}),
    ...(tooling.verifyGuardConfig !== undefined ? { verifyGuard: tooling.verifyGuardConfig } : {}),
    ...(tooling.searchPipeline !== undefined ? { searchPipeline: tooling.searchPipeline } : {}),
});
const projectExecutionPlaneOptionals = (executionPlane) => ({
    ...(executionPlane.conversationCheckpoint !== undefined
        ? { conversationCheckpoint: executionPlane.conversationCheckpoint }
        : {}),
    ...(executionPlane.fork !== undefined ? { fork: executionPlane.fork } : {}),
    ...(executionPlane.forkSession !== undefined ? { forkSession: executionPlane.forkSession } : {}),
    ...(executionPlane.delegation !== undefined ? { delegation: executionPlane.delegation } : {}),
    ...(executionPlane.subagentBackground !== undefined
        ? { subagentBackground: executionPlane.subagentBackground }
        : {}),
    ...(executionPlane.autoBackground !== undefined
        ? { autoBackground: executionPlane.autoBackground }
        : {}),
});
const projectMemoryAutoOptionals = (memoryAuto) => ({
    ...(memoryAuto?.sessionCtx !== undefined ? { sessionCtx: memoryAuto.sessionCtx } : {}),
    ...(memoryAuto?.memoryConsolidator !== undefined
        ? { memoryConsolidator: memoryAuto.memoryConsolidator }
        : {}),
    ...(memoryAuto?.stage1OutputsStore !== undefined
        ? { stage1OutputsStore: memoryAuto.stage1OutputsStore }
        : {}),
});
const buildDaemonModeBase = (opts) => ({
    llm: opts.llm,
    registry: opts.tooling.registry,
    stream: opts.stream,
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: opts.message }] }],
    system: buildSystemPrompt(opts.input.cwd),
    cwd: opts.input.cwd,
    maxTurns: 40,
    signal: opts.signal,
    sessionId: opts.input.sessionId,
    ...projectDaemonToolingOptionals(opts.tooling),
    ...(opts.summarizerLlm !== undefined ? { summarizerLlm: opts.summarizerLlm } : {}),
    ...(opts.automationSlot !== undefined ? { automationEngine: opts.automationSlot } : {}),
    ...projectExecutionPlaneOptionals(opts.executionPlane),
    ...projectMemoryAutoOptionals(opts.memoryAuto),
});
const buildDaemonSummarizerLlm = (opts) => buildSummarizerLlmCore({
    mainProvider: opts.provider,
    signal: opts.signal,
    model: opts.envSource.QUANTA_COMPACT_MODEL,
    ...(opts.envSource.QUANTA_COMPACT_PROVIDER !== undefined
        ? { provider: opts.envSource.QUANTA_COMPACT_PROVIDER }
        : {}),
    env: opts.envSource,
});
const buildReactorDaemonBaseFactory = async (input) => {
    const envSource = input.envSource;
    const provider = pickProvider(envSource);
    const llm = tryCreateLLM(provider, {}, envSource);
    if (llm === null) {
        throw new Error(`daemon delivery requires API credentials for provider '${provider}' (e.g. OPENAI_API_KEY)`);
    }
    const slog = new StructuredLogger();
    const { tooling, automationSlot, mcpClients } = await buildDaemonSurfaceDeps(input, envSource, slog);
    const convStore = defaultConversationCheckpointStore();
    const automationTicker = automationSlot !== undefined
        ? startAutomationEngineTicker({ automationEngine: automationSlot })
        : undefined;
    return {
        createBase: async (message) => {
            const signal = new AbortController().signal;
            const stream = new JsonlRecorder(input.logPath, {
                ctx: { runId: input.sessionId },
            });
            const summarizerLlm = buildDaemonSummarizerLlm({ provider, envSource, signal });
            const baseDeps = buildDaemonSessionDeps({
                llm,
                tooling,
                automationSlot,
                summarizerLlm,
                input,
                signal,
                stream,
            });
            const executionPlane = await buildSharedExecutionPlaneSessionDeps({
                history: [{ role: "user", content: [{ type: "text", text: message }] }],
                sessionDeps: baseDeps,
                cwd: input.cwd,
                envSource,
                convStore,
            });
            const memoryAuto = await buildSessionMemoryAutoWires({
                env: envSource,
                llm,
                ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
                sessionId: input.sessionId,
                signal,
                homeDir: input.homeDir,
            });
            return buildDaemonModeBase({
                llm,
                tooling,
                automationSlot,
                input,
                signal,
                message,
                stream,
                executionPlane,
                memoryAuto,
                summarizerLlm,
            });
        },
        close: async () => {
            automationTicker?.stop();
            for (const client of mcpClients)
                await client.stop().catch(() => undefined);
        },
    };
};
export const createDaemonTriggerDelivery = async (opts, deps = {}) => {
    const envSource = opts.envSource ?? process.env;
    const cwd = opts.cwd;
    const homeDir = opts.homeDir ?? homedir();
    const sessionId = opts.sessionId;
    const logPath = opts.logPath ?? reactorDaemonLogPath(sessionId, homeDir);
    let factory;
    const runModeImpl = deps.runMode ?? runDaemonMode;
    const delivery = createQueuedMessageDelivery({
        runMessage: async (message) => {
            const base = await factory?.createBase(message);
            if (base === undefined)
                throw new Error("daemon delivery factory not initialized");
            const out = await runModeImpl({ mode: "daemon", base });
            if (base.stream instanceof JsonlRecorder)
                base.stream.close();
            if (out.exitCode !== 0) {
                throw new Error(`daemon run failed (exit ${out.exitCode}, reason=${out.outcome?.reason ?? "unknown"})`);
            }
        },
    });
    factory = await (deps.createBaseFactory ?? buildReactorDaemonBaseFactory)({
        sessionId,
        cwd,
        homeDir,
        envSource,
        logPath,
        enqueueUserMessage: delivery.enqueueMessage,
    });
    return {
        deliverTrigger: delivery.deliverTrigger,
        close: async () => {
            await delivery.close();
            await factory?.close();
        },
    };
};
const failWithHelp = (message, code) => {
    process.stderr.write(message);
    process.stderr.write(HELP_TEXT);
    return code;
};
const validateWatcherArgs = (args, envSource) => {
    if (args.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (args.prRef === undefined)
        return failWithHelp("error: --pr <ref> is required\n\n", 2);
    if (!args.dryRun && args.sessionId === undefined) {
        return failWithHelp("error: --session-id <id> is required unless --dry-run\n\n", 2);
    }
    if (!args.dryRun && envSource[REACTOR_ENV_FLAG] !== "1") {
        process.stderr.write(`error: ${REACTOR_ENV_FLAG} is not set to "1"; refusing to run without --dry-run\n`);
        return 3;
    }
    return undefined;
};
const createSocketTriggerDelivery = (sessionId, socketPath) => ({
    deliverTrigger: async (trigger) => {
        await publishReactorWatchTrigger({ sessionId, socketPath, trigger });
    },
    close: async () => undefined,
});
const createWatcherDelivery = async (args) => {
    if (args.dryRun || args.sessionId === undefined)
        return undefined;
    if (args.delivery === "daemon") {
        return createDaemonTriggerDelivery({
            sessionId: args.sessionId,
            cwd: process.cwd(),
            homeDir: homedir(),
            ...(args.daemonLogPath !== undefined ? { logPath: args.daemonLogPath } : {}),
        });
    }
    return createSocketTriggerDelivery(args.sessionId, args.socketPath ?? reactorWatchSocketPath(args.sessionId, homedir()));
};
const buildWatchRuntime = async (args, prRef) => {
    const seenRunsPath = args.seenRunsPath ?? reactorWatchSeenRunsPath(prRef, homedir());
    const seenRunsStore = createInMemorySeenRuns(await loadSeenRunsSeed(seenRunsPath));
    const gh = ghCliPort(process.cwd());
    const ciSource = createCiTriggerSource({
        ghCliPort: gh,
        clockPort: { now: () => Date.now() },
        repoCwd: process.cwd(),
        prRef,
        seenRunsStore,
    });
    const commentSource = args.prComments === true
        ? await (async () => {
            const ctx = await resolvePrCommentContext({
                ghCliPort: gh,
                repoCwd: process.cwd(),
                prRef,
            });
            if (ctx === undefined)
                return undefined;
            const watermarksPath = args.watermarksPath ?? reactorWatchWatermarksPath(prRef, homedir());
            return createPrCommentTriggerSource({
                ghCliPort: gh,
                clockPort: { now: () => Date.now() },
                repoCwd: process.cwd(),
                repoSlug: ctx.repoSlug,
                prNumber: ctx.prNumber,
                watermarkKey: ctx.watermarkKey,
                watermarkStore: createFileBackedWatermarkStore(watermarksPath),
            });
        })()
        : undefined;
    return {
        seenRunsPath,
        seenRunsStore,
        source: {
            poll: async () => {
                const commentPoll = commentSource !== undefined
                    ? commentSource.poll()
                    : Promise.resolve([]);
                const [ci, comments] = await Promise.all([ciSource.poll(), commentPoll]);
                return [...ci, ...comments];
            },
        },
        delivery: await createWatcherDelivery(args),
    };
};
const keepPollingUntilStopped = async (runTick, intervalMs) => new Promise((resolve) => {
    let inFlight = false;
    const interval = setInterval(() => {
        if (inFlight)
            return;
        inFlight = true;
        runTick()
            .catch(() => {
            /* keep the watcher alive; stderr already carries the failure */
        })
            .finally(() => {
            inFlight = false;
        });
    }, intervalMs);
    process.on("SIGINT", () => {
        clearInterval(interval);
        resolve();
    });
    process.on("SIGTERM", () => {
        clearInterval(interval);
        resolve();
    });
});
const main = async (argv) => {
    const args = parseArgs(argv);
    const validation = validateWatcherArgs(args, process.env);
    if (validation !== undefined)
        return validation;
    const prRef = args.prRef;
    const runtime = await buildWatchRuntime(args, prRef);
    const env = { get: (n) => process.env[n] };
    const runOnce = async () => {
        const before = JSON.stringify(runtime.seenRunsStore.snapshot());
        const { triggers, action } = await pollOnce({
            source: runtime.source,
            dryRun: args.dryRun,
            env,
        });
        if (JSON.stringify(runtime.seenRunsStore.snapshot()) !== before) {
            await persistSeenRunsSnapshot(runtime.seenRunsPath, runtime.seenRunsStore);
        }
        for (const t of triggers) {
            process.stdout.write(`${JSON.stringify({
                at: Date.now(),
                action,
                delivery: args.delivery,
                reason: t.reason,
                evidence: t.evidence,
                simulatedMessage: t.simulatedMessage,
            })}\n`);
            if (action === "enqueued" && runtime.delivery !== undefined) {
                await runtime.delivery.deliverTrigger(t);
            }
        }
    };
    const runTick = async () => {
        try {
            await runOnce();
        }
        catch (error) {
            process.stderr.write(`reactor-watch tick failed: ${error instanceof Error ? error.message : String(error)}\n`);
            throw error;
        }
    };
    try {
        await runTick();
        if (args.once)
            return 0;
        await keepPollingUntilStopped(runTick, args.intervalMs);
        return 0;
    }
    finally {
        await runtime.delivery?.close();
    }
};
if (import.meta.main) {
    const code = await main(process.argv.slice(2));
    process.exit(code);
}
