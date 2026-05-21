# Codex Round-6 Polish Ship Note (2026-05-21)

R5 (`may-21-codex-r5-implementation.md`)에서 ship한 ADR 0045-0049 5개 feature를 사용자 지시 "기깔나게 다 만들어주고, 만든것들은 3회정도 어딧해서 구조적으로 100점만점급으로 보완"에 따라 5 worktree-isolated agent로 3-pass audit + follow-up wiring 적용.

## 결과 요약

| Agent | ADR | Polish surface | Main commit | 신규 tests |
|---|---|---|---|---|
| A | 0045 progress-audit | router-agnostic seam (`triggerProgressAudit`/`findProgressAuditSkill`) + structural P0 pin | `9ed0789` | +11 |
| B | 0046 permission stack | `PermissionInspector` 5-axis explainResolution + 10 smells fixed | `a37d00a` | +34 |
| C | 0047 HITL 4-tier | `HandoffRequiredEvent` + `onHandoff` callback + one-way ratchet + zod strict | `30c56f2` | +49 |
| D | 0048 response.in_progress | Rate-limited unknown event logger + `InProgressIndicator` byte-identical fallback | `5c64d0e` | +13 |
| E | 0049 side-conversation | `dispatchSideConversation` router + 동적 allowlist invariant + token budget + sticky-taint addendum | `9fbf52d` | +17 |

총 **+124 신규 tests / +443 expects / 0 regression** (우리 R6 슬라이스).

## 5 Agent 3-Pass Protocol

각 agent worktree에서 자기 ADR 영역을 다음 3 pass로 audit + 보강:
- **Pass 1 (smell hunt)**: structural design 결함, leaky abstraction, missing test, naming inconsistency 식별 — 코드 작성 X, 보고서만
- **Pass 2 (hardening)**: Pass 1 발견들 fix. edge case test 추가, type safety 강화, error path 보완
- **Pass 3 (100/100 polish)**: cross-ADR 일관성, docs 정밀화, ADR/카탈로그 동기화, JSDoc

추가로 **follow-up wiring** (R5 §한계에 명시한 미완성 표면 마무리).

## Worktree base 분기 (cherry-pick 전략)

| Agent | Base | 의미 |
|---|---|---|
| A/B | `2540a09` | R5 끝 시점, polish만 추가 → cherry-pick 깨끗 |
| C/D/E | `04e4381` | R5 전, commit이 R5 + polish superset → `-X theirs`로 incoming 우선 |

## 통합 인시던트 + 1-line fix

**Symptom**: cherry-pick 후 11 fail (`ReferenceError: inferToolTier is not defined`).
**Root cause**: `-X theirs`로 Agent C의 `admissibility-gate.ts`를 가져왔지만 `@/permission` imports 블록에서 `inferToolTier` 한 줄 누락.
**Fix**:
```diff
   type HITLTier,
   hardDenyReason,
+  inferToolTier,
   type PermissionContext,
```
**결과**: 11 fail → 0 fail. 1-line surgical fix.

## 5 Polish의 구조적 보강

### A. progress-audit (0045) — Surface decision 미루기
- 슬래시 router는 surface-specific (CLI vs Web-Tauri vs CLI-embedded browser). v3에 중앙 router 없음.
- 채택: **router-agnostic seam** — 스킬 모듈이 SSOT, 미래 router가 import해서 사용
- P0 rule pin: substring → **structural numbered-list regex** (6 rules 순번/위치까지 검증)
- HITL 4-tier 호환성: progress-audit = `none` (read-only)

### B. permission stack (0046) — 10 smells fixed
1. `load()` cognitive complexity → 분할
2. **Schema-version quarantine** (numeric/string/missing 모두 → 시작 empty)
3. **Orphan `.tmp` cleanup** (write 실패 후)
4. `flushDebounced` race teardown rmdir → ENOENT graceful
5. **Per-instance tmp suffix** (두 store가 같은 filePath 공유 시 clobber 방지)
6. **Idempotent set/clear** (same value 재설정 시 mtime 변경 X)
7. `reset()` ordering — inflight flush와 race 차단
8. Naming convention 섹션 추가 (`evaluateStack` SSOT)
9. **`PermissionInspector` 5-axis source enum**: `read-only-bypass | post-denial-override | per-thread | per-host | global-default`
10. OTel `quanta.permission.{stack.source,stack.verdict,action_signature,thread_id,host_id,post_denial.event}` 6 keys

### C. HITL 4-tier (0047) — One-way ratchet + handoff event
- ADR-0020 SSOT 보존 (HITLTier enum re-export, 재정의 X — "EXTENDS, not supersedes")
- **One-way ratchet**: `baseline === "hand-off-required"` short-circuit, downgrade 시도는 stderr warn + ignored (security boundary 보존)
- **zod `.strict()` override validation** — unknown field reject
- 7 failure modes tested: malformed JSON / wrong version / missing tool / ENOENT silent / unknown tier / ratchet downgrade refused / runtimeConfig null
- **HandoffRequiredEvent**:
  ```typescript
  { kind: "hitl-handoff", tool, args, handoffMessage,
    reason: "hard-deny:<rule>" | "registry:<tool>" | "tier:hand-off-required",
    timestamp }
  ```
  try/catch wrapped → throwing listener도 dispatch propagate X (stderr warn만)
- **No regex** for command matching (ADR-0031 negative reference, 의도성)
- Zero `as any`

### D. response.in_progress (0048) — Rate-limited logger + byte-identical fallback
- **Rate-limited unknown event logger**: 10 lines / 60s token bucket (log spam 방지)
- Pure & total parsers: throw 안 함, null/false on malformed
- SSE edge case 풀: CRLF/LF, multi-line `data:`, BOM, fragmented buffer, leading-space stripping, 1MB payload
- **`InProgressIndicator`** seam: handler 미설정 시 **byte-identical legacy** (integration test로 pin)
- `parseSseLine` + `applyField` 분리로 biome cognitive-complexity 충족
- ADR cross-link 0033 (jsonrpc envelope), 0034 (session jsonl), 0032 (OTel vocabulary)

### E. side-conversation (0049) — 동적 invariant + sticky-taint addendum
- **동적 allowlist invariant** (가장 가치 있는 정착):
  ```typescript
  expect(SIDE_CONVERSATION_TOOL_NAMES.sort()).toEqual(readOnly(planModeMutatingTable).sort())
  ```
  → 새 mutating tool 추가 시 CI에서 LOUD fail
- Effort runtime guard: `as any`, `JSON.parse`, null/undefined/object bypass 모두 throw
- **Token budget**: 8192 input / 4096 output (configurable) + `SideConversationBudgetError`
- **Cancellation 전파**: parent abort → side-conv abort (test #2 e2e)
- **Sticky-taint addendum ADDED**: `--- quanta side-conv addendum ---` delimiter로 분리해서 byte-identical Codex prompt 보존. 4 sticky-taint 규칙. namespace `quanta.thread.side` 채택했으니 divergence license
- `dispatchSideConversation(req, { resolveLlm, resolveTools?, observe?, signal? })` — host가 LLM/tools/abort/observe 소유

## Cross-ADR pattern 정착

이번 R6에서 4개 Agent가 같은 패턴 자연스럽게 수렴:
- **One-way ratchet** (C — never downgrade hand-off-required)
- **Byte-identical legacy fallback** (D — handler absent ⇒ zero observable change)
- **Dynamic invariant test** (E — fail loudly if dependency changes)
- **5-axis explainer enum** (B — `read-only-bypass | post-denial-override | per-thread | per-host | global-default`)

→ 통일된 audit 결과 패턴. 다음 라운드에서도 활용.

## 최종 검증

| 검증 | 결과 |
|---|---|
| R6 14 test files | **175 pass / 0 fail / 443 expects** |
| tsc (R6 영역) | 0 errors |
| biome (R6 paths) | 0 errors (6 infos pre-existing) |
| `bun fc validate` | **136 features all evidence resolved** (R5 131 → +5 R6) |
| baseline.json | 자동 refresh |

## Cherry-pick 순서 (참조)

```
main 87da548 [before R6]
   ↓ stash main wip
   ↓ git cherry-pick ef0c687       (Agent A — clean)         → 9ed0789
   ↓ git cherry-pick 49fd931       (Agent B — clean)         → a37d00a
   ↓ git cherry-pick -X theirs f539f57   (Agent C — R5 superset)  → 30c56f2
   ↓ git cherry-pick -X theirs 0cb990e3  (Agent D — R5 superset)  → 5c64d0e
   ↓ git cherry-pick -X theirs e407c65   (Agent E — R5 superset)  → 9fbf52d
   ↓ 1-line fix: inferToolTier import in admissibility-gate.ts
   ↓ verify: tsc / biome / bun test / fc validate
   ↓ baseline refresh
main HEAD [post R6, +5 commits]
```

## 알려진 follow-up

- **다른 트랙의 `trust-scope-wire.test.ts`** — main에 trust-scope wire-up commit 있는데 test에서 `AgentConfig.trustScope` 참조. types.ts에 field 누락. R6와 무관 (다른 트랙 책임).
- **`tool/apply-patch.test.ts` `@/patch` import** — V4A 모듈 alias 누락 가능성. R6와 무관.
- **session-envelope-store-seam 2 pre-existing concurrency flakes** — 별도 추적.
- **Stash entry 보존됨** (`wip-before-r6-cherry-pick`) — 사용자가 검토 후 drop/apply 결정. 충돌은 `docs/10.feature-catalog.md` 하나뿐 (fc build로 재생성 가능).

## 누적 ADR 슬롯 (R5 ship + R6 polish + 다른 트랙)

```
0028-0042   cluster integration (직전 라운드)
0043-0044   reference-only (desktop / negative invariants)
0045-0049   본 R5+R6 (progress-audit / permission stack / HITL / response.in_progress / side-conversation)
0050-0054   다른 트랙 (Claude-Desktop absorption renumber)
0055-0059   다른 트랙 (AWF matcher / disclaimer shell / effort 5-tier / anthropic-beta + skill cap / 5 slash commands)
0060+       다음 자유 슬롯
```

## 관련 메모리

- [[may-21-codex-r6-polish]] — 본 라운드
- [[may-21-codex-r5-implementation]] — R5 ship
- [[codex-desktop-build-2867-round-4]] — R5 P1 도출 dive
- [[codex-system-skills-pattern]] — Agent A reference
- [[codex-subagent-tools]] — Agent E nickname/subagent 대조
- [[codex-collaboration-mode-pattern]] — Agent E side-conv 모드 비교
- [[may-21-cluster-integration-15-features]] — ADR 0028-0044 직전 cluster
- [[claude-desktop-tier0-absorption-r2]] — 병행 트랙
- [[verify-workflow]] — tsc fallback
