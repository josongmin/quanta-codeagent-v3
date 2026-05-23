# ADR-0122: ShadowOdb rewind extensions — per-file restore + verified anchor + /rewind skill

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0108 (Shadow git ODB foundation), ADR-0118 (rewindToLast + 안전망), ADR-0119 (shadow_rewind + shadow_snapshots tool 노출), ADR-0123 (verify-checkpoint bridge — 본 ADR 의 markVerified caller)
- **참조**:
  - `src/storage/shadow-odb/types.ts` — port 확장 (3 method + 1 ref constant + 1 error code)
  - `src/storage/shadow-odb/default.ts` — 3 메서드 구현 + repo-relative path validator
  - `src/storage/shadow-odb/index.ts` + `src/storage/index.ts` — 새 ref 상수 re-export
  - `src/tool/shadow/rewind.ts` — `target: "last" | "verified"` 추가
  - `src/tool/shadow/restore-partial.ts` — 신규 tool (always-confirm, repo-relative paths)
  - `src/tool/shadow/index.ts` — 배럴 + `shadowTools()` 배열에 추가 (snapshots → restore_partial → rewind 순)
  - `src/tool/index.ts` — re-export 확장
  - `src/skill/system-skills/rewind/{SKILL.md,index.ts}` — `/rewind` user-invocable skill
  - `src/skill/system-skills/index.ts` + `src/skill/index.ts` — 배럴 등록
  - `tests/unit/shadow-odb-rewind-extensions-hellgate.test.ts` — 18 case (A. restorePartial 6 / B. markVerified 4 / C. rewindToVerified 5 / D. bridge 3)
  - `tests/unit/tool/shadow-rewind-extensions-hellgate.test.ts` — 10 case (A. rewind target routing 4 / B. restore_partial 6)

## Context

ADR-0118 + ADR-0119 가 닫은 surface 는 "full-tree rewind to last-registered snapshot" 단일 모드뿐이다. 실제 사용자 요청 패턴은 두 가지 갭이 있다.

1. **Per-file 복원 갭 (Hermes Agent 패턴).** Nous Research 의 Hermes Agent 는 `/rollback N`, `/rollback diff N`, `/rollback N <file>` 세 모드를 노출한다. quanta 는 `shadow_rewind` 가 all-or-nothing — "방금 만든 build artifact 만 살리고 src/foo.ts 만 되돌려" 같은 흔한 요청을 단일 tool 호출로 표현할 길이 없다. 모델이 bash + `git checkout` 으로 직접 치면 HITL gate 우회 + typed-error 손실.

2. **Verified anchor 갭 (Cursor `markVerifiedV2` 패턴).** Cursor 의 snapshot 시스템은 verify gate 가 통과한 시점에만 `refs/cursor/snapshots/last-verified` 를 advance — 이후 verify fail 이 발생하면 그 anchor 로 자동 rewind 가능. quanta 는 verify-guard 가 존재하지만 "verify 통과 시점" 을 영구화할 anchor surface 가 없다. "마지막으로 테스트 통과했을 때로 되돌려" 라는 자연스러운 요청에 응답 불가.

3. **`/rewind` slash skill 갭.** ADR-0119 의 follow-up 에 "`/rewind` CLI slash command" 가 정확히 listed — UI surface 가 비어있다. 사용자 입장에서 "rewind / undo / rollback" 자연어 → 3-tool 결합 (`shadow_snapshots` 로 enumerate → `shadow_rewind` or `shadow_restore_partial` 로 destructive) 의 decision tree 가 documented 안 됨.

본 ADR 은 세 갭을 **단일 라운드** 로 닫는다. ADR-0123 (verify-checkpoint bridge) 는 paired — `markVerified` 의 caller surface 를 분리해 비대화 (auto-rewind 정책은 또 별도 ADR).

## Decision

### Part 1 — `ShadowOdb` port 확장 (types.ts)

3 메서드 + 1 ref 상수 + 1 error code:

- `restorePartial(workspaceRoot, paths, opts?)` — `SHADOW_LAST_REF` 에서 명시된 path 만 복원. 기타 worktree 파일은 미터치. paths 가 repo-relative (절대 경로 + `..` 거부); 빈 paths 는 no-op (safety-net ref 생성 안 함). 나머지 semantics 는 `rewindToLast` 와 동일 (uninitialized / merge-in-progress / 같은 per-workspace lock).
- `markVerified(workspaceRoot)` — `SHADOW_LAST_REF` 가 가리키는 sha 를 `SHADOW_LAST_VERIFIED_REF` 에 update-ref. idempotent. `SHADOW_LAST_REF` 부재 시 `uninitialized`.
- `rewindToVerified(workspaceRoot, opts?)` — `rewindToLast` 의 mirror. ref 가 `SHADOW_LAST_VERIFIED_REF` 인 것만 다름. `markVerified` 가 한 번도 호출되지 않았으면 `no-verified-anchor` (새 error code).

새 ref 상수 `SHADOW_LAST_VERIFIED_REF = "refs/quanta/snapshots/last-verified"`. `assertSafeRef` 가 두 canonical ref 모두 허용하도록 확장.

### Part 2 — 구현 (default.ts)

- **repo-relative path validator** (`assertRepoRelativePaths`): conflict-inspect 의 패턴 미러. 빈 문자열 + 절대 경로 + `..` 세그먼트 거부. POSIX `/` AND OS native sep 모두 split 해 Windows backslash traversal 도 차단 (defense in depth).
- **lock 공유**: 세 새 메서드 모두 기존 `serialize(st, fn)` closure 를 사용. lock 을 외부에 노출하지 않고 `defaultShadowOdb` 의 returned object 안에서 신규 메서드가 직접 `serialize` 를 참조 — closure capture 가 자연스러운 lock-sharing 메커니즘. ADR-0118 hellgate (HELL-11 등) 가 sealing 한 같은 보장이 신규 메서드에도 자동 전이.
- **rewindToLast 미터치**: 원본 메서드 본문은 라인 단위로 byte-identical. 신규 메서드들은 safety-net + merge-guard 흐름을 *복제* 한다 (DRY 위반보다 byte-identical-when-absent 우선). 한 번 더 추출 리팩터링은 follow-up.

### Part 3 — `shadow_rewind` tool 확장

`target: z.enum(["last", "verified"]).optional()` 입력 필드 추가. `target ?? "last"` 분기:
- `"last"` ⇒ `odb.rewindToLast` (back-compat 기본).
- `"verified"` ⇒ `odb.rewindToVerified`.

`no-verified-anchor` 는 typed-error mapping 을 통해 `ok:false "no-verified-anchor: ..."` 로 surface (다른 ShadowOdbError 와 같은 패턴).

성공 output 메시지가 `"last snapshot"` / `"last verified snapshot"` 으로 분기 — ADR-0119 hellgate (E15: 'preserve' + 'Pre-rewind ref saved' 포함) 와 호환되도록 두 label 모두 `"Pre-rewind ref saved"` 와 untracked policy 를 포함.

### Part 4 — 신규 tool `shadow_restore_partial`

`always-confirm` + `isReadOnly:false` + `isConcurrencySafe:false`. 입력 schema:
- `paths: z.array(z.string().min(1)).min(1)` — 빈 배열 zod 거부 (port 의 no-op semantics 와 다른 시그니처 의도, 모델이 의식적으로 빈 배열을 보내지 못하게 함).
- `target: z.enum(["last", "verified"]).optional()` — v1 에선 `"verified"` 가 typed `no-verified-anchor` 로 응답 (port-level partial-from-verified 는 follow-up).
- `allowDirtyMerge: z.boolean().optional()` — `rewindToLast` 와 동일.

output: `Restored N file(s) from <target>: file1, file2, …` (4,000 char cap 으로 거대 path list 방어).

shadowTools 배열 순서 변경: `[snapshots, restore_partial, rewind]` — read-only-first (snapshots) 유지하고, destructive 두 개 사이에선 더 surgical 한 restore_partial 을 앞에. `gitTools` convention (mutating 작업 중 narrower blast radius 가 먼저) 일관.

### Part 5 — `/rewind` slash skill

`src/skill/system-skills/rewind/{SKILL.md, index.ts}` 신규. SKILL.md frontmatter:
- `userInvocable: true` — slash command (`/rewind`) 로 직접 trigger 가능.
- `allowedTools: [Bash, Read, shadow_snapshots, shadow_rewind, shadow_restore_partial]` — 3 shadow tool + 진단용 Read/Bash.
- `tools:` mirror (lenient parser SSOT 와 strict 6-field parser SSOT 동시 만족, ADR-0040 패턴).

body 는 4-step decision tree: (1) `shadow_snapshots` 로 enumerate 먼저 → (2) target 결정 (verified vs last vs per-file) → (3) untracked policy (default preserve) → (4) HITL confirm. `index.ts` 는 progress-audit / CTK 8 skills 패턴 미러 (NAME + Trigger + trigger + find).

### Part 6 — auto-verify bridge

ADR-0123 으로 분리. 본 ADR 의 `markVerified` port 가 caller surface 를 제공; ADR-0123 의 `defaultVerifyCheckpointBridge(odb).onVerifySuccess(workspace)` 가 host wiring 점. 두 ADR 이 paired — 본 ADR 만 적용해도 `markVerified` 를 사용자가 명시적으로 호출 가능 (default-OFF 안전).

### Part 7 — 28-case hellgate

`shadow-odb-rewind-extensions-hellgate.test.ts` (18):
- A. restorePartial (6) — happy 1-file restore (other files unchanged) / empty paths no-op / absolute path / `..` traversal / never-registerHead'd / non-existent path in snapshot
- B. markVerified (4) — happy + idempotent + before registerHead → uninitialized + verified-ref 가 register 진행에도 OLD sha 유지
- C. rewindToVerified (5) — happy / no markVerified → no-verified-anchor / MERGE_HEAD guard / allowDirtyMerge / safety-net ref 생성 확인
- D. bridge (3) — odb 부재 no-op / 던지는 odb 도 swallow / 정상 odb 가 workspace path 전달받음

`tool/shadow-rewind-extensions-hellgate.test.ts` (10):
- A. shadow_rewind target (4) — 부재/last/verified routing + verified 에러 typed-mapping
- B. shadow_restore_partial (6) — schema min(1) / 정상 호출 + exact-optional / target=verified v1 deferred / 절대 경로 / metadata (hitlTier/isReadOnly/isConcurrencySafe) / output 포맷 'Restored 1 file from last: a.ts'

## Default-OFF posture

`config.shadowOdb` 부재 ⇒ `buildShadowBlock` 이 `[]` 반환 (ADR-0119 의 기존 게이트 미터치) ⇒ 새 tool 3 개 (`shadow_restore_partial` 포함) 도 함께 미등록. `/rewind` skill 은 `discoverSystemSkills()` 에서 항상 노출되지만 실제 동작은 shadow tools 등록 여부에 종속 (없으면 모델이 tool 호출 시 `shadow_*` 가 catalog 에 없어 noop).

bridge 는 `defaultVerifyCheckpointBridge(undefined)` 가 silent no-op — host 가 unconditional 으로 wire 해도 byte-identical 한 안전성.

## Alternatives rejected

1. **one-file restore 를 `rewindToLast` + manual revert 로**
   - 사용자에게 "rewind 전체 → 안 되돌릴 부분을 manual edit 으로 다시 적용" 시퀀스 강요 — too fragile, race 위험 (rewind 직후 모델이 'b.txt 만 원래대로' 한 줄 잘못 쓰면 lose).
   - 거부 — first-class API 가 안전망 + atomic 보장.

2. **verified-ref 를 `SHADOW_LAST_REF` 의 새 tier 로 통합**
   - "last-registered-and-verified" 같은 단일 ref 를 advance — verified 정보를 lose (registered 진행 시 verified 가 강제로 advance 됨, 마지막 verified 시점 회수 불가).
   - 거부 — 두 axis (registered / verified) 가 직교, 별도 ref 가 옳음. Cursor 도 동일 구조.

3. **`shadow_restore_partial` 에 zod-level absolute-path refine 추가 (port reach 전 거부)**
   - schema-level reject 가 빠르긴 하나 — port 가 동일 검사를 *반드시* 해야 함 (다른 caller 가 zod 우회 가능). 두 layer 모두 check 하면 검사 SSOT drift.
   - 채택 = port-only check; tool 은 그대로 통과시키고 typed error mapping 으로 surface. test HELL-B8 이 `rewind-failed:` prefix 로 sealing.

4. **`target: "verified"` 를 `shadow_restore_partial` v1 에서 실제 verified-ref 로 라우팅**
   - port 의 `restorePartial` 시그니처가 ref 인자를 받지 않음 (current). 두 ref 모두 path-scoped 복원 지원하려면 port 시그니처 확장 필요.
   - 거부 (v1) — 절차 minimize. v1 은 typed `no-verified-anchor` 로 응답, port 확장은 follow-up. HELL-B7 이 이 deferral 을 명시적으로 sealing.

5. **shadow tools 배열 순서를 ADR-0119 와 동일하게 유지 (snapshots → rewind), restore_partial 을 끝에**
   - 직관적이지만 `gitTools` convention "destructive 중 narrower blast radius 먼저" 와 어긋남.
   - 채택 = `[snapshots, restore_partial, rewind]`. dispatch 가 array 순서에 의존하지 않음으로 동작 영향 0.

6. **`/rewind` skill 의 SKILL.md 를 `tools:` 만 두고 strict 6-field metadata 제외**
   - discoverSystemSkills 는 두 SSOT 모두 만족시켜야 (lenient `tools:` → host allowlist, strict frontmatter → `userInvocable` / `category` / `stability`). 누락 시 frontmatter parser 가 reject.
   - 채택 = both blocks (progress-audit / fix-merge-conflicts 패턴 유지).

## SOTA++ 자리매김

| 시스템 | per-file rewind | verified anchor | /rewind UI skill | hellgate |
|---|---|---|---|---|
| Hermes (Nous) | `/rollback N <file>` | ✗ | `/rollback` slash | ✗ (closed) |
| Cursor 3.2 | ✗ (full-tree only via gix-snapshot) | `markVerifiedV2` (auto on success) | ✗ (IDE-internal) | ✗ |
| Codex 0.131 | ✗ | ✗ | ✗ | N/A |
| Claude Code 2.1 | ✗ | ✗ | ✗ | N/A |
| **quanta (R2)** | **`shadow_restore_partial` typed tool + always-confirm** | **`markVerified` port + opt-in bridge (ADR-0123)** | **`/rewind` system skill + 4-step decision tree** | **28 case (port 18 + tool 10)** |

= "Hermes 의 per-file rewind 와 Cursor 의 verified anchor 를 single round 로 흡수하면서 양측 모두 typed-error + HITL `always-confirm` + closed-port DI 로 봉합, `/rewind` slash skill 까지 documented 한 최초 OSS 구현".

## Follow-up (이 ADR 이 닫지 않음)

- **`shadow_restore_partial` 의 `target:"verified"` 실제 라우팅** — port 의 `restorePartial` 시그니처를 `(ws, paths, refTag, opts?)` 로 확장하거나 두 번째 메서드 `restorePartialFromVerified` 추가. 별도 ADR.
- **auto-rewind on verify-fail policy** — bridge 가 verify-fail 시점에도 hook 호출하도록 확장. retry budget + breaker 정책 필요 — ADR-0124 후보.
- **`/rewind` CLI slash route binding** — apps/cli 가 stabilize 된 후 slash router 가 `triggerRewind()` 호출. 현재는 skill metadata 만 in place, router 자체는 미구현 (ADR-0045 와 같은 상황).
- **`shadow_rewind {target:"verified"}` 의 ok:true 응답에 verified ref 의 sha 첨부** — ADR-0119 follow-up #6 의 verified-tier 버전.
- **OTel attribute** — `tool.shadow_restore_partial.{path_count, target, mapped_error_code}`, `tool.shadow_rewind.target` span attribute 추가.
