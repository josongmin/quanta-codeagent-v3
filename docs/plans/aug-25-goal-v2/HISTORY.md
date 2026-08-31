# Goal v2 — 역사 기록

> 이 문서는 archival record다. 현재 상태나 실행 순서를 판단하는 데 사용하지 않는다.
> 현재 요약은 [`README.md`](README.md), 남은 작업은 [`NEXT-PLAN.md`](NEXT-PLAN.md)를 사용한다.

## 2026-08-25 착수 기준

- 최초 기준은 `main` `1624c7ce707ed757e76936878cbca9609dc6abc0`과 staged goal slice였다.
- 계획은 GOAL-00부터 GOAL-10까지 공유 owner를 직렬로 수정하는 main-direct 흐름이었다.
- 당시 확인된 주요 결함은 judge unavailable admission, manual criterion 우회, polling ticker,
  verifier 실행 경로 부재, self-reported budget, receipt ordering, web attach no-clobber,
  불완전한 `/goal` facade, live plan mode 부재, blocker prompt-only hysteresis였다.
- 이 결함 목록은 착수 전 baseline이며 현재 코드 설명이 아니다.

## 원래 실행 순서

```text
GOAL-00 baseline/index isolation
  -> GOAL-01 domain v2
  -> GOAL-02 authority/completion policy
  -> GOAL-03 verifier runtime
  -> GOAL-04 turn settlement
  -> GOAL-05 CLI facade
  -> GOAL-06 bounded wake
  -> GOAL-07 attach transaction
  -> GOAL-08 web submit/control
  -> GOAL-09 blocker hysteresis
  -> GOAL-10 evidence/catalog/promotion
```

당시 공유 owner가 많아 병렬 수정을 금지했다. 각 티켓의 상세 write set, RED rail, 중단 조건은
[`tickets/`](tickets/)에 남아 있다.

## 실행 변천

- 2026-08-25~26: domain/policy/verifier/settlement/CLI/wake/web/blocker/evidence 티켓이 순차 진행됐다.
- 2026-08-27: goal lane들이 merge `9b21d2fd2`로 합쳐졌고, hard cap·wake fence·PTY 관련
  후속 remediation이 진행됐다.
- 2026-08-27: `QUANTA_GOAL` default ON, `QUANTA_GOAL=0` public opt-out으로 promotion됐다.
- 2026-08-27~29: attach, web attribution, blocker, browser controls의 audit와 mutation rail 보강이
  여러 차례 추가됐다.
- 2026-08-30: 계획 티켓을 당시 코드에 재대조하면서 명세와 실제 구현 이름/구조의 차이를 기록했다.
- 2026-08-31: production owner와 consumer를 다시 대조해 이미 완료된 항목과 실제 잔여 작업을
  분리하고 current plan을 `NEXT-PLAN.md`로 단일화했다.

## 역사 자료 해석 규칙

- [`tickets/`](tickets/)는 구현 전 의도와 당시 acceptance contract다. 현행 API 명세가 아니다.
- [`receipts/`](receipts/)와 [`GOAL-10-RECEIPT.md`](GOAL-10-RECEIPT.md)는 기록 당시 SHA의
  실행 증거다. 현재 HEAD의 green receipt가 아니다.
- `receipts/*.yaml`은 legacy YAML-shaped 자유서술 기록이다. generic YAML parser 계약이 아니며
  10개 중 8개는 기존 장문 scalar의 콜론 때문에 parser-clean하지 않다. 새 자동화의 입력으로 쓰지 않는다.
- receipt의 test count, 파일 경로, 미완료 설명은 후속 commit으로 바뀔 수 있다.
- 역사 자료와 현재 문서가 충돌하면 현재 소스와 owner-local test, `NEXT-PLAN.md`, `README.md`
  순으로 판단한다.
- 상세 commit lineage와 삭제된 과거 README 내용은 Git history에서 보존된다. 역사 보존을 위해
  오래된 결함 표를 current README에 중복 게시하지 않는다.
