---
instance_id: django__django-11179
repo: django/django
base_commit: 19fc6376ce67d01ca37a91ef2f55ef769f50513a
version: 3.0
difficulty: <15 min fix
created_at: 2019-04-05T15:54:39Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [django/db/models/deletion.py]
---

# django__django-11179

## 문제 요약
의존관계(외래키 참조 등)가 전혀 없는 모델 인스턴스에 대해 `.delete()`를 호출하면, DB row는 지워지지만 인스턴스의 PK 속성이 갱신되지 않고 기존 값 그대로 남는다. 사용자는 삭제 후 인스턴스의 PK가 `None`이 되기를 기대한다(이미 다중 객체 삭제 경로에서는 그렇게 동작함). 즉 fast-delete 경로에서만 PK 클리어가 누락된 회귀(regression) 버그다.

## 유형 분류
- 버그 카테고리: 누락처리 (fast-delete 경로에서 PK reset 로직 누락) / regression
- 서브시스템: django ORM — 모델 삭제(Collector, `django.db.models.deletion`)
- 증상 타입: silent-wrong (예외 없이 인스턴스 상태가 잘못 남음)
- 로컬라이제이션 신호: problem_statement가 `Django.db.models.deletion:276-281`, "Should update the model line 280"으로 파일·라인을 직접 지목. hints_text는 회귀 커밋(bc7dd8490b)과 다중객체 경로 L324-326을 미러링하라고 명시 — 사실상 정답 위치를 손에 쥐어줌.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/deletion.py` : `Collector.delete()` (fast-delete 분기 내부)
- 근본 원인: `delete()` 안의 `can_fast_delete(instance)` 단축 경로는 `sql.DeleteQuery(...).delete_batch(...)`로 row만 지우고 곧장 `return`한다. 일반(다중) 경로 끝(L320-326)에서 수행하는 "삭제된 인스턴스의 PK를 None으로 세팅"하는 후처리를 fast 경로는 건너뛴다.
- 수정 요지: fast-delete 분기에서 `delete_batch` 직후, `return` 전에 한 줄 추가 — `setattr(instance, model._meta.pk.attname, None)`. PK 필드의 attname을 통해 인스턴스 속성을 `None`으로 설정해 다중 객체 경로와 동작을 일치시킨다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_fast_delete_instance_set_pk_none` (delete.tests.FastDeleteTests)
- 증명 방식: `User.objects.create()`로 의존관계 없는 인스턴스 생성 → `Collector(using='default').can_fast_delete(u)`가 `True`임을 단언해 이 객체가 실제로 fast-delete 경로를 탄다는 전제를 고정 → `u.delete()` 호출 후 `self.assertIsNone(u.pk)`로 PK가 None으로 클리어됐는지 확인. 픽스 없으면 `u.pk`가 옛 값으로 남아 실패.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·라인을 직접 주므로 `deletion.py`의 `Collector.delete()`만 열면 된다. fast-delete `return` 직전과 일반 경로 마무리(`field_updates`/PK reset 루프)를 비교하면 누락이 즉시 보인다.
- 함정/난이도: PK 속성 세팅은 `model._meta.pk.attname`을 써야 함 — `instance.pk = None`도 동작하지만 골드는 다중 경로와 동일한 attname 패턴을 사용. hints가 "field_updates 블록도 옮길까?" 고민하지만 fast-delete 객체는 collect를 거치지 않아 field_updates가 비어 있으므로 PK reset 한 줄로 충분(과잉 수정 주의). 단일 파일·단일 라인.
- 우리 에이전트 관점: 난이도 낮음. 위험은 (1) fast 경로를 못 찾고 일반 `delete()` 끝부분만 보는 오진, (2) attname 대신 다른 방식으로 세팅해 일관성 라쳇/스타일이 어긋나는 정도. PASS_TO_PASS 40개(기존 fast-delete/cascade 동작)를 깨지 않도록 `return` 전 위치를 정확히 잡는 게 핵심.
