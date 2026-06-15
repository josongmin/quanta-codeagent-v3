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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-11179

## 문제 요약
의존관계(외래키 역참조 등)가 전혀 없는 모델 인스턴스에 `.delete()`를 호출하면 DB row는 지워지지만 인스턴스의 PK 속성이 갱신되지 않고 기존 값 그대로 남는다. 사용자는 삭제 후 PK가 `None`이 되기를 기대하며, 실제로 다중 객체 삭제 경로에서는 이미 그렇게 동작한다. 즉 fast-delete 단축 경로에서만 PK 클리어가 누락된 회귀(regression) 버그다. problem_statement는 `Django.db.models.deletion:276-281`, "Should update the model line 280"으로 파일·라인을 직접 지목하고, hints_text는 회귀 커밋(`bc7dd8490b`)과 다중객체 경로의 미러링 위치(L324-326)까지 명시한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈가 `deletion.py:276-281`과 "line 280"을 직접 지목. grep도 필요 없이 파일·라인이 손에 쥐어진 상태. 가장 강한 localize 신호.
- **S1 (Direct-Map)** — 정형 결함클래스 "단축경로가 공통 후처리를 누락" 패턴. 픽스는 누락된 한 줄(상태 reset) 추가로 기계적이며, hints가 다중객체 경로(L324-326)를 그대로 미러링하라고 사실상 픽스를 명세한다. 후보 탐색·테스트 반복(S3) 없이 한 줄을 알맞은 위치에 넣으면 끝.
- **K-Domain** — 픽스 자체는 한 줄이지만 *왜 attname을 쓰는가*, *왜 field_updates 블록은 옮길 필요 없는가*는 django Collector의 `collect`/`can_fast_delete`/`field_updates` 내부 동작과 `model._meta.pk.attname` API를 알아야 정확히 판단된다. 일반 파이썬 추론(K-Gen)만으로는 과잉/과소 수정 위험.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 S1 기계적(공통 후처리 누락 → 상태 reset 한 줄 추가)이라 정의에 정확히 맞는다. T-LocTrivial이 아닌 이유는 픽스의 *올바른 형태*(attname 패턴, field_updates 제외 판단)에 K-Domain 지식이 개입하기 때문이다.
- **repair strategy 근거(APR 관점)** — 이건 SemFix류 식 합성(S2)도, Generate-&-Validate 후보탐색(S3/S4)도 아니다. 결함은 "두 코드경로(fast vs slow)의 사후처리 비대칭"이라는 PAR/TBar류 fix-pattern으로, 정답 경로가 이미 코드베이스 안(L324-326)에 존재하고 그걸 fast 경로로 복제하는 template-transfer다. 따라서 dominant strategy는 S1.

## 난이도 티어
**T2 (쉬움)**. 공식 라벨 "<15 min fix"(T1성)와 거의 일치하나 T1이 아닌 T2로 한 칸 올린다.
- **T1로 보이는 피처**: 1파일·1줄 추가, has-repro(회귀 커밋·재현 SHA 명시), problem_statement가 파일·라인을 직접 지목(L0). 이슈가 픽스를 거의 적어줌.
- **T2로 미는 피처**: (1) K-Domain — `instance.pk = None`이라는 순진한 한 줄도 테스트는 통과시키지만, 골드는 `model._meta.pk.attname`을 거쳐 다중경로와 동일 패턴을 쓴다. 올바른 일반화에 Collector 내부지식이 필요. (2) **regression-trap** — PASS_TO_PASS 40개가 fast-delete/cascade/setnull/inheritance 전반의 삭제 동작을 커버. `return` 직전이라는 위치를 한 칸이라도 틀리면(예: `with transaction.mark_for_rollback_on_error()` 블록 안/밖, return 뒤) 동작이 깨지거나 무효가 된다. (3) hints가 "field_updates 블록도 옮길까?"를 던져 과잉 수정 유혹(over-edit)을 심는다 — 정답은 옮기지 않는 것이라 판단에 도메인 추론이 든다.
- 결론: localize·픽스 형태 자체는 trivial하지만 "올바른 한 줄"을 고르는 데 약한 도메인 추론 + 넓은 P2P를 안 깨는 정확한 위치 선정이 필요해 T2.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/deletion.py` → `Collector.delete()`의 fast-delete 분기(`if self.can_fast_delete(instance):` 블록 내부, L277 부근).
- **근본 원인**: `delete()`의 `can_fast_delete(instance)` 단축 경로는 `sql.DeleteQuery(model).delete_batch([instance.pk], self.using)`로 row만 지우고 즉시 `return count, {model._meta.label: count}` 한다. 일반(다중) 경로 끝에서 수행하는 "삭제된 인스턴스의 PK를 None으로 세팅"하는 후처리(L320-326의 패턴)를 fast 경로가 건너뛴다. 이 비대칭은 회귀 커밋 `bc7dd8490b`에서 fast-delete 단축이 도입되며 생겼다.
- **수정 요지**: fast-delete 분기에서 `delete_batch` 직후, `return` 전에 한 줄 추가 —
  `setattr(instance, model._meta.pk.attname, None)`.
  PK 필드의 attname을 통해 인스턴스 속성을 `None`으로 설정해 다중객체 경로와 동작을 일치시킨다. 위치가 `with transaction.mark_for_rollback_on_error():` 블록 밖(이미 delete 완료 후), `return` 직전이라는 점이 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_fast_delete_instance_set_pk_none (delete.tests.FastDeleteTests)`. (frontmatter fail_to_pass=1, JSON 배열 길이와 일치)
- **동작/픽스 증명**: 테스트는 `User.objects.create()`로 의존관계 없는 인스턴스를 만들고, `Collector(using='default').can_fast_delete(u)`가 `True`임을 `assertTrue`로 먼저 고정한다 — 즉 이 객체가 실제로 fast-delete 경로를 탄다는 전제를 못박는다(단순 delete 테스트가 아님을 증명). 이어 `u.delete()` 후 `self.assertIsNone(u.pk)`로 PK 클리어를 확인. 픽스 없으면 `u.pk`가 생성 시 받은 정수 값 그대로 남아 실패한다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, `can_fast_delete==True` 단언이 테스트를 fast 경로에 정확히 고정하므로 "엉뚱한 곳에 pk=None을 넣어 우연히 통과"하는 special-case 통과 여지가 작다. 다만 일반(slow) 경로의 PK reset은 이 테스트가 직접 커버하지 않으므로(P2P가 간접 보장) overfit 위험이 0은 아님 → `regression-trap`이 진짜 안전망.
- **regression 관점**: PASS_TO_PASS 40개(frontmatter pass_to_pass=40, JSON 배열 길이와 일치)가 fast_delete_fk/m2m/qs/inheritance/large_batch, cascade·setnull·setdefault·protect, bulk·large_delete·instance_update 등 삭제 전반을 커버. 추가 한 줄이 `return` 전·트랜잭션 밖이라 row 삭제 결과(count, return 형태)에 영향 없음을 이들이 보장.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 `Django.db.models.deletion:276-281` + "Should update the model line 280" → 곧장 `deletion.py`의 `Collector.delete()`를 연다. fast-delete `if self.can_fast_delete(instance):` 블록의 `return`과, 함수 아래쪽 일반 경로 마무리(`for ... field_updates` / PK reset 루프, L320-326)를 나란히 비교하면 "fast 경로만 PK reset이 없다"는 비대칭이 즉시 드러난다. hints가 미러링 대상 라인까지 줘서 grep 1방 수준.
2. **픽스와 일반화 정당성**: fast 분기 `return` 직전에 `setattr(instance, model._meta.pk.attname, None)` 한 줄. `instance.pk = None`이 아니라 `_meta.pk.attname`을 쓰는 이유 — PK가 `id`가 아닌 커스텀/상속 PK일 때도 실제 attribute 이름으로 정확히 세팅되며, 이는 다중객체 경로가 이미 쓰는 동일 패턴이다. 즉 한 객체 특수 케이스가 아니라 "삭제된 인스턴스는 PK가 None"이라는 불변식을 두 경로에 통일하는 올바른 일반화다(overfit 아님).
3. **regression 안전**: 추가 줄을 `with transaction.mark_for_rollback_on_error():` 블록 *밖*, `return` *앞*에 둬서 DB 삭제 자체와 반환값(`count`, `{label: count}`)에 영향 없게 한다. 이로써 P2P 40개의 fast/slow/cascade/setnull/large_batch 동작이 그대로 보존된다. 트랜잭션 블록 안에 넣거나 return 뒤(도달 불가)에 두면 깨진다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 일반 `delete()` 끝부분만 보고 fast 경로를 놓쳐 "이미 reset 있는데?"라 오판(no-op 패치). → `can_fast_delete` 단축 경로의 별도 `return`을 반드시 확인. (b) hints의 "field_updates 블록도 옮길까?" 유혹에 넘어가 L320-323까지 함수로 추출·복제(과잉 수정). → fast-delete 객체는 `collect`를 거치지 않아 `field_updates`가 비어 있으므로 PK reset 한 줄로 충분하다는 도메인 판단으로 회피. (c) `instance.pk = None`으로 적당히 통과시키되 attname 패턴 불일치 → 다중경로와 동일하게 `model._meta.pk.attname` 사용.
