# Subagent Memory And Continuity

Overview router: [subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)

## 1. Direct facts

직접 보이는 continuity 관련 사실:

| Fact | Meaning |
| --- | --- |
| child lifecycle tools exist | child state is not purely ephemeral per call |
| `fork_context` exists | parent context copy/fork concept exists |
| `wait_agent` exists | child completion can be synchronized |
| `resume_agent` exists | child continuity can outlive one immediate response |

## 2. Best-fit continuity ladder

| Continuity rail | Strength | Safe claim | Unsafe overclaim |
| --- | --- | --- | --- |
| child id / handle | medium | child can be referenced again until close | durable global agent registry |
| forked context | medium | some parent context can seed child | exact full memory graph copy |
| child final result | medium | child output can be reintegrated | full persistent work log |
| child after close | weak | maybe resumable only if explicitly supported by visible tool path | guaranteed durable child resurrection |

핵심:
- child continuity는 있다
- 하지만 artifact/thread summary보다 강하지는 않다

## 2.1 Relative strength versus other rails

| Rail | Relative strength versus subagent context | Why |
| --- | --- | --- |
| thread history | stronger | parent same-thread continuity가 더 기본 rail이다 |
| workspace artifact | much stronger | file/doc/log는 durable substrate다 |
| live shell session | similar or slightly stronger in its niche | both are in-flight continuation rails |
| automation wakeup | orthogonal | future re-entry trigger이지 child context 자체는 아님 |

## 3. Relation to broader memory model

best-fit memory stack 안에서 subagent는 이 위치다. `[STRONG-INFERENCE]`

```mermaid
flowchart TD
    A["Policy memory"] --> E["Current decision"]
    B["Thread memory"] --> E
    C["Artifact memory"] --> E
    D["Subagent context"] --> E
```

의미:
- parent thread history가 제일 강한 continuity rail 중 하나
- artifact는 durable proof substrate
- child context는 bounded auxiliary continuity rail

## 3.1 Continuity after interruption

best-fit rule:

1. same thread, child still open: child continuity usable
2. same thread, child closed but resumable: maybe reuse
3. app interruption or new thread: artifact/thread summary reread가 더 안전

즉 interruption이 커질수록 child continuity보다 artifact continuity가 우선한다.
앱 재시작이나 더 큰 recovery 질문은 [session-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/session-management-audit.md)와 [logging-and-recovery-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/logging-and-recovery-audit.md)가 더 직접적인 owner다.

## 4. What `fork_context` most likely means

안전한 해석:
- child bootstrap에 parent context 일부를 전달할 수 있다
- child는 blank worker보다 parent-derived worker에 가깝다

안전하지 않은 해석:
- exact hidden prompt stack 전체가 lossless copy된다
- global memory store까지 자동 복제된다
- child close 후에도 same richness로 자동 복구된다

## 5. Practical rule

subagent 결과를 받았다고 해서 그 자체를 durable truth로 취급하면 안 된다.

실전 closeout rule:
1. child output 확인
2. parent-side live source or artifact reread
3. defended claim만 final에 반영

## 5.1 Resume versus rebuild

| Situation | Better move |
| --- | --- |
| child가 아직 relevant하고 handle이 살아 있음 | `wait` or `send_input` |
| child context가 still useful but closed | `resume_agent` 고려 |
| parent evidence가 크게 바뀜 | fresh spawn or local reread |
| thread/app continuity가 약해짐 | artifact/thread-based reconstruction 우선 |

## 5.2 Continuity failure modes

| Failure mode | Consequence |
| --- | --- |
| child packet만 믿고 local reread 생략 | stale closure claim |
| child continuity를 durable memory처럼 가정 | wrong cross-session expectation |
| huge context drift after parent evidence changed | outdated child hypothesis persists |
| interruption 후 child handle 집착 | weaker rail에 과적합 |

## 6. Non-claims

이 문서가 주장하지 않는 것:
- subagent persistent store exact shape
- child context retention after platform restart
- arbitrary cross-thread automatic child recall

---

## Round 2 update (2026-05-21 deep dive)

이 섹션은 subagent continuity rail에 round-2에서 확인된 추가 substrate evidence를 추가한다. 다만 background subagent / external-agent migration lifecycle 자체는 [subagent-management-audit.md](./subagent-management-audit.md#round-2-update-2026-05-21-deep-dive)와 [subagent-lifecycle-and-runtime-interface.md](./subagent-lifecycle-and-runtime-interface.md#round-2-update-2026-05-21-deep-dive)가 owner다.

### R2.1 External-agent import has its own persistent state file

round-2 발견: `external_agent_session_imports.json`이라는 persistent state file이 존재한다. `[FACT]`

해석:
- 이건 in-process subagent의 child handle이 아니라 **imported external-agent session state**를 유지하는 별도 rail이다 `[FACT]`
- 즉 subagent continuity의 sibling rail로 “import 기록”이 디스크에 남는다 `[STRONG-INFERENCE]`
- round-1 §2 continuity ladder에는 in-process child 4 rail만 있었지만, round-2부터는 “imported external-agent session lineage”라는 5번째 rail이 추가된다 `[STRONG-INFERENCE]`

### R2.2 Background subagent continuity

round-2 facts: `/tasks` page + `list-pending-automation-run-threads` IPC. `[FACT]`

해석:
- background subagent의 continuity는 “queue에 들어가 있다 + UI에서 가시화된다”는 형태로 in-process child보다 약간 강할 가능성이 높다 `[STRONG-INFERENCE]`
- 다만 backend queue persistence (디스크에 어떻게 남는가)는 NON-CLAIM
- foreground subagent와 달리 background subagent는 parent loop가 `wait_agent`로 즉시 join하지 않으므로, “child packet → parent integration” shape가 다를 수 있다 `[STRONG-INFERENCE]`

### R2.3 Updated continuity ladder

§2 ladder에 round-2 추가:

| Continuity rail | Strength | Safe claim | Unsafe overclaim |
| --- | --- | --- | --- |
| child id / handle | medium | child can be referenced again until close | durable global agent registry |
| forked context | medium | some parent context can seed child | exact full memory graph copy |
| child final result | medium | child output can be reintegrated | full persistent work log |
| child after close | weak | maybe resumable only if explicitly supported | guaranteed durable child resurrection |
| background subagent queue entry (`/tasks`) | medium | UI-visible queue item until processed | durable proof substrate |
| external-agent session import (`external_agent_session_imports.json`) | medium | imported session lineage persists in JSON file | full session content embedded |

### R2.4 Relative strength updates

§2.1 table에 추가:

| Rail | Relative strength versus subagent context | Why |
| --- | --- | --- |
| `~/.codex/memories/` (git-versioned) | stronger | cross-thread durable memory substrate (round-2 confirmed) |
| `archived_sessions/*.jsonl` `turn_context` snapshot | stronger | turn-self-contained re-construction surface (round-2 confirmed) |
| `external_agent_session_imports.json` | similar | discrete import lineage rail, not continuous work log |

### R2.5 Updated non-claims

추가:
- whether background subagent queue items survive app restart
- whether `external_agent_session_imports.json` is append-only or rewritten
- whether imported external-agent sessions get a `turn_context` rail of their own
