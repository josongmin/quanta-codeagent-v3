# ADR-0210: 3-way restore — Files Only / Task Only / Both (Cline 패턴)

- **상태**: Accepted (default-OFF; slash command `/rewind-tool` 등록, 조립 layer가 wiring opt-in)
- **날짜**: 2026-05-25
- **관련**: ADR-0118 (shadow rewind), ADR-0122 (shadow-odb rewind extensions — restorePartial), ADR-0124 (conversation-checkpoint store), ADR-0209 (per-tool granularity + tag registry)
- **참조**: `src/agent/per-tool-checkpoint/{port,three-way-restore,index}.ts`, `src/apps/cli/rewind-tool-cmd.ts`, `tests/unit/per-tool-checkpoint-hellgate.test.ts`

## 맥락

Cline UI는 user에게 3 가지 명시적 명령을 제공:

1. **Restore Files Only** — 워크스페이스 파일만 되돌리고 대화는 그대로 유지.
2. **Restore Task Only** — 대화만 되돌리고 파일은 그대로 유지.
3. **Restore Both** — 둘 다 되돌림.

quanta는 ADR-0118 `rewindToLast` (files만) + ADR-0124 `ConversationCheckpointStore` (대화만) **둘을 가지고 있지만**, 두 면을 묶어 사용자에게 직교 3-way UX로 surface하는 단일 typed surface가 없었음. ADR-0209의 tag registry 위에서 같은 tag로 두 면을 동시 indexing 가능 — 그게 본 ADR의 wiring point.

## 결정

`ThreeWayRestorePort` 신규 closed-port:

```ts
export interface ThreeWayRestorePort {
  restoreFiles(tag, opts?): Promise<RestoreOutcome>
  restoreTask(tag, opts?): Promise<RestoreOutcome>
  restoreBoth(tag, opts?): Promise<RestoreOutcome>
}
```

`RestoreOutcome`은 typed result envelope:

| 필드 | 의미 |
|---|---|
| `ok: boolean` | every requested leg 성공 여부 |
| `errorCode?: RestoreErrorCode` | 실패 시 closed enum |
| `originalCode?: string` | shadow-rewind-failed일 때 underlying `ShadowOdbErrorCode` |
| `filesChanged?: ReadonlyArray<string>` | files leg가 호출됐을 때 변경된 path 목록 |
| `messagesBefore?` / `messagesAfter?` | task leg가 호출됐을 때 conversation snapshot |
| `tag: CheckpointTag` | resolved canonical tag |
| `message: string` | human-readable |

### Orthogonality

| Call | shadow ODB consult? | conversation store consult? |
|---|---|---|
| `restoreFiles` | YES | NO |
| `restoreTask` | NO | YES |
| `restoreBoth` | YES (1st) | YES (2nd, files OK일 때만) |

이 직교성은 hellgate D14/D15로 봉인 — `restoreFiles`가 conversation store size를 변경하지 않음을 assert + 역방향도 동일.

### 에러 코드 (closed enum)

```ts
export type RestoreErrorCode =
  | "tag-not-found"                       // registry miss
  | "shadow-odb-not-configured"           // files leg, port absent
  | "conversation-store-not-configured"   // task leg, port absent
  | "task-snapshot-missing"               // store LRU evicted snapshot
  | "shadow-rewind-failed"                // underlying ShadowOdbError
```

`shadow-rewind-failed`일 때 `originalCode`에 underlying `ShadowOdbErrorCode` (`merge-in-progress` / `uninitialized` / `rewind-failed` 등) 보존 — UI가 추가 introspection 없이 분기 가능.

### No-throw

모든 method가 throw하지 않음 — 모든 실패는 `RestoreOutcome.ok === false`로 collapse. Programmer-bug 입력 (unknown tag)도 typed envelope로 surface. 유일 throw 가능 지점은 construction time.

### Error-priority ordering

- `tag-not-found`이 `*-not-configured`보다 우선 — 가장 specific한 에러가 surface 우선순위.
- File leg failure가 task leg failure를 가림 — `restoreBoth` first-failure-wins.

### Trade-off: `rewindToLast` vs per-SHA restore

ADR-0205 implementation은 `ShadowOdb.rewindToLast`를 사용 (which targets `SHADOW_LAST_REF`) — registry의 specific SHA로 restore하지 않음. 이유: `ShadowOdb` port는 per-SHA `restore` method를 노출하지 않고, 추가하려면 `src/storage/shadow-odb/*`를 mutate해야 하는데 이는 본 슬라이스 제약 (사용자 instruction)에 의해 금지.

실제로는 auto-checkpoint policy가 매 destructive tool 호출 전 `SHADOW_LAST_REF`를 advance하므로 (tool-grain), tag의 registered SHA = the SHA that `SHADOW_LAST_REF` pointed at after the immediately preceding anchor ⇒ 즉시-rewind는 의도된 동작. Trade-off 명시 — 사용자가 다른 tag로 rewind하고 싶다면 future ADR이 ShadowOdb port에 `restoreToSha(sha)` 추가해야 함.

### Slash command `/rewind-tool` (ADR-0066 slash registry 등록)

```
/rewind-tool                                    → registry list
/rewind-tool <tag-prefix>                       → preview
/rewind-tool <tag-prefix> --mode=files [--yes]  → files leg
/rewind-tool <tag-prefix> --mode=task --yes
/rewind-tool <tag-prefix> --mode=both --yes [--allow-dirty-merge]
```

- `ctx.perToolCheckpoint` 부재 시: `"not wired in this surface"` + exit 0 (default-OFF parity, byte-identical to NOT registering).
- `--yes` 없으면 preview line만 출력 (`/rewind`, `/snapshot`과 동일 protocol).
- 모호한 prefix ⇒ exit 1 + 명확 메시지.

### 무엇을 NOT 하는가

- `ShadowOdb` 포트 신규 method 추가 안 함.
- `ConversationCheckpointStore` 본체 mutate 안 함.
- 사용자 in-flight 트랙 (mode, subagent, playbook, voice, scheduler) 어디도 import 안 함.
- conversation snapshot의 **record**는 본 ADR의 책임이 아님 — caller가 anchor 시점에 `store.record(tag, messages)`를 invoke해야 함 (assembly layer 책임).

## 결과

- **8 hellgate**: 3-way orthogonality (5) + typed failures (3) + slash routing (3 — F19/F20/F21). Total ADR-0209 + ADR-0210 합계 **23 hellgate** (1 hellgate file).
- **default-OFF**: slash 명령은 등록되지만 ctx slot 부재 ⇒ "not wired" + exit 0.
- **slice clean**: `src/agent/per-tool-checkpoint/` 4 files + `src/apps/cli/rewind-tool-cmd.ts` + `src/apps/cli/slash-commands.ts` 등록 줄 2개.

## Negative invariants

- `restoreFiles`가 conversation store size를 변경 ⇒ ❌ (HELL-D14).
- `restoreTask`가 shadow rewind 호출 ⇒ ❌ (HELL-D15).
- `restoreFiles` 성공 시 `messagesAfter` 필드 존재 ⇒ ❌ (orthogonality).
- `restoreTask` 성공 시 `filesChanged` 필드 존재 ⇒ ❌.
- `restoreBoth` files-leg 실패 시 task-leg 시도 ⇒ ❌ (first-failure-wins).
- `ShadowOdbError`가 typed envelope를 우회해 throw ⇒ ❌ (HELL-E18 catches it).
- Slash ctx 부재 시 `restoreFiles`가 silently 호출됨 ⇒ ❌ ("not wired" + exit 0).
