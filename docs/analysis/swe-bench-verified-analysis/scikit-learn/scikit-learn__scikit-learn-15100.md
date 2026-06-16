---
instance_id: scikit-learn__scikit-learn-15100
repo: scikit-learn/scikit-learn
base_commit: af8a6e592a1a15d92d77011856d5aa0ec4db4c6c
version: "0.22"
difficulty: "15 min - 1 hour"
created_at: "2019-09-26T19:21:38Z"
fail_to_pass: 1
pass_to_pass: 93
gold_files: [sklearn/feature_extraction/text.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약

`strip_accents_unicode`는 입력 문자열을 `unicodedata.normalize('NFKD', s)`로 정규화한 뒤, `normalized == s`이면 (즉 이미 NFKD 형태이면) 입력을 그대로 반환한다. 그런데 입력이 이미 NFKD 분해형(예: `"n" + COMBINING TILDE`)인 경우 정규화가 no-op이라 `normalized == s`가 True가 되고, combining mark를 제거하는 핵심 로직을 건너뛴다. 결과적으로 `chr(241)`("ñ" 단일 코드포인트)는 "n"으로 stripping되지만 시각적으로 동일한 `chr(110)+chr(771)`은 변경 없이 반환된다. 이슈는 재현 코드를 첨부하고 두 입력이 모두 "n"이 되어야 한다고 명세한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈 본문이 함수명 `strip_accents_unicode`를 직접 지목하고 재현 코드까지 제공. grep 한 방이면 끝. localize 노력 사실상 0.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, "이미 NFKD인 경우 skip"이라는 잘못된 단축경로의 *의도*(ASCII 입력에서 비싼 list comprehension 회피)를 보존하면서 *올바른 조건*(combining mark 유무 ≠ NFKD-동일성)을 재합성해야 함. hint의 "그냥 if 지워라"는 동작상 맞지만, 골드는 정확성+성능 불변식을 동시에 만족하는 조건(`s.encode("ASCII")` 성공 여부)으로 합성. 후보를 마구 시도하는 G&V가 아니라 불변식 추론이라 S2.
- **K-Domain**: 유니코드 정규화(NFKD/combining/composed vs decomposed) 도메인 지식이 근본원인 이해의 병목. 일반 파이썬 추론(K-Gen)만으론 "왜 `normalized == s`가 거짓 음성을 내는지" 설명 불가.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 dominant 난점이 "버그 있는 조건의 의도를 보존하며 올바른 조건식을 추론 합성"하는 데 있으므로 T-DirectMap이 아닌 T-ConstraintReason.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`text.py`) 단일 함수, 골드 diff +6/-3줄로 ≲5줄급, `has-repro`로 가장 강한 easiness 신호 보유, P2P 104개는 모두 동일 테스트 파일의 vectorizer 스위트라 인접 동작 trap이 약함(실제로 함수 동작만 좁게 바뀜). 약한 엣지추론(NFKD-동일 ≠ no-accent)이 들어가 T1(픽스 자명)보다는 위. 공식 라벨 "15분-1시간"은 테스트 3케이스 작성+유니코드 검증 시간을 반영한 prior로, 구조적으로는 T2와 정합적이라 재조정 불필요.

## 골드패치 분석

- **파일·함수**: `sklearn/feature_extraction/text.py` 의 `strip_accents_unicode(s)`.
- **근본원인**: early-return 가드 `if normalized == s: return s`가 "정규화 후 변화 없음 == 제거할 accent 없음"이라고 *잘못 가정*. 입력이 이미 NFKD 분해형이면 NFKD 정규화는 idempotent라 `normalized == s`가 참이 되지만, 분해형 문자열은 여전히 combining mark를 포함하므로 stripping이 필요하다. 즉 조건이 거짓 음성(false negative)을 낸다.
- **수정요지**: `normalized == s` 비교를 제거하고, 대신 `s.encode("ASCII", errors="strict")`를 `try`로 감싼다. ASCII 인코딩이 성공하면 (accent가 있을 수 없으므로) 비싼 normalize+list comprehension을 건너뛰고 `s`를 그대로 반환. `UnicodeEncodeError`가 나면 그때만 `unicodedata.normalize('NFKD', s)` 후 `''.join([c for c in normalized if not unicodedata.combining(c)])`로 combining mark를 제거. 성능 단축경로의 *원래 의도*(순수 ASCII 회피)는 정확한 판별식으로 보존하면서 NFKD 입력의 버그를 제거.

## 검증 (test_patch)

- **FAIL_TO_PASS** (`test_strip_accents` 1개): 세 케이스 추가 — (1) 이미 분해형 `"ö"`(o+diaeresis)→`"o"`, (2) combining mark만 단독 `"̀́̂̃"`→`""`, (3) 한 문자에 다중 combining mark `"ȫ"`→`"o"`. 버그 버전은 세 입력 모두 `normalized == s`라 입력을 그대로 반환해 실패. 픽스 후엔 셋 다 비-ASCII라 `UnicodeEncodeError` 경로를 타고 combining mark가 제거되어 통과.
- **overfit**: 추가 케이스가 단일 문자가 아닌 (a) 분해형 (b) 마크 단독 (c) 다중 마크 세 패밀리를 커버해 special-case 통과를 봉쇄. 골드는 입력-구조 무관하게 "ASCII면 skip, 아니면 NFKD+strip"이라 일반화가 옳음. overfit-risk 낮음.
- **regression**: 기존 ASCII 입력은 `encode` 성공 경로로 동일 결과 반환(`test_to_ascii` 등 유지). composed 단일 코드포인트("ñ"→"n")도 비-ASCII라 NFKD 경로로 변함없이 동작. P2P 104개(vectorizer/tfidf/pickle 스위트)는 이 함수만 거치므로 영향 없음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `strip_accents_unicode`를 명시 + 재현코드 제공 → `sklearn/feature_extraction/text.py`의 동명 함수로 직행(L0). 탐색 불필요.
2. **픽스와 일반화 근거**: 버그의 본질은 `normalized == s`가 "accent 없음"의 *대리 지표로 부정확*하다는 것. 단순히 if를 삭제(hint 제안)해도 정확하지만, 원본의 성능 단축경로 의도를 살리려면 진짜 불변식 — "문자열이 순수 ASCII면 결코 accent가 없다" — 으로 교체한다. `s.encode("ASCII", errors="strict")` 성공 여부가 그 불변식의 정확한 판별식. 입력의 NFC/NFKD 형태와 무관하게 옳으므로 일반화.
3. **regression 안전**: ASCII 입력은 새 경로에서 byte-identical하게 반환되어야 함(`test_to_ascii`, vectorizer 스위트). composed accent("ñ" 단일 코드포인트)도 비-ASCII라 기존 NFKD strip 동작 유지. 둘 다 안 깨야 P2P 104개가 green.
4. **함정 회피**: (a) if만 삭제하면 정확하지만 모든 입력에서 normalize+list-comp를 강제해 성능 회귀 — encode 단축경로로 회피. (b) `normalized == s` 비교를 유지한 채 또 다른 조건을 덧붙이는 식의 미봉책은 NFKD 거짓 음성을 못 고침. (c) `errors="strict"`를 빠뜨리거나 `.encode()` 기본 코덱(utf-8)을 쓰면 비-ASCII가 예외를 안 던져 분기 자체가 무력화 — 반드시 ASCII 코덱+strict. (d) test_patch의 "combining mark 단독"(`""` 기대) 케이스가 mark-only 입력도 빈 문자열로 환원되는지 검증하므로, mark 제거 로직을 빼먹으면 적발됨.
