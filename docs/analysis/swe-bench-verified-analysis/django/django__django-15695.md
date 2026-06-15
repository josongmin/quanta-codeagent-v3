---
instance_id: django__django-15695
repo: django/django
base_commit: 647480166bfe7532e8c471fef0146e3a17e6c0c9
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-05-16T07:58:51Z
fail_to_pass: 1
pass_to_pass: 123
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-15695

## 문제 요약
`RenameIndex()` 마이그레이션 연산이 unnamed index(`unique_together`로 자동 생성된, 이름을 명시하지 않은 인덱스)를 backward로 되돌린 뒤 다시 forward로 재적용하면 크래시한다. backward 시점에 인덱스 이름이 자동 생성 이름으로 복원되어야 하지만, ticket #27064의 설계상 "unnamed old index에 대한 backward는 noop"으로 처리되어 인덱스는 forward가 붙였던 새 이름(`new_pony_test_idx`)을 그대로 유지한다. 그 상태에서 forward를 재실행하면 PostgreSQL에서 `django.db.utils.ProgrammingError: relation "new_pony_test_idx" already exists`가 발생한다. 즉 apply/un-apply가 멱등(idempotent)하지 않다. hints는 backward noop이 "on purpose"임을 못 박고, 픽스가 backward가 아니라 다른 곳에서 충돌을 회피해야 함을 시사한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** problem_statement가 `RenameIndex`와 `tests/migrations/test_operations.py::test_rename_index_unnamed_index`를 직접 지목하므로 클래스까진 grep 한 방이다. 다만 "forward를 고칠지 backward를 고칠지"는 `database_forwards`/`database_backwards` 한 쌍을 읽고 데이터플로우(어느 쪽이 noop이라 상태가 어긋나는지)를 추적해야 결정되므로 L0(pinpoint)이 아니라 L1. 단일 파일(`models.py`) 단일 함수로 수렴한다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 보조).** 고칠 함수(`database_forwards`)는 비교적 명확하나, *무엇을 추가해야 멱등성이 보장되는지*는 기계적 템플릿이 아니라 불변식 추론으로 합성해야 한다: "old index의 현재 이름이 이미 new_name과 같으면 RENAME은 no-op이어야 한다"는 조건식(`old_index.name == self.new_name`)을 직접 도출해야 한다. 또한 backward noop이 의도된 설계(#27064)라는 **스펙을 hints/티켓에서 재구성**(S5)한 뒤라야, backward를 건드리는 과교정 대신 forward에 가드를 넣는 올바른 지점을 고를 수 있다. 후보 패치를 마구 만들어 테스트로 거르는 G&V가 아니라 "생각으로" 푸는 결함이므로 S2가 dominant.
- **K (Knowledge) = K-Domain.** django migrations operations의 forward/backward 의미론, state(`from_state`/`to_state`)와 `get_index_by_name`, named vs unnamed(`unique_together`-auto) index의 생명주기, `_create_index_name` 자동명명 규칙 등 프레임워크 내부 지식이 병목이다. 일반 파이썬 추론만으론 "왜 재적용이 충돌하는지" 인과를 못 세운다.
- **Primary = T-ConstraintReason.** 위치는 명확(L1)하나 난점이 "올바른 가드 조건식과 그 삽입 지점을 추론 합성"하는 데 있다. localize가 진짜 어려움인 T-DiffuseLoc도, 픽스가 자명한 T-DirectMap(S1)도 아니다 — None가드처럼 보이지만 실제로는 `old_index.name == self.new_name`이라는 도메인 불변식을 세워야 하는 semantic fix이므로 S2 → T-ConstraintReason.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 `15 min - 1 hour`(≈ T3 prior)다. 한 단계 올려 T4로 두는 근거:
- **patch scope는 작다(1파일·3줄 추가)** — 이 축만 보면 T2~T3. has-repro(티켓에 재현 diff + 네이티브 PostgreSQL 스택트레이스)도 easiness 신호.
- **그러나 K-Domain + S2가 티어를 끌어올린다.** migrations operation의 forward/backward 멱등성, named/unnamed index 생명주기를 이해해야 "재적용이 왜 충돌하는지"의 인과를 세울 수 있다. 일반 추론으로는 안 풀린다(K-Domain이 dominant bottleneck인 케이스는 루브릭상 T4).
- **regression-trap이 강하다.** PASS_TO_PASS가 123개로, 그중 `test_rename_index`, `test_rename_index_arguments`, `test_rename_index_state_forwards_unnamed_index`, `test_rename_index_unknown_unnamed_index` 등 RenameIndex 인접 동작이 다수 포함된다. 가드를 너무 넓게 잡거나 backward를 손대면 정상 rename 경로가 깨진다.
- **underspecified 함정.** hints가 backward noop을 "on purpose"라 못 박지만 *어디를* 고쳐야 하는지는 명시하지 않아, backward를 고치려는 잘못된 방향으로 빠지기 쉽다.

공식 라벨(개발자 구현시간)은 "정답 위치를 안다는 전제의 구현 시간"이라 도메인 추론·과교정 위험·넓은 P2P trap을 반영하지 못한다. 그래서 구조적 피처 기준으로는 T3가 아니라 T4가 방어 가능하다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/migrations/operations/models.py` → `RenameIndex.database_forwards`.
- **근본 원인:** unnamed old index에 대한 `database_backwards`는 ticket #27064 설계상 noop이다(이름을 자동명으로 되돌리지 않음). 따라서 한 번 forward로 `new_name`이 붙은 인덱스는 backward 후에도 `new_name`을 유지한다. `database_forwards`는 `from_state`/`to_state`에서 `old_index`/`new_index`를 가져온 뒤 *무조건* `schema_editor.rename_index(...)`를 호출하므로, 현재 인덱스 이름이 이미 `self.new_name`과 같은데도 `RENAME INDEX old TO new` SQL을 만들어 "relation already exists" 충돌을 일으킨다. 즉 forward가 멱등하지 않다.
- **수정 요지:** `old_index`를 named/unnamed 양쪽 분기에서 확정한 직후, 가드를 삽입한다.
  ```python
  # Don't alter when the index name is not changed.
  if old_index.name == self.new_name:
      return
  ```
  이름이 실제로 바뀌지 않는 경우 alter 자체를 건너뛰어(early-return) 연산을 멱등하게 만든다. backward 설계(noop)는 그대로 두고 forward에서 충돌만 회피하는 최소 변경(3줄 추가, 정상 rename 경로는 불변).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_rename_index_unnamed_index (migrations.test_operations.OperationTests)`. test_patch는 기존 forward→backward(`assertNumQueries(0)`로 backward가 noop임을 확인) 시퀀스 뒤에 `database_forwards`를 **한 번 더** 호출하고(`# Reapply, RenameIndex operation is a noop when the old and new name match.`), 그 후 `assertIndexNameExists(table_name, "new_pony_test_idx")`로 인덱스가 정상 존재함을 단언한다.
- **픽스 증명:** 가드가 없으면 두 번째 `database_forwards`가 `RENAME INDEX ... TO new_pony_test_idx`를 발행 → "relation already exists"로 크래시. 가드가 있으면 `old_index.name == self.new_name`이 참이라 early-return하여 SQL을 발행하지 않고 인덱스 이름이 유지된다. 따라서 가드 삽입이 통과의 필요조건.
- **overfit 관점:** F2P가 단 1개라 표면상 얇아 보이나, 가드 조건이 인덱스 이름 동일성이라는 일반 불변식이고 special-case 상수가 아니므로 CEGIS(S4)식 overfit과는 거리가 있다. 다만 "이 특정 테스트만 통과시키려 더 좁은 조건(예: unnamed 분기에서만 return)"을 넣으면 named 재적용 시 같은 충돌을 놓칠 수 있다 — 골드처럼 양쪽 분기 공통 지점에 두는 것이 올바른 일반화.
- **regression 관점:** P2P 123개, 특히 `test_rename_index`, `test_rename_index_arguments`, `test_rename_index_state_forwards`, `test_rename_index_state_forwards_unnamed_index`, `test_rename_index_unknown_unnamed_index`가 정상 rename(이름이 실제로 바뀌는 경우)을 지킨다. 가드는 `old_index.name != self.new_name`인 정상 케이스에선 절대 발동하지 않으므로 이들을 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 `RenameIndex`와 `tests/migrations/test_operations.py::test_rename_index_unnamed_index`, 그리고 "re-applying ... crashes / relation already exists"라는 네이티브 신호로 `django/db/migrations/operations/models.py`의 `RenameIndex` 클래스에 직행한다. `database_forwards`와 `database_backwards`를 한 쌍으로 읽고, hints의 "backward는 unnamed old index에서 noop(#27064, on purpose)"을 근거로 *상태 불일치의 발생원은 backward의 의도된 noop이고, 충돌은 forward 재적용에서 터진다*는 데이터플로우를 세운다.
2. **픽스 & 왜 올바른 일반화인가:** `database_forwards`에서 `old_index`를 named/unnamed 양쪽 분기로 확정한 직후 `if old_index.name == self.new_name: return` 가드를 추가. 이는 "rename의 source 이름이 이미 target과 같으면 rename은 정의상 no-op"이라는 보편 불변식이라 idempotency를 일반적으로 보장한다. backward 설계를 건드리지 않으므로 #27064의 "unnamed→named 유지" 의도를 지키면서 충돌만 제거한다.
3. **regression 안전:** 가드는 `old_index.name == self.new_name`일 때만 발동한다. 정상 rename(이름이 실제 변경)에선 조건이 거짓이라 기존 `rename_index` 경로가 그대로 실행된다 — `test_rename_index`/`test_rename_index_arguments`/`test_rename_index_state_forwards*` 등 P2P를 안 깬다. `database_backwards`를 미변경으로 두는 것이 `assertNumQueries(0)`(backward noop) 계열 P2P 보존의 핵심.
4. **함정 회피:** 오라클 없는 에이전트가 틀리는 지점 — (a) hints의 "backward noop"을 "backward가 버그"로 오독해 backward에서 자동명 복원을 구현하는 **과교정**(#27064 의도 위반 + P2P 깨짐). (b) 가드를 unnamed 분기 *안*에만 넣어 named 재적용 충돌을 놓치는 **과소 일반화**. (c) 실제 DB를 띄우지 않으면 "already exists" 충돌이 재현되지 않아 멱등 시나리오 자체를 인지 못함(has-repro 신호를 실행으로 살려야 함). 정답은 `old_index`가 양쪽 분기에서 확정된 *공통 지점*에 단일 가드를 두고 backward는 손대지 않는 것.
