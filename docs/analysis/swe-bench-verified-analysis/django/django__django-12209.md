---
instance_id: django__django-12209
repo: django/django
base_commit: 5a68f024987e6d16c2626a31bf653a2edddea579
version: 3.1
difficulty: <15 min fix
created_at: 2019-12-12T04:11:05Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [django/db/models/base.py]
---

# django__django-12209

## 문제 요약
PK 필드에 `default`(예: `UUIDField(primary_key=True, default=uuid4)`)가 걸린 모델에서, 명시적 pk 값을 주고 저장할 때 동작이 바뀌었다. Django 2.2까지는 `Sample(pk=existing_pk).save()`가 INSERT 시도 후 UPDATE로 fallback 됐는데, 3.0부터는 두 번 INSERT를 하게 되어 두 번째가 실패한다. 특히 이 회귀는 동일 fixture를 여러 번 로드하는 `loaddata` 경로를 깨뜨려서, 이미 존재하는 객체를 갱신하지 못한다.

## 유형 분류
- 버그 카테고리: regression (티켓 #29260의 PK-default UPDATE-skip 최적화가 도입한 회귀)
- 서브시스템: django ORM model save / serialization(loaddata)
- 증상 타입: 예외 (중복 PK로 두 번째 INSERT가 IntegrityError) / silent behavior-change
- 로컬라이제이션 신호: problem_statement가 명시적으로 ticket #29260을 가리키고, hints_text가 회귀 커밋 85458e94를 bisect로 짚으며 "`_save_table`이 explicit pk일 때 INSERT를 강제하면 안 된다"고 지목한다. "fixture loading은 serialization이 넘기는 `raw` 플래그로 분기해 최적화를 끄자"는 결론까지 힌트에 박혀 있어 골드 파일과 정확히 일치.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._save_table`
- 근본 원인: #29260 최적화는 "instance 추가 중이고 PK에 default가 있으면 UPDATE를 건너뛰고 INSERT 강제"하는데, 이 조건이 `raw` 저장(serialization/loaddata 경로)까지 포함했다. raw 저장은 명시적 pk를 가진 기존 객체를 다시 적재하는 경로라 UPDATE fallback이 필요하다.
- 수정 요지: UPDATE-skip 조건문의 맨 앞에 `not raw and` 한 줄을 추가했다. 즉 `raw=True`(serializer가 넘김)이면 더 이상 UPDATE를 건너뛰지 않고 기존의 INSERT-then-UPDATE fallback 동작으로 복귀한다. hints에서 논의된 "explicit pk 추적 불가" 한계 때문에 일반 사용자 코드는 force_update로 우회하도록 문서화하되, fixture 로딩만은 `raw` 분기로 안전하게 복구한 것.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: serialization 데이터 라운드트립 테스트. `tests/serializers/models/data.py`에 `UUIDDefaultData(data = UUIDField(primary_key=True, default=uuid.uuid4))` 모델을 신설하고, `tests/serializers/test_data.py`의 테스트 매트릭스에 `(pk_obj, 793, UUIDDefaultData, uuid_obj)` 케이스를 추가.
- 테스트가 어떻게 픽스를 증명하는지: serializer는 객체를 덤프했다가 `raw=True`로 역직렬화/저장한다. PK-default가 있는 모델을 명시적 pk로 raw 저장할 때, 패치 전이면 UPDATE-skip이 발동해 같은 pk로 두 번째 INSERT를 시도→IntegrityError로 실패. `not raw and` 추가 후엔 raw 경로가 UPDATE fallback을 타서 라운드트립이 성공한다. (FAIL_TO_PASS 라벨이 `partial(...)`로 보이는 건 SWE-bench가 parametrize된 테스트 id를 캡처하면서 생긴 표기 아티팩트.)

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `_save_table`의 "Skip an UPDATE when adding an instance and primary key has a default" 주석 블록. 회귀를 만든 #29260 커밋의 정확히 그 조건문이 타겟.
- 함정/난이도 메모: 원인은 한 줄이지만 "왜 raw인가"를 이해 못 하면 엉뚱하게 `pk_set`을 추적하려다 막힌다(hints의 Simon Charette가 그 경로가 막다른 길임을 설명—`Model.__init__`이 default 생성 여부를 추적하지 않아 `Sample()`와 `Sample(pk=...)`가 둘 다 pk_set=True). 일반 explicit-pk 케이스는 코드로 안 고치고 force_update 문서화로 남긴다는 설계 결정을 알아야 골드와 동일한 minimal-fix에 도달. 테스트는 base.py를 안 건드리고 serializers 픽스처에만 추가됨—멀티파일이지만 프로덕션 수정은 단일 파일 1라인.
- 우리 에이전트 관점: 막힐 지점은 "pk_set 기반의 더 일반적인 수정"으로 과확장하는 것. problem_statement와 hints가 raw/fixture 경로를 명확히 가리키므로 그 신호를 따라 `raw` 인자에 집중하면 정답. 반대로 hints 없이 증상만 보면 `_save_table` 대신 serializer 쪽을 의심해 시간을 낭비할 수 있다.
