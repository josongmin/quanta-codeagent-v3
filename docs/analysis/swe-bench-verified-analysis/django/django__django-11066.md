---
instance_id: django__django-11066
repo: django/django
base_commit: 4b45b6c8e4d7c9701a332e80d3b1c84209dc36e2
version: 3.0
difficulty: <15 min fix
created_at: 2019-03-09T13:03:14Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [django/contrib/contenttypes/management/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11066

## 문제 요약
`RenameModel` 마이그레이션을 default가 아닌 다른 데이터베이스(`migrate --database other`)에 대해 실행하면, content type rename 과정에서 `no such table: django_content_types` 같은 OperationalError가 발생한다. `RenameContentType._rename()`이 `transaction.atomic(using=db)`로 감싸긴 했지만 실제 `content_type.save()` 호출은 `using`을 받지 않아, DB 라우터(`db_for_write`)나 default DB로 쿼리가 흘러가 잘못된 DB에 저장을 시도한다. 사용자가 기대한 동작은 `schema_editor.connection.alias`(= 마이그레이션이 실제로 도는 `db`)에 저장되는 것이다. problem_statement에 파일·라인·코드 스니펫뿐 아니라 정확한 fix(`save(using=db, ...)`)까지 제안되어 있다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement가 파일(`django/contrib/contenttypes/management/__init__.py`), 라인(L27), 함수(`_rename`), 심볼(`content_type.save(update_fields={'model'})`)을 직접 지목한다. grep 한 방, 탐색 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 Constraint-Reasoning)** — 픽스가 이슈에 그대로 명세되어 있다: 누락된 kwarg 추가(`using=db`)라는 정형 결함클래스(missing-routing-arg)에 기계적으로 매칭. 다만 "왜 `transaction.atomic(using=db)`가 있는데도 라우팅이 안 되는가"를 이해하려면 atomic의 `using`(트랜잭션 connection 선택)과 `save(using)`(query routing skip)의 의미 차이를 추론해야 하므로 보조로 S2가 붙는다. dominant는 명백히 S1 — 이슈가 답을 적어줬다.
- **K (Knowledge) = K-Domain** — 일반 파이썬 추론으로는 "atomic이 DB를 지정했으니 save도 따라갈 것"이라는 오판에 빠진다. Django 멀티-DB 의미론(atomic.using ≠ query routing; save(using)이 라우터를 skip한다)이라는 프레임워크 내부 지식이 픽스의 정당성·테스트 설계의 핵심이다. hints의 StackOverflow 논쟁도 정확히 이 지점에서 헤맸다.

**Primary type = T-DirectMap** — 위치가 L0로 명확하고 픽스가 S1 기계적(누락 kwarg 추가)이다. T-LocTrivial이 아닌 이유: 픽스 자체는 자명하나 "왜 옳은가"가 도메인 의미론에 묶여 있어 완전 trivial은 아니다. T-DomainBound이 dominant가 아닌 이유: 도메인 지식이 병목이라기보다 *검증·이해*에만 필요하고, 코드 변경의 도출은 이슈가 직접 명세해 기계적이다.

## 난이도 티어

**Tier = T2 (쉬움)**

이 티어로 미는 구조적 피처:
- **파일수 1 / 변경 라인 1** — gold patch는 단일 파일·단일 헌크·한 토큰 추가(`using=db, `). ICLR 2024 컷에서 1파일·<5줄은 최고 solve 구간.
- **localize 직접성 L0** — 이슈가 파일·라인·심볼·수정안까지 지목. localization 실패 확률 거의 0 (전체 실패의 ~51%가 localize 에러인데 여기선 해당 없음).
- **has-repro** — problem_statement에 재현 시나리오와 native error(OperationalError: no such table)가 명시되어 있어 가장 강한 easiness 신호(해결률 ~87%).
- 티어를 T1에서 *끌어올리는* 요소: (a) K-Domain — atomic.using vs save(using) 구분이 없으면 "이미 DB 지정됨"이라 오판해 fix를 건너뛸 수 있다(개념적 함정). (b) **regression-trap** — P2P 3개(`test_content_type_rename_conflict`, `test_existing_content_type_rename`, `test_missing_content_type_rename_ignore`)가 default-DB rename 경로의 정상·conflict·missing 케이스를 커버하므로, fix가 default-DB(single-db) 동작을 깨면 안 된다.

**공식 라벨(`<15 min fix`)과의 일치/차이**: 공식 시간라벨 prior와 정합(개발자 입장 한 줄 수정). 다만 시간라벨은 "개발자가 답을 알 때의 구현시간"이라 도메인 함정(atomic.using 착각)을 반영 못 한다. 에이전트 관점에선 이 개념 함정 + 테스트에 의도적으로 잘못된 라우터를 꽂아야 한다는 점 때문에 순수 T1보다 살짝 위인 T2가 방어 가능하다.

## 골드패치 분석

- **건드린 파일/함수**: `django/contrib/contenttypes/management/__init__.py` : `RenameContentType._rename()`
- **근본 원인**: `transaction.atomic(using=db)`는 트랜잭션을 *어느 connection에 열지*만 정할 뿐, 그 블록 내부 ORM 쿼리를 그 DB로 라우팅하지 않는다. `content_type.save()`에 `using`을 주지 않으면 Django ORM이 DB 라우터(`db_for_write`) 또는 default를 거쳐 alias를 결정하므로, 정작 마이그레이션이 도는 `db`(= `schema_editor.connection.alias`)가 아닌 곳에 저장을 시도한다 → 그 DB에 테이블이 없으면 OperationalError.
- **수정 요지**: `content_type.save(update_fields={'model'})` → `content_type.save(using=db, update_fields={'model'})`. `save(using=...)`는 라우터를 *skip*하고 지정 alias에 직접 쓰므로, 트랜잭션 connection과 쿼리 라우팅 대상이 일치하게 된다. 단일 토큰 추가.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_existing_content_type_rename_other_database`
  - 동작: `databases = {'default', 'other'}`를 활성화하고, `db_for_write`가 *항상 'default'*를 반환하는 내부 `TestRouter`를 `@override_settings(DATABASE_ROUTERS=[TestRouter()])`로 주입한다. `'other'` DB에 model='foo' content type을 만든 뒤 `call_command('migrate', 'contenttypes_tests', database='other')`로 RenameModel을 실행 → 'other'에서 foo→renamedfoo로 바뀌는지 검증하고, `migrate ... 'zero'`로 역방향 롤백까지 확인.
- **픽스 증명 메커니즘**: 라우터가 일부러 *엉뚱한* DB('default')를 가리키게 해 두었으므로, fix 전이면 `save()`가 라우터 따라 'default'로 가서 'other'의 content type이 안 바뀌어 `assertTrue(...filter(model='renamedfoo').exists())`가 실패한다. `using=db`가 들어가면 라우터를 무시('other'로 직접 저장)해 통과 — 즉 routing-skip을 강제로 관찰하는 설계. 이것이 red-on-injection을 보장하는 핵심이다(라우터가 정상 DB를 가리켰다면 vacuous하게 통과할 수도 있었음).
- **overfit 관점**: FAIL_TO_PASS는 1개로 얇지만, 라우터를 의도적으로 잘못 꽂아 special-case 통과를 차단했다. `using=db`보다 좁은 수정(예: 라우터 우회를 다른 곳에 하드코딩)으로는 양방향(rename + zero 롤백) + 라우터-무시를 동시에 만족하기 어려워 overfit 위험은 낮다. 다만 더 넓은 입력공간(여러 DB alias, 실제 라우터 변형)은 미검증.
- **regression 관점**: P2P 3개가 default-DB 경로(정상 rename / conflict fallback / missing 무시)를 지킨다. `using=db`는 single-db에서도 alias가 그대로 'default'이므로 기존 동작과 byte-equivalent — regression-trap을 통과한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 파일·라인·심볼·수정안을 직접 박아준다 → `django/contrib/contenttypes/management/__init__.py`의 `RenameContentType._rename()` 안 `content_type.save(update_fields={'model'})` 호출 한 곳으로 즉시 수렴. 탐색 비용 0(L0).
2. **픽스와 일반화 정당성**: `save()`에 `using=db`를 추가한다(`db = schema_editor.connection.alias`). 이것이 overfit이 아닌 올바른 일반화인 이유 — 버그의 근본은 "트랜잭션 connection과 쿼리 라우팅 대상의 불일치"이고, `save(using=db)`는 *모든* multi-db/router 구성에서 쿼리를 마이그레이션 대상 DB로 고정한다(테스트의 특정 라우터에만 맞춘 우회가 아님). atomic의 `using`을 건드리거나 라우터를 패치하는 대안은 증상만 덮고 routing 의미론을 안 고친다.
3. **regression 안전**: P2P `test_existing_content_type_rename`(default-DB 정상 rename), `test_content_type_rename_conflict`(stale content type IntegrityError fallback 경로 — `using=db` 추가가 try/except IntegrityError 흐름을 안 바꿔야 함), `test_missing_content_type_rename_ignore`(missing 무시)를 깨면 안 된다. single-db에서 alias는 'default'로 동일하므로 한 토큰 추가가 이들을 보존한다.
4. **함정 회피**: 오라클 없는 에이전트의 주된 오답 경로 — (a) 같은 함수의 `transaction.atomic(using=db)`를 보고 "이미 DB 지정됨"이라 판단해 fix를 *건너뛰는* 것(atomic.using ≠ query routing이라는 Django 의미론을 모르면 발생). (b) 라우터 설정/atomic 인자 같은 엉뚱한 곳을 건드리는 것. (c) 테스트를 작성할 때 라우터를 정상(대상 DB를 가리킴)으로 꽂아 fix 없이도 통과하는 vacuous 테스트를 만드는 것 — 오라클 test_patch처럼 `db_for_write`를 *의도적으로 'default'(엉뚱한 DB)*로 고정해야 routing-skip을 실제로 잡는다. 핵심 회피책: "save 레벨 routing"과 "transaction 레벨 connection"을 분리해 이해하는 것.
