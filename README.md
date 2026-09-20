# Codex 알림 감시기

codex-reset.com의 공개 사건 목록을 5분마다 확인해 **리셋 발표·사용량 확대·저장형 리셋권 안내**를 한국어 Discord 메시지로 전달하는 Cloudflare Worker다. 사용자 PC가 꺼져 있어도 클라우드에서 실행한다.

소스 버전은 **0.8**이다. npm 표기는 `0.8.0`이며 `src/version.js`가 정본이다. 이번 변경은 시험판이며 운영 전환은 별도 승인이 필요하다. 기존 운영 0.7과 분리된 시험판은 `wrangler.preview.jsonc`를 사용한다.

0.8 구현과 39개 자동 시험, Cloudflare 실제 API 진단, 승인된 Discord 연결 시험 1건을 완료했다. 사용자가 메시지 수신 성공도 확인했다. 아직 운영은 0.7이며, 원격 저장소에 소스를 저장하는 작업은 운영 전환이 아니다.

## 동작

```text
5분 Cron → 단일 Durable Object → codex-reset.com/api/timeline
        → 응답·발표 상태 검사 → 사건별 저장 → Discord
```

Durable Object는 같은 감시기의 요청을 한 순서로 처리하고 기록을 보관하는 Cloudflare 구성 요소다. SQLite 기반 저장을 사용한다. 기존 `STATE` KV 연결은 되돌리기를 위해 설정에 남겨 두지만 새 코드에서 읽거나 쓰지 않는다.

- X API, HTML 수집, 트윗 본문 의미 판정, LLM, 상대 시간·Pacific 시간 추출을 사용하지 않는다.
- 일반 리셋은 `group=reset`이고 `announcement_state=announced`일 때만 알린다.
- 사용량 확대는 `group=boost`를 알린다.
- 리셋권은 `group=credits`이고 `banked_state`가 `announced`, `arriving`, `available` 중 하나일 때만 알린다. 일반 크레딧·unknown은 보류한다.
- 예측·모델 공개·일반 게시물·장애는 알리지 않는다.
- 발표 후 1시간 이내 항목만 처리한다. 수집 지연이 1시간을 넘으면 알림을 놓칠 수 있다.
- 첫 정상 목록의 이미 알려진 사건은 기록만 하고 발송하지 않는다. 이후 새 ID 또는 허용된 상태 전진을 알린다.
- 리셋권 상태 역행, 요약·시각 편집, 사건 삭제·재등장은 재알림 사유가 아니다. 같은 ID의 종류가 바뀌면 보류한다.

사이트는 OpenAI와 별개이며 실제 계정 사용량을 확인하지 않는다. 알림은 사이트에 등록된 발표이며 사용자의 계정에서 리셋이 완료되었다는 보장이 아니다. 서로 다른 ID가 같은 실제 리셋을 가리키는지는 합치지 않는다.

## 알림 형식

항상 세 줄이며 원문을 포함하지 않는다.

```text
🚨 **Codex 리셋 발표 감지!**
**발표 시각(KST)**: 2026-09-12 17:09 KST
출처: https://codex-reset.com/ · https://fixupx.com/thsottiaux/status/2098685367058612394
```

시각은 API `announced_at`을 한국 시간으로 바꾼 값이다. 실제 적용 순간으로 추정하지 않는다. FixupX는 미리보기 링크로만 쓰며 알 수 없는 출처는 사이트 timeline으로 연결한다. Discord 전체 호출에 mentions 차단을 적용한다.

## 설정과 비밀 값

| 설정 | 기본값과 역할 |
| --- | --- |
| `NOTIFICATIONS_ENABLED` | `false`. `true`일 때만 정기 감시가 실제 발송 |
| `DISCORD_TEST_ENABLED` | `false`. 별도 실제 연결 시험을 명시적으로 켤 때만 `true` |
| `MONITOR_NAMESPACE` | 운영·시험판의 저장 이름을 구별 |
| `SOURCE_CONTACT_URL` | API User-Agent에 넣는 공개 프로젝트·연락 URL |
| `DISCORD_WEBHOOK_URL` | 발송 시 필요한 Worker 비밀 값 |
| `SMOKE_TEST_TOKEN` | 수동 진단·연결 시험을 보호하는 Worker 비밀 값 |

비밀 값은 소스·설정 파일·`.dev.vars`·대화·로그·커밋에 넣지 않는다. `X_BEARER_TOKEN`은 새 코드에 필요 없지만 운영판을 되돌릴 수 있도록 원격 값은 아직 삭제하지 않는다.

미발송 관측, 실제 발송, 연결 시험은 각각 다른 Durable Object ID를 쓴다. 따라서 관측에서 본 사건이 실제 발송 상태를 오염시키지 않는다. 실제 발송을 처음 켜면 새 기준 목록을 만든다.

## 자료와 전송 실패 처리

- 고정된 JSON 경로만 요청한다. 시간 제한 10초, 본문 상한 1 MiB. 다른 주소로 이동하는 HTTP 응답을 따라가지 않는다.
- 게시본의 checked-at·expires-at 헤더가 없거나 잘못되었거나 만료되면 보내지 않는다. 마지막 리셋이 오래전이라는 이유로 정상 게시본을 장애로 판단하지 않는다.
- 같은 감시 객체의 API 요청은 1분 이상 간격을 둔다. 수동 진단도 같은 제한을 공유한다. 429에서는 Retry-After를 따른다.
- 중복되며 상충하는 ID, 필수 필드 오류는 제외한다. 초기 목록에 오류가 있으면 기준 목록 전체를 저장하지 않는다.
- 전송 직전에 `attempting`을 저장한다. Discord `wait=true` 응답의 메시지 ID가 있어야 `sent`로 기록한다.
- 429는 정해진 시각 이후, 항목이 여전히 목록에 있고 1시간 안일 때만 재시도한다.
- 네트워크 단절·불분명한 서버 응답·전송 직후 저장 실패는 실제 전달 여부가 불명확하다. 해당 사건의 자동 재전송을 막고 진단에 표시한다. 정확히 한 번의 전달을 절대 보장하지 않는다.
- 사건 기록은 자동 만료시키지 않는다. 사용량 규모가 커지면 보존 정책을 별도로 설계한다. 본문은 저장하지 않는다.
- 성공 heartbeat는 KV에 쓰지 않는다. 사건 변화·전송 영수증·오류·조회 및 전송 간격 제어만 Durable Object에 저장한다.

## 로컬 검증

Node.js 22 이상이 필요하다. Windows에서 Node.js 24로 검증했다.

```powershell
npm ci
npm run check
npm test
npx wrangler deploy --dry-run --outdir .wrangler/build-0-8
```

`npm test`는 모든 `test/*.test.js`를 실행한다. Discord와 API는 가짜 응답을 사용한다. Worker 실행 시험은 Miniflare/workerd에서 SQLite Durable Object와 동시 요청을 검증하고 모든 외부 요청을 가로챈다. 실제 Discord에는 보내지 않는다.

Wrangler와 실행 시험 도구는 검증한 정확한 버전으로 고정했다. Miniflare 버전명에 alpha가 포함된 것은 현재 Wrangler가 사용하는 개발 의존성 버전이며 Worker 배포 코드의 의존성은 아니다.

공개 사이트만 실제로 읽는 별도 명령은 다음과 같다. 저장이나 Discord 호출은 없다. 이 명령도 1분보다 자주 실행하지 않는다.

```powershell
npm run check:live-source
```

## 격리 시험판

`wrangler.preview.jsonc`는 운영과 다른 Worker·저장소를 쓰고 Cron·발송·연결 시험을 모두 끈다. 운영 KV·Discord 비밀 값 연결도 없다.

```powershell
npx wrangler deploy --config wrangler.preview.jsonc
node scripts/verify-preview.js
```

검증 스크립트는 시험판에 임시 진단 토큰을 등록해 API 읽기만 확인하고 finally에서 지운다. 토큰 값은 메모리에만 두며 출력·파일 저장하지 않는다. `/test-discord`를 호출하지 않는다. 중간에 프로세스가 강제 종료되어 토큰이 남으면 시험판의 `SMOKE_TEST_TOKEN`만 삭제한다.

## 보호된 경로

- `POST /run`: 올바른 Bearer 토큰이 있어야 한다. 실제 API 읽기·검사 결과만 반환하고 메시지 전송·기준 목록 초기화·알림 처리 기록 변경은 하지 않는다. 조회 간격 기록과 오류 기록은 바뀔 수 있다.
- `POST /test-discord`: 같은 인증에 더해 `DISCORD_TEST_ENABLED=true`가 필요하다. 실제 시험 메시지는 버전당 한 번만 보내며 불명확한 전송은 반복하지 않는다.
- 나머지 경로·메서드는 404. 토큰 미설정·오류는 401. 인증했지만 연결 시험이 꺼져 있으면 403.

사용자가 **실제 Discord 시험 직전에 멈추고 허락을 요청하라**고 지시했다. 허락 전 시험을 켜거나 호출하지 않는다. 가짜 응답을 사용하는 자동 시험은 이 실제 발송에 해당하지 않는다.

## 운영 전환

0.8 운영 전환은 별도 명시 승인 후 수행한다. 무조건 `npm run deploy`를 실행하면 안 된다.

1. 검증 결과와 실제 Discord 시험 결과를 제시한다. 시험 허락과 운영 전환 허락을 구별한다.
2. 기존 배포 UUID·비밀 값·KV를 보존하고, 새 SQLite Durable Object 구성과 SOURCE_CONTACT_URL을 확인한다.
3. 발송을 끈 상태로 배포·자료 읽기를 확인한 뒤 승인된 발송 설정을 적용한다. 첫 실제 감시는 과거 자료를 발송하지 않는다.
4. 실제 Cron 연속 실행을 확인한다. 필요할 때만 일시 1분으로 변경하고 최종 `*/5 * * * *` 복구를 검증한다.
5. 24시간 관측과 안정성 확인 후에만 X 비밀 값과 옛 상태를 정리한다.

되돌릴 때는 새 전송부터 끈다. 새 버전의 성공 기록과 불확실한 전송 ID를 이전 버전의 중복 표식에 반영한 뒤 이전 코드를 복원해야 1시간 안의 재전송을 피할 수 있다. Durable Object 도입 뒤 과거 버전 복원이 거부되면 새 binding·클래스를 보존한 채 0.7 실행 코드만 담은 호환 배포를 만든다. 저장 namespace를 삭제해 강제로 되돌리지 않는다. 이 절차의 원격 실행은 아직 검증하지 않았다.

세부 설계와 한계는 [개편 계획](CODEX_RESET_MIGRATION_PLAN.md), 실제 검증 상태는 [0.8 검증 기록](verification/0.8-implementation.md), 이전 운영 이력은 [버전 이력](VERSION_HISTORY.md)에 있다.
