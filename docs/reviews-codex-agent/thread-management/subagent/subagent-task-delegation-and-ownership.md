# Subagent Task Delegation And Ownership

Overview router: [subagent-management-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/subagent/subagent-management-audit.md)

## 1. Direct rules

직접 보이는 rule은 이거다.

1. explicit user permission 필요
2. urgent blocking task는 main에서 처리
3. sidecar task만 병렬 분리
4. write ownership은 disjoint해야 함
5. child가 다른 사람/다른 worker의 변경을 revert하면 안 됨

이건 heuristic이 아니라 visible policy surface다.

## 2. Best-fit split model

```mermaid
flowchart TD
    A["Task queue"] --> B["Critical path item"]
    A --> C["Sidecar item"]
    B --> D["Main thread keeps ownership"]
    C --> E["Spawn child only if disjoint"]
    E --> F["Integrate when useful"]
```

## 2.1 Spawn versus no-spawn matrix

| Condition | Spawn bias |
| --- | --- |
| child result is not an immediate blocker | pro-spawn |
| child write set is disjoint | pro-spawn |
| task is read-only and bounded | pro-spawn |
| parent next step depends on the answer now | anti-spawn |
| ownership is fuzzy | anti-spawn |
| merge contract is unclear | anti-spawn |

## 3. Good split versus bad split

| Split type | Good or bad | Why |
| --- | --- | --- |
| read-only repo question in parallel | good | main can continue independently |
| bounded code edit on disjoint files | good | ownership is clear |
| immediate blocker needed for next line of work | bad | parent stalls waiting |
| same module edited by parent and child | bad | merge and ownership conflict |
| duplicated grep/read done by both parent and child | bad | waste and context drift |

## 4. What the child should own

best-fit ownership packet:

```text
OwnershipBoundary {
  owned_files,
  owned_modules,
  read_only_surfaces,
  forbidden_surfaces,
  expected_output,
  merge_contract
}
```

parent는 최소한 이 다섯 개를 명확히 해야 한다.

1. child objective
2. owned write set
3. no-touch surfaces
4. expected output shape
5. merge point

## 4.1 Ownership examples

| Example | Good boundary? | Why |
| --- | --- | --- |
| `docs/analysis/codex-agent/thread-management/subagent/*.md` only | good | file scope is explicit |
| `parser owner file` while parent edits same owner | bad | same write surface |
| `test-only sidecar` while parent changes implementation | maybe | only if tests and impl are truly disjoint and merge contract is clear |
| repo-wide grep summary with no owner narrowing | bad | bounded ownership보다 broad search noise가 큼 |

## 5. Main-thread discipline

parent가 유지해야 하는 것:
- critical path ownership
- final source-of-truth reread
- integration authority
- closeout wording

child에 넘기면 안 되는 것:
- final defended claim selection
- overlapping write ownership
- unbounded broad refactor
- speculative architecture rewrite

## 5.1 Integration contract

parent는 child spawn 전에 integration contract를 정해두는 게 맞다. `[STRONG-INFERENCE]`

```text
IntegrationContract {
  expected_return_shape,
  whether_live_reread_is_mandatory,
  merge_owner,
  closeout_owner,
  escalation_rule_if_child_finds_conflict
}
```

이 contract가 없으면 child result를 받아도 parent가 다시 넓게 읽느라 병렬 이득이 줄어든다.

## 6. Failure modes

| Failure mode | Symptom | Correction |
| --- | --- | --- |
| child gets blocking work | parent waits immediately | keep blocker local |
| ownership unclear | merge conflict or revert risk | tighten owned file/module list |
| child output over-trusted | stale result beats fresh source | reread live source before closeout |
| too many children | thread/attention overhead | keep lane count bounded |
| parent duplicates child work | no real parallel win | narrow child objective |

## 7. Stop rule

subagent를 써도 merge authority는 parent에 남아야 한다. `[STRONG-INFERENCE]`

즉 closeout 전 최종 판정은:
- child result 수령
- live source reread if needed
- parent-side defended claim filtering

순서로 닫는 것이 맞다.

## 7.1 Parent-side final arbitration

child가 무언가를 결론냈더라도 마지막 승자는 parent-side fresh evidence다.

우선순위:
1. fresh local source
2. runtime/build/test output if relevant
3. child packet
4. older docs or memory

즉 child result는 strong hint일 수는 있어도 final authority는 아니다.
