# Sep-08 SE audit — agent-3 (lane H)

> **Role:** W1-H 전담. `src/media`, `src/voice`, `src/browser`, `src/git`,
> `src/patch`, `src/subagent`, `src/side-agent`.
> **Status:** classified, not fixed. Production 미수정.
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-H.md`](../../plans/sep-7-solid-se-audit/receipts/W1-H.md)
> **이 파일:** 그 세션에서 오너 코드를 직접 읽고 잡은 근거·판결·금지사항을
> 다른 에이전트가 바로 쓸 수 있게 옮긴 노트. 112파일 표는 W1-H에 있음.
> **Hole-check (2026-09-08):** side-agent/subagent + patch/git/browser + media/voice
> 3워커 병렬 재검증 후 오너 재독. 신규 2건 채택, 테스트-only/레인G는 inventory·fingerprint.

## Snapshot

| 항목 | 값 |
|---|---|
| HEAD | 검사 시점 `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` = 당시 `origin/main`. **현재 origin/main은 `9b05cd33`** — 단 Lane-H 프로덕션 7슬라이스는 두 커밋 간 byte-identical이라 아래 finding은 전부 유효 |
| H 프로덕션 dirty | **false**. `src/{media,voice,browser,git,patch,subagent,side-agent}` HEAD==WT |
| 공유 체크아웃 | 검사 시점 dirty (~98 porcelain). `docs/ARCHITECTURE.md`, `tests/unit/_arch/slice-boundary-configs.ts` WT≠HEAD였음. **두 파일 모두 `9b05cd33`에 커밋되어 현재는 clean.** H 분류는 committed HEAD만 사용. |
| W0 | 세션 시작 시 `receipts/W0.md` **없음**. 로컬 동결로 진행. 이후 W0이 다른 HEAD를 찍으면 이 노트는 STALE. |
| 검사 규모 | 110 prod `.ts` + 1 colocated test + 1 `.mjs` = **112/112** |
| 라인 | ~19191. god-module>1000=0, cohort 900–999=0, fn body>150=0 (`createProcessSideAgentDaemonRegistry` interior 147) |
| SEP5/SEP6 | 같은 HEAD를 SEP6 P2 closeout baseline으로 씀. 은퇴 ID는 trigger 재현 없이 재오픈하지 않음. |

### 세션에서 직접 확인한 권한 문서 해시 (검사 시점)

- `AGENTS.md` / `AGENT_CORE.md` / `AGENT_PLAYBOOK.md` / `tests/README.md` / `package.json` / `biome.json` / god-code allowlist / lint-debt: WT=HEAD
해시는 **파일 내용의 SHA-256** (git blob 해시 아님 — blob은 각각 `fa8743e7…`/`b401ec63…`, `401d34af…`/`cfa6d791…`).

- `docs/ARCHITECTURE.md` `0b14f5cf` `f190b0a2…` vs WT `16626624…` (당시 DIRTY, H 밖; `9b05cd33`에 커밋되어 지금은 `16626624…`가 HEAD 내용)
- `slice-boundary-configs.ts` `0b14f5cf` `31556028…` vs WT `1e570be7…` (동일 — 지금은 `1e570be7…`가 HEAD 내용). side-agent `allowImports` file-narrow는 양쪽 모두 존재.

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

## 유지 finding (7)

구현 큐. P1 하나, 나머지 P2. 2026-09-08 hole-check에서 **H-SA-02**, **H-PATCH-03** 추가.

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

H-SA-01 sibling universe (같은 오너, failure/absence → success-finding **또는** silent drop):

| Site | 행동 | 분류 |
|---|---|---|
| `worker-entry.mjs` `handleCharter` L133–145 | LLM viable + null → synthetic finding | **본 finding** |
| `worker-entry.mjs` `runCharterPassLLM` L74–80 | import/throw → null | chain |
| `worker-charter-runner.ts` L256–258 / L154–158 | catch → null | chain |
| `worker-entry.mjs` `emitFinding` L117–118 | null → silent | sibling silent |
| `process.ts` `handleChildMessage` L199–210 | malformed finding → silent drop | sibling silent (shape defense, 유지) |
| `process-registry.ts` `recordProcessFinding` | IPC finding 무조건 로그 | amplifier |
| `registry.ts` wake L236 | `result === null` → no publish | **in-process 대조** |
| `registry.ts` catch L237–240 | throw → `failed` | 대조 (finding 아님) |

`llmPassViable()===false` deterministic finding은 no-creds OS-fork e2e 레거시. H-SA-01 sibling 아님.

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

### H-SA-02 — process registry가 같은 포트에서 runaway/cadence 계약을 빼먹음 (P2)

**한 줄:** `SideAgentDaemonRegistry`인데 in-process는 `validateSpec`/`maxWakes`/`idleReapMs`/interval·event arm을 지키고, process backer는 spawn 후 한 번 charter하고 상주.

| | |
|---|---|
| Attribution | pre-existing. `process.ts` 헤더는 V1 “daemon MANAGER deferred”지만 **같은 포트**로 이미 노출. 게다가 오너 `process-registry.ts` L27-34의 공개 자체가 **거짓** — "a forked child runs its OWN wake loop" / "the child's cadence lives in the worker"라고 하지만 `worker-entry.mjs`(162줄)에 `setInterval`/`setTimeout`/루프가 **0건**이고 `process.on("message")` L148-158이 charter 1회 처리 후 정지. 수정 시 이 헤더도 같이 고칠 것 |
| Axis | LSP / 계약 드리프트 (host XOR, 툴은 동일 surface) |
| Owner inproc | `src/side-agent/registry.ts` `validateSpec` L52–65, `applyPostPassBounds` L196–205, `armTrigger` L251–261, spawn L283+ |
| Owner process | `src/side-agent/process-registry.ts` `spawn` L228–272. `validateSpec`/`maxWakes`/`idleReap`/`armTrigger` **문자열 0** |
| Supervisor | `process.ts` `handleChildMessage` L218–221: `ready` → charter **1회**. interval 재wake 없음. crash-respawn만 있음 |
| Consumer | `src/tool/side-agent/index.ts` spawn 설명 “wakes on an interval or event”; `renderSnapshot` `wakes=${s.wakesDone}/${s.spec.maxWakes}`. host `maybeWireSideAgent` + `QUANTA_SIDE_AGENT_PROCESS` → process 레지스트리 |
| Failure | `max_wakes`/`idle_reap_ms`/interval이 툴·list에 보이지만 process 경로는 한 번 돌고 상주. empty task/`maxWakes<1`도 `invalid-spec` 없이 spawn 가능. hellgate는 finding 2회·status running만 잠금 |
| 아님 | H-SA-01 (LLM-null→finding). in-process 의미를 약하게 맞춰 닫으면 안 됨 |
| Write | `src/side-agent/process-registry.ts` + `tests/unit/side-agent-process-registry-hellgate.test.ts` (maxWakes stop / idleReap / invalid-spec / interval 재wake 또는 “V1은 one-shot”을 **포트에서 정직하게** 분리). optional shared `validateSpec` |
| Forbidden | tool 문구만 고쳐서 닫기; in-process 가드를 후퇴시키기; `src/tool/side-agent/**`를 오너로 끌어오기 |

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
| Failure | `old.py → new.py` rename+edit가 `old.py`에 내용이 남고 `new.py`는 안 생김 (실측: `{ok:true,"updated: old.py"}`). applier의 `move` op는 **native V4A `*** Move to:`에선 live**이고, unified 변환 경로에서만 도달 불가. 도달 범위: 트레일링 개행이 제거된 unified diff — 개행이 남으면 변환기의 잉여 trailing blank context 때문에 `PatchAnchorNotFoundError`로 loud-fail (rename 무관, 평문 대조군도 동일) |
| Write | `src/patch/unified-to-v4a.ts` + `tests/unit/patch/unified-to-v4a*.test.ts` (S-OP-5를 move 기대로 뒤집어야 함) |
| Forbidden | `src/tool/**` (consumer). 변환 오너는 `@/patch`. |

---

### H-PATCH-03 — binary/mode-only unified → 빈 패치 성공 (P2)

**한 줄:** `Binary files` / mode-only meta만 있으면 converter가 empty V4A를 만들고 `parsePatch`는 `ops=[]`로 성공, apply는 무변경 성공.

| | |
|---|---|
| Attribution | pre-existing, **S-META-3가 “no op”를 잠금** |
| Axis | SE 계약 흠결 (empty-ops가 typed reject이 아님). **"성공 위장" 아님** — 아래 Failure 참조 |
| Owner | `src/patch/unified-to-v4a.ts` `GIT_META_PREFIXES` discard + `---`/`+++` 없으면 `emitFileSection` 미호출. 결과는 Begin+End만 |
| Parser | `parsePatch` empty Begin/End → `{ ops: [] }` throw 없음 (`parser.ts` L50–58) |
| Consumer | `src/tool/apply-patch.ts` `guardedParseAndApply` L416–417 |
| Proof | `unified-to-v4a-scenarios.test.ts` S-META-3 L327–340: binary 라인 → Update/Add/Delete 없음. apply 성공·툴 메시지는 **미핀** |
| Failure | **실측 정정**: 툴 출력은 `{ok:true, output:"apply_patch: no-op patch"}` — 문구는 정직함 (`apply-patch.ts:383` `parts.length === 0 ? "apply_patch: no-op patch"`). 잔여 결함은 **`ok:true`가 typed reject이 아니라는 것**뿐. 그 문자열엔 테스트 핀 0. ⇒ P2 fail-open이 아니라 **P3/inventory** 급 |
| vs H-PATCH-01 | rename은 **잘못된 Update**(디스크가 실제로 틀리게 바뀜); 여기는 **정직한 no-op**이되 `ok:true`. 같은 converter 구멍이지만 심각도가 다름 — PATCH-01이 진짜 결함이고 PATCH-03은 계약 흠결 |
| Write | `unified-to-v4a.ts` + scenarios: binary/mode-only는 typed reject이거나 호출자에게 unsupported/no-op 명시. empty-ops 정책도 같이 |
| Forbidden | `src/tool/**`만 경고 문자열로 덮기 |

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
| Failure (잠재) | 어느 한쪽이라도 주입되는 순간 UI tail vs turn-collector가 같은 git 성공에서 다른 fact를 받음. **현재는 미도달** — 0234 collector가 `agent/loop/session-bootstrap.ts:226`에서 생성되고 `agent/turn-closeout.ts:101`에서 flush되지만 tool에 주입이 없어 영구 empty flush |
| 교차 영수증 | W1-A fingerprint #13이 같은 쌍을 W2-X로 넘김. H가 이미 보유한다고 적혀 있음. |
| H write | W2-X가 call-site를 H로 정하면 `src/git/directive-emit/**` + `tests/unit/git-directive-*` |
| Forbidden for H | `src/agent/git-directives/**`, `src/tool/git/**` 를 H가 소유한 것처럼 수정. **D13 GitRunner 통합과 묶지 말 것.** |

`src/git/directive-emit/types.ts` L10–14가 의도적 차별을 인정함: call-site intent vs UI-tail. 같은 wire prefix + 측정 드리프트라 finding이되, **"라이브 dual emit"은 반증됨**: production `gitTools()` 호출 2곳(`apps/cli/internal.ts:562`, `apps/agent/mode-presets/ci-bot.ts:218`)이 전부 `coChange`/`budget`만 넘기고 collector/emitter를 안 넘김. `tool/git/stage.ts:16` 자체가 "Absent both ⇒ byte-identical legacy (no allocation, no publish)"라고 명시. dual emit은 **테스트에서만** 발화.

⇒ 이 finding은 dual-write race가 아니라 **dead wire** (H-MEDIA-01과 같은 부류). L36의 duplicate 정의(producer→consumer)를 현재로선 충족하지 못함.

Hole-check producer 표 (신규 finding 아님, H-GIT-01 보완):

| 위치 | emit |
|---|---|
| `tool/git/stage.ts`, `push.ts` | 0220+0234 dual (테스트 잠금). composition의 `gitTools()` 포함 여부는 B/G — H는 기록만 |
| `tool/git/commit.ts` | 0220 only |
| `tool/git/branch-switch.ts` | 0220 only |
| `tool/git/_directive-publish.ts` | dual helper (commit/create-branch/create-pr) |
| `tool/gh/index.ts`, `pr-open.ts` | `publishGitDirective` |
| `git/directive-emit` collector flush | turn-closeout |

**Wire gap (inventory / X-H):** collector를 만들고 flush까지 하는 주석은 `gitTools({ gitDirectiveCollector })`를 가정. composition root가 emitter/collector를 tool에 넘기는 호출은 hole-check에서 0으로 보임. 이중 프로토콜과 **별축**(활성화 구멍). B/G가 확인.

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
| Write | `src/media/**`, `tests/unit/media/**`. media 삭제 시 같이 정리해야 하는 실 value-importer: `tests/unit/cli/voice-confirm-hellgate.test.ts` **+ `tests/unit/boundary-cancellation-hellgate.test.ts`(L24-25 `@/media/stt/{deepgram,openai-whisper}-adapter`)**. slice-boundary media·default-off ledger는 W2/W3 |
| Forbidden | `src/voice/**` 삭제, REST core, peer import |

`voice/index.ts` 헤더 “Default-OFF: no apps/cli wire”는 **stale** — `voice-live-wire.ts`가 존재.

테스트 정직성 (H-MEDIA-01 형제, 별 티켓 아님):

- `voice-confirm-hellgate`가 `@/media/stt` + `@/media/voice` + `voice-overlay` + `voice-queue`를 **테스트 안에서만** 합성. `createVoiceOverlay` / `createVoiceTranscriptQueue` production import 0. CI가 capture→transcribe→confirm을 통과해도 실 CLI wire는 없음. media 삭제 트리거를 가짜 소비자로 가림.
- `stt-hellgate` / `voice-transcriber-hellgate`는 주입 fetch — 어댑터 단위. live wire 주장 아님.
- `fallbackOnError===true` caller는 hellgate HELL-S-10만. production 0.
- `create*Transcriber` apps/host 호출 0. `ctx.voice` 슬롯만 있고 surface-compose는 `voiceLive`만 채움.

레인 G 소유 (H finding 아님): `voice-live-wire.ts` `buildMicPump` SIGTERM-only, reap/SIGKILL/maxBytes 없음. W2-X `X-H-voice-live-mic-pump`로만 넘김.

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
| X-H-git-process-port | `GitProcessPort` (cloud-branch, src/git spawn 없음) | storage/git-runner, tool/git/runner, rewind-git, memory/consolidate/git (`runtime/worktree`는 **spawn 0건** — git driver이지 spawn owner 아님) | D13 재오픈 아님 |
| X-H-cdp-corr | `browser/cdp/cdp-session.ts` | `tool/debug/cdp-client.ts` | D23 browser 쪽 클리어 |
| X-H-patch-apply | `patch/applier.ts` | `tool/apply-patch.ts` | jail/stale/budget/OTel은 tool. **unified 변환기 본체는 H(`patch/unified-to-v4a.ts`) — H-PATCH-01/03 오너**; tool은 ingress 판정만. 두 번째 apply 엔진 아님 |
| X-H-atomic-split | `PatchFileSystemPort.writeFile` | FsJail temp+rename | 내구성이 fence 너머 |
| X-H-stt-http | media adapters (dead) | voice transcriber (unwired) | REST merge 금지 |
| X-H-recorder | `media/voice` captureOnce (dead) | `voice/default-recorder` (live) | 라이브 오너 1 |
| X-H-subagent-turn-gate | `subagent/turn-gate.ts` | `agent/loop/turn-gate.ts` thin adapter | duplicate 아님 |
| X-H-subagent-spawn | trio `agent-tool.ts` vs six `handlers-6.ts` | `agent/subagent-runner` | 같은 TaskRegistry. 병렬 surface |
| X-H-side-vs-sub | SideAgentDaemonRegistry XOR process | TaskRegistry | invariant 다름. **H-SA-02는 같은 포트 안 adapter drift** |
| X-H-conflict-parse | `@/git/conflict-parser` | tool forwarder | SSOT OK |
| X-H-voice-live-mic-pump | `voice/default-recorder` (H, byte cap 있음) | `apps/cli/repl/voice-live-wire.ts` mic-pump (G) | SIGTERM-only 고아. **G write** |
| X-H-git-directive-wire | collector flush | host/CLI가 tool에 collector 주입? | 활성화 구멍. B/G |
| (A #9) | `@/subagent` port | `agent/subagent-runner` | W1-A: port+adapter, duplicate 아님 |
| (A #10) | `subagent/agent-type.ts` | `named-agent-registry.ts` | well-known vs disk |
| (A #12) | H `DEFAULT_MAX_DEPTH=3` | `spawn-depth.ts` | 리터럴 이중, dual-write 미측정 |

`@/shared`에 STT HTTP / git directive / CDP correlator를 넣지 말 것.

---

## Inventory (failure mode 없음 → 티켓 만들지 말 것)

- H god-code 없음. 큰 파일이지만 cohesive: conflict-parser 705, applier 761, agent-tool 742, handlers-6 719, cloud-branch-snapshot 665, cdp-session 406, headless methods 453.
- Headless `close`가 `sessions.delete` 없이 `closed=true`만 (`headless-stub/methods.ts` L448–453). consumer는 테스트 (`createHeadlessBrowser` production 0). **P3 inventory**, CDP lifecycle는 delete함. 티켓 아님.
- `bring-up` Runtime/Log/Network.enable swallow — capture fail-open, 설계.
- console-buffer / network-buffer 같은 슬라이스 링 클론. count+byte cap 있음 (unbounded 기각).
- 레지스트리 4개 (Task / Team / inproc side-agent / process side-agent): invariant 분리. process vs inproc XOR. **같은 포트에서 cadence 가드 빠진 건 H-SA-02.**
- `DEFAULT_MAX_DEPTH=3` trio+six 리터럴. `tier1/subagent.ts`가 `effectiveMaxDepth` 항상 주입 → fallback 미도달. 측정 dual-write 없음.
- `exec-command` env-scrub hellgate는 shape-scan 정직. 실제 자식 env runtime assert 없음. `input.env` 오버레이로 키가 다시 들어갈 수 있음 (의도 레이어).
- handlers-6 `deliver` catch → `deliver_failed`; spawn `.catch` → `registry.fail`; exec typed error; turn-wake `"no-receiver"`; broker `undefined` — fail-closed/honest. 신규 finding 아님.
- applier D7 zero-hit fallback ~L509: 테스트 잠금 의도. 신규 아님.
- `structured.ts` beforeContent catch: 의도 best-effort.
- `cloud-branch-snapshot`: export만(배럴 재export뿐), live prod caller 없음. abort signal 있고 wall timeout은 포트 구현자 몫.
- Voice transcriber 팩토리 unwired. local-whisper는 timeout 120s + stdout drain 있음 (missing-timeout 의심 기각).
- Media/voice hellgate는 어댑터 직호출. live production ingress / anti-vacuum / red-on-injection 없음.
- `voice-queue` / `voice-overlay` 정의만 있고 production import 0 (G 레인 확인 후보).
- `createProcessSideAgentDaemonRegistry` 147줄 — god-fn 아님.

---

## No-finding으로 닫은 영역

- leaf DIP (**value-import 기준**): media/voice/browser/git/patch/subagent → `@/shared`. subagent는 `import type … from "@/tool"` 4건(`agent-tool.ts:4`, `agent-tools-6.ts:31`, `introspect-tools.ts:28`, `task-tools.ts:2`) — 가드가 type-only를 스킵하므로 위반은 아니나 "shared만"은 아님. side-agent **barrel**은 llm/tool 미재export.
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
| H-SA-02 | `process-registry.ts` + `side-agent-process-registry-hellgate.test.ts`; optional shared validateSpec | tool 문구만; in-process 가드 후퇴 |
| H-PATCH-01 | `unified-to-v4a.ts` + unified-to-v4a tests | tool |
| H-PATCH-03 | 같은 converter + empty-ops 정책. PATCH-01과 한 PR 가능, 실패 모드는 분리 | tool 경고만 |
| H-PATCH-02 | `applier.ts` + applier tests | FsJail을 patch로 끌어오기 |
| H-GIT-01 | W2-X 후. canonical=H면 `git/directive-emit/**` | agent git-directives, tool/git, GitRunner mega-merge |
| H-MEDIA-01 | `src/media/**`, `tests/unit/media/**`, `tests/unit/cli/voice-confirm-hellgate.test.ts`, `tests/unit/boundary-cancellation-hellgate.test.ts` 정리 | REST core, voice 삭제, peer import |

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
- 함수 크기는 repo 정본 AST 검출기 `tools/god-code/detect.ts`(`ts.createSourceFile`) 결과 — 근사 아님. >150 = 0 확정.
- `gitTools({ collector })` 주입 0은 **확정** — production call-site 2곳 전수(`apps/cli/internal.ts:562`, `apps/agent/mode-presets/ci-bot.ts:218`) 모두 `coChange`/`budget`만 전달.
- mic-pump 고아는 G 코드. H는 fingerprint만.

---

## 2026-09-08 hole-check (병렬 3워커)

| 워커 | 결과 |
|---|---|
| side-agent + subagent | H-SA-01 유지 + sibling 표. **H-SA-02 채택**. DEFAULT_MAX_DEPTH·지정 catch는 기각 |
| patch + git + browser | PATCH-01/02·GIT-01·D23 유지. **H-PATCH-03 채택**. headless Map은 inventory. binary empty apply는 converter+parser |
| media + voice | MEDIA-01 유지. voice-confirm 가짜 합성은 테스트 정직성. live mic-pump는 **G** |

기각: handlers-6 fail-open, exec-kill legacy를 성공 위장으로 보기, CDP unmatched-id leak, buffer unbounded, D23 browser 재오픈, D7 REST, D13 src/git spawn.

---

## 다른 레인과의 정렬 (이 세션이 읽은 범위)

- W1-A: git-directives를 W2-X #13으로 넘김. subagent-runner는 H 포트의 어댑터로 봄. spawn-depth × `DEFAULT_MAX_DEPTH=3`.
- W1-B: D23 closed. `tool/debug/cdp-client.ts`와 `src/browser`를 X-B8로만. apply-patch는 B 소유 파일이지만 apply **알고리즘**은 H `@/patch`.
- W1-G: `voice-live-wire.ts`, `side-agent-fork-port.ts`가 G 스코프. mic-pump 고아는 G finding 후보. H는 fingerprint만.

전체 파일 표·fingerprint 한 줄은 W1-H receipt가 SSOT.

---

DONE — agent-3 lane H 세션 노트 + hole-check 보완. 코드 미수정.
