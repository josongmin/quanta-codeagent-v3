# Sep-08 SE audit — agent-3 (lane H)

> **Role:** W1-H 전담. `src/media`, `src/voice`, `src/browser`, `src/git`,
> `src/patch`, `src/subagent`, `src/side-agent`.
> **Status:** classified, not fixed. Production 미수정.
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-H.md`](../../plans/sep-7-solid-se-audit/receipts/W1-H.md)
> **이 파일:** 그 세션에서 오너 코드를 직접 읽고 잡은 근거·판결·금지사항을
> 다른 에이전트가 바로 쓸 수 있게 옮긴 노트. 112파일 표는 W1-H에 있음.

## Snapshot

| 항목 | 값 |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` = `origin/main` (ahead 0 / behind 0) |
| H 프로덕션 dirty | **false**. `src/{media,voice,browser,git,patch,subagent,side-agent}` HEAD==WT |
| 공유 체크아웃 | dirty (~98 porcelain). `docs/ARCHITECTURE.md`, `tests/unit/_arch/slice-boundary-configs.ts` WT≠HEAD. **H 분류는 committed HEAD만 사용.** |
| W0 | 세션 시작 시 `receipts/W0.md` **없음**. 로컬 동결로 진행. 이후 W0이 다른 HEAD를 찍으면 이 노트는 STALE. |
| 검사 규모 | 110 prod `.ts` + 1 colocated test + 1 `.mjs` = **112/112** |
| 라인 | ~19191. god-module>1000=0, cohort 900–999=0, fn body>150=0 (`createProcessSideAgentDaemonRegistry` interior 147) |
| SEP5/SEP6 | 같은 HEAD를 SEP6 P2 closeout baseline으로 씀. 은퇴 ID는 trigger 재현 없이 재오픈하지 않음. |

### 세션에서 직접 확인한 권한 문서 해시 (검사 시점)

- `AGENTS.md` / `AGENT_CORE.md` / `AGENT_PLAYBOOK.md` / `tests/README.md` / `package.json` / `biome.json` / god-code allowlist / lint-debt: WT=HEAD
- `docs/ARCHITECTURE.md` HEAD `f190b0a2…` vs WT `16626624…` (DIRTY, H 밖)
- `slice-boundary-configs.ts` HEAD `31556028…` vs WT `1e570be7…` (DIRTY, H 밖). side-agent `allowImports` file-narrow는 양쪽 모두 존재.

---

## 방법 / 판결 규칙

- rg는 항해만. 오너 파일 + 도달 가능 consumer 1곳 이상 읽음.
- 역할 계약으로 분류 (basename 유사성 제외).
- **duplicate finding** = 라이브 오너 2 + producer→consumer + (측정 드리프트 또는 dual-write race).
- SOLID smell만 있고 failure mode 없으면 inventory.
- Cross-lane import는 증거. 그 슬라이스를 소유한 것처럼 수정 제안하지 않음.
- `@/shared` REST/policy dump 금지.

4개 서브에이전트 병렬 (media+voice / browser+patch / git / subagent+side-agent) 후 오너 코드 재검증.

---

## 유지 finding (5)

구현 큐. 우선순위는 P1 하나, 나머지 P2.

### H-SA-01 — process charter fail-open (P1)

**한 줄:** LLM이 살아 있는데 패스가 `null`이면, 프로세스 side-agent가 그걸 `{kind:"finding"}` 으로 위장 emit함. in-process는 null=무응답.

| | |
|---|---|
| Attribution | pre-existing |
| Axis | SE hidden fallback / fail-open |
| Owners | `src/side-agent/worker-entry.mjs` `handleCharter` L133–145; `runCharterPassLLM` L74–80 catch→null; `src/side-agent/worker-charter-runner.ts` `runCharterPassLLM` L256–258, `buildLlmPort` L154–158 catch→null |
| Consumer | fork child가 production ingress. parent `createProcessSideAgentDaemonRegistry`가 IPC `{kind:"finding"}`을 실 finding으로 취급 (`src/side-agent/types.ts`, `process.ts`). host: `agent-config-assembler` + `QUANTA_SIDE_AGENT_PROCESS` |
| Failure | `llmPassViable()` true (API key 또는 `QUANTA_SIDE_AGENT_LLM_REPLAY`)인데 import/assembly/empty/runner throw로 `null` → 그래도 `summary: "side-agent process pass: <task>"` + detail `"pass returned no finding"` 을 **finding IPC로 보냄**. detail은 정직, **kind는 아님**. |
| Test gap | `"pass returned no finding"` 문자열 테스트 **0건**. OS-fork e2e는 no-creds deterministic 경로만 잠금. |
| 아님 | SEP6 allowImports 재오픈 아님. `@/llm`/`@/tool`/`@/agent/*`는 `files: ["worker-charter-runner.ts"]` 로 file-narrow (HEAD 확인). |
| Write | `src/side-agent/worker-entry.mjs` (주). optional `worker-charter-runner.ts` 계약/주석. 새 hellgate: LLM viable + null ⇒ finding emit 금지 또는 typed non-finding. |
| Forbidden | `src/agent/**`, `src/tool/**`, `src/shared/**` |

직접 읽은 degrade 경로:

```js
// worker-entry.mjs handleCharter
if (llmPassViable()) {
  const llmFinding = await runCharterPassLLM(charter)
  if (llmFinding !== null && llmFinding !== undefined) {
    emitFinding(llmFinding)
    return
  }
  emitFinding(runCharterPass(charter, "pass returned no finding"))  // ← 여기
  return
}
```

in-process `registry.ts`는 `result !== null`일 때만 publish. **프로세스 vs in-process null 의미 drift.**

부가로 읽은 잔여 (finding 아님, inventory):

- `assembleChildConfig` 주석: OS-process daemon은 parent `ownershipPolicy`를 fork로 안 넘김 → UNFENCED daemon. 완화: default-OFF² (`QUANTA_SIDE_AGENT` + `QUANTA_SIDE_AGENT_PROCESS`) + `SIDE_AGENT_READONLY_TOOLS`. 전체 parity는 deferred.
- `matchPolicy: "fuzzy-content"` replay는 cassette miss에 `onMiss:"throw"` (loud). 그건 fail-closed.

---

### H-PATCH-01 — unified rename → Update(old path) (P2)

**한 줄:** git rename unified diff가 Move가 아니라 옛 경로 Update로 적용됨. 테스트가 그 의미를 잠금.

| | |
|---|---|
| Attribution | pre-existing, **test-locked** |
| Axis | SE correctness |
| Owner | `src/patch/unified-to-v4a.ts` |
| 증거 | `GIT_META_PREFIXES`가 `"rename from"` / `"rename to"` 를 버리고 스캔 (L103–114). `emitFileSection` non-add/delete는 `fromPath`로 `Update File:` (L210–226). `/dev/null`만 add/delete. |
| Consumer | `src/tool/apply-patch.ts` unified ingress (`unifiedDiffToV4A`) |
| Proof | `tests/unit/patch/unified-to-v4a-scenarios.test.ts` **S-OP-5** L269–286: rename meta → `ops[0].kind === "update"` |
| Failure | `old.py → new.py` rename+edit가 `old.py`에 내용이 남고 `new.py`는 안 생김. applier의 `move` op는 쓰이지 않음. |
| Write | `src/patch/unified-to-v4a.ts` + `tests/unit/patch/unified-to-v4a*.test.ts` (S-OP-5를 move 기대로 뒤집어야 함) |
| Forbidden | `src/tool/**` (consumer). 변환 오너는 `@/patch`. |

---

### H-PATCH-02 — “rolled back” 문자 vs best-effort undo (P2)

**한 줄:** commit 실패 에러는 롤백됐다고 말하는데, undo throw는 swallow.

| | |
|---|---|
| Attribution | pre-existing, 코드 주석이 best-effort라고 명시 |
| Axis | partial-update durability / 에러 정직성 |
| Owner | `src/patch/applier.ts` `rollback` L226–238; commit catch L122–128 |
| 증거 | journal reverse replay, undo `catch {}`. 그 다음 `PatchApplyError("Patch commit failed and was rolled back: …")` |
| Consumer | `applyPatch`: `tool/apply-patch.ts`, `structured.ts`, `agent/shadow-verify-adapters/apply-v4a.ts` |
| Failure | mid-commit I/O fail + undo fail → 호출자는 rollback된 줄 알지만 디스크에 부분 op 남을 수 있음 |
| 아님 | `wrapObserver` L44–63 observer/trace swallow는 **의도된 fail-open**, `patch-observer-fail-open-hellgate` 소유. 이 finding이 아님. |
| 아님 | plan-before-write / journal-before-mutate 순서 자체는 정상. |
| Write | `applier.ts` + applier rollback 테스트. 에러에 undo 실패를 드러내거나, undo 실패를 별 typed error로. |
| Forbidden | 외국 `FsJailFileSystemPort` atomic write를 `@/patch`로 끌어와 합치기 (W2-X). `PatchFileSystemPort.writeFile`은 atomic을 **요구하지 않음**. |

---

### H-GIT-01 — 이중 `::git-*` 프로토콜 (P2, W2-X 머지)

**한 줄:** 같은 prefix `::git-<kind>` 아래 JSON 필드가 두 계약. tool이 성공 한 번에 둘 다 emit.

| | |
|---|---|
| Attribution | pre-existing. 양쪽 ADR이 sibling이라고 문서화 |
| Axis | duplicate authority + dual-write |
| Owner H | ADR-0221 `src/git/directive-emit`: `stage.files`, `push.ref/force`. serializer `::git-${kind}{canonical json}` |
| Owner A (외국) | ADR-0220 `src/agent/git-directives`: `stage.paths`, `push.remote/branch` |
| Producer B (외국) | `src/tool/git/stage.ts` L14–16, L54–87 `build0220Stage` + `build0234Stage`; `push.ts` 동일. 주석: “two ADRs disagree on the field name (`paths` vs `files`); we publish the union” |
| Drift | stage 필드명; push 의미 (`ref/force` vs `remote/branch`). 한쪽 parser는 다른 shape를 shape-mismatch |
| Failure | UI tail vs turn-collector가 같은 git 성공에서 다른 fact를 받거나 한쪽을 drop. round-trip 단일 계약 없음 |
| 교차 영수증 | W1-A fingerprint #13이 같은 쌍을 W2-X로 넘김. H가 이미 보유한다고 적혀 있음. |
| H write | W2-X가 call-site를 H로 정하면 `src/git/directive-emit/**` + `tests/unit/git-directive-*` |
| Forbidden for H | `src/agent/git-directives/**`, `src/tool/git/**` 를 H가 소유한 것처럼 수정. **D13 GitRunner 통합과 묶지 말 것.** |

`src/git/directive-emit/types.ts` L10–14가 의도적 차별을 인정함: call-site intent vs UI-tail. 그래도 **같은 wire prefix + 측정 드리프트 + 라이브 dual emit** 이라 finding.

---

### H-MEDIA-01 — 죽은 두 번째 STT/capture 권한 (P2, D7 삭제 경로)

**한 줄:** `@/media` production import 0. REST 합치기 금지. 미사용 스택 삭제는 SEP5-11 D7 허용.

| | |
|---|---|
| Attribution | pre-existing (SEP5 D7 conditional) |
| Axis | dead-authority (two-live-owner duplicate **아님**) |
| 증명 | `src/` 에서 `from "@/media` / `createSttFromEnv` 생산 호출 **0**. 소비자=테스트만 (`tests/unit/media/*`, `boundary-cancellation-hellgate`, `cli/voice-confirm-hellgate`) |
| Live voice | recorder: `src/apps/cli/repl/voice-live-wire.ts` → `createPlatformRecorder`. transcriber `createOpenAIWhisperTranscriber` / `createDeepgramTranscriber` / `createLocalWhisperTranscriber` **production 호출 0**. `/voice` (`voice-cmd.ts`)는 recorder+transcriber 미주입이면 exit 1 (fail-closed). |
| 측정 드리프트 (importable vs voice transcriber) | timeout 30s vs 60s; mime wav\|mp3 vs wav\|webm; media `fetchWithDeadline` vs voice local AbortController+setTimeout; media `createSttFromEnv` `fallbackOnError` DG→Whisper hidden retry; Deepgram URL baked query vs `URLSearchParams` |
| Failure | 두 번째 writable HTTP STT+sox-capture가 public. 지금 dual-write는 없음. 우연 합성 시 timeout/mime/fallback이 live recorder plane과 다름. |
| D7 | **Do not** `voice→media` REST core / `src/shared` transport / peer import. **Allowed:** unused `@/media` 삭제 (이 consumer-absence가 trigger). |
| Write | `src/media/**`, `tests/unit/media/**`. slice-boundary media 항목·default-off ledger `owner_seam`은 W2/W3 reserved. |
| Forbidden | `src/voice/**` 삭제, REST core, peer import |

`voice/index.ts` 헤더 “Default-OFF: no apps/cli wire”는 **stale** — `voice-live-wire.ts`가 존재.

---

## 재오픈하지 않은 SEP5/SEP6

| ID | 판결 | 이 세션 증거 |
|---|---|---|
| D7 REST core | **재오픈 안 함** | 양쪽 STT create\* 모두 live public consumer 없음. 삭제는 MEDIA-01. |
| D13 GitRunner | **재오픈 안 함** | `src/git`에 `Bun.spawn`/`child_process` 없음. `GitProcessPort` 주입만. spawn은 storage/tool/apps/memory/runtime (외국). |
| D23 CDP correlator | **browser owner에서 재오픈 안 함** | `cdp-session.ts` dispose L383–396 / markDead가 pending **+** eventWaiters 정산. HELL-SESS-12, map-leak. W1-B X-B8도 D23 closed로 기록. 외국 `tool/debug/cdp-client.ts` dispose가 waiter 미정산이면 W2-X 전용. |
| SEP6 side-agent allow | **재오픈 안 함** | whole-slice 아님. `worker-charter-runner.ts` file-narrow. |

conflict-parser tool 쪽은 이미 SSOT forwarder (`src/tool/git/conflict-parser/parse.ts` → `@/git/conflict-parser`). ratchet `tests/unit/git/conflict-parser-ssot-ratchet.test.ts` non-vacuous (알고리즘 재도입 시 RED). 전트리 스캔은 아님(2파일 closed set).

---

## W2-X에 넘긴 fingerprint

| ID | H | 외국 | 메모 |
|---|---|---|---|
| X-H-git-directive | `git/directive-emit` | `agent/git-directives` + `tool/git/{stage,push}` | = H-GIT-01 |
| X-H-git-process-port | `GitProcessPort` (cloud-branch, src/git spawn 없음) | storage/git-runner, tool/git/runner, rewind-git, memory/consolidate/git, runtime/worktree | D13 재오픈 아님 |
| X-H-cdp-corr | `browser/cdp/cdp-session.ts` | `tool/debug/cdp-client.ts` | D23 browser 쪽 클리어 |
| X-H-patch-apply | `patch/applier.ts` | `tool/apply-patch.ts` | jail/stale/budget/unified/OTel은 tool. 두 번째 apply 엔진 아님 |
| X-H-atomic-split | `PatchFileSystemPort.writeFile` | FsJail temp+rename | 내구성이 fence 너머 |
| X-H-stt-http | media adapters (dead) | voice transcriber (unwired) | REST merge 금지 |
| X-H-recorder | `media/voice` captureOnce (dead) | `voice/default-recorder` (live) | 라이브 오너 1 |
| X-H-subagent-turn-gate | `subagent/turn-gate.ts` | `agent/loop/turn-gate.ts` thin adapter | duplicate 아님 |
| X-H-subagent-spawn | trio `agent-tool.ts` vs six `handlers-6.ts` | `agent/subagent-runner` | 같은 TaskRegistry. 병렬 surface |
| X-H-side-vs-sub | SideAgentDaemonRegistry XOR process | TaskRegistry | invariant 다름. host XOR |
| X-H-conflict-parse | `@/git/conflict-parser` | tool forwarder | SSOT OK |
| (A #9) | `@/subagent` port | `agent/subagent-runner` | W1-A: port+adapter, duplicate 아님 |
| (A #10) | `subagent/agent-type.ts` | `named-agent-registry.ts` | well-known vs disk |
| (A #12) | H `DEFAULT_MAX_DEPTH=3` | `spawn-depth.ts` | 리터럴 이중, dual-write 미측정 |

`@/shared`에 STT HTTP / git directive / CDP correlator를 넣지 말 것.

---

## Inventory (failure mode 없음 → 티켓 만들지 말 것)

- H god-code 없음. 큰 파일이지만 cohesive: conflict-parser 705, applier 761, agent-tool 742, handlers-6 719, cloud-branch-snapshot 665, cdp-session 406, headless methods 453.
- Headless `BrowserPort`는 CDP보다 약함 (type/fill no-op). prod assembler는 CDP. stub=테스트 더블.
- `bring-up` Runtime/Log/Network.enable swallow — capture fail-open, 설계.
- console-buffer / network-buffer 같은 슬라이스 링 클론.
- 레지스트리 4개 (Task / Team / inproc side-agent / process side-agent): invariant 분리. process vs inproc는 host XOR (`QUANTA_SIDE_AGENT_PROCESS`).
- `DEFAULT_MAX_DEPTH=3` trio+six 리터럴. 측정 dual-write 없음.
- `exec-command` env-scrub hellgate는 shape-scan 정직. 실제 자식 env runtime assert 없음. `input.env` 오버레이로 키가 다시 들어갈 수 있음 (의도 레이어).
- `cloud-branch-snapshot` export만, live prod caller 없음. timeout은 포트 구현자 몫.
- Voice transcriber 팩토리 unwired. local-whisper는 timeout 120s + stdout drain 있음 (missing-timeout 의심 기각).
- Media/voice hellgate는 어댑터 직호출. live production ingress / anti-vacuum / red-on-injection 없음.
- `voice-queue` / `voice-overlay` 정의만 있고 production import 0 (G 레인 확인 후보).
- `createProcessSideAgentDaemonRegistry` 147줄 — god-fn 아님.

---

## No-finding으로 닫은 영역

- leaf DIP: media/voice/browser/git/patch/subagent → `@/shared`. side-agent **barrel**은 llm/tool 미재export.
- Passive VCS: bash가 duck-type hook. knob default-OFF.
- Review-source fail-closed resolve + linguist generated filter. argv 변환은 `tool/git/review-source-adapter.ts`.
- Structured apply는 단건 `applyPatch` 재사용 (두 번째 locator 아님).
- CDP session Map reap; `process-exit-kill-guard`는 **defaultProcessSpawner**에만. 주입 spawner는 빠질 수 있음 (DI, inventory).
- Allowlist `cdp()` stub↔CDP 대칭.

---

## 슬라이스별 한 줄 지도

| Slice | 파일/라인 | 라이브 역할 | 비고 |
|---|---:|---|---|
| media | 13 / 747 | **dead** | STT+sox. 테스트만 |
| voice | 11 / 1731 | recorder live, transcriber unwired | `/voice` fail-closed if deps missing |
| browser | 26 / 4071 | CDP `BrowserPort` | stub 테스트 전용 |
| git | 23 / 3055 | conflict SSOT, directive-emit, passive-vcs, review-source | cloud-branch parked |
| patch | 8 / 1886 | V4A parse/apply canonical | unified converter best-effort |
| subagent | 24 / 6060 | TaskRegistry + trio/six tools + coordination leaf | runner는 A |
| side-agent | 6 ts+1 mjs / ~1641 | inproc XOR process daemon | charter runner는 leaf barrel 밖 composition |

### 확인한 production consumer (H 밖)

- media: 없음
- voice: `apps/cli/voice-cmd.ts`, `apps/cli/repl/voice-live-wire.ts`; type `realtime/voice-session/default-session.ts`
- browser: `host/runtime/agent-config-assembler.ts`, `tool/browser/*`
- git: `agent/loop-helpers.ts`, `tool/bash/index.ts`, `tool/git/conflict-parser/parse.ts`, `tool/git/review-diff.ts`
- patch: `tool/apply-patch.ts`, structured tool, fallback-wire, `agent/shadow-verify-adapters/apply-v4a.ts`, `agent/ownership-policy.ts`, `apps/cli/preflight.ts`
- subagent: `agent/coordination-broker-wire.ts`, `agent/side-agent-runner.ts`, `agent/tier1/subagent-*`, `host/runtime/peer-team-wire.ts`
- side-agent: `agent/side-agent-runner.ts`, assembler, `host/runtime/side-agent-fork-port.ts`, child `worker-entry.mjs`

미러 테스트: `tests/unit/{media,git,patch,subagent}/` 있음. `tests/unit/{voice,browser,side-agent}/` 디렉터리 없음 (루트 `*-hellgate.test.ts`). integration 동명 디렉터리 없음.

---

## 제안 write set (구현 시)

| ID | 허용 | 금지 |
|---|---|---|
| H-SA-01 | `worker-entry.mjs`, optional `worker-charter-runner.ts`, 새 side-agent hellgate | agent/tool/shared |
| H-PATCH-01 | `unified-to-v4a.ts` + unified-to-v4a tests | tool |
| H-PATCH-02 | `applier.ts` + applier tests | FsJail을 patch로 끌어오기 |
| H-GIT-01 | W2-X 후. canonical=H면 `git/directive-emit/**` | agent git-directives, tool/git, GitRunner mega-merge |
| H-MEDIA-01 | `src/media/**`, `tests/unit/media/**` | REST core, voice 삭제, peer import |

구현/머지/activation/runtime proof는 분리. 이 노트는 분류만.

---

## Uninspected / 한계

- W0 union/intersection proof 없음.
- dirty non-H 트리 미분류.
- Real Chrome e2e 부하, 실 Whisper/Deepgram HTTP 미실행.
- `@/media` dynamic string import는 TS `from` 0건. 런타임 문자열 경로 전수는 아님.
- 외국 슬라이스 전수 아님 (`cdp-client.ts`, `agent/git-directives/**`, `agent/subagent-runner.ts`는 인용 라인만).
- process-supervisor UI가 degrade finding을 성공으로 그리는지 런타임 미검증.
- non-atomic `PatchFileSystemPort`에서 journal 내구성은 외국 jail에 의존.
- `worker-entry.mjs` **node** execPath는 문서상 degrade. bun path만 정적 검사.
- 함수 크기 측정은 brace matcher 근사. 150 초과 없음만 신뢰.

---

## 다른 레인과의 정렬 (이 세션이 읽은 범위)

- W1-A: git-directives를 W2-X #13으로 넘김. subagent-runner는 H 포트의 어댑터로 봄. spawn-depth × `DEFAULT_MAX_DEPTH=3`.
- W1-B: D23 closed. `tool/debug/cdp-client.ts`와 `src/browser`를 X-B8로만. apply-patch는 B 소유 파일이지만 apply **알고리즘**은 H `@/patch`.
- W1-G: `voice-live-wire.ts`, `side-agent-fork-port.ts`가 G 스코프 파일로 등장. H는 그걸 consumer로만 기록.

전체 파일 표·fingerprint 한 줄은 W1-H receipt가 SSOT.

---

DONE — agent-3 lane H 세션 노트. 코드 미수정.
