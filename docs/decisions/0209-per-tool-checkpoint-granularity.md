# ADR-0209: Per-tool-call checkpoint granularity (Cline / Cursor / Codex absorption)

- **상태**: Accepted (default-OFF; not yet wired into dispatch — opt-in for callers)
- **날짜**: 2026-05-25
- **관련**: ADR-0108 (shadow git ODB), ADR-0118 (shadow rewind), ADR-0121 (auto-checkpoint policy 4-arm), ADR-0122 (shadow-odb rewind extensions), ADR-0124 (conversation-checkpoint store)
- **참조**: `src/agent/per-tool-checkpoint/{port,granular-policy,index}.ts`, `tests/unit/per-tool-checkpoint-hellgate.test.ts`

## 맥락

3-vendor 강신호:

- **Cline** — UI에 per-tool-use diff + "Restore Files Only / Restore Task Only / Restore Both" 3-way (`webview-ui/src/components/chat-view/checkpoint/CheckpointControls.tsx`).
- **Cursor** — per-checkpoint shadow ODB (`gix-snapshot`).
- **Codex** — shadow ODB 자동 snapshot.

quanta는 ADR-0121로 4-arm trigger mode를 표면화했지만 **anchor의 GRANULARITY는 "per-turn" 1축**만 존재. tool 호출 단위 anchor는 dedup 때문에 turn당 1회로 collapsed. Cline UX (`/rewind-tool tool:edit_file:turn-1:7`)을 구현하려면 tool 호출 단위로 tag-able SHA가 필요.

## 결정

`@/agent/per-tool-checkpoint` 신규 slice (closed-port). 기존 `CheckpointPolicy`(ADR-0121)에 **별도 직교 축인 GRANULARITY** 추가:

```ts
export type CheckpointGranularity = "turn" | "tool" | "skill"
```

`GranularCheckpointPolicy`는 `CheckpointPolicy`를 extends하고 추가로:

- `granularity: CheckpointGranularity` (read-only at construction)
- `registry: GranularRegistry` (in-memory tag→{sha,takenAt,toolName,turnId,callIndex} map, LRU)
- `computeTag(ctx): CheckpointTag | null` (pure tag derivation)
- `recordAnchorSha(tag, sha, ctx)` (caller가 anchor 실 SHA를 알게 됐을 때 호출)

### Granularity 의미

| 값 | 동작 | 호환성 |
|---|---|---|
| `"turn"` (default) | 모든 method를 base policy로 verbatim 위임. registry empty. | **byte-identical** to pre-ADR-0209. |
| `"tool"` | `shouldAnchorBefore`가 base의 per-turn dedup를 우회 (Cline pattern: 매 destructive call마다 anchor). `recordAnchorSha`가 `tool:<name>:<turnId>:<callIndex>` 형식 entry를 registry에 삽입. `shouldAnchorAfterTurn` ⇒ false (turn 경계는 tool-grain의 책임이 아님). | base mode가 `"per-mutating"`일 때 의도된 동작. `"pre-destructive"`와는 cooperative — base가 dedup으로 거절하면 tool-grain도 거절 (legacy posture 존중). |
| `"skill"` | reserved. 현재는 `"turn"`과 동일 처리. enum grep-stable. | future: Codex skill boundary 와이어링. |

### 4-arm trigger mode (ADR-0121) 와의 직교성

- `mode === "off"` ⇒ granularity 무관, 모든 anchor 거절 (byte-identical to ADR-0121 off).
- `mode === "per-mutating"` + `granularity === "tool"` ⇒ 매 destructive tool 호출마다 anchor + tag.
- `mode === "pre-destructive"` + `granularity === "tool"` ⇒ base가 per-(workspace, turn) dedup을 강제하므로 turn당 1회만 anchor (의도적: caller가 dedup을 원했으면 tool-grain도 존중).
- `mode === "per-turn"` + `granularity === "tool"` ⇒ `shouldAnchorAfterTurn`만 trigger되지만 tool-grain은 false 반환 ⇒ 아무 anchor도 안 일어남 (caller misconfiguration — 의도적으로 surface, throw 안 함).

### Tag 포맷 (canonical)

| Granularity | Tag |
|---|---|
| `tool` | `tool:<toolName>:<turnId>:<callIndex>` |
| `skill` | `skill:<skillName>:<turnId>` |
| `turn` | (no tag; legacy path) |

`computeTag(ctx)`는 turn-grain에서 `null`을 반환 — registry는 비어있는 상태 유지.

### Default-OFF

`AgentConfig`에 wiring 추가 안 함 (사용자 in-flight 트랙 보호). assembly layer가 명시적으로 `defaultGranularCheckpointPolicy({base, granularity})`를 구성해 `withAutoCheckpoint`에 주입할 때만 활성. 기본 호출자는 `defaultCheckpointPolicy`를 그대로 사용 ⇒ byte-identical.

### No-throw + exactOptionalPropertyTypes

- Public surface 모든 method: NO-THROW (base policy throw도 catch해서 false로 collapse).
- Optional 필드 (`toolName?`, `turnId?`, `callIndex?`, `skillName?`) 모두 conditional spread로 구성 — `tsc`가 `field: undefined`를 절대 못 봄.
- Programmer-bug 입력 (negative `maxRegistryEntries`)는 silent clamp.

### 안전망

- `recordAnchorSha`가 empty SHA (anchor I/O 실패 sentinel)를 받으면 registry 삽입 skip.
- `recordAnchorSha`가 non-canonical tag (caller bug)를 받으면 거절 — registry poisoning 방지.
- LRU eviction: `maxRegistryEntries` 기본 200 (per-tool은 per-turn보다 frequency 높음). 초과 시 oldest-first drop.

### 무엇을 NOT 하는가

- `ShadowOdb` 포트를 mutate 안 함. 본 슬라이스는 `src/storage/shadow-odb/*`에 한 줄도 추가/수정하지 않음 (사용자 instruction 준수).
- `CheckpointPolicy` (ADR-0121) 본체를 mutate 안 함. `checkpoint-policy.ts`는 read만, extension만.
- `EffectChannel` wrap (`withAutoCheckpoint`)를 duplicate 안 함. wrap은 ADR-0121 본체에 머묾.
- dispatch / loop / session / permission 어디도 import 안 함 (closed slice).

## 결과

- **15 hellgate**: granularity="turn" parity (3) + tool-grain cardinality (3) + recordAnchorSha typed invariants (4) + tag collision + abort-mid-checkpoint (2 — block G에 추가) + (3-way restore는 ADR-0210).
- **default-OFF**: byte-identical to pre-ADR-0209.
- **slice clean**: `src/agent/per-tool-checkpoint/` 3 파일 (port.ts / granular-policy.ts / index.ts) + 1 ADR.

## Negative invariants

- `granularity === "turn"` ⇒ registry에 entry가 단 1개도 안 들어감 (HELL-A2).
- `mode === "off"` ⇒ granularity 무관 anchor 0회 (HELL-A3).
- Non-canonical tag로 `recordAnchorSha` 호출 ⇒ registry size 변화 없음 (HELL-C9).
- Empty SHA로 `recordAnchorSha` 호출 ⇒ registry size 변화 없음 (HELL-C8).
- LRU cap 초과 ⇒ oldest 우선 drop, newest 보존 (HELL-C10).
