---
instance_id: django__django-14053
repo: django/django
base_commit: 179ee13eb37348cd87169a198aec18fedccc8668
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-02-25T23:57:27Z
fail_to_pass: 1
pass_to_pass: 31
gold_files: [django/contrib/staticfiles/storage.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-14053

## 문제 요약
`HashedFilesMixin.post_process()`(ManifestStaticFilesStorage / CachedStaticFilesStorage가 사용)는 #24452 수정 이후 중첩 참조를 올바르게 처리하려고 여러 번 패스를 돈다. 그런데 매 패스마다 동일한 원본 파일명을 `collectstatic`의 `collect()`로 다시 yield한다. 그 결과 같은 파일(`admin/css/base.css`)이 서로 다른 중간 해시들과 함께 여러 번 "Post-processed"로 보고된다. 폐해는 세 가지다: (1) `collect()`가 yield 횟수를 post-processed 파일 수로 가정하므로 최종 통계("Y post-processed")가 부풀려진다, (2) WhiteNoise/S3 같이 yield된 파일을 즉석 처리하는 서브클래스가 같은 파일을 중복 압축·업로드한다(Brotli 등 비싼 작업 반복), (3) 모든 중간 파일이 나오는 것도 아니라서 일관성도 없다. 사용자는 파일당 단 한 번, **최종** 해시로만 yield되기를 기대한다.

## 유형 (정형화)
- **L = L1 (Traceable)**: problem_statement가 클래스 `HashedFilesMixin`, 메서드 `post_process()`, 상수 `max_post_process_passes`를 직접 호명한다. 단일 파일 `django/contrib/staticfiles/storage.py`로 거의 직행한다. L0가 아닌 이유는 "어디를 고치냐"가 한 줄/한 심볼이 아니라 generator 본문 전체의 yield 흐름을 읽어야 드러나기 때문(파일은 핀포인트, 수정 지점은 흐름 추적 필요).
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning)**: 한 줄 가드가 아니라 generator의 제어흐름을 **collect-then-process**로 재배치해야 한다. `processed_adjustable_paths = {}` 누적 버퍼를 도입하고, 첫 패스의 즉시-yield와 adjustable 파일의 지연-yield 두 경로를 분리하며, 모든 패스 종료 후 일괄 `yield from`을 추가한다 — 전형적 S6 lifecycle 재배치. 보조 S2인 이유: 어떤 항목을 즉시 yield하고 어떤 항목을 버퍼링할지의 **조건식**(`name not in adjustable_paths or isinstance(processed, Exception)`)을 불변식으로 정확히 합성해야 한다(예외는 즉시·non-adjustable은 즉시·adjustable은 마지막에). 단순 dedup이 아니라 yield 시멘틱을 보존하는 추론이 핵심이라 S3/S4(테스트 반복으로 후보 수렴)가 아니다.
- **K = K-Domain**: collectstatic post-processing 파이프라인 지식이 병목이다. adjustable vs non-adjustable 파일의 구분, 다중 패스가 왜 필요한지(중첩 CSS 참조 재작성), `_post_process()`가 4-튜플 `(name, hashed_name, processed, subst)`을 내놓고 `subst`가 수렴 신호라는 점, `paths`가 중간에 adjustable만으로 재바인딩된다는 점 — 모두 django staticfiles 내부 계약이다. 일반 파이썬 추론만으론 "최종 해시가 정답"이라는 의미를 모른다.
- **primary type = T-DesignRefactor**: 위치는 명확(L1)하나 진짜 난점은 generator의 조율된 구조 변경(버퍼 도입 + 2-경로 분기 + 종단 flush)이다. T-DirectMap(기계적 가드)도 T-DiffuseLoc(찾기 어려움)도 아니다.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨 "15분~1시간"(prior로 T3 근처)에서 **상향**한다. 근거:
- **구조 피처**: 1파일·메서드 1개·~13줄 net이라 scope는 작다(이것만 보면 T2~T3). 그러나 변경 성격이 단순 라인 픽스가 아니라 **S6 제어흐름 재배치**라 추론 부하가 시간라벨에 안 잡힌다.
- **regression-trap (P2P 31개)**: 인접 동작을 안 깨야 하는 표면이 넓다. 특히 `post_processing indicates the origin of the error when it fails.`(예외 즉시 yield), `test_intermediate_files`, `test_template_tag_*`(최종 해시 정확성), `test_import_loop`(다중 패스 수렴)가 한꺼번에 걸린다. 분기 조건을 하나라도 틀리면 여러 P2P가 동시에 깨진다.
- **overfit-risk**: FAIL_TO_PASS가 사실상 1개(`assertCountEqual(post_processed, set(post_processed))`, 중복 없음만 단언)라 "set으로 감싸 dedup"하는 얕은 패치로도 그 테스트는 통과 가능하다. 정답성(최종 해시·예외 순서)은 P2P에 떠넘겨져 있어 G&V 에이전트가 함정에 빠지기 쉽다.
- **has-repro**: 이슈에 `collectstatic | grep 'admin/css/base.css'` 재현과 기대출력이 또렷이 있어 localize는 쉬운 쪽으로 당긴다(이게 T5로 안 가는 이유).

종합하면 localize 쉬움(L1+repro)이 난이도를 낮추지만, S6 재구조화 + 넓은 P2P trap + 얇은 F2P로 인한 overfit 위험이 T4로 민다. T5가 아닌 것은 단일파일·소규모 헌크이고 도메인 지식이 "치명적"까진 아니기 때문.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/staticfiles/storage.py` : `HashedFilesMixin.post_process()` (단일 메서드).
- **근본 원인**: 첫 단일 패스와 이후 `range(self.max_post_process_passes)` 반복 패스가 **모두** `_post_process()`가 내놓는 항목을 그대로 `yield name, hashed_name, processed` 했다. adjustable 파일(CSS 등 참조 재작성 대상)은 패스마다 다시 처리되어 등장하므로, 같은 원본명이 중간 해시들과 함께 여러 번 호출자에게 흘러나갔다. 즉 "패스 = 구현 디테일"이 yield 계약("파일당 1회, 최종본")으로 누설됐다.
- **수정 요지**:
  1. 누적 버퍼 도입: `processed_adjustable_paths = {}` (원본 path → `(name, hashed_name, processed)`).
  2. 첫 패스 2-경로 분기: `if name not in adjustable_paths or isinstance(processed, Exception): yield ...` (non-adjustable 파일과 **예외**는 즉시 yield) `else: processed_adjustable_paths[name] = (...)` (adjustable은 버퍼링).
  3. 반복 패스에서는 yield 제거, `processed_adjustable_paths[name] = (...)`로 **덮어쓰기**만(주석 "Overwrite since hashed_name may be newer" — 마지막 패스 해시가 최종 정답).
  4. 전 패스 종료·`self.hashed_files.update(hashed_files)` 이후 `yield from processed_adjustable_paths.values()`로 adjustable 파일을 **최종 해시로 1회씩** flush.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `post_processing behaves correctly.` (`tests/staticfiles_tests/test_storage.py::test_post_processing`). 추가된 단언은 한 줄:
  `self.assertCountEqual(stats['post_processed'], set(stats['post_processed']))`.
  `set()`이 중복을 제거한 결과와 원본 리스트가 같은 개수여야 함을 요구 → `post_processed`에 같은 파일이 2회 이상 없음을 증명. 버그 상태에선 adjustable CSS가 여러 번 들어가 `len(list) > len(set)`이라 실패, 픽스 후 파일당 1회라 통과.
- **픽스 증명**: 통계는 yield 횟수로 집계되므로, adjustable을 dict에 모았다가 마지막에 한 번씩만 내보내면 중복이 구조적으로 제거된다. `assertCountEqual(x, set(x))`은 dedup-동치를 직접 검사하므로 픽스의 의도와 정확히 일치.
- **overfit 관점**: F2P 단언이 "중복 없음"만 보므로 `yield`를 `set`/`dict`로 후처리 dedup하는 패치로도 **이 테스트만은** 통과할 수 있다(S4 함정). 진짜 정답성은 P2P가 지킨다 — 31개 PASS_TO_PASS가 (a)예외 origin 보고(`post_processing indicates the origin of the error`), (b)최종 해시 정확성(`test_intermediate_files`, `test_template_tag_*`), (c)다중 패스 수렴(`test_import_loop`)을 커버. 따라서 골드처럼 "예외/non-adjustable 즉시 yield + adjustable 종단 yield"의 경로 분리를 지켜야만 F2P·P2P 동시 green.
- **regression 관점**: regression-trap 강함. 분기에서 `isinstance(processed, Exception)` 누락 시 예외가 버퍼로 새거나 순서가 뒤집혀 origin-보고 테스트가 깨지고, `name not in adjustable_paths` 누락 시 non-adjustable 파일까지 지연돼 다른 동작이 흔들린다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `HashedFilesMixin.post_process()`와 `max_post_process_passes`를 명시 → `django/contrib/staticfiles/storage.py`의 `post_process` generator로 직행. 재현 출력("같은 base.css가 다른 해시로 3회")으로 "yield가 패스마다 반복된다"를 즉시 가설화. 두 yield 지점(첫 단일 패스 루프 + `for i in range(self.max_post_process_passes)` 루프)을 식별한다.
2. **픽스 (왜 올바른 일반화인가)**: "패스 횟수"는 구현 디테일이고 호출자 계약은 "파일당 최종본 1회"다. 따라서 adjustable 파일은 **마지막 패스의 해시가 정답**이므로 즉시 yield하면 안 되고, dict(`processed_adjustable_paths`)에 원본 path 키로 누적하며 덮어쓰다가, 전 패스 종료 후 `yield from ...values()`로 일괄 방출한다. non-adjustable 파일과 예외는 패스 반복과 무관하므로 첫 패스에서 즉시 yield. 이 구조는 단순 dedup과 달리 (a)최종 해시 보장, (b)예외/일반 파일의 즉시성 보존을 둘 다 만족하므로 테스트 너머로 일반화된 올바른 픽스다.
3. **regression 안전**: `post_processing indicates the origin of the error` P2P를 위해 `isinstance(processed, Exception)` 항목은 반드시 첫 패스에서 즉시 yield(버퍼링하면 순서·존재 깨짐). `test_template_tag_*`/`test_intermediate_files` P2P를 위해 dict 덮어쓰기로 **최신 해시 우선**을 보장. `test_import_loop`/수렴 로직을 위해 `substitutions` 종료조건(`if not substitutions: break`)은 건드리지 않는다. `paths = {path: paths[path] for path in adjustable_paths}` 재바인딩과 `self.hashed_files.update(hashed_files)` 위치도 그대로 유지.
4. **함정 회피**: 오라클 없는 에이전트의 최빈 오답은 (a)**얕은 dedup** — 출력 리스트를 `set`으로 감싸거나 마지막 yield만 남기기. F2P는 통과하나 예외 순서/최종 해시가 틀려 P2P가 깨진다. (b)**예외 분기 누락** — adjustable 여부만 보고 예외를 버퍼에 넣어 origin-보고 테스트 실패. (c)**중간 해시 채택** — 첫 패스 해시를 최종으로 남겨 `*.6b517d...`가 아닌 중간 해시가 매니페스트에 들어감. 회피법: F2P("중복 없음")를 정답 기준으로 착각하지 말고 P2P 31개가 요구하는 불변식(예외 즉시·non-adjustable 즉시·adjustable 최종 1회)을 명세로 삼아 generator를 collect-then-flush로 재구조화한다.
