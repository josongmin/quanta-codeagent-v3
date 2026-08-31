# R8 — Headless/batch autonomous pursuit deliberate hold

**Status:** DELIBERATE HOLD · **Priority:** none until product decision
· **Owner:** product surface semantics

## 판정

이 항목은 현재 Goal v2 완료의 미구현 blocker가 아니다.

- interactive CLI와 web daemon만 `startGoalWakeController()` production caller다.
- headless preset은 one-shot/single trajectory/ephemeral output contract다.
- batch preset은 corpus verdict, per-instance sandbox/budget, external aggregation이 owner다.
- objective authority가 config에 존재할 수 있다는 사실은 autonomous scheduler 요구를 의미하지 않는다.

## 확정 제외

### Batch

autonomous wake를 추가하지 않는다. bench driver가 이미 per-instance termination/verdict를 소유하며 Goal
wake를 섞으면 benchmark turn/budget/trajectory 의미가 바뀐다. Batch에서 Goal metadata가 필요하면
관측/보고 projection으로 별도 설계하고 scheduler를 재사용하지 않는다.

### Headless

현재 one-shot 의미를 유지한다. “초기 prompt 이후 durable goal을 여러 turn/session에 걸쳐 계속 추구”가
제품 요구로 승인될 때만 별도 persistent goal-runner mode를 설계한다. 기존 interactive external prompt
queue를 headless에 연결하지 않는다.

## Promotion 질문

다음 질문에 명시적 답이 모두 생기기 전에는 구현하지 않는다.

1. process 종료 후 누가 goal lifecycle을 소유하는가?
2. stdout text/json/stream-json 계약에서 autonomous 후속 turn을 어떻게 표현하는가?
3. restart/resume identity와 persistence target은 무엇인가?
4. approval/user input이 필요한 경우 어떤 host policy가 중단/재개하는가?
5. wall/token/turn budget과 cancellation은 어느 front door가 소유하는가?

## 승인 후 필요한 계약

- headless 전용 host-owned dispatch/admission port
- durable session/objective restore
- explicit cancellation and approval policy
- output protocol versioning
- bounded pursuit E2E and crash/restart receipt

## DoD

현재 DoD는 구현이 아니라 다음이다.

- README/NEXT-PLAN/catalog가 headless/batch pursuit를 지원한다고 주장하지 않는다.
- feature catalog에 deliberate hold reason/promotion path가 기록된다.
- CLI/web Goal completion과 이 hold가 분리돼 있다.

## 중단 조건

- interactive prompt queue를 headless/batch에 그대로 재사용하는 경우.
- batch benchmark termination owner와 Goal wake owner를 병렬로 두는 경우.
- 제품 요구 없이 mode 목록을 늘리고 이를 parity로 보고하는 경우.
