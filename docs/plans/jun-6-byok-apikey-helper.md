# RFC — H7-BYOK: `apiKeyHelper` mint for the LEGACY vendor key path

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-06
- Axis: `@/llm` credential resolution / vendor-key BYOK
- Pair: **H7 — rotating cloud credentials (`CredentialSource`, LANDED, grep-verified §3.1)**.
  H7 today drives AWS/GCP `refreshCloudCreds(...)` before a Bedrock/Vertex call.
  This RFC extends the SAME `CredentialSource.mintApiKey()` (already hardened) to
  feed the LEGACY `anthropic` / `openai` vendor-key resolver in `createLLM`.
- Default-OFF, byte-identical when `apiKeyHelper` is unset.
- ROI: **LOW / niche** — only operators who mint short-lived vendor keys from a
  secrets broker (Vault, gcloud-printed AWS-Bedrock-style key, an internal STS).

---

## 1. 요약 (Summary)

H7 shipped a fully-hardened executable `CredentialSource` with **two** capabilities
(`src/llm/credential-helper.ts:1-43`): (a) `mintApiKey()` — run a shell command that
prints a freshly-minted API key to stdout, TTL-cached; (b) `refreshCloudCreds(cloud)` —
run `aws sso login` / `gcloud auth …` before a Bedrock/Vertex call. **Only (b) is wired
to a live provider.** `createMulticloudLLM` injects the source into the Bedrock/Vertex
adapters (`factory.ts:494-524`), which call `refreshCloudCreds(...)`. The **`mintApiKey()`
path has no consumer** — no factory awaits it, so the `apiKeyHelper` knob is dead for the
legacy `anthropic` / `openai` vendor key path that `createLLM` resolves from
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (`factory.ts:42-46, 262-297`).

This RFC closes that gap: when an operator configures `apiKeyHelper`, `createLLM`'s
key resolver consults `mintApiKey()` **before** falling back to the env var, so a
short-lived minted key is injected as the adapter `Authorization` / `x-api-key`. This is
Claude Code's `apiKeyHelper` + `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` exactly — the H7 header
already names that parity (`credential-helper.ts:6-10, 125-129`). The hard part (the mint,
TTL cache, single-flight, no-leak, trust gate) is **already done and tested**; this RFC is
purely the *consumption seam* in the legacy factory path.

The single load-bearing constraint is **async**: `mintApiKey()` is `Promise<string|undefined>`,
but `createLLM` is **synchronous** (`factory.ts:277`). The design resolves this by a
pre-resolution step at the composition root (mint once, hand the resolved key in as
`opts.apiKey`) rather than making the factory async — see §4.2.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

### 2.1 Claude Code — `apiKeyHelper` + TTL (verified via H7 parity)

The H7 module header documents the parity verbatim: a shell command that "prints a freshly
minted API key to stdout", TTL-cached, keyed by the command string, mirroring
`CLAUDE_CODE_API_KEY_HELPER_TTL_MS` with a 5-minute default
(`credential-helper.ts:6-10, 125-129`). Claude Code uses the helper as the `Authorization`
source for the Anthropic client when set — i.e. it **replaces** the static
`ANTHROPIC_API_KEY` with a rotating, broker-minted bearer. That is exactly the legacy-path
consumption this RFC adds. (근거: H7 module header + Claude Code env-var documentation.)

### 2.2 Codex / Cursor — broker-minted keys

근거: 백로그 기술. Both support an external-credential-process model (a command that
emits a token); the value is short-lived keys for compliance (no static key on disk).
quanta already has the *mint*; it just needs to feed the vendor path.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 `mintApiKey()` exists, hardened — but has NO live consumer

`createCredentialSource(...)` returns `{ mintApiKey, refreshCloudCreds }`
(`credential-helper.ts:113-123, 200-268`). `mintApiKey()` is fully hardened:
- TTL cache keyed by the **command** (not the secret), `:205-208`;
- single-flight coalescing so N concurrent callers share ONE shell, `:159, 209-238`;
- empty-stdout rejected as a typed failure BEFORE the cache write (so a broken helper
  never pins `""` for a whole TTL window and never silently overrides a working env key),
  `:215-227`;
- trust gate + no-leak + no-throw, `:164-198`.

The ONLY thing missing is a caller. `grep -rn "mintApiKey" src` (excluding tests/`.js`)
shows it is referenced in `credential-helper.ts` alone — `factory.ts`, the runner
assembler, and the CLI never call it. Contrast `refreshCloudCreds`, which IS consumed
(`vertex-adapter.ts:189-191`, `bedrock-adapter` sibling, wired by `factory.ts:513, 521`).

### 3.2 The legacy vendor-key resolver — where the mint must land

`createLLM(provider, opts, env)` (`factory.ts:277-297`):
- short-circuits `chatgpt-oauth` (on-disk token, `:281-284`);
- else `resolveApiKey(provider, opts, env)` = `opts.apiKey ?? env[API_KEY_ENV[provider]]`
  (`factory.ts:262-266`), where `API_KEY_ENV = { anthropic:"ANTHROPIC_API_KEY",
  openai:"OPENAI_API_KEY", … }` (`:42-46`);
- `undefined` ⇒ `throw new MissingApiKeyError(provider)` (`:286`);
- else builds the adapter via `ADAPTER_REGISTRY[provider](apiKey, …)` (`:296`), and the
  Anthropic adapter passes `apiKey` straight to `new Anthropic({ apiKey })`
  (`adapters/anthropic.ts:104-122`).

So the mint must produce a string that arrives as `opts.apiKey` (which already wins over
env, `:266`) — no adapter change needed.

### 3.3 `createLLM` is SYNCHRONOUS — the binding constraint

`createLLM` (`:277`) and `tryCreateLLM` (`:302`) return `LLMPort` synchronously.
`mintApiKey()` is async. The factory CANNOT `await` without becoming async and rippling
into every call site (`cli`/`bench`/`eval` `buildLLM`). The resolution is to mint at the
composition root and pass the result down as `opts.apiKey` (§4.2) — the factory stays sync.

### 3.4 `CredentialSource` is already built at the composition root for H7

`createMulticloudLLM` documents that the composition root builds the source from the H7
runtime-config knobs via `createCredentialSource` and injects it (`factory.ts:392-399`).
That same construction site is where the `mintApiKey()` pre-resolution belongs — the
source is already in hand there; this RFC only adds a `mintApiKey()` call ahead of the
legacy `createLLM`.

---

## 4. 설계 (Design)

### 4.1 The mint feeds `opts.apiKey` (no adapter / factory-signature change)

The vendor adapters already accept an explicit key and already let `opts.apiKey` win over
env (`factory.ts:266`). The mint therefore lands as a **pre-resolved `opts.apiKey`**: the
composition root calls `mintApiKey()`, and IF it returns a string, sets it on the
`CreateLLMOptions` it passes to `createLLM`. The factory, adapters, and `MissingApiKeyError`
are byte-identical otherwise.

Applicability is **legacy vendor providers only** — `anthropic` and `openai`. Not
`chatgpt-oauth` (on-disk token, no env key) and not the multicloud transports (`bedrock`/
`vertex` use `refreshCloudCreds`, a different H7 capability). A guard pins this:

```ts
const MINTABLE_PROVIDERS: ReadonlySet<Provider> = new Set(["anthropic", "openai"])
```

### 4.2 Composition-root pre-resolution (closed-port DI, async lives OUTSIDE the factory)

A small async helper at the composition root (the assembler that already builds the H7
`CredentialSource`):

```ts
// @/host/runtime — beside the existing createCredentialSource wiring
export const resolveVendorApiKey = async (
  provider: Provider,
  opts: CreateLLMOptions,
  source: CredentialSource | undefined,        // H7 source (may be undefined ⇒ no mint)
): Promise<CreateLLMOptions> => {
  if (source === undefined) return opts                  // default-OFF fast path
  if (!MINTABLE_PROVIDERS.has(provider)) return opts      // oauth / cloud transports skip
  if (opts.apiKey !== undefined) return opts              // explicit caller key wins over mint
  const minted = await source.mintApiKey()                // undefined when apiKeyHelper unset
  return minted === undefined ? opts : { ...opts, apiKey: minted }
}
```

- **No `Date.now()` / `process.env` here** — the clock and env already live inside the H7
  source (`credential-helper.ts:110, 141-142`) and the composition root respectively. This
  helper is a pure async transform over its inputs.
- The factory stays synchronous: the root `await`s `resolveVendorApiKey(...)` THEN calls
  `createLLM(provider, resolvedOpts, env)`.
- `mintApiKey()` returning `undefined` (no `apiKeyHelper` configured) ⇒ `opts` unchanged ⇒
  byte-identical legacy path. A *failing* helper throws a typed `CredentialHelperError`
  (`untrusted` / `helper-failed`) which the root surfaces — symmetric with how a failing
  `refreshCloudCreds` already surfaces before a wire call (`vertex-adapter.ts:189-191`).

### 4.3 Precedence (documented, deterministic)

For a legacy vendor provider, the resolved key is the FIRST of:
1. `opts.apiKey` (explicit caller — wins over everything, mirrors `factory.ts:266`).
2. `apiKeyHelper` mint (when H7 source present AND `apiKeyHelper` configured AND trusted).
3. `env[API_KEY_ENV[provider]]` (the existing env var) — inside `createLLM` unchanged.
4. else `MissingApiKeyError`.

The mint sits ABOVE env (a configured helper is the operator's stated intent to rotate),
but BELOW an explicit `opts.apiKey` (a caller that hard-pins a key meant it). The H7
empty-stdout guard (`credential-helper.ts:215-227`) is what makes "mint above env" safe —
a broken helper throws rather than shadowing a working env key with `""`.

### 4.4 No-leak preserved end-to-end

The minted key flows `mintApiKey()` → `opts.apiKey` → `new Anthropic({ apiKey })`. It is
NEVER logged, NEVER put in the `llm_request` marker (which carries model/provider/transport,
not the key), and the H7 error taxonomy already drops helper stdout/stderr
(`credential-helper.ts:30-35, 185-191`). This RFC adds no new sink for the secret.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

Reuse the EXISTING H7 knobs — no new env var:
- `apiKeyHelper` (mint command) + `apiKeyHelperTtlMs` already feed `createCredentialSource`
  (`credential-helper.ts:88-95`). The composition root that builds the source from
  `QUANTA_API_KEY_HELPER` / `QUANTA_API_KEY_HELPER_TTL_MS` (the H7 runtime-config knobs,
  `factory.ts:392-399`) simply ALSO passes the source into `resolveVendorApiKey`.
- **Unset `apiKeyHelper` ⇒ `mintApiKey()` returns `undefined` ⇒ `opts` unchanged ⇒
  byte-identical.** This is the H7 inert-no-op contract (`credential-helper.ts:39-42`),
  reused verbatim.

No new tool, no manifest row (this is a credential seam, not a model-facing tool).

### 5.2 Feature catalog (fc)

Extend the existing H7 fc node (cloud-credential-helper) with a `legacy-vendor-mint`
capability bullet, or add a sibling `byok-apikey-helper.yaml` under the LLM-credential
subsystem: `depends_on: [h7-credential-source]`, `labels: ["absorbed:claude-code",
"surface:cli"]`, `status: planned`. No tool-surface manifest change (no new tool name).

### 5.3 Slice / fence (where it lives)

- `src/llm/credential-helper.ts` — **untouched** (the mint is already complete). Optionally
  export `MINTABLE_PROVIDERS` is NOT here — `Provider` lives in `factory.ts`, and the helper
  must not import the factory (it currently imports only `@/shared`-level shapes). The
  `MINTABLE_PROVIDERS` set + `resolveVendorApiKey` live in **`@/host/runtime`** (the
  composition root), which already reaches both `@/llm` (`createLLM`, `createCredentialSource`)
  and the env — the only layer allowed to await the mint and re-enter the sync factory.
- `@/llm/factory` stays synchronous and import-clean.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, fake shell injected)

Inject a `FakeShellExec` into `createCredentialSource` (no real shell) + drive
`resolveVendorApiKey`:
- **mint wins over env, loses to explicit:** with `apiKeyHelper` set and `env.ANTHROPIC_API_KEY`
  present, the resolved `opts.apiKey` is the MINT; with `opts.apiKey` also set, the explicit
  key wins (mint not even called — assert the fake shell ran 0 times).
- **default-OFF byte-identical:** `apiKeyHelper` unset ⇒ `mintApiKey()` returns `undefined`
  ⇒ returned `opts` is `===`-identical (no `apiKey` key added); `createLLM` then resolves
  from env exactly as today.
- **non-mintable providers skipped:** `chatgpt-oauth`, `bedrock`, `vertex` ⇒ `opts`
  returned unchanged, mint never called (assert 0 shell calls) — the cloud transports keep
  their `refreshCloudCreds` path.
- **empty mint does NOT shadow env:** a helper that exits 0 with empty stdout ⇒ the H7
  guard throws `helper-failed` (re-uses `credential-helper.ts:215-227` hellgate) ⇒ the root
  surfaces it; the working `env.ANTHROPIC_API_KEY` is NOT silently replaced by `""`.
- **untrusted ⇒ refused:** `isTrusted()=false` ⇒ `mintApiKey()` throws `untrusted`; the
  root never injects a key; legacy env path is not reached (fail-closed).
- **no-leak:** assert the minted value appears in NO emitted event / log / error message
  across the resolve→createLLM→adapter path (the `llm_request` marker carries model/provider
  only).

### 6.2 e2e

Fake `mintApiKey` returns `"sk-minted-123"`; assert the constructed `AnthropicAdapter`'s
client was built with `apiKey:"sk-minted-123"` (via a DI client factory or a spy), and that
a second `createLLM` within the TTL re-uses the cached mint (the fake shell ran ONCE — the
H7 cache, exercised end-to-end).

---

## 7. 단계 (Phasing)

- **Phase 1 — legacy `anthropic`/`openai` mint (this RFC).** `resolveVendorApiKey` at the
  composition root + the `MINTABLE_PROVIDERS` guard + hellgate. Default-OFF. Shippable unit.
- **Phase 2 — mint TTL surfaced in `/status`.** Show "vendor key: minted (expires ~Nm)"
  derived from the H7 cache `mintedAt + ttlMs` (presence/age only, never the value),
  mirroring the OAuth-token "presence not value" discipline. Pure read.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Async-in-sync (primary risk) — RESOLVED by pre-resolution.** Making `createLLM` async
  would ripple into `cli`/`bench`/`eval`. Minting at the root and passing `opts.apiKey`
  keeps the factory sync and the change surgical. Alternative (rejected): an async
  `createLLMAsync` wrapper — adds a parallel factory surface for one niche capability.
- **A failing helper hard-fails the turn.** Mitigated: the mint is consulted only when
  `apiKeyHelper` is configured (operator opt-in); when unset it returns `undefined` and the
  env path runs. A configured-but-broken helper SHOULD fail loudly (a silent fall-through to
  a stale env key is worse for a rotation user) — this matches the H7 `refreshCloudCreds`
  fail-before-wire posture.
- **Mint above env could surprise an operator** who set BOTH `apiKeyHelper` and a static
  env key. Documented precedence (§4.3) + the empty-stdout guard make this deterministic and
  safe; the helper is the explicit rotation intent, so it correctly wins.
- **ROI is genuinely low.** This is a niche compliance feature (short-lived broker keys).
  It is cheap because the hard part (H7 mint) is already built and tested — the RFC is one
  composition-root helper + a hellgate. Documented honestly as low-ROI / low-cost.
- **Alternative — make the adapter await a key provider.** Rejected: pushes async +
  credential policy into the wire slice (`@/llm/adapters`), which must stay
  `@/shared`-only and synchronous-construct. The composition root is the correct owner.

---

## 9. 코드 위치 요약 (Code-location summary)

**Create / touch (composition root only):**
- `@/host/runtime` — `resolveVendorApiKey(provider, opts, source)` + `MINTABLE_PROVIDERS`;
  call it (awaited) ahead of the existing legacy `createLLM` wiring, beside the H7
  `createCredentialSource` construction.
- `tools/feature-catalog/…/byok-apikey-helper.yaml` (or extend the H7 node).
- `…/__tests__/byok-apikey-helper.hellgate.test.ts` (§6).

**Read-only (referenced, NOT modified):**
- `src/llm/credential-helper.ts:113-268` — `mintApiKey()` (the hard part, already done).
- `src/llm/factory.ts:42-46, 262-297, 392-399` — `API_KEY_ENV`, `resolveApiKey`,
  `createLLM` (stays sync), the H7 source-construction doc.
- `src/llm/adapters/anthropic.ts:104-122` — `new Anthropic({ apiKey })` sink.
- `src/llm/providers/vertex-adapter.ts:189-191` — the `refreshCloudCreds` consumption
  precedent (the OTHER H7 capability, already live).
