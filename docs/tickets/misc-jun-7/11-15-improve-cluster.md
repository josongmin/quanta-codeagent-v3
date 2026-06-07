# Tickets 11–15 — IMPROVE cluster (있는데 미완 → SOTA++)

**Date:** 2026-06-08
**Source:** 4병렬 재어딧(jun-08)으로 백로그 jun-07 OPEN 다수가 이미 SOTA로 판명. 남은 5개는 "있는데 부분"(IMPROVE) — host/advisory/render는 있고 에이전트-도구/강제/변형/UI만 빠짐. 각 계획은 deep-audit(file:line) 기반.
**Discipline:** 전부 default-OFF byte-identical · TDD red-first hellgate · 신규도구는 manifest GATED+zero-unwired 라쳇 · claim-100 ⇒ 3R 적대어딧.

---

## 11 — P8 git worktree 에이전트도구 + edit-fence  · ROI 고

**Current (file:line):** `src/runtime/worktree.ts` `withWorktree()`(throwaway, auto-remove-on-clean)+`worktree-fork.ts` `createPersistentWorktree()`(세션 fork) 존재 = host-orchestrated만. `src/runner/session-ops/index.ts:403` `fork --worktree`. **에이전트 도구 0**(manifest에 `enter_worktree` 없음), Bash/Edit는 `ctx.cwd` 고정(`bash/index.ts:499`, edit jail). LLM이 worktree 못 부름.
**Design (default-OFF):** GATED 도구 `enter_worktree`/`exit_worktree`(기존 `withWorktree`/`createPersistentWorktree`/`removeWorktree` 코어 재사용) + 세션스코프 `AgentConfig.activeWorktreeSlot`{worktreePath,isPersistent,branch,repoRoot} + `ToolContext.activeWorktree` (dispatch `buildToolContext`서 thread) + Bash/Edit cwd가 `ctx.activeWorktree?.worktreePath ?? ctx.cwd`로 fence. gate `QUANTA_WORKTREE_TOOL`. **불변식**: 절대경로는 여전히 세션 jailRoot에 jail(worktree는 relative-cwd override지 trust boundary 재정의 아님).
**Files:** NEW `src/tool/worktree/index.ts`(2도구) · `tool/types.ts`(+activeWorktree seam) · `tool/bash/index.ts`+`tool/edit/index.ts`(cwd override 1줄) · `tool/surface/manifest.ts`(GATED) · `agent/types.ts`(slot) · `agent/dispatch.ts`(buildToolContext) · comp-root(slot port mint).
**TDD:** enter→slot set→bash cwd=worktree→exit→slot clear→cwd 복귀 · throwaway auto-remove · persistent 유지 · **edit-fence: relative write는 worktree, absolute write는 세션 jail** · 중복 enter는 에러("exit 먼저") · default-OFF(도구 미등록, cwd byte-identical) · manifest drift-guard.
**Risks:** crash시 orphan worktree(세션 delete가 `deriveWorktreeInfo`로 정리) · 동시 worktree(중복 enter 거부) · dirty-tree(persistent는 CLI-only로, 에이전트는 throwaway 기본) · edit-fence absolute 우회(설계상 세션 jail이 방어).

---

## 12 — §20.4 subagent FS owned/forbidden 강제화  · ROI 중-고 (보안)

**Current (file:line):** `src/subagent/types.ts:73` `ownedSurfaces`/`forbiddenSurfaces`(loose string[], 미canonical). `agent/subagent-runner.ts:346` `buildSeedPrompt`서 **프롬프트 텍스트로만** 주입(advisory). dispatch 12-gate(`dispatch.ts`)에 ownership gate 0. write chokepoint=`storage/fs-jail-lib.ts:72`(symlink-aware canonical+`isPathInside`). bash `sed -i`/redirect는 write 도구 우회.
**Design (default-OFF, fail-closed):** NEW `src/subagent/ownership-policy.ts` — `isPathAllowed(target, policy, cwd)`(forbidden 우선, owned 화이트리스트; fs-jail canonical+`..`/symlink 해소 재사용, glob=picomatch). `AgentConfig.ownershipPolicy{owned,forbidden,enforced}`(`buildChildConfig`서 req에서 조립, `enforced=runtimeConfig().fsOwnershipEnforce`). dispatch **새 게이트 9.5**(permission stack 후, mode policy 전): mutating FS 도구(write/edit/apply_patch/bash)의 target path 추출→non-owned/forbidden이면 typed deny. gate `QUANTA_FS_OWNERSHIP_ENFORCE`. **MVP**: bash는 enforced시 보수적 deny(fine-grained 파싱은 phase-2; circumvention-tracker와 교차).
**Files:** NEW `subagent/ownership-policy.ts` · `agent/types.ts`(+slot) · `agent/subagent-runner.ts`(policy 조립) · `agent/dispatch.ts`(gate 9.5+`extractTargetPaths`) · `shared/runtime-config{,-knobs}.ts`(knob).
**TDD:** owned 안 write 허용 / non-owned·forbidden deny / forbidden>owned / **symlink·`..`·absolute escape 전부 canonical 후 deny** / bash write to forbidden deny / permission HARD_DENY가 여전히 우선 / default-OFF advisory-only byte-identical / fail-closed(unknown knob값→OFF).
**Risks:** over-block(default-OFF+glob 코너 테스트) · bash 보수적 deny 마찰(문서화+phase-2 파싱) · canonical 성능(policy-absent는 alloc 0).

---

## 13 — §12.2 MITM proxy header rewrite/strip/inject  · ROI 중

**Current (file:line):** `network-proxy/types.ts:70` `MitmConfig`(secretEgress/onFailure만). `secret-egress.ts:101` 헤더값 SCAN+redact+`dropHeaderValues`(헤더 통째 drop은 됨, 값 rewrite/inject는 없음). hook point: `loopback-proxy.ts:406` `pipeBufferedHttp`(plain) + `:620` `mitmForwardUpstream`(TLS) — 양쪽서 헤더 재구성 후 upstream dial. gate `mitm-gate.ts`(double-opt-in ack).
**Design (default-OFF):** NEW `network-proxy/header-rules.ts` — pure `applyHeaderRules(headers, rules?)`: `HeaderRule{name, op:strip|set|rewrite, value?}` 순서대로, case-insensitive(lowercase normalize), malformed(set/rewrite without value) silent-ignore, **rules 없으면 입력 그대로 반환(byte-identical)**. `MitmConfig.headerRules?`+(plain용 `SecretEgressConfig.headerRules?`). **redaction 후 적용** → redaction이 이김(drop된 헤더는 rule이 못 살림). 주입값은 secret-egress 재스캔 안 함(operator-trusted).
**Files:** NEW `network-proxy/header-rules.ts`(~50줄) · `network-proxy/types.ts`(+headerRules) · `loopback-proxy.ts`(2 콜사이트서 `applyHeaderRules` 적용).
**TDD:** strip 제거 / set 추가·override / rewrite는 존재할때만 / 순서(나중 rule이 앞 undo) / malformed ignore / **no-rules pass-through byte-identical** / **redaction이 rewrite를 이김** / case-insensitive / e2e(plain+MITM 양쪽 upstream 캡처).
**Risks:** case-sensitivity(lowercase normalize+테스트) · 금지헤더 주입(redaction 우선 불변식) · 순서 혼동(문서+테스트).

---

## 14 — §11.6 `/model` 인터랙티브 피커  · ROI 저

**Current (file:line):** `slash/registry-surface.ts:670` `/effort` 인터랙티브 피커 = **미러할 패턴**(no-arg→현재+목록+`*`마커+hint, arg→검증+set). `/sticky-model`(536)은 mode+id 2-arg(목록 렌더 없음). 모델 카탈로그 SSOT=`llm/provider-metadata.ts:117` `MODEL_CONTEXT_WINDOWS`(28모델). `SlashContext.stickyModel.candidates()`에 id 있음.
**Design:** `/model`(mode-implicit) — no-arg시 현재+candidates(context-window+max-output inline)+hint, arg시 `pickModel(id, candidates)`→`stickyModel.set(currentMode, id)`(기존 set 경로 재사용). `/sticky-model`(admin mode+id)과 직교. tab-complete=prefix 필터(`/effort` 미러). 미배선시 "not wired" degrade.
**Files:** NEW `slash/model-picker.ts`(pure: `formatModelLine`/`pickModel`) · `slash/model-cmd.ts`(/effort 구조 미러) · `repl/ctx-adapters/model-adapter.ts` · `slash-contract.ts`(+model wire) · `registry-surface.ts`(register) + drift-guard 2곳.
**TDD:** pure pick-logic(exact/case-insensitive/not-found throw, window 렌더 degrade) · cmd(no-arg 목록, valid set, invalid 에러, 미배선 degrade, tab) · 슬래시 drift-guard.
**Risks:** candidates 비면 MODEL_CONTEXT_WINDOWS keys fallback · window miss시 "unknown" degrade.

---

## 15 — §11.7 스크립터블 statusLine + 색맹 팔레트  · ROI 저

**Current (file:line):** `apps/cli/status-line.ts:72` `formatContextUsage`(고정 렌더). `registry-surface.ts:53` `VALID_THEMES=[auto,light,dark,claude,none]`(색맹 없음). `/color`(163)가 pref 세팅.
**Design:** (A) **scriptable statusLine** — `runtimeConfig().statusLineCommand?`(operator-authored, hook과 동급 trust) → NEW `status-command-runner.ts` `runStatusCommand`(spawn **NO `shell:true`**, timeout 기본 500ms·hard cap 5s, stdout만 캡처, 실패=silent degrade+warn). REPL이 prompt tick마다 호출(async/cache). default-OFF(absent⇒무영향). (B) **색맹 팔레트** — NEW `color-palettes.ts`(Okabe-Ito SSOT[PLoS ONE 2008]+deuteranopia/protanopia/tritanopia/achromatopsia, 순수 데이터) + `VALID_THEMES`에 `daltonized*` 추가. host 렌더러가 `getColorPalette(theme)` 사용.
**Files:** NEW `status-command-runner.ts`·`color-palettes.ts` · `runtime-config{,-knobs}.ts`(+statusLineCommand) · `registry-surface.ts`(theme enum) · REPL surface(runner 호출).
**TDD:** runner(stdout 캡처/timeout→""/non-zero→warn+stdout/spawn-error→""/timeout cap clamp) · palettes(getColorPalette 매핑/invalid→default/모든 변종 non-empty/valid hex) · 슬래시 theme drift-guard.
**Risks/보안:** statusLine 명령은 operator-authored(hook 신뢰모델), `shell:true` 금지(injection 차단), 5s cap(prompt hang 방지), 느린 명령은 async+cache.

---

## 시퀀싱 (ROI×보안)
1. **12 §20.4 FS enforce**(보안, dispatch gate — 명확한 닫힘) → 2. **11 P8 worktree**(고 ROI, 에이전트 역량) → 3. **13 §12.2 header-rewrite**(중, 자기완결 pure) → 4. **14 /model**·**15 statusLine**(저, UX polish — 묶어서).

**NEW(별도, 미착수)**: §11.1 /init · §11.2 /agents fleet(observability 북극성) · §11.4 Ctrl+B · §22.3 reverse-MCP(고, 신규 server subsystem) · §1.3/1.5 MCP templates/Tasks · §6.2-6.4 browser · §9.4/9.5 reasoning summary/verbosity.
