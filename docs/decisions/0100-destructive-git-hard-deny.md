# ADR-0100: Destructive git HARD_DENY 6룰 (런타임 backstop)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0099(prompt 단 verbatim ban), ADR-0101(push mass-delete 3룰, 같은 batch), ADR-0091(`.git/{hooks,config}` write deny — 기존)
- **참조**: `src/permission/policy-rules.ts`(6 신규 HardDenyRule), `tests/unit/permission-rules.fixtures.ts`(6 신규 적대 fixture), `tests/unit/permission-rules.test.ts`(245/245)

## 맥락

ADR-0099가 prompt에서 destructive git을 금지하지만 — 모델 일탈 / user 명시 요청 wrapping / shell command 안에서 호출 등 다양한 우회가 가능. **런타임 backstop** 필요.

기존 HARD_DENY에 git 관련 3룰만 있었음(`-c`/`--exec-path`/`--config-env` — 모두 config injection 보안 primitive). workflow-destructive 룰(예: `reset --hard`) 부재.

## 결정

`HARD_DENY_RULES`에 6개 추가(`policy-rules.ts`):

1. **git-reset-hard**: `\bgit\b...\breset\b...--hard\b`
2. **git-push-force**: `\bpush\b...(--force(-with-lease)?|-f\b)`
3. **git-checkout-discard**: `\bcheckout\b...(\s--\s|\s\.(?=\s|$)|\s--$)` — `git checkout -- <path>` / `git checkout .` / `git checkout <ref> -- <path>` 매치
4. **git-commit-amend**: `\bcommit\b...--amend\b`
5. **git-rebase-interactive**: `\brebase\b...(--interactive|\s-i\b)`
6. **git-clean-force**: `\bclean\b...(-(?=[a-zA-Z]*[fF])[a-zA-Z]+|--force)` — `-fd`, `-df`, `-fdx`, `--force` 모두 매치(lookahead로 `f` 위치 비고정)

각 룰: `[\s\S]{0,500}?` 길이 cap으로 ReDoS 방지(기존 규칙 스타일 답습).

`permission-rules.fixtures.ts`: 룰당 ≥5 mustBlock + ≥4 mustAllow(near-miss 거부 포함). 적대 사례: 환경변수 prefix(`GIT_DIR=. git ...`), 체이닝(`cd /tmp && git ...`), `-C` 와 혼동, dot-token confusion(`v1.0.0`/`v.1`).

## 결과

- 245 permission-rules.test.ts 전부 통과(기존 222 + 신규 23).
- `hardDenyReason()` short-circuit 동작 — 일치 시 즉시 deny verdict.
- 사용자 EXPLICIT 요청도 차단 — 정말 필요하면 사용자가 직접 shell에서 실행해야(catastrophic 비대칭 by design).

## 한계

- regex 기반 — 충분히 obfuscated된 명령(예: `eval $(echo "git r" "eset --hard")`)은 우회 가능. 우리는 "보안 sandbox 아니다" 명시.
- `git push origin +main:main` refspec-`+` 형태의 force-push는 의도적 미매치(`mustAllow`에 기록). 실제 우회 사례가 발견되면 확장.
- 일부 룰(`-i` rebase, `clean -ndf`)은 사용자가 dry-run을 의도해도 차단 — 보수적 디자인.
