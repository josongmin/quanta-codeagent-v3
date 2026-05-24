# Cursor 갭 구현 계획 (#6~11) — grounded

> [cursor.md](cursor.md) §"우리보다 기깔난 기능" 🟡 tier 6개의 구현 계획. quanta 실제 코드를 3-track 탐색해 grounded. 마킹: S(작음)/M(중간)/L(큼) effort.

## 0. ★ 현실 보정 (탐색 후 — 원래 표가 effort를 잘못 잡았음)

| # | 기능 | 원래 추정 | **실제 (코드 확인)** |
|---|---|---|---|
| 6 | glob `.mdc` rule | "구조적 부재" | quanta가 **이미 `globToRegExp`+`matchesAnyGlob`+`skillsActivatedFor` 보유** ([src/skill/activation.ts:9-72](../../../src/skill/activation.ts#L9)). rule layer는 그걸 재사용 → **S** |
| 7 | hook updated_input | "미흡" | hook bus + **per-tool ToolMatcher 이미 split**([tool-matchers.ts](../../../src/agent/tool-matchers.ts)). `pre_tool_use`가 `{deny}`만 반환 → `{updatedInput}` 추가만 → **S** |
| 8 | PTY/tmux | "Tier2" | **typed shell observer 이미 존재**(ADR-0081, `ShellExecEvent` start/stdout/stderr/exit/aborted+byte offset). 단 node-pty 의존성 0, Bun.spawn은 PTY 아님 → **L** (native dep 필요) |
| 9 | OS 샌드박스 | "OS 샌드박스 0" | **pure guard 3개 이미 SHIP됐는데 미배선**: git-write-guard(0091)+branch-only+network-allowlist. `SandboxPolicy` typed인데 exec서 미적용 → **배선=S-M, 진짜 OS 샌드박스=L** |
| 10 | cache 워밍 | "워밍 없음" | Anthropic ephemeral cache 2 breakpoint 존재, OpenAI auto. **warming=speculative prefetch=API 콜 2배+Anthropic만 이득**. cache-hit metric은 이미 usage event에 thread됨 → **대부분 low-ROI, skip** |
| 11 | idempotency/3-transport | "단일 stream" | **FallbackLLM이 이미 provider swap**(Anthropic↔OpenAI, 529/5xx/network). RetryingLLM+stream-timeout+same-turn retry 존재. idempotency=Anthropic header만 가능(OpenAI SDK 차단)+스트리밍엔 저가치 → **대부분 이미 해결, 신규는 저우선** |

**결론**: 6개 중 #6/#7/#9-배선은 **싸고 즉시 가능**, #8은 진짜 큰 작업, #10/#11은 **대부분 불필요/이미 됨**. 우선순위를 표 순서가 아니라 ROI/effort로 재배열한다.

---

## Phase 1 — Quick wins (전부 S, 병렬 가능, default-OFF, additive)

### 1a. glob-targeted rules — `S`
- **현재**: `repoRules`는 세션당 1파일(AGENTS.md/CLAUDE.md) 우선순위 로드, glob 0 ([repo-rules.ts:25-56](../../../src/agent/repo-rules.ts)). skills는 `paths:` frontmatter로 glob 활성화 이미 함.
- **설계**: `AgentConfig.globRules?: GlobRule[]`(`{pattern, body, loadedAt?}`) 추가 → [buildDynamicContext](../../../src/agent/prompt.ts#L460)에서 changedPaths(또는 cwd 컨텍스트)로 필터 → 매칭 rule을 repoRules 블록 위에 별도 `## Glob-targeted rule: <pattern>` 섹션. **`src/skill/activation.ts`의 globToRegExp/matchesAnyGlob 재사용**(공유 util로 추출).
- **캐시**: glob rule은 per-turn dynamic이라 trailing `<system-reminder>`에(repoRules처럼), 캐시 prefix 불변 유지.
- **default-OFF**: `globRules` absent ⇒ byte-identical.
- **파일**: 신규 `src/agent/glob-rules.ts`(loader+matcher) + prompt.ts 1 루프 + types.ts 1 필드. 테스트. ADR.

### 1b. hook updated_input (인자 mutate) — `S`
- **현재**: `pre_tool_use` 핸들러가 `{deny:string}`만 반환, mutation seam 없음 ([hooks.ts:36-48](../../../src/agent/hooks.ts)). 실행은 `call.input` 그대로([dispatch.ts:226](../../../src/agent/dispatch.ts)).
- **설계**: hook 반환 타입 `HookDeny | { updatedInput: unknown } | null` discriminated union으로 확장 → [runPreToolUseHook](../../../src/agent/admissibility-gate.ts#L189) seam에서 `updatedInput` 있으면 `execute(call, ...)`에 mutated input 전달. zod 검증은 mutated input에 적용(registry.run이 final input 봄).
- **per-tool gate**: `ToolMatcher`(FS/AGENT split) **이미 존재** — 추가 작업 없음.
- **default-OFF**: 기존 deny-only 핸들러 null 반환 그대로 컴파일·동작 불변.
- **파일**: hooks.ts(반환 union) + admissibility-gate.ts/dispatch.ts(1 conditional). 테스트. ADR.

### 1c. 기존 sandbox guard 배선 (git-write-guard + network-allowlist) — `S-M`
- **현재**: **pure detector 3개가 SHIP됐는데 아무도 안 부름**: `gitWriteProtectReason`(0091), `decideBranchOnly`(branch-only.ts), `isHostAllowed`(network-allowlist.ts). `SandboxPolicy` typed인데 exec서 미적용.
- **설계**: dispatch seam(또는 admissibility-gate HARD_DENY 이후)에서:
  - mutating 도구의 target path → `gitWriteProtectReason(path)` non-null이면 deny (0091 follow-up 완성)
  - shell/network 도구 → `isHostAllowed` 미허용 host면 deny/ask (mode policy 연동)
- **default-OFF**: 새 mode-policy lever(`gitWriteProtect`/`networkAllowlist`) 켰을 때만. absent ⇒ 불변.
- **파일**: dispatch.ts/admissibility-gate.ts wiring + permission policy lever. 테스트. ADR(0091 follow-up).

**→ Phase 1 = 3 병렬 에이전트 (1a/1b/1c), disjoint files, 검증된 0069/0070/0071 패턴.**

---

## Phase 2 — Real capability (M~L, 순차)

### 2a. per-thread/per-host SandboxPolicy 실제 적용 — `M` (refactor)
- **현재**: `ThreadPermission.sandboxPolicy` typed인데 inspector만 읽고 **exec gate가 미적용**([permission-store.ts:73-77](../../../src/permission/permission-store.ts)).
- **설계**: dispatch seam이 `ResolvedSandboxPolicy`(global mode + per-host + per-thread stack)를 build → `runShell` options로 thread([runtime/shell.ts](../../../src/runtime/shell.ts)). envAllowlist/cwdJail/maxOutputBytes/disclaimShell는 이미 `SandboxPolicy`에 typed.
- **default-OFF**: policy absent ⇒ 현재 동작.

### 2b. PTY-backed shell (node-pty) Phase A — `L` (가장 큰 단일 작업)
- **현재**: typed shell observer 존재([shell-exec-types.ts](../../../src/shared/shell-exec-types.ts), ADR-0081) but Bun.spawn=pipe-only, PTY 아님. node-pty 의존성 0.
- **설계**: (i) `@lydell/node-pty`(또는 동등) 의존성 추가, (ii) `ShellExecEvent`에 `cols?/rows?`(start) + 신규 `{kind:"input", data, offset}` 변종(stdin 펌프), (iii) `runShell`에 PTY 모드(observer 있을 때 opt-in), (iv) `write_shell_stdin`/`await(regex)` 도구(Cursor 패턴). long-running dev server/REPL/loop-on-ci 안정 셸 unlock.
- **리스크**: native dep = per-platform build matrix(verify-workflow 메모리: install 차단됨 — 사용자가 dep 추가해야). Bun PTY 지원 확인 필요.
- **default-OFF**: observer absent ⇒ 기존 buffered path 불변.

---

## Phase 3 — 저우선 / 대부분 이미 됨 (정직한 deprioritize)

### 3a. cache 워밍 — **대부분 SKIP**, metric만 `S`
- speculative prefetch는 **API 콜 2배 + Anthropic만 이득**(OpenAI auto-cache라 prefetch 무의미). ROI 낮음 → **보류**.
- 단 **cache-hit metric 노출**은 싸다: `cacheReadTokens`가 이미 usage event에 thread됨([adapters/shared.ts](../../../src/llm/adapters/shared.ts)) → observability sink에 expose만. S.
- explicit breakpoint config(`AgentConfig` cache strategy)는 선택적.

### 3b. idempotency/3-transport — **대부분 이미 해결**, 신규는 저우선
- **3-transport**: `FallbackLLM`([llm/fallback.ts:95-181](../../../src/llm/fallback.ts))이 **이미** Anthropic↔OpenAI swap(529/5xx/network) + stream_reset tombstone. **2-provider는 config 배선만**(factory.createLLM에서 FallbackLLM 체인). 신규 코드 0.
- **idempotency**: Anthropic SDK `defaultHeaders`로 `X-Idempotency-Key` 주입 가능하나 **OpenAI SDK는 미지원**. 스트리밍 요청은 idempotent replay 가치 낮음 → **저우선**(원하면 Anthropic-only).
- **raw-http 3rd transport**: explicit idempotency+Retry-After 제어 가능하나 **메시지 포맷/스트리밍 파싱 유지보수 비용 큼** → SKIP.
- **adaptive Retry-After**: SDK가 raw response header 미노출 → SDK fork 필요 → SKIP. 현 fixed full-jitter backoff로 충분.

**→ Phase 3은 cache-metric 노출(S) 1건만 가치, 나머지는 이미 됐거나 저ROI.**

---

## 권장 시퀀스

```
Phase 1 (병렬 3, 즉시):  1a glob-rules + 1b hook-mutate + 1c guard-wiring   [전부 S, default-OFF]
        │
Phase 2 (순차):          2a sandbox-policy-apply (M) → 2b PTY-shell (L, native dep)
        │
Phase 3 (선택):          3a cache-metric 노출 (S).  3b/나머지 = 이미 됨 or SKIP
```

## 우선순위 한 줄
**Phase 1 (glob-rule / hook-mutate / guard-wiring) = 싸고 즉시·high-ROI → 지금 병렬로.** Phase 2 PTY는 진짜 큰 작업(native dep)이라 별도 결정. **#10 cache 워밍 / #11 idempotency·3-transport는 "기깔나 보였지만 실측하니 대부분 이미 있거나 저ROI"** — 정직하게 deprioritize.

## ADR 번호 (작성 시 ls로 free 확인 — 사용자 동시추가 주의)
1a→glob-rules / 1b→hook-updated-input / 1c→guard-wiring(0091 follow-up) / 2a→sandbox-policy-apply / 2b→pty-shell. 0092+ 사용.
