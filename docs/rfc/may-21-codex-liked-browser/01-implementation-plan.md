# RFC: Codex-like Browser Surface for quanta-codeagent-v3

> Status: Draft (2026-05-21)
> Author: songmin (TBD reviewer)
> Companion: [00-feature-catalog.md](./00-feature-catalog.md)
> Related ADRs: 0028~0033 (예약), [[surface-model]], [[codex-absorption-complete]], [[subagent-sota-hardening]]
> 정찰 산출물: [/docs/reviews-codex-agent/browser-runtime/](../../reviews-codex-agent/browser-runtime/) (5개, 1,885 lines)

## 0. TL;DR

Codex `openai-bundled/browser/0.1.0-alpha2` 플러그인을 12 agent로 deep audit한 결과, quanta-v3 multi-surface 아키텍처([[surface-model]])와 자연스럽게 정합하는 **6가지 SOTA++ 패턴**과 **8개의 critical 위험**이 식별되었다. 본 RFC는 (a) Codex의 진짜 좋은 패턴 — 2-tier surface (Browser→Tab), 4-tier confirmation enum, untrusted content envelope, snapshot discipline 6 rules, AsyncLocalStorage span context, multi-backend discovery — 만 흡수하고, (b) Codex가 빠뜨린 7가지 빈 곳 — policy-code 통합 enforcement, approval token 6-tuple, origin pivot tracker, input provenance signing, self-quote tainting, snapshot freshness enforcement, surface-aware admissibility — 을 처음부터 박는 6 phase 로드맵 (~2.9 KLoC + tests, ADR-0028~0033)을 제시한다. **byte-identical 1309 tests 보호**가 최우선이며, 모든 인터페이스 변경은 optional 필드만 추가한다. `browser-client.mjs` 소스 복사 금지 (Proprietary), SKILL.md 정책 아이디어만 차용.

---

## 1. 동기 & 범위

### 1.1 왜 지금

세 가지 force가 동시에 수렴한다.

1. **Codex가 increasingly 브라우저-중심으로 정렬됨** — 12개 deep-audit agent가 확인: Codex Desktop build 2867 (Electron 42.0.1)은 `chrome` / `iab` 2-backend, native messaging host (`com.openai.codexextension`), 35MB `comment-preload.js` annotation overlay, Skybridge MCP UI iframe까지 박혀 있다. 브라우저는 "convenience UI"가 아니라 **별도 runtime subsystem**이다 ([browser-runtime-and-transport-architecture.md](../../reviews-codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md)).
2. **quanta-v3의 surface model이 정확히 이 모양을 받아들일 수 있음** — [[surface-model]] 메모리: CLI/Web-Tauri/CLI-embedded는 이미 인정된 multi-surface. 브라우저는 (Web-Tauri의 자식) 또는 (별도 surface) 어느 쪽으로도 fit된다.
3. **Phase 1 (byte-identical 흡수)이 안정화됨** — [[codex-absorption-complete]] 1309 tests / 0 fail. 이제 *새로운* surface를 더해도 회귀를 즉시 감지할 수 있다.

### 1.2 In-scope

- `src/browser/` 신설 slice (types/transport/tab/capability/snapshot)
- `src/artifact/` 신설 slice (display bridge — binary evidence channel)
- `src/tool/browser/` 7~9개 도구 (open / navigate / snapshot / click / type / screenshot / read_dom / claim_user_tab / capability_call)
- `src/permission/` 확장: `ToolAction.hazardTags?`, `ToolAction.capability?`, `ToolAction.origin?`
- `src/tool/types.ts` 확장: `ToolResultEvidence.provenance?`
- `src/agent/admissibility-gate.ts` 확장: surface-aware tier resolver
- `src/agent/hooks.ts` 확장: `HookEvent` union에 `tool_artifact_emit` 추가 (optional consumer)
- ADR-0028 ~ ADR-0033 (6개)

### 1.2 Out-of-scope (의도적 미흡수, RFC §1.2 정합)

- Sentry / Statsig telemetry (PII risk — [browser-safety-and-admissibility-model.md](../../reviews-codex-agent/browser-runtime/browser-safety-and-admissibility-model.md) Codex `Sentry.setUser({email})` 참조)
- Codex plugin manifest 그대로 흡수 (alias/부정 routing 패턴만 차용)
- Codex `comment-preload.js` annotation overlay 1:1 흡수 (i18n 64 locale + Google Docs API integration — over-engineered for our surfaces)
- `disabled-for-local-testing` sentinel header 같은 모든 escape hatch (§5.1 참조)
- LevelDB / `classic-level` 의존성 (우리 sqlite로 대체)
- Chrome extension 직접 발행 (Phase 5 옵션, 별도 RFC)
- Skybridge iframe MessagePort protocol 1:1 흡수 (우리 stream/dispatch와 중복)

### 1.3 surface-model 메모리 정합성

[[surface-model]]: "quanta는 CLI / Web-Tauri / CLI-embedded multi-surface. surface 가용성으로 흡수 ROI 게이팅 금지."

본 RFC는 이를 다음과 같이 준수한다.

- 브라우저 capability registry는 **surface-aware** (§4.7) — 같은 `browser.click` 도구가 CLI surface에서는 headless CDP, Web-Tauri surface에서는 in-app webview, CLI-embedded surface에서는 user's running Chrome (native messaging host)으로 라우팅된다.
- **단 하나의 surface를 가정하는 코드 경로 금지** — 모든 tool은 capability registry를 통해 backend를 lookup한다. CDP / Playwright / Tauri webview / native messaging을 모두 후보 backend로 둔다.
- ROI가 surface 가용성과 무관하게 결정됨 — Codex의 좋은 패턴은 surface를 가리지 않고 흡수 (4-tier enum, untrusted envelope, snapshot discipline).

### 1.4 non-goal — Codex 직접 흡수가 아닌 무엇

- **bit-for-bit Codex behavior replication** — 우리는 우리 안전 모델 (HITL 4-tier, admissibility gate SSOT, anti-signals policy)을 유지하면서 Codex의 *좋은* 패턴만 SOTA++ 형태로 가져온다.
- **Chrome-only first-class** — Firefox/Safari가 surface tier에서 동등해야 한다 (Codex의 `chrome` backend 한정 lock-in 회피).
- **`browser-client.mjs` 코드 복사** — Proprietary. 학습 후 from-scratch.
- **PR-vector 카탈로그 (00-feature-catalog.md) 중복 작성** — 카탈로그는 자매 문서. 본 문서는 *어떻게* 가져올지에만 집중.

---

## 2. 우리가 흡수할 Codex 기능 (SOTA++ 패턴)

각 항목은 카탈로그의 사실을 인용 형태로만 참조하고, quanta-v3 좌표로 어떻게 land 시킬지에 집중한다.

### 2.1 Session-bound transport (P0, Critical)

**Codex 패턴**: `session_id` / `turn_id`를 transport layer가 강제 주입 (HTTP header / RPC envelope) — 우회 불가능.

**우리에게**: 우리는 이미 `src/observability/`에 span context가 있고, jsonl-recorder ([src/stream/adapters/jsonl-recorder.ts:197-209](../../../src/stream/adapters/jsonl-recorder.ts#L197))의 `KIND_MAP`이 `turn_start` event를 통해 turn boundary를 트래킹한다. 신설 `src/browser/transport.ts`는 모든 tab actor RPC에 `{sessionId, turnId, spanId}` 3-tuple을 **caller가 omit 불가능한 mandatory 인자**로 만든다. AsyncLocalStorage를 통해 host가 주입 — tool code는 envelope에 접근할 수 없다.

**파일**: `src/browser/transport.ts` (신규), `src/observability/span-context.ts` (확장)

### 2.2 2-tier surface (Browser → Tab actor) (P0, Critical)

**Codex 패턴**: `agent.browsers.get("iab")` → `browser.tabs.get(id)` 2단 계층. Browser는 backend lifecycle, Tab은 page actor.

**우리에게**: `src/browser/index.ts`에서 다음 shape 노출:

```ts
interface BrowserSurface {
  readonly backend: "cdp" | "tauri-webview" | "native-messaging" | "mock"
  tabs(): Promise<TabActor[]>
  openTab(url: string, opts: OpenOptions): Promise<TabActor>
  claimUserTab(filter: TabFilter): Promise<TabActor> // §5.2 별도 tier
}
interface TabActor {
  readonly id: string
  readonly origin: string
  navigate(url: string, opts: NavOpts): Promise<void>
  snapshot(): Promise<DomSnapshot>
  capability<K extends CapabilityKey>(k: K, args: CapabilityArg<K>): Promise<CapabilityResult<K>>
}
```

Tab actor는 abort signal chain ([src/subagent/types.ts:40-45](../../../src/subagent/types.ts#L40)) 패턴을 그대로 차용 — parent abort가 tab actor RPC를 cancel.

### 2.3 Multi-backend discovery (P1, High)

**Codex 패턴**: `rn()` 함수가 `chrome` / `iab` 후보를 enumerate, IPC channel `x-codex-browser-use-available-backends`로 expose.

**우리에게**: `src/browser/capability.ts`의 `BackendRegistry`. 부팅 시 후보 backend를 probe (CDP localhost:9222 ping / Tauri webview detect / native-messaging port lookup) — vendor lock-in 회피. Backend 선택은 environment + capability requirement → deterministic resolver. lsp-bridge ([src/agent/lsp-bridge.ts](../../../src/agent/lsp-bridge.ts))의 probe 패턴과 동일 mental model.

### 2.4 Read vs Transmit 분리 (P0, Critical)

**Codex 패턴**: capability 권한이 "read DOM"과 "send keystrokes / submit form"을 분리.

**우리에게**: `ToolAction.hazardTags?: ("read" | "transmit" | "navigate" | "claim-user-context")[]`. HITL tier resolver ([src/agent/admissibility-gate.ts:86](../../../src/agent/admissibility-gate.ts#L86) `runHitlGate`)가 `transmit`이 있으면 자동 `always-confirm` tier로 promote. `read` only면 `none` tier 후보. [src/permission/types.ts:32](../../../src/permission/types.ts#L32) HITLTier enum은 변경하지 않고 *입력*만 풍부하게 한다.

### 2.5 6 engine 병렬 (Playwright / CUA / DOM-CUA / dev / clipboard / capabilities) (P2, Med)

**Codex 패턴**: 동일 의도 (예: "click button")를 6개 engine 중 가장 적합한 것이 처리.

**우리에게**: Phase 2-3에서는 단일 engine (CDP)으로 시작. Phase 5에서 `src/browser/engines/` 하위에 strategy pattern으로 분리. **단**, dev engine과 capability engine은 P1 — 두 가지를 처음부터 분리:

- `dev engine`: developer-mode debug primitives (`evaluate`, raw CDP). 항상 `always-confirm` tier.
- `capability engine`: high-level 의도 (semantic locator, autocomplete-aware type). 정상 경로.

### 2.6 Read-only isolated world + Readonly proxy (P0, Critical)

**Codex 패턴**: snapshot evaluation을 isolated world에서 실행, 24개 read-only proxy로 모든 mutation을 trap.

**우리에게**: `src/browser/snapshot.ts`에 두 가지 보장.

1. CDP `Page.createIsolatedWorld`로 격리. (Phase 5)
2. Phase 2-4에서는 mock engine에서도 **read-only contract typing** 강제 — `interface ReadonlySnapshot` (`readonly` 모든 필드, no mutation methods) — Codex의 dynamic proxy를 우리는 *static* 타입으로 강제 (tsc 단계에서 escape 차단).

### 2.7 4-tier confirmation `[1]~[17]` enum (P0, Critical)

**Codex 패턴**: SKILL.md가 17개 confirmation prompt를 `[1]~[17]` 번호로 부여, LLM이 자기 분류.

**우리에게 — 차별점 (§4.1 참조)**: 우리는 *코드 enum + deterministic matcher*로 박는다. `src/browser/confirmation-prompts.ts`:

```ts
export const enum BrowserConfirmPrompt {
  NavigateUntrustedOrigin = 1,
  SubmitFormWithPII = 2,
  // ... 17개
}
export const matchPrompt = (action: ToolAction): BrowserConfirmPrompt | null => { /* pure */ }
```

[src/agent/admissibility-gate.ts:192](../../../src/agent/admissibility-gate.ts#L192) `runAdmissibilityGate`가 호출하는 `resolveHitlTier`가 `matchPrompt` 결과를 priority-1 신호로 사용 — LLM 자기분류 우회 불가.

### 2.8 Locator strategy 7-priority + Snapshot discipline 6 rules (P1, High)

**Codex 패턴**: `aria-label > role+name > text > testid > css > xpath > coord` 7-priority locator. snapshot은 (stale 금지 / mutation 전 재snapshot / etc.) 6 rule.

**우리에게**: `src/browser/locator.ts` — priority enum + `resolveLocator(target: LocatorSpec): Resolver`. snapshot discipline은 *코드 enforcement* (§4.6): snapshot에 `snapshotId` 부여, mutation tool은 `expectedSnapshotId` parameter 필수 — mismatch면 tool error.

### 2.9 Untrusted content envelope (general) (P0, Critical)

**Codex 패턴**: 외부 컨텐츠(웹 페이지 text, scraped HTML)를 `<untrusted source="X">...</untrusted>` wrapper로 감싸 prompt injection 격리.

**우리에게 — quanta 일반화**: 이 패턴을 브라우저-한정으로 두지 않는다. `src/tool/types.ts:65` `ToolResultEvidence`에 `provenance?: { source: string; trust: "trusted" | "untrusted" | "self-derived"; origin?: string }` 추가. `src/agent/dispatch-helpers.ts:23` `resultBlock`에 provenance 4번째 인자 — 모델에게 들어가는 `content`를 자동으로 envelope wrap. 모든 tool (브라우저 외, MCP / shell / web fetch도)이 이걸 사용한다. **ADR-0029**.

[src/agent/prompt.ts:164](../../../src/agent/prompt.ts#L164) `untrusted sources` 문구는 이미 모델에게 envelope 의미를 가르치고 있다 — 인프라가 비어 있을 뿐. 본 RFC가 그 구멍을 메운다.

### 2.10 Playwright injected.js embed (P2, Med)

**Codex 패턴**: Playwright의 `injected.js` (selector engine) 통째로 embed해서 selector 재사용.

**우리에게**: Phase 5에서만. **법적 검토 필요**: Playwright는 Apache 2.0 — embed OK, 단 license 명시. 그 전 (Phase 2-4)은 우리 자체 querySelector 기반 minimal locator.

### 2.11 AsyncLocalStorage span context (P0, Critical)

**Codex 패턴**: host process가 span context를 AsyncLocalStorage로 주입, tool code는 read-only 접근.

**우리에게**: `src/observability/span-context.ts`에 ALS instance. `src/browser/transport.ts`가 RPC 호출 직전 ALS에서 `{sessionId, turnId, spanId}` 자동 흡수. tool 함수 signature에서 envelope 제거 — *불가능하게* 만든다. **ADR-0031**.

### 2.12 SKILL.md 글쓰기 패턴 (함정 명명, 숫자 prose 등) (P2, Med)

**Codex 패턴**:
- 함정 추상명사 명명 (`authoritative signal`, `stop re-verifying`)
- `[1]~[17]` 번호화로 모델 검색 가능성 ↑
- emoji 🔎 default fallback
- "Don't ask early" + "exception for data transmission" 두 줄 룰
- alias + 부정 routing rule

**우리에게**: 우리 prompt ([src/agent/prompt.ts:34](../../../src/agent/prompt.ts#L34) trust ladder, [:112,114](../../../src/agent/prompt.ts#L112) artifact)에 다음 추가:
- "browser surface" snippet — Phase 3에서 추가, byte-identical을 깨므로 *opt-in flag* 뒤에.
- internal term blacklist 강제 (§4 — turn_id, session_id, spanId 등 user-facing에 leak 금지). **ADR-0032**.

---

## 3. 우리 기존 강점 (이미 SOTA, 그대로 유지)

본 RFC의 *어느 phase도* 다음 영역을 건드리지 않는다.

### 3.1 Subagent cancellation tree

[src/subagent/types.ts:40-45](../../../src/subagent/types.ts#L40)의 parent↔child signal chain은 Codex의 OOPIF-recursive 패턴보다 명시적. Tab actor abort는 이 패턴을 *재사용*한다 — 새로 만들지 않는다.

### 3.2 Tool result externalization (output-spill)

[src/tool/output-spill.ts](../../../src/tool/output-spill.ts) + [src/tool/registry.ts:85-97](../../../src/tool/registry.ts#L85)는 large output을 `fullLogPath`로 spill한다. 브라우저 screenshot / DOM dump도 이걸 그대로 사용 — `src/artifact/`는 *binary* 채널만 새로 만든다 (§6.2).

### 3.3 Authoritative signal stop (closeout-guard)

[src/agent/closeout-guard.ts:45](../../../src/agent/closeout-guard.ts#L45) + [src/agent/loop.ts:683-704](../../../src/agent/loop.ts#L683) `verifyGuardStep`. 브라우저 도구의 verification result도 이 guard에 흡수된다.

### 3.4 Confirmation timing canonical order

[src/agent/admissibility-gate.ts:212-227](../../../src/agent/admissibility-gate.ts#L212): mode → HITL → policy → hook 순. Codex "Don't ask early"와 동등. **변경 금지**.

### 3.5 Tier 명시 (HITLTier enum)

[src/permission/types.ts:32](../../../src/permission/types.ts#L32) `HITLTier`. Codex SKILL.md 자기분류 vs 우리 enum — 우리가 이미 우월. **enum 자체는 추가하지 않는다** (4-tier 변경은 ADR-0020 재오픈 필요).

### 3.6 Slice isolation (Biome)

`biome.json` boundary rules. 신설 `src/browser/`도 동일 규칙: `@/permission`/`@/llm`/`@/agent` 직접 import 금지 — bridge 패턴 ([src/agent/lsp-bridge.ts](../../../src/agent/lsp-bridge.ts), [src/agent/mcp-bridge.ts](../../../src/agent/mcp-bridge.ts))으로 통신.

### 3.7 jsonl-recorder audit trail

[src/stream/adapters/jsonl-recorder.ts:49](../../../src/stream/adapters/jsonl-recorder.ts#L49). browser tool event도 기존 `tool_call` / `tool_result` event로 흐른다 — `KIND_MAP` ([:197-209](../../../src/stream/adapters/jsonl-recorder.ts#L197))은 *추가만* 하지 변경하지 않는다.

---

## 4. 우리 차별점 (Codex 위에 SOTA++)

Codex의 좋은 패턴을 그대로 들고 오기만 해도 큰 성공이지만, Codex가 *놓친* 곳을 처음부터 채우는 것이 quanta-v3의 정체성이다.

### 4.1 Policy-code 통합 enforcement (P0, Critical) — vs Codex SKILL.md 자기분류

**Codex 문제**: 4-tier 분류가 LLM의 SKILL.md 자기-검색에 의존. 모델이 "이건 tier 1입니다"라고 거짓말하면 코드 단계에서 잡을 길이 없음.

**우리 해법**: `src/browser/confirmation-prompts.ts`에서 `BrowserConfirmPrompt` `const enum` + pure `matchPrompt(action)`. [src/agent/admissibility-gate.ts:192](../../../src/agent/admissibility-gate.ts#L192) `runAdmissibilityGate`가 LLM 출력보다 *먼저* `matchPrompt`를 실행 — deterministic matcher가 prompt 번호 결정. 모델은 *분류*에 관여하지 않고 *확인 메시지를 사용자에게 전달*하는 역할만.

### 4.2 Approval token 6-tuple (P0, Critical) — vs Codex once/session/always 3-scope

**Codex 문제**: approval 범위가 `once` / `session` / `always` 3-tier뿐. dataClass / TTL / revoke가 없음. 24h cache + revocation 없음.

**우리 해법**: `src/permission/approval-token.ts` 신설.

```ts
interface ApprovalToken {
  action: ToolAction          // 1
  origin: string              // 2 — normalized URL origin
  dataClass: DataClass        // 3 — "public" | "session-secret" | "pii" | "auth"
  ttlMs: number               // 4 — absolute expiry
  scope: "once" | "origin" | "origin+action" | "session" // 5 — narrowest by default
  revokeHandle: string        // 6 — symbol the user can revoke from CLI
}
```

revoke는 `/approval revoke <handle>` CLI 명령으로. backend 다운 시 **fail-closed** (§5.4).

### 4.3 Origin pivot tracker (P0, Critical) — vs Codex 3xx redirect 무검사

**Codex 문제**: form action / meta-refresh / 3xx redirect 후 origin re-check 안 함 — silent privilege pivot.

**우리 해법**: `src/browser/origin-tracker.ts`. 모든 nav 직전/직후 origin diff → 다르면 approval token 재-evaluate. CDP `Network.requestWillBeSent` + `Network.responseReceived` 이벤트 hook (Phase 5). Phase 2-4에서는 mock 모드에서도 동일 결과 — origin transition은 *항상* `runHitlGate` 재호출. **ADR-0034 (예약)**.

### 4.4 Input provenance signing (P1, High) — vs Codex untagged keystrokes

**Codex 문제**: `Input.dispatchKeyEvent`가 어디서 originated 했는지 (사용자 직접 vs agent reasoning vs replayed log) 구분 없음.

**우리 해법**: `src/browser/input-provenance.ts`. 모든 keystroke RPC에 `{actorId, reasoningHash, modelTurnId, signedAt}` 부착. AsyncLocalStorage span context (§2.11)가 자동 fill. 브라우저 backend는 metadata만 전달 (실제 DOM은 plain key event) — receiving page는 변화 없음. 우리 trajectory만 누가 typed 했는지 알 수 있음.

### 4.5 Self-quote tainting (P1, High) — vs Codex no-trust-decay

**Codex 문제**: agent 자신의 prior turn output이 다시 context로 들어올 때 trust level 동일 — prompt injection의 amplification vector.

**우리 해법**: `src/memory/working.ts`의 working state에 들어가는 모든 agent self-quote는 `trust: "self-derived"`로 강등. [src/agent/working-state.ts](../../../src/agent/working-state.ts)의 append 단계에서 자동. ToolResultEvidence.provenance (§2.9)와 결합 — 외부 untrusted → self-quote도 untrusted.

### 4.6 Snapshot freshness enforcement (P0, Critical) — vs Codex SKILL rule만

**Codex 문제**: snapshot rule을 SKILL.md 6줄로만 적어둠 — 코드 enforcement 없음.

**우리 해법**: `DomSnapshot.snapshotId: string` 부여. mutation tool (click, type, navigate)은 `expectedSnapshotId` parameter *필수*. 불일치 → 자동 재snapshot prompt (`tool error: snapshot stale (id=X, current=Y), call browser_snapshot first`). 어떤 DOM mutation event도 snapshotId를 invalidate. Phase 5에서 `MutationObserver` 기반 자동 invalidation. **ADR-0030의 일부**.

### 4.7 Surface-aware admissibility (P0, Critical) — vs Codex single-surface

**Codex 문제**: 모든 confirmation prompt가 CLI-style stdin assumption. Web-Tauri의 `confirm()` dialog나 CLI-embedded의 webview popup은 다른 UX.

**우리 해법**: `src/permission/surface.ts` 신설. `SurfaceKind = "cli" | "web-tauri" | "cli-embedded"` enum. `runHitlGate`에 surface 인자 추가, 같은 tier가 surface별로 다른 prompt UI로 라우팅 (단, decision logic은 동일 — 우리는 *결정*과 *UI*만 분리). [src/agent/admissibility-gate.ts:192](../../../src/agent/admissibility-gate.ts#L192) `runAdmissibilityGate`에 `surface?: SurfaceKind` optional 인자 추가, 미지정 시 `"cli"` (byte-identical). **ADR-0033**.

---

## 5. 보안 개선점 (Codex의 critical 위험 회피)

| # | Codex 위험 | quanta 회피책 | 강제 layer |
|---|---|---|---|
| 5.1 | `disabled-for-local-testing` sentinel header → 전 게이트 무력화 | **escape hatch 금지 원칙**. env var / header / file flag로 정책을 우회하는 코드 경로를 *컴파일 단계*에서 차단 — Biome custom rule 추가 검토 (Phase 1). | static |
| 5.2 | `claimUserTab`이 T8 whitelist → approval 없는 사용자 탭 escalation | `claim_user_tab` tool은 **별도 tier `always-confirm` 강제** + `hazardTags: ["claim-user-context"]`. whitelist 가능 도구 목록에서 제외 ([src/permission/policy.ts:84](../../../src/permission/policy.ts#L84) HARD_DENY 인접 영역). | runtime |
| 5.3 | 3xx redirect origin re-check 안 함 → silent privilege pivot | §4.3 Origin pivot tracker. ADR-0034. | runtime |
| 5.4 | `SecurityChecker.isBlocked` fail-open → backend 다운 시 모든 origin 통과 | **fail-closed 정책**. backend 응답 timeout 또는 error → deny (not allow). [src/permission/policy.ts](../../../src/permission/policy.ts) 결정 매트릭스에 `unknown → deny`. | runtime + test |
| 5.5 | 24h cache + revocation 없음 | §4.2 Approval token 6-tuple — `ttlMs` + `revokeHandle`. revocation은 CLI command `/approval revoke <handle>` 즉시 반영. | runtime |
| 5.6 | `Sentry.setUser({email})` raw → GDPR risk | Sentry 자체를 흡수 안 함 (§1.2). 만약 미래에 추가하면 `src/observability/`의 redaction layer 통과 강제 — email은 hash 또는 omit. | architecture |
| 5.7 | `Page.handleJavaScriptDialog` confirm/prompt 무시 → hang | 모든 dialog event를 명시적으로 처리 — default = `dismiss` + tool error. user 응답이 필요한 경우 `dialog_pending` tool result로 surface, agent가 명시적으로 `dialog_respond` tool을 호출. | runtime |
| 5.8 | LLM 자기-classifier가 코드 enforcement 없음 | §4.1 `matchPrompt` deterministic matcher. | static + runtime |

---

## 6. 아키텍처 결정

### 6.1 신설 slice: `src/browser/`

**파일 구조**:
```
src/browser/
  index.ts           — public API (BrowserSurface, TabActor types)
  types.ts           — DomSnapshot, LocatorSpec, CapabilityKey, OpenOptions
  transport.ts       — Session-bound RPC envelope (§2.1, AsyncLocalStorage)
  tab.ts             — TabActor implementation (§2.2)
  capability.ts      — BackendRegistry + capability dispatch (§2.3)
  snapshot.ts        — DomSnapshot + freshness enforcement (§4.6)
  locator.ts         — 7-priority locator resolver (§2.8)
  origin-tracker.ts  — Origin pivot tracker (§4.3)
  confirmation-prompts.ts — `BrowserConfirmPrompt` enum + matchPrompt (§4.1)
  input-provenance.ts — Input provenance signing (§4.4)
  engines/
    mock.ts          — Phase 2-4 default
    cdp.ts           — Phase 5
    tauri.ts         — Phase 5 (Web-Tauri surface)
```

**Biome boundary** (slice isolation 유지, §3.6):
- `@/browser`는 `@/shared`, `@/observability`, `@/permission/types` (type only)만 import.
- `@/agent`, `@/llm`, `@/tool`은 **import 금지** — 모두 bridge 통해 통신.

### 6.2 신설 slice: `src/artifact/` (display bridge)

screenshot / 동영상 / binary blob을 ToolResult.output (string)에 박을 수 없음. 별도 채널 필요.

```
src/artifact/
  index.ts
  types.ts  — Artifact = { id, kind: "image" | "pdf" | "har" | "json", path, mediaType, bytes? }
  store.ts  — content-addressed disk store (`<cwd>/.quanta/artifacts/<sha256>`)
```

HookEvent union ([src/agent/hooks.ts:23](../../../src/agent/hooks.ts#L23))에 `tool_artifact_emit` variant 추가 — UI surface (CLI / Web-Tauri)가 subscribe해서 표시. AgentEvent에도 동등 variant — jsonl-recorder가 trajectory에 fingerprint만 기록 (binary 직접 X). **ADR-0030**.

### 6.3 Decision: `src/approval/` slice 분리 vs `src/permission/` 확장

**Decision: `src/permission/` 확장.**

Approval token (§4.2)은 permission decision의 *결과 부산물* — 분리하면 [src/permission/types.ts](../../../src/permission/types.ts)와 동기화 부담 ↑. `src/permission/approval-token.ts` 추가, `PermissionDecision`에 `token?: ApprovalToken` 추가. byte-identical 유지 (optional 필드).

### 6.4 Tool 등록: `src/tool/browser/`

```
src/tool/browser/
  open.ts            — browser_open
  navigate.ts        — browser_navigate
  snapshot.ts        — browser_snapshot
  click.ts           — browser_click
  type.ts            — browser_type
  screenshot.ts      — browser_screenshot
  read_dom.ts        — browser_read_dom
  claim_user_tab.ts  — browser_claim_user_tab (special tier, §5.2)
  capability_call.ts — browser_capability (escape hatch for dev engine, always-confirm)
```

각 tool은 `src/tool/types.ts`의 `Tool` interface 구현. 등록은 [src/tool/registry.ts:7-33](../../../src/tool/registry.ts#L7) 패턴 — eager Map. 9개 tool, 모두 isReadOnly()는 tool별로 결정 (open/navigate/snapshot/screenshot/read_dom = true, click/type/claim_user_tab/capability_call = false).

### 6.5 Bridge 파일: `src/agent/browser-bridge.ts`

[src/agent/lsp-bridge.ts](../../../src/agent/lsp-bridge.ts), [src/agent/mcp-bridge.ts](../../../src/agent/mcp-bridge.ts)와 동일 패턴. agent loop ↔ browser slice 간 통신 단일 진입점. dispose chain에 포함 ([src/agent/loop.ts:293](../../../src/agent/loop.ts#L293) `tool_result` 송신 흐름 변화 없음).

### 6.6 surface-aware: 같은 인터페이스가 CLI/Web-Tauri 모두 지원

`BrowserSurface.backend`는 capability descriptor만 노출 (`cdp` / `tauri-webview` / `native-messaging`). 호출자는 backend를 *알 필요 없이* TabActor를 받는다. 같은 `browser_click` tool이 Web-Tauri에서는 webview IPC, CLI에서는 CDP, CLI-embedded에서는 native messaging으로 라우팅된다. §1.3 surface-model 정합.

---

## 7. 인터페이스 변경 명세

**모든 변경은 optional 필드만 — byte-identical invariant 유지 ([[codex-absorption-complete]] 1309 tests).**

### 7.1 `ToolAction` 확장 ([src/permission/types.ts:8](../../../src/permission/types.ts#L8))

```ts
export interface ToolAction {
  tool: string
  input: unknown
  isReadOnly: boolean
  // 새로 추가 (모두 optional)
  capability?: string         // e.g. "browser.click", "browser.type"
  origin?: string             // normalized URL origin (browser tools)
  hazardTags?: ("read" | "transmit" | "navigate" | "claim-user-context")[]
  surface?: SurfaceKind       // §4.7
}
```

### 7.2 `ToolResultEvidence` 확장 ([src/tool/types.ts:65-71](../../../src/tool/types.ts#L65))

```ts
export interface ToolResultEvidence {
  stderr?: string
  exitCode?: number
  fullLogPath?: string
  // 새로 추가
  provenance?: {
    source: string                                  // "browser:https://example.com"
    trust: "trusted" | "untrusted" | "self-derived"
    origin?: string                                 // URL origin
    snapshotId?: string                             // §4.6
  }
  artifactRefs?: string[]                           // §6.2 artifact ids
}
```

### 7.3 `resultBlock` 확장 ([src/agent/dispatch-helpers.ts:23](../../../src/agent/dispatch-helpers.ts#L23))

```ts
export const resultBlock = (
  id: string,
  content: string,
  isError: boolean,
  provenance?: { trust: "trusted" | "untrusted" | "self-derived"; source?: string }
): ToolResultBlock => {
  const wrapped = provenance?.trust === "untrusted"
    ? `<untrusted source="${escapeXml(provenance.source ?? "unknown")}">\n${content}\n</untrusted>`
    : content
  return {
    type: "tool_result",
    tool_use_id: id,
    content: wrapped,
    ...(isError ? { is_error: true } : {}),
  }
}
```

provenance 미제공 시 기존 동작 (byte-identical).

### 7.4 AgentEvent 확장 (jsonl-recorder)

[src/stream/adapters/jsonl-recorder.ts:197-209](../../../src/stream/adapters/jsonl-recorder.ts#L197) `KIND_MAP`에 추가:
```ts
tool_artifact_emit: "tool_artifact_emit",
```
`dataOf` switch ([:215-261](../../../src/stream/adapters/jsonl-recorder.ts#L215))에 case 추가. binary 자체는 기록 안 함 — 항상 `{ artifactId, kind, sha256, bytes }` 메타만.

### 7.5 admissibility-gate 확장 ([src/agent/admissibility-gate.ts:192](../../../src/agent/admissibility-gate.ts#L192))

```ts
export const runAdmissibilityGate = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  action: AdmissibilityAction,    // 이제 ToolAction with optional capability/surface/hazardTags
  autoClassifier?: AutoModeClassifier,
  // 신규 인자 없음 — surface는 action 안으로 흡수
): Promise<DispatchResult | null>
```

`resolveHitlTier` 내부에서 `action.hazardTags?.includes("transmit")` → `always-confirm` promotion. 기존 callsite는 hazardTags 미지정 → 기존 tier resolution → 기존 동작 (byte-identical).

### 7.6 jsonl-recorder 신규 event

추가만 — 기존 event는 변경 없음. 기존 trajectory tests 회귀 없음.

### 7.7 byte-identical 보장 체크리스트

- [ ] 새 optional 필드는 *모두* `?` 마크
- [ ] `dataOf` switch는 conditional-set 패턴 ([src/stream/adapters/jsonl-recorder.ts:240-244](../../../src/stream/adapters/jsonl-recorder.ts#L240) 참조)
- [ ] resultBlock provenance 미제공 시 wrapped 변수가 `content` reference identical
- [ ] HookEvent union 추가 variant는 기존 5 variant subscribe handler에 영향 없음
- [ ] 새 slice는 *부팅 시* lazy load — capability registry empty 시 zero side-effect

---

## 8. ADR 후보 (6개)

다음 ADR free = **0028**.

### ADR-0028: Browser slice & capability registry

**결정**: `src/browser/` 신설 slice + `BackendRegistry` multi-backend discovery (§2.3). lsp / mcp slice와 동일 boundary 규칙.

**근거**: surface-model 정합 (§1.3). vendor lock-in 회피.

**트레이드오프**: 새 slice는 cognitive overhead. 대신 향후 (Web-Tauri / CLI-embedded surface 추가 시) 변경 영역이 격리됨.

### ADR-0029: Untrusted content envelope (general, not browser-only)

**결정**: `ToolResultEvidence.provenance` 추가 + `resultBlock` provenance arg + agent prompt에 envelope semantics 명시. **브라우저뿐 아니라 MCP / web fetch / shell tool 모두 사용**.

**근거**: prompt injection은 single-tool 문제가 아님. envelope를 첫 도구 (browser)에서만 박으면 다른 도구는 silent vector로 남음.

**트레이드오프**: untrusted wrap이 토큰 사용량 ↑ (envelope당 ~12자). ROI는 Open Q7 참조.

### ADR-0030: Browser evidence externalization (artifact channel)

**결정**: `src/artifact/` 신설 slice. binary는 ToolResult.output 외 별도 채널. jsonl trajectory에는 메타만.

**근거**: screenshot / video / HAR는 string output에 fit 안 함. output-spill (§3.2)은 plain text 전용.

**트레이드오프**: 디스크 사용량. `<cwd>/.quanta/artifacts/`에 GC 정책 필요 (Phase 5).

### ADR-0031: Trajectory attribute namespace (`turn.*` / `tool.*` / `tool.browser.*`)

**결정**: jsonl event payload 키 prefix 규칙. browser specific 키는 `tool.browser.*` (e.g. `tool.browser.origin`, `tool.browser.snapshotId`).

**근거**: 미래 다른 도구 도메인 (mcp / lsp / git)이 namespace 충돌 없이 expand.

### ADR-0032: User-facing internal-term blacklist

**결정**: 사용자에게 노출되는 text (assistant text, deny reason, hook message)에 `turn_id` / `session_id` / `spanId` / 내부 함수명 leak 금지. CI lint rule.

**근거**: Codex가 이 leak으로 confusion 유발. user-facing는 도메인 언어만.

### ADR-0033: ToolAction.tier surfacing (surface-aware)

**결정**: `ToolAction`에 `surface?: SurfaceKind` 추가. `runAdmissibilityGate` 결정 로직은 동일, prompt UI만 surface별 분기.

**근거**: §4.7 — Web-Tauri / CLI-embedded는 stdin assumption이 깨짐.

### (예약) ADR-0034: Origin pivot tracker
### (예약) ADR-0035: Approval token revocation API

§4.3 / §4.2가 충분히 클 경우 Phase 2-3 중 별도 ADR로 분리 검토.

---

## 9. Phase 0~5 로드맵

| Phase | 기간 | 목표 | LOC est | Byte-identical risk |
|---|---|---|---|---|
| 0 | 1주 | ADR 0028~0033 초안 + 정찰 검증 (browser-runtime/* 5개 docs re-read) | 0 (docs) | none |
| 1 | 2주 | `ToolAction` / `ToolResultEvidence` / `resultBlock` optional 필드 확장. `src/artifact/` skeleton. envelope wrap (provenance 미제공시 no-op). | ~600 | low (optional만) |
| 2 | 3주 | `src/browser/` slice (types/transport/tab/capability/snapshot) + mock engine. `src/browser/origin-tracker.ts`, `confirmation-prompts.ts`, `input-provenance.ts`. tests = ~150 expects | ~900 | none (new slice) |
| 3 | 2주 | `src/agent/browser-bridge.ts` + `src/tool/browser/*` (9개 tool). admissibility-gate에 hazardTags 흡수. mock backend로 end-to-end. | ~600 | low (admissibility 변경 careful) |
| 4 | 1주 | artifact channel real (screenshot mock → disk store). jsonl-recorder event 추가. trajectory tests 확장. | ~300 | low (additive) |
| 5 | 2주 | CDP backend (Playwright optional dep) + Tauri webview backend. real browser smoke tests. | ~500 | none (Phase 1-4 위에 backend만 swap) |
| **합계** | **11주** | | **~2,900** | |

**의존성 그래프**:
```
Phase 0 → Phase 1 (ADR 승인 필요)
Phase 1 → Phase 2 (envelope shape 결정 후 transport 설계)
Phase 2 → Phase 3 (slice 안정화 후 tool 등록)
Phase 3 → Phase 4 (bridge 안정화 후 artifact rail 연결)
Phase 3 → Phase 5 (mock 안정화 후 CDP swap — Phase 4와 병렬 가능)
```

**Phase 1 끝나면 1309 tests 여전히 pass + ~30 신규 tests**. Phase 5 끝나면 ~1,460 tests target.

---

## 10. 테스트 전략

**Unit (Bun runner, `bun test`)**:
- `confirmation-prompts.test.ts` — `matchPrompt` 모든 17개 케이스 deterministic.
- `origin-tracker.test.ts` — 3xx redirect / meta-refresh / form action / window.location 모두 origin transition으로 잡힘.
- `approval-token.test.ts` — TTL 만료, revoke handle 동작, scope narrowing.
- `snapshot.test.ts` — stale snapshotId 사용 시 tool error.
- `input-provenance.test.ts` — ALS missing 시 fail-closed (deny).
- `envelope.test.ts` — provenance 미제공시 byte-identical, untrusted시 wrap.

**Integration**:
- `tests/integration/browser-mock-e2e.test.ts` — mock backend로 9개 tool 모두 happy + sad path.
- `tests/integration/browser-admissibility-e2e.test.ts` — hazardTags `transmit` → always-confirm promotion. claim_user_tab tier.
- `tests/integration/browser-trajectory.test.ts` — jsonl event sequence + `tool.browser.*` namespace.

**Byte-identical 회귀 가드**:
- 기존 1309 tests 그대로 통과 — Phase 1 끝마다 확인.
- Phase별 PR에 `tests/golden/*.jsonl` snapshot diff 첨부 — 기존 시나리오는 0 diff.

**Playwright optional dep**:
- `package.json`에 `optionalDependencies` 등록 (Phase 5).
- `try { await import("playwright") } catch { /* skip cdp backend */ }` 패턴.
- CI matrix: `with-playwright` job과 `without` job 둘 다 통과 필요.

---

## 11. 호환성 / 위험 매트릭스

| 위험 | 영향 | 회피 | 검증 |
|---|---|---|---|
| `resultBlock` provenance wrap이 prompt cache miss 유발 | latency / cost ↑ | provenance 미제공시 wrapped = content reference identical (§7.7) | snapshot tests Phase 1 종료시 |
| `ToolAction` 새 필드가 기존 hook handler 깨뜨림 | runtime error | optional만 — 모든 기존 handler는 새 필드 무시 가능 | hook integration tests |
| `src/browser/` slice가 lsp/mcp와 boundary 침범 | Biome lint fail | 부팅 시 lazy load + bridge 패턴 | `bun run lint:biome` Phase 2 종료시 |
| Playwright Apache 2.0 license 부담 | legal | optional dep + license notice + Phase 5에만 도입 | legal review at Phase 5 start |
| Origin tracker가 fast nav loop 못 따라감 | escape | CDP `Network.requestWillBeSent`는 sync 직전 fire — race window 0 | `tests/integration/origin-pivot-race.test.ts` |
| artifact disk usage 폭증 | OOM / disk full | GC 정책 (LRU 1GB cap) + `/artifact prune` CLI 명령 | Phase 5 stress test |
| HookEvent union 확장이 기존 handler narrowing 깨뜨림 | tsc fail | discriminated union 추가는 type-safe (기존 type guard 그대로 동작) | `bun run check:types` Phase 1 |
| Tauri webview backend가 origin model 다름 (custom scheme) | spec 불일치 | origin normalizer가 custom scheme 처리 (테스트 케이스 추가) | `tab-origin.test.ts` |

---

## 12. 의존성 결정

| Phase | new npm dep |
|---|---|
| 0-4 | **zero** — 우리 sqlite / zod / Bun stdlib만 사용 |
| 5 | `playwright` (Apache 2.0, optional) 또는 `chrome-remote-interface` (MIT, lighter) |

**의도적 미흡수**:
- `classic-level` / LevelDB — 우리 sqlite (`@/storage`)로 대체
- Sentry / Statsig — RFC §1.2 의도적 미흡수 ([[codex-absorption-complete]] 정합)
- `electron` — 우리는 Tauri rail
- Codex `comment-preload.js` 35MB bundle 자체 (annotation overlay) — 아이디어만 차용
- Native messaging host binary — Phase 5 옵션, 별도 RFC

**license notice 추가 필요**:
- Phase 5에서 Playwright `injected.js` embed 시 (§2.10) — Apache 2.0 NOTICE 파일 첨부.

---

## 13. Open Questions

| # | 질문 | 결정 필요 시점 | 후보 |
|---|---|---|---|
| Q1 | surface-aware admissibility는 ADR-0033과 통합 vs 별도 ADR? | Phase 0 끝 | 통합 권장 (작은 결정) |
| Q2 | PROMPT INJECTION 방어 강도 — untrusted envelope만 vs self-quote tainting까지? | Phase 1 시작 | 둘 다 (§4.5는 비용 낮음) |
| Q3 | capability registry는 신설 slice (§6.1) vs ToolRegistry 확장? | Phase 2 시작 | 신설 slice (slice isolation 유지) |
| Q4 | Playwright injected.js embed 전체 vs subset? | Phase 5 시작 | subset (selector engine만) — legal/size 모두 ↓ |
| Q5 | Chrome extension backend 지원 여부 (Codex `chrome` backend equivalent) | Phase 5 끝 | 별도 RFC (P2) |
| Q6 | Web-Tauri surface 지원 시점 — Phase 5 vs 별도 RFC | Phase 4 끝 | Phase 5에 mock-level만, real은 별도 RFC |
| Q7 | tool result envelope의 토큰 비용 (~12자/호출) ROI | Phase 1 끝 | provenance 있을 때만 wrap → 평균 ~3% calls만 비용 ↑ |
| Q8 | `claim_user_tab` 도구를 *제공조차 하지 않음*이 더 안전한가? | Phase 3 시작 | 제공 + always-confirm tier로 결정 (전체 차단은 surface usability ↓) |
| Q9 | Approval token revocation API는 ADR-0035 분리 vs §4.2에 포함? | Phase 2 끝 | revocation이 nontrivial하면 분리 |

---

## 14. References

**카탈로그**:
- 자매 문서: [00-feature-catalog.md](./00-feature-catalog.md)

**정찰 결과** ([/docs/reviews-codex-agent/browser-runtime/](../../reviews-codex-agent/browser-runtime/), 1,885 lines total):
- [README.md](../../reviews-codex-agent/browser-runtime/README.md) — 106 lines, owner pack 정의
- [browser-surface-and-capability-audit.md](../../reviews-codex-agent/browser-runtime/browser-surface-and-capability-audit.md) — 275 lines
- [browser-runtime-and-transport-architecture.md](../../reviews-codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md) — 366 lines
- [browser-comment-overlay-and-agent-sync.md](../../reviews-codex-agent/browser-runtime/browser-comment-overlay-and-agent-sync.md) — 421 lines
- [browser-safety-and-admissibility-model.md](../../reviews-codex-agent/browser-runtime/browser-safety-and-admissibility-model.md) — 289 lines
- [browser-reimplementation-blueprint.md](../../reviews-codex-agent/browser-runtime/browser-reimplementation-blueprint.md) — 428 lines

**메모리**:
- [[surface-model]] — multi-surface 게이팅 정책
- [[codex-absorption-complete]] — 1309 tests / 0 fail, byte-identical invariant
- [[subagent-sota-hardening]] — ownedSurfaces / forbiddenSurfaces / continue_from / checkpoint

**RFC / ADR 정합**:
- RFC §1.2 — 의도적 미흡수 정책 (Sentry/Statsig/plugin manifest)
- [ADR-0001](../../decisions/0001*) — slice isolation
- [ADR-0020](../../decisions/0020-hitl-4tier-gate.md) — HITL 4-tier
- [ADR-0023](../../decisions/0023-sota-codex-integration-byte-identical.md) — byte-identical invariant
- [ADR-0026](../../decisions/0026-admissibility-gate-ssot.md) — admissibility gate SSOT
- [ADR-0027](../../decisions/0027-anti-signals-policy-injection-hardening.md) — anti-signal policy

**Codex bundle paths (학습 only, 코드 복사 금지)**:
- `/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/` (Proprietary)
- `/Applications/Codex.app/Contents/Resources/app.asar` (Proprietary)

---

## 부록 A: 흡수 vs 재구현 결정 표

| Codex 컴포넌트 | 결정 | 근거 |
|---|---|---|
| `browser-client.mjs` (번들/난독화) | **학습 only** | Proprietary, 코드 복사 금지 |
| SKILL.md 정책 텍스트 | **아이디어 차용** | 텍스트 그대로는 인용형태로만, 우리 prompt 재작성 |
| `plugin.json` alias/부정 routing 패턴 | **차용** | 표현형식 우리 ToolSpec에 매핑 |
| 4-tier `[1]~[17]` enum | **재구현** | code enum + deterministic matcher (Codex 위 SOTA++) |
| Backend discovery (`chrome` / `iab`) | **재구현** | 우리 BackendRegistry, surface-aware |
| Playwright `injected.js` selector engine | **fork (Phase 5)** | Apache 2.0, subset embed |
| Read-only isolated world (CDP) | **재구현** | 우리는 static typing 추가 (§2.6) |
| Untrusted content envelope wrapper | **재구현 + 일반화** | 브라우저 한정 → 모든 tool로 (§2.9, ADR-0029) |
| Snapshot discipline 6 rules | **재구현 + 코드 enforcement** | (§4.6, ADR-0030 일부) |
| AsyncLocalStorage span context | **차용 패턴** | Node.js stdlib, 우리 observability에 통합 |
| `comment-preload.js` 35MB annotation overlay | **흡수 안 함** | i18n + Google Docs API over-engineered for our surfaces |
| Sentry/Statsig telemetry | **흡수 안 함** | RFC §1.2 |
| `classic-level` (LevelDB) | **대체** | 우리 sqlite 사용 |
| `disabled-for-local-testing` sentinel | **흡수 안 함** | §5.1 escape hatch 금지 원칙 |
| `claimUserTab` whitelist 가능 도구 | **흡수 안 함** | §5.2 별도 tier 강제 |
| `SecurityChecker.isBlocked` fail-open | **반대로 구현** | fail-closed (§5.4) |
| `Sentry.setUser({email})` raw 전송 | **흡수 안 함** | GDPR risk, §1.2 |
| Native messaging host binary | **fork 옵션** | Phase 5 별도 RFC |

---

## 부록 B: Codex 패턴 vs quanta-v3 매핑 표

| Codex 패턴 (카탈로그 §) | quanta 좌표 | Phase |
|---|---|---|
| session_id/turn_id transport-level | `src/browser/transport.ts` + `src/observability/span-context.ts` | 2 |
| 2-tier surface (Browser → Tab) | `src/browser/index.ts` BrowserSurface / TabActor | 2 |
| Multi-backend discovery | `src/browser/capability.ts` BackendRegistry | 2 |
| Read vs Transmit 분리 | `ToolAction.hazardTags` + admissibility | 1+3 |
| 6 engine 병렬 | `src/browser/engines/` (Phase 5에서 분리) | 5 |
| Read-only isolated world | `src/browser/snapshot.ts` ReadonlySnapshot | 2/5 |
| Playwright injected.js embed | `src/browser/locator.ts` (Phase 5 subset) | 5 |
| 4-tier confirmation `[1]~[17]` | `src/browser/confirmation-prompts.ts` + admissibility-gate | 2+3 |
| Untrusted content envelope (general) | `ToolResultEvidence.provenance` + `resultBlock` wrap | 1 |
| Locator strategy 7-priority | `src/browser/locator.ts` | 2 |
| Snapshot discipline 6 rules | `src/browser/snapshot.ts` snapshotId enforcement | 2 |
| "Don't ask early" + data transmission 예외 | 이미 admissibility-gate.ts:212-227 (no change) | — |
| AsyncLocalStorage span context | `src/observability/span-context.ts` | 1+2 |
| 함정 추상명사 명명 | `BrowserConfirmPrompt` enum (코드 enforcement) | 2 |
| emoji 🔎 default fallback | UI surface — CLI prompts (낮은 우선순위) | 3 |
| alias + 부정 routing rule | tool spec description 가이드 | 3 |
| retry-safe if-guard bootstrap | `src/browser/transport.ts` lazy init pattern | 2 |
| 3-layer 언어 분리 (internal/setup/user-facing) | ADR-0032 lint rule | 1 |
| internal term blacklist | CI lint rule (ADR-0032) | 1 |
| `Promise<undefined \| Tab>` 타입 순서 | TypeScript style guide (low ROI) | 2 |
| Codex `disabled-for-local-testing` sentinel | **흡수 안 함** | — |
| Codex `claimUserTab` T8 whitelist | **반대로 — 별도 tier 강제** | 3 |
| Codex 3xx redirect re-check 누락 | **§4.3 Origin pivot tracker** (우리 차별점) | 2 |
| Codex `SecurityChecker.isBlocked` fail-open | **§5.4 fail-closed** (우리 차별점) | 1 |
| Codex 24h cache + no revocation | **§4.2 Approval token 6-tuple** (우리 차별점) | 2 |
| Codex 4-tier LLM 자기분류 | **§4.1 deterministic matcher** (우리 차별점) | 2 |
| Codex `Sentry.setUser({email})` | **흡수 안 함** + redaction layer | — |
| Codex dialog 무시 → hang | **명시적 처리** (§5.7) | 5 |
| Input provenance (Codex 없음) | **§4.4 우리 차별점** | 2 |
| Self-quote tainting (Codex 없음) | **§4.5 우리 차별점 + memory/working** | 2 |
| Snapshot freshness 코드 enforcement (Codex SKILL만) | **§4.6 우리 차별점** | 2 |
| Surface-aware admissibility (Codex single-surface) | **§4.7 우리 차별점 + ADR-0033** | 3 |

---

*문서 끝. Phase 0 산출물로 ADR-0028~0033 초안 PR이 필요하다.*
