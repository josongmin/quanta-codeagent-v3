# Codex Browser Runtime Pack

이 폴더는 Codex의 `in-app browser / browser plugin / browser runtime / tab interaction / browser safety / browser comment overlay` 축만 따로 모은 owner pack이다.

상위 router:
- [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)
- [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/README.md)

이 폴더의 목적:
- Codex 브라우저 기능을 `UI convenience`가 아니라 별도 runtime subsystem으로 설명한다
- `Browser` plugin, `browser-client` runtime, `iab` backend, tab/capability surface를 분리해서 정리한다
- 선택 영역 활성화, comment marker, annotated screenshot, agent thread 동기화 같은 app-side overlay 기능을 분리해서 정리한다
- visible skill/plugin contract와 hidden backend 추정을 분리한다
- browser safety/HITL/permission rail을 재구현 관점에서 정리한다
- Codex 비슷한 브라우저 서브시스템을 새로 만든다면 필요한 최소 control plane / data plane을 설계 수준으로 적는다

이 폴더가 직접 소유하는 질문:
- Codex 브라우저 기능은 어떤 plugin/runtime/capability 표면으로 노출되는가
- `agent.browsers.get("iab")` 아래에서 어떤 browser/tab API가 살아 있는가
- Playwright, DOM/CUA, screenshot, asset export, visibility, viewport가 어떻게 분해되는가
- browser action은 어떤 session/turn binding 아래 실행되는가
- 활성 선택 영역과 browser comment는 어떤 overlay/runtime/serializer 경로를 타는가
- read-only evaluate, DOM snapshot discipline, screenshot discipline은 왜 필요한가
- browser safety와 confirmation policy는 어떤 층으로 강제되는가
- Codex 같은 브라우저 기능을 새로 구현하려면 어떤 최소 아키텍처가 필요한가

권장 읽기 순서:
1. [browser-surface-and-capability-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-surface-and-capability-audit.md)
2. [browser-runtime-and-transport-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md)
3. [browser-comment-overlay-and-agent-sync.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-comment-overlay-and-agent-sync.md)
4. [browser-safety-and-admissibility-model.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-safety-and-admissibility-model.md)
5. [browser-reimplementation-blueprint.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-reimplementation-blueprint.md)

문서 배치:
- [browser-surface-and-capability-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-surface-and-capability-audit.md)
  - visible plugin metadata, skill contract, browser/tab/capability API inventory, 기능 분해
- [browser-runtime-and-transport-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md)
  - `browser-client` bootstrap, backend discovery, session binding, tab/session RPC, CDP bridging, best-fit hidden runtime model
- [browser-comment-overlay-and-agent-sync.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-comment-overlay-and-agent-sync.md)
  - selected region, comment marker, hover metadata, annotated screenshot, browser comment to thread sync
- [browser-safety-and-admissibility-model.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-safety-and-admissibility-model.md)
  - browser-specific safety, confirmation taxonomy, capability gating, read/write risk boundary
- [browser-reimplementation-blueprint.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-reimplementation-blueprint.md)
  - Codex-like browser subsystem을 새로 만들 때의 control plane, API shape, phased build plan, failure modes

업스트림 evidence owner:
- [plugin-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/plugin-audit.md)
- [turn-context-and-runtime-interface.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/turn-context-and-runtime-interface.md)
- [tool-routing-and-triggering.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/tool-routing-and-triggering.md)
- [permission-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/permission-management-audit.md)
- [hitl-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/hitl-audit.md)
- [direct-observable-facts.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/direct-observable-facts.md)

직접 읽은 local browser bundle:
- [plugin.json](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/.codex-plugin/plugin.json)
- [SKILL.md](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/skills/browser/SKILL.md)
- [browser-client.mjs](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/scripts/browser-client.mjs)
- [visibility.md](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/docs/capabilities/browser/visibility.md)
- [viewport.md](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/docs/capabilities/browser/viewport.md)
- [pageAssets.md](/Users/songmin/.codex/plugins/cache/openai-bundled/browser/0.1.0-alpha2/docs/capabilities/tab/pageAssets.md)
- [app.asar](/Applications/Codex.app/Contents/Resources/app.asar)
- [rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl](/Users/songmin/.codex/sessions/2026/05/21/rollout-2026-05-21T02-14-01-019e4661-4823-7bb1-8dd2-e188103d4a20.jsonl)

절대경로 메모:
- Codex desktop app bundle path: `/Applications/Codex.app/Contents/Resources/app.asar`

주의:
- 이 폴더는 hidden browser backend implementation dump가 아니다.
- `browser-client.mjs`는 번들/난독화된 단일 파일이라, direct fact와 best-fit reconstruction을 분리해서 읽어야 한다.
- `classic-level` 같은 bundled dependency 존재만으로 browser state persistence backend를 단정하지 않는다.
- 추정 섹션은 `visible contract + local bundle code + current Codex app surface + 2026 agent/browser SOTA pattern` 조합으로만 올린다.

---

## Round 2 update (2026-05-21 deep dive)

Codex Desktop build 2867 (Electron 42.0.1, prod) deep dive에서 확정된 owner-pack 수준 변경 사항.

1. `[FACT]` `comment-preload.js` (35MB)는 MCP UI preload가 **아니다**. in-app browser sidebar의 annotation/comment overlay preload다.
   - 35MB 크기는 64 locale i18n bundle + DOM selector generation + Google Docs API integration의 합으로 설명된다.
   - MCP-vs-annotation 정정의 owner: [browser-comment-overlay-and-agent-sync.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-comment-overlay-and-agent-sync.md)

2. `[FACT]` browser-use backend enum은 더 이상 `iab`/`extension`/`cdp` 추정이 아니다.
   - 실제 main bundle 함수 `rn()`: `chrome`, `iab` 두 값만 push한다.
   - IPC channel `x-codex-browser-use-available-backends`로 frontend에 expose된다.
   - owner: [browser-runtime-and-transport-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md)

3. `[FACT]` Chrome plugin은 별도 trust/permission rail을 가진다.
   - Chrome extension ID `hehggadaopoacecdllhhajmbjkdcmajg`, native messaging host `com.openai.codexextension`.
   - 별도 bundled `extension-host` native binary가 Chrome ↔ Codex backend bridge다.
   - plugin manifest privacy notice: "Browser data from using this plugin may be used for training".
   - owner: [browser-surface-and-capability-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-surface-and-capability-audit.md), [browser-safety-and-admissibility-model.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-safety-and-admissibility-model.md)

4. `[FACT]` Skybridge MCP UI iframe (`https://web-sandbox.oaiusercontent.com/?app=skybridge…`)은 in-app browser webview 위에서 host되며, 12 named MessagePort 기반 protocol을 가진다.
   - 이 router는 browser-runtime/이 surface 차원에서 cross-reference만 한다.
   - protocol detail owner: [browser-runtime-and-transport-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-runtime-and-transport-architecture.md) Round 2 §.

5. `[FACT]` Codex.app 자체의 macOS code signing/entitlement도 browser surface에 영향을 준다.
   - team `2DC432GLL2` (OpenAI), `network.client=true`, `device.audio-input=true`, `automation.apple-events=true`, `app-sandbox=false`.
   - owner: [browser-safety-and-admissibility-model.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/browser-runtime/browser-safety-and-admissibility-model.md)

absolute paths newly observed:
- `/Applications/Codex.app/Contents/Resources/native/browser-use-peer-authorization.node`
- `/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/browser/.codex-plugin/plugin.json`
- `/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json`
- `~/Library/Application Support/Codex/browser-sidebar-local-servers.json`
