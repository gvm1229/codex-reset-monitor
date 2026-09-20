# Codex Monitor — 프로젝트 지침

## 목적과 실행

- 소스 0.8은 `https://codex-reset.com/api/timeline`의 공개 JSON으로 리셋 발표·사용량 확대·저장형 리셋권을 Discord에 알린다.
- 기존 운영 Worker 이름은 `tibo-codex-monitor`다. PC에 독립적인 Cloudflare 5분 Cron을 유지한다.
- 0.8은 아직 시험판이다. 운영 적용은 현재 버전별 명시 승인이 필요하다. 기록과 실제 배포 상태를 확인하며 소스 변경을 운영 적용으로 표현하지 않는다.
- 현재 사용자 지시: **실제 Discord 시험 전에 멈추고 허락을 요청한다.** 시험 전송 허락을 운영 전환 허락으로 확대하지 않는다.
- 2026-09-21 승인된 연결 시험 1건은 전송·본문 재조회까지 완료했다. 같은 승인을 추가 시험 전송에 재사용하지 않는다. 상세 결과는 `verification/0.8-implementation.md`에 있다.

## 코드·상태 규칙

- X API·HTML 수집·트윗 본문 의미 판정·시간 문장 해석·LLM을 도입하지 않는다.
- `src/source.js`: 고정 API, 식별 User-Agent, 10초 제한, 1 MiB 제한, 게시본 신선도.
- `src/events.js`: 문서화된 필드만 정규화하고 선택. 알 수 없는 필드는 버린다.
- `src/delivery.js`: 단일 SQLite Durable Object와 순차 처리 대기열. 미발송·실발송·시험 상태는 분리한다.
- `src/discord.js`: 세 줄·한국어·KST 발표 시각·사이트 출처·미리보기 링크. 원문과 원본 X 링크를 넣지 않는다. mentions 차단.
- 초기 정상 목록은 과거 알림을 보내지 않는다. reset+announced, boost, credits+알려진 banked_state만 대상이다.
- 발표 후 1시간 제한. 같은 ID의 상태 전진만 추가 알림하며 편집·역행·삭제 후 재등장으로 보내지 않는다.
- 실제 리셋 적용 시각·계정 리셋 완료를 추정하지 않는다. 예측·unlock·일반 credits·unknown은 제외한다.
- 전송 직전 durable attempting 기록, wait=true Discord 응답의 메시지 ID를 영수증으로 기록한다. 불확실한 결과는 자동 재전송 금지.
- `STATE` KV는 옛 운영의 되돌리기용으로 남겨 두며 새 코드에서 사용하지 않는다. 정상 KV heartbeat 없음.

## 설정·보안

- 기본 `NOTIFICATIONS_ENABLED=false`, `DISCORD_TEST_ENABLED=false`를 유지한다.
- 새 코드는 `X_BEARER_TOKEN`을 사용하지 않는다. 운영 안정 확인 전 원격의 옛 비밀 값·KV를 삭제하지 않는다.
- `DISCORD_WEBHOOK_URL`, `SMOKE_TEST_TOKEN` 값은 소스·`.dev.vars`·Wrangler 설정·대화·로그·커밋에 저장하지 않는다.
- `/run`은 인증된 읽기 진단 전용이다. 연결 시험은 별도 `/test-discord` 경로와 명시된 설정으로만 가능하다.
- 실제 공개 API 시험은 분당 1회보다 자주 실행하지 않는다. Retry-After를 따른다.
- `wrangler.preview.jsonc`는 분리된 무발송·무Cron 시험판이다. 운영 KV·Webhook 비밀 값을 연결하지 않는다.

## 수정과 검증

1. 계획은 프로젝트 Markdown에 먼저 기록하고 기존 미커밋 변경을 보존한다.
2. 제품 버전은 `src/version.js`의 `0.X`, npm은 `0.X.0`; VERSION_HISTORY 규칙을 따른다.
3. `npm run check`, `npm test`를 실행한다. `test/*.test.js` 모두 자동 발견한다.
4. `npm test`의 네트워크는 가짜 API·Discord로 제한한다. workerd 시험에서 Durable Object·동시 요청·SQLite를 검증한다.
5. `npm run check:live-source`는 공개 API만 읽는다. `scripts/verify-preview.js`도 실제 Discord를 호출하지 않는다.
6. 빌드 확인은 `npx wrangler deploy --dry-run`. 운영 승인 없이 기본 설정으로 실제 deploy하지 않는다.
7. 운영 승인 후 실 Cron 확인에만 임시 1분 주기를 쓰고 마지막에 5분으로 복구한다.
8. 시험 결과는 로컬 Windows/Node, 로컬 workerd, 실제 Cloudflare를 구분한다. 가짜 Discord 성공을 실제 전달 성공으로 표현하지 않는다.

이전 X 분류·복구 절차는 역사 기록이며 현재 구현 지시가 아니다. 구현 전 파일 사본은 `.wrangler/backups/before-0-8-20260921`에 보관했다. 상세 동작·전환·되돌리기는 README와 CODEX_RESET_MIGRATION_PLAN을 따른다.
