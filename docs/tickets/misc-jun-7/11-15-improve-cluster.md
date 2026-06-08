# Tickets 11–15 — IMPROVE cluster (있는데 미완 → SOTA++)

**Date:** 2026-06-08
**Source:** 4병렬 재어딧(jun-08)으로 백로그 jun-07 OPEN 다수가 이미 SOTA로 판명. 남은 4개(12 DONE)는 "있는데 부분"(IMPROVE) — host/advisory/render는 있고 에이전트-도구/강제/변형/UI만 빠짐. 각 계획은 deep-audit(file:line) 기반.
**SOTA++ pass (jun-08):** 4 Explore 에이전트가 `.extracted_source/`(Claude Code CLI/IDE·Codex·Cursor) 실구현을 grep해 각 티켓의 경쟁사 메커니즘·스키마·UX를 file:line으로 캐옴. 아래 각 티켓에 **§SOTA(corpus file:line)** + **§SOTA++ delta**(경쟁사엔 있고 우리 원안엔 없던 것; [CORE]=이번에 넣음·[DEFER]=후속+이유) 추가.
**Discipline:** 전부 default-OFF byte-identical · TDD red-first hellgate · 신규도구는 manifest GATED+zero-unwired 라쳇 · claim-100 ⇒ 3R 적대어딧.

---

## 11 — P8 git worktree 에이전트도구 + edit-fence + status  · ROI 고

**Current (file:line):** `src/runtime/worktree.ts` `withWorktree()`(throwaway, auto-remove-on-clean)+`worktree-fork.ts` `createPersistentWorktree()`(세션 fork) 존재 = host-orchestrated만. `src/runner/session-ops/index.ts:403` `fork --worktree`. **에이전트 도구 0**(manifest에 `enter_worktree` 없음), Bash/Edit는 `ctx.cwd` 고정(`bash/index.ts:499`, edit jail). LLM이 worktree 못 부름.

**§SOTA (corpus file:line):** **Claude Code가 유일하게 worktree를 에이전트 도구로 노출** — `claude-code-cli/_cli-symbols.txt`: `EnterWorktree`/`ExitWorktree`(108612,108626), `isolation:"worktree"` 파라미터(126841: "spawns agent in isolated git worktree, auto-cleaned if no changes"), **edit-fence를 우리와 동일하게**: `bgIsolation:"worktree"` 설정(116204)이 `EnterWorktree` 호출 전엔 main checkout Edit/Write를 막고 에러로 가이드(131707). 즉 우리 slot+cwd-override 설계가 CC와 메커니즘 일치 = 방향 검증됨. 추가로 CC가 가진 것: `worktree.branchFrom:"fresh"|"head"`(116207, origin/default vs 로컬 HEAD), `cleanupStaleAgentWorktrees`(orphan GC), `listRegisteredWorktrees`(인벤토리 쿼리), `persistWorktreeSession`(resume signal), `worktree.sparseCheckout`(monorepo cone), `executeWorktreeCreate/RemoveHook`(setup/teardown 훅), dirty-exit시 `force:true` 요구+uncommitted 파일 리스팅. **statusLine `workspace.git_worktree` 필드(아래 §15)로 현재 worktree를 status에 노출** — 11↔15 연결. Cursor/Codex는 host/UI-only(에이전트 도구 없음) → 우리는 CC와 같은 SOTA 진영.

**Design (default-OFF):** GATED 도구 `enter_worktree`/`exit_worktree`/**`worktree_status`**(기존 `withWorktree`/`createPersistentWorktree`/`removeWorktree` 코어 재사용) + 세션스코프 `AgentConfig.activeWorktreeSlot`{worktreePath,isPersistent,branch,repoRoot,**branchFrom**} + `ToolContext.activeWorktree` (dispatch `buildToolContext`서 thread) + Bash/Edit cwd가 `ctx.activeWorktree?.worktreePath ?? ctx.cwd`로 fence. gate `QUANTA_WORKTREE_TOOL`. **불변식**: 절대경로는 여전히 세션 jailRoot에 jail(worktree는 relative-cwd override지 trust boundary 재정의 아님).

**§SOTA++ delta:**
- **[CORE] `worktree_status` 도구**(CC `listRegisteredWorktrees` 미러) — 현재 slot(path/branch/persistent) + `git status --porcelain` 요약(uncommitted count) 반환. observability 북극성 정렬, enter/exit만으론 LLM이 "내가 어디서 작업 중인지" 모름.
- **[CORE] dirty-exit 가드**(CC `force:true` 미러) — `exit_worktree`가 throwaway에서 dirty면 기본 거부+uncommitted 파일 리스트 typed-error, `force:true`로만 폐기. 무음 작업손실 방지(우리 메모리 worktree 작업손실 교훈 다수).
- **[CORE] `branchFrom:"fresh"|"head"`**(CC 116207) — `enter_worktree` 인자(default `head`=현 HEAD). 싸고 결정적, slot에 박아 status/diff에 노출.
- **[DEFER] auto-commit-on-exit + diff 표면화**(Codex PR-flow 미러) — exit시 worktree diff를 turn-diff 채널로. ROI 중이나 turn-diff/observability 슬라이스와 교차 필요 → 후속.
- **[DEFER] lifecycle 훅**(CC `executeWorktreeCreate/RemoveHook`) — create/remove시 operator 스크립트(deps install). 우리 hook 서브시스템 위에 얹어야 함, ROI 저 → 후속.
- **[DEFER/HAZARD] sparse-checkout / symlinkDirs**(CC monorepo 디스크 최적화) — **symlink node_modules는 우리 [[worktree-node-modules-hazard]]로 메인 깨진 전적 → 금지**. sparse-checkout(cone)은 안전하나 ROI 저 → 후속.
- **[DEFER] subagent isolation 상속**(CC subagent `isolation` 캐스케이드) — 12(FS ownership) DONE과 교차; 서브에이전트가 부모 worktree 상속/신규. 후속.

**Files:** NEW `src/tool/worktree/index.ts`(3도구: enter/exit/status) · `tool/types.ts`(+activeWorktree seam) · `tool/bash/index.ts`+`tool/edit/index.ts`(cwd override 1줄) · `tool/surface/manifest.ts`(GATED ×3) · `agent/types.ts`(slot+branchFrom) · `agent/dispatch.ts`(buildToolContext) · comp-root(slot port mint).
**TDD:** enter→slot set→bash cwd=worktree→exit→slot clear→cwd 복귀 · throwaway auto-remove(clean) · **dirty-exit 기본 거부+uncommitted 리스트, force:true로만 폐기** · persistent 유지 · `branchFrom:fresh`는 origin/default서 분기·`head`는 HEAD서 · `worktree_status`가 path/branch/uncommitted-count 반환 · **edit-fence: relative write는 worktree, absolute write는 세션 jail** · 중복 enter는 에러("exit 먼저") · default-OFF(도구 미등록, cwd byte-identical) · manifest drift-guard ×3.
**Risks:** crash시 orphan worktree(세션 delete가 `deriveWorktreeInfo`로 정리, CC `cleanupStaleAgentWorktrees` 동급) · 동시 worktree(중복 enter 거부) · dirty-tree(force 가드+리스팅) · edit-fence absolute 우회(설계상 세션 jail이 방어) · symlink 최적화 금지(과거 메인 파손).

---

## 12 — §20.4 subagent FS owned/forbidden 강제화  · ✅ **DONE (jun-08)** · ROI 중-고 (보안)
**구현완료:** NEW `src/agent/ownership-policy.ts`(`isPathAllowed`/`consultOwnershipPolicy`/`checkWriteEffects`/`buildOwnershipPolicy` — subtree containment, glob-free) + `@/storage` `canonicalizePath` export(symlink-safe 재사용) + dispatch gate(admissibility 후, `extractWriteEffects`+`checkWriteEffects`+deny, default-OFF) + `AgentConfig.ownershipPolicy` slot + knob `QUANTA_FS_OWNERSHIP_ENFORCE`(gateOnStrict, fail-closed) + `buildChildConfig` 조립. **핵심수정:** circumvention `canonicalizeEffectPath`는 lexical-only(symlink 미해소)라 `checkWriteEffects`가 effect를 같은 canonicalizer로 재정규화(symlink escape 방어; 안하면 /var↔/private/var로 우연일치하는 위험). **17 hellgate**(pure 13: owned/forbidden/empty/`..`/symlink/bash-sed e2e + dispatch e2e 4: 실 `dispatchTool`서 deny/run/default-off). 1639 regression 0fail, tsc0/biome0, build OK.

> 이하 원안(참고):

**Current (file:line):** `src/subagent/types.ts:73` `ownedSurfaces`/`forbiddenSurfaces`(loose string[], 미canonical). `agent/subagent-runner.ts:346` `buildSeedPrompt`서 **프롬프트 텍스트로만** 주입(advisory). dispatch 12-gate(`dispatch.ts`)에 ownership gate 0. write chokepoint=`storage/fs-jail-lib.ts:72`(symlink-aware canonical+`isPathInside`). bash `sed -i`/redirect는 write 도구 우회.
**Design (default-OFF, fail-closed):** NEW `src/subagent/ownership-policy.ts` — `isPathAllowed(target, policy, cwd)`(forbidden 우선, owned 화이트리스트; fs-jail canonical+`..`/symlink 해소 재사용, glob=picomatch). `AgentConfig.ownershipPolicy{owned,forbidden,enforced}`(`buildChildConfig`서 req에서 조립, `enforced=runtimeConfig().fsOwnershipEnforce`). dispatch **새 게이트 9.5**(permission stack 후, mode policy 전): mutating FS 도구(write/edit/apply_patch/bash)의 target path 추출→non-owned/forbidden이면 typed deny. gate `QUANTA_FS_OWNERSHIP_ENFORCE`. **MVP**: bash는 enforced시 보수적 deny(fine-grained 파싱은 phase-2; circumvention-tracker와 교차).
**Files:** NEW `subagent/ownership-policy.ts` · `agent/types.ts`(+slot) · `agent/subagent-runner.ts`(policy 조립) · `agent/dispatch.ts`(gate 9.5+`extractTargetPaths`) · `shared/runtime-config{,-knobs}.ts`(knob).
**TDD:** owned 안 write 허용 / non-owned·forbidden deny / forbidden>owned / **symlink·`..`·absolute escape 전부 canonical 후 deny** / bash write to forbidden deny / permission HARD_DENY가 여전히 우선 / default-OFF advisory-only byte-identical / fail-closed(unknown knob값→OFF).
**Risks:** over-block(default-OFF+glob 코너 테스트) · bash 보수적 deny 마찰(문서화+phase-2 파싱) · canonical 성능(policy-absent는 alloc 0).

---

## 13 — §12.2 MITM proxy header rewrite/strip/set/append + cross-origin strip  · ROI 중

**Current (file:line):** `network-proxy/types.ts:70` `MitmConfig`(secretEgress/onFailure만). `secret-egress.ts:101` 헤더값 SCAN+redact+`dropHeaderValues`(헤더 통째 drop은 됨, 값 rewrite/inject는 없음). hook point: `loopback-proxy.ts:406` `pipeBufferedHttp`(plain) + `:620` `mitmForwardUpstream`(TLS) — 양쪽서 헤더 재구성 후 upstream dial. gate `mitm-gate.ts`(double-opt-in ack).

**§SOTA (corpus file:line):** **에이전트 레벨 rich header-rewrite는 경쟁사 누구도 없음** → 우리 설계가 신규. 다만 인접 prior-art 확정: **Cursor** `cursor-agent-exec/dist/main.js:5019` `headersList.set/append/delete(name,value,caseless?)` 3-op(우리 strip/set만 → **append 누락**) + `:32087` `NetworkPolicy{defaultAction:ALLOW|DENY, allow[], deny[], logging.decision_log_path}`(도메인 allow/deny+감사로그) + `secret_redaction_enabled` 플래그(no:18). **Claude Code IDE** `extension.beautified.js:23977` — **cross-origin redirect시 `delete authorization/cookie/host`**(보안 핵심, 리다이렉트가 origin 넘으면 민감헤더 자동 strip) + `:23982` Basic-auth는 **없을때만 주입**(set 아닌 set-if-absent) + `:12461` secret 헤더이름 regex(`api_key|secret|token|password|bearer|authorization|cookie|...`). **Codex** OTel `propagation.inject(...,headers)`(trace 헤더 하드코딩 주입). **누구도 주입값 재스캔 안 함**(우리 operator-trusted 정렬). **누구도 forbidden-header 가드 없음** → 우리가 추가하면 차별점.

**Design (default-OFF):** NEW `network-proxy/header-rules.ts` — pure `applyHeaderRules(headers, rules?)`: `HeaderRule{name, op:strip|set|append|rewrite, value?}` 순서대로, case-insensitive(lowercase normalize), malformed(value 필요한데 없음) silent-ignore, **rules 없으면 입력 그대로 반환(byte-identical)**. `MitmConfig.headerRules?`+`crossOriginStrip?`+(plain용 `SecretEgressConfig.headerRules?`). **redaction 후 적용** → redaction이 이김(drop된 헤더는 rule이 못 살림). 주입값은 secret-egress 재스캔 안 함(operator-trusted).

**§SOTA++ delta:**
- **[CORE] `append` op**(Cursor `headersList.append` 미러) — set(덮어쓰기)과 구분되는 add-if-present(다중값 헤더). strip/set/append/rewrite 4-op. 싸고 자기완결.
- **[CORE] forbidden-header 가드**(경쟁사 전무 → 차별점) — `set/append`가 `authorization/cookie/set-cookie/proxy-authorization` 등 민감헤더 *주입* 시도시 silent-ignore+warn(operator 오설정 방어). redaction-우선과 별개 레이어. SSOT 상수 리스트.
- **[CORE] cross-origin redirect strip**(CC IDE 23977 미러) — `crossOriginStrip:true`(default ON 권장)시 리다이렉트가 origin(scheme+host+port) 넘으면 `authorization/cookie/host` 자동 drop. **header-rules와 직교한 redirect-hygiene 방어** — 우리 proxy가 리다이렉트 추적하면 토큰 유출 차단. pure `shouldStripOnRedirect(from,to)`.
- **[CORE] mutation 감사로그**(Cursor `logging.decision_log_path` 미러) — rule 발화시 {rule-id, header-name, op, fired} 1줄(값은 redact). 어느 rule이 무엇을 바꿨나 추적. 기존 proxy 로거 재사용.
- **[DEFER] per-domain 조건부 rule**(`domainPattern?`) — Cursor allow/deny가 도메인 기반인 점에서 인접. 헤더 rule을 도메인별로. ROI 중, 4-op 안정화 후 후속.
- **[DEFER] templated value `${ENV}`/`${request.id}`**(trace/request-id 주입 유스케이스) — 경쟁사 전무(novel). 보안 표면(ENV 유출) 검토 필요 → 후속.

**Files:** NEW `network-proxy/header-rules.ts`(~70줄: applyHeaderRules+shouldStripOnRedirect+FORBIDDEN_INJECT 상수) · `network-proxy/types.ts`(+headerRules+crossOriginStrip) · `loopback-proxy.ts`(2 콜사이트서 `applyHeaderRules` 적용 + redirect 추적시 strip).
**TDD:** strip 제거 / set 덮어쓰기 / **append는 기존에 추가(다중값)** / rewrite는 존재할때만 / 순서(나중 rule이 앞 undo) / malformed ignore / **forbidden 헤더 주입 silent-ignore+warn** / **cross-origin redirect시 authorization/cookie/host strip, same-origin은 유지** / **no-rules pass-through byte-identical** / **redaction이 rewrite를 이김** / case-insensitive / mutation 로그 값-redact / e2e(plain+MITM 양쪽 upstream 캡처).
**Risks:** case-sensitivity(lowercase normalize+테스트) · 금지헤더 주입(forbidden-guard+redaction 우선 이중방어) · cross-origin 판정 오류(scheme+host+port 정확 비교+테스트) · 순서 혼동(문서+테스트).

---

## 14 — §11.6 `/model` 인터랙티브 피커 + effort 커플링  · ROI 저

**Current (file:line):** `slash/registry-surface.ts:670` `/effort` 인터랙티브 피커 = **미러할 패턴**(no-arg→현재+목록+`*`마커+hint, arg→검증+set). `/sticky-model`(536)은 mode+id 2-arg(목록 렌더 없음). 모델 카탈로그 SSOT=`llm/provider-metadata.ts:117` `MODEL_CONTEXT_WINDOWS`(28모델). `SlashContext.stickyModel.candidates()`에 id 있음.

**§SOTA (corpus file:line):** **Claude Code CLI가 가장 풍부** — `_cli-symbols.txt:145230` 피커: 모델당 displayName + description("most capable for complex work"/"fastest for quick answers") + **context-window inline**("1M context") + **recommended 뱃지**("Default (recommended)"·"(default)") + **세션-한정 vs 기본 토글**(`modelPicker:thisSessionOnly` 키바인딩 — "Currently using X for this session only. Selecting will undo this") + **effort 커플링**(`modelPicker:increaseEffort/decreaseEffort` + 비추론모델엔 "Effort not supported" 힌트) + fast-mode 경고("Switching to other models turns off fast mode"). **Codex가 effort 커플링의 정본**(`use-model-settings-DhE-8qP1.js:106`) — 모델마다 `defaultReasoningEffort`+`supportedReasoningEfforts[]`, **모델 바꾸면 effort를 그 모델의 supported set으로 validate/clamp**(`validateEffort`), 미지원이면 모델 default로. **CC IDE**(`webview/index.beautified.js:207061` `MJe` dropdown) — arrow-nav + 현재모델 **체크마크** + displayName+description(context는 선택 후 별도 fetch). **공통 UX 불변식**: ↑↓ 네비/Enter 선택/Esc 취소/현재 시각마커. **fuzzy 검색은 누구도 없음**(prefix-only 표준) → 우리 prefix tab-complete 정렬.

**Design:** `/model`(mode-implicit) — no-arg시 현재+candidates(context-window+max-output **+ recommended 뱃지 + capability 힌트** inline, **현재모델 `*`/✓ 마커**)+hint, arg시 `pickModel(id, candidates)`→`stickyModel.set(currentMode, id)`(기존 set 경로 재사용). `/sticky-model`(admin mode+id)과 직교. tab-complete=prefix 필터(`/effort` 미러). 미배선시 "not wired" degrade.

**§SOTA++ delta:**
- **[CORE] model↔effort 커플링 검증**(Codex `validateEffort` 미러 — 가장 중요, 정합성 버그) — 모델 set시 현 effort가 그 모델 supported set에 없으면 모델 default effort로 clamp + 1줄 알림. 우리 `/model`·`/effort` 독립 → 추론 미지원 모델에 high-effort 박히는 불일치 방지. `provider-metadata`에 모델별 effort-support 메타 필요(없으면 보수적 "all-supported" fallback).
- **[CORE] recommended 뱃지 + capability/cost 힌트**(CC 145230 미러) — `formatModelLine`이 메타에서 "(recommended)"/"fastest"/"most capable"/"lower cost" 1-liner 부착(메타 없으면 생략 degrade). 의사결정 정보.
- **[CORE] 현재모델 마커**(CC IDE ✓ 미러) — no-arg 목록서 현재 sticky 모델에 `*`(또는 ✓) 표기(`/effort` 미러라 이미 패턴 있음, 명시).
- **[DEFER] 세션-한정 vs sticky 토글**(CC `thisSessionOnly`) — 우리 `setSessionModel` seam 있으면 `/model <id> --session`. 인터랙티브 피커(arrow carousel)는 우리 슬래시가 1-shot이라 키바인딩 캐러셀은 후속(REPL 입력 모델 수술).
- **[DEFER] latest/legacy 그룹핑**(CC 섹션 헤더) — 28모델 정렬·섹션화. ROI 저, cosmetic → 후속.

**Files:** NEW `slash/model-picker.ts`(pure: `formatModelLine`/`pickModel`/**`clampEffortForModel`**) · `slash/model-cmd.ts`(/effort 구조 미러) · `repl/ctx-adapters/model-adapter.ts` · `slash-contract.ts`(+model wire) · `registry-surface.ts`(register) + `provider-metadata.ts`(모델별 effort-support 메타, 없으면 보수 fallback) + drift-guard 2곳.
**TDD:** pure pick-logic(exact/case-insensitive/not-found throw, window 렌더 degrade) · **clampEffortForModel(미지원 effort→모델 default, 메타없음→all-supported fallback)** · formatModelLine(뱃지·힌트 부착·메타없음 생략·현재마커) · cmd(no-arg 목록+현재마커, valid set, **set시 effort clamp 알림**, invalid 에러, 미배선 degrade, tab) · 슬래시 drift-guard.
**Risks:** candidates 비면 MODEL_CONTEXT_WINDOWS keys fallback · window miss시 "unknown" degrade · effort 메타 없는 모델→보수적 all-supported(clamp 안 함, 불일치 안 만듦).

---

## 15 — §11.7 스크립터블 statusLine(CC stdin 계약 호환) + 색맹 팔레트  · ROI 저

**Current (file:line):** `apps/cli/status-line.ts:72` `formatContextUsage`(고정 렌더). `registry-surface.ts:53` `VALID_THEMES=[auto,light,dark,claude,none]`(색맹 없음). `/color`(163)가 pref 세팅.

**§SOTA (corpus file:line):** **Claude Code가 정본 — config 스키마 + stdin JSON 계약 둘 다 확정.** config(`claude-code-ide/claude-code-settings.schema.json:737`): `statusLine{type:"command"(required), command(required), padding?:number, refreshInterval?:number(min 1s, "event-driven 외 추가 N초 폴링"), hideVimModeIndicator?:boolean}` + `subagentStatusLine`(770: "per-subagent, receives row context as JSON on stdin"). **stdin 계약**(`_cli-symbols.txt` 재구성 — 우리가 명령에 *건네줄* JSON):
```jsonc
{ "hook_event_name":"Status", "session_id":…, "transcript_path":…, "cwd":…,
  "model":{"id":…,"display_name":…},
  "workspace":{"current_dir":…,"project_dir":…,"added_dirs":[…],"git_worktree":…},   // ← 11과 연결
  "version":…, "output_style":{"name":…},
  "cost":{"total_cost_usd":…,"total_duration_ms":…,"total_api_duration_ms":…,"total_lines_added":…,"total_lines_removed":…},
  "context_window":…, "exceeds_200k_tokens":…, "fast_mode":…,
  "effort":{"level":…},  // 조건부  "thinking":{"enabled":…} }
```
**색맹 테마 정본 확정**(`...schema.json:2691` theme enum): `auto·dark·light·`**`light-daltonized·dark-daltonized`**`·light-ansi·dark-ansi` + `custom:*` 패턴. → 우리 원안 "daltonized\*"가 CC 실명명과 일치(검증). statusLine은 hook과 동급 신뢰(operator-authored settings). Codex/Cursor엔 스크립터블 statusLine·색맹 테마 **없음** → CC가 유일 SOTA.

**Design:** (A) **scriptable statusLine** — `runtimeConfig().statusLineConfig?`{command, padding?, refreshInterval?(min 1s), hideVimModeIndicator?}(operator-authored, hook과 동급 trust) → NEW `status-command-runner.ts` `runStatusCommand(cfg, payload)`(spawn **NO `shell:true`**, **CC stdin 계약 JSON을 stdin으로 주입**, timeout 기본 500ms·hard cap 5s, **stdout 첫 줄만**·ANSI 허용·width 트렁케이트, 실패=silent degrade+warn). REPL이 prompt tick마다 호출(async/cache, `refreshInterval` 폴링+event-driven). default-OFF(absent⇒무영향). (B) **색맹 팔레트** — NEW `color-palettes.ts`(Okabe-Ito SSOT[PLoS ONE 2008]+deuteranopia/protanopia/tritanopia/achromatopsia, 순수 데이터) + `VALID_THEMES`에 **`light-daltonized`/`dark-daltonized`**(CC 실명명) 추가. host 렌더러가 `getColorPalette(theme)` 사용.

**§SOTA++ delta:**
- **[CORE] CC stdin 계약 JSON 주입**(원안엔 "stdout만"만 있고 *입력 페이로드 미정의* — 최대 갭) — `buildStatusPayload(sessionState)`가 위 계약 형태(`hook_event_name:"Status"`, model/workspace/cost/context_window/exceeds_200k_tokens/output_style…)를 조립해 stdin으로. **CC용 statusLine 스크립트가 quanta에서 그대로 동작**(에코시스템 호환). 우리가 못 채우는 필드는 생략(스크립트가 옵셔널 처리).
- **[CORE] config 객체화**(원안 `statusLineCommand` string → CC `statusLine{}` 미러) — `padding`/`refreshInterval`(min 1s)/`hideVimModeIndicator` 지원. refreshInterval=event-driven 외 추가 폴링.
- **[CORE] stdout 첫 줄 + ANSI 허용 + width 트렁케이트**(원안 "stdout만" 모호 → CC status-bar 관례 명시) — 첫 줄만 채택, ANSI color pass-through, 터미널 width로 자른다(우리 P14 line-truncation 재사용).
- **[CORE] 테마 실명명 정렬** — `daltonized*` → `light-daltonized`/`dark-daltonized`(CC enum 일치). `*-ansi` 변종은 후속.
- **[DEFER] `subagentStatusLine`**(CC 770, per-subagent row JSON) — **17 /agents fleet 뷰(observability 북극성)와 직결** — 서브에이전트마다 status 줄. 같은 runner 재사용, fleet 뷰 착수시 함께.
- **[DEFER] `git_worktree` 필드 채움** — 11 worktree 도구 LIVE 후 `workspace.git_worktree`를 payload에 노출(현재 worktree를 status에). 11 의존.

**Files:** NEW `status-command-runner.ts`(runStatusCommand+`buildStatusPayload`)·`color-palettes.ts` · `runtime-config{,-knobs}.ts`(+statusLineConfig 객체) · `registry-surface.ts`(theme enum +daltonized) · REPL surface(runner 호출+payload 조립).
**TDD:** runner(**stdin JSON 주입 캡처**/stdout 첫줄만/ANSI pass/width 트렁케이트/timeout→""/non-zero→warn+stdout/spawn-error→""/timeout cap clamp/refreshInterval 폴링) · buildStatusPayload(계약 필드 형태·missing 필드 생략·`hook_event_name:"Status"`) · palettes(getColorPalette 매핑/invalid→default/모든 변종 non-empty/valid hex) · 슬래시 theme drift-guard(+daltonized).
**Risks/보안:** statusLine 명령은 operator-authored(hook 신뢰모델), `shell:true` 금지(injection 차단), 5s cap(prompt hang 방지), 느린 명령은 async+cache · stdin payload에 secret 안 실음(cost/model/cwd만, 토큰/키 제외) · width 트렁케이트로 깨진 ANSI 방지(reset 보정).

---

## 시퀀싱 (ROI×보안) — 12 DONE, 남은 4개
1. **11 P8 worktree**(고 ROI, 에이전트 역량 — CC EnterWorktree 진영 합류; +status/dirty-guard/branchFrom) → 2. **13 §12.2 header-rewrite**(중, 자기완결 pure — +append/forbidden-guard/cross-origin-strip/audit) → 3. **14 /model**(저, +effort-clamp 정합성) · **15 statusLine**(저, +CC stdin 계약 호환/색맹 실명명 — 묶어서).
- ~~12 §20.4 FS enforce~~ ✅ DONE(jun-08).

**SOTA++ 요지(이 pass에서 추가)**: 11=CC가 유일 에이전트-도구 진영, 우리 slot/edit-fence가 `bgIsolation` 메커니즘 일치 검증 + status/dirty-guard/branchFrom 보강. 13=경쟁사 rich-rewrite 전무(우리 novel)이나 Cursor append·CC cross-origin-strip·forbidden-guard 흡수. 14=Codex `validateEffort` model↔effort 커플링이 진짜 정합성 갭. 15=CC stdin JSON 계약 그대로 호환(스크립트 portability)+색맹 테마 실명명(`light/dark-daltonized`) 일치 확정.

**NEW(별도, 미착수)**: §11.1 /init · §11.2 /agents fleet(observability 북극성 — 15 `subagentStatusLine`과 직결) · §11.4 Ctrl+B · §22.3 reverse-MCP(고, 신규 server subsystem) · §1.3/1.5 MCP templates/Tasks · §6.2-6.4 browser · §9.4/9.5 reasoning summary/verbosity.
