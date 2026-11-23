# Gachi-Gochi-BE

가치고치 백엔드 (Supabase: Postgres DB + 로그인 + 사진 저장소 + Edge Functions)

| | |
|---|---|
| Supabase 조직 / 프로젝트 | `Gachi-Gochi` / `gachigochi` (서울 `ap-northeast-2`, 무료 플랜) |
| 서버 주소 | `https://rlhdjijbnstdlfzjmxcd.supabase.co` |
| API 주소 | `https://rlhdjijbnstdlfzjmxcd.supabase.co/functions/v1` |
| 앱에 넣는 키 | publishable 키 (대시보드 Project Settings → API Keys). 앱에 넣어도 되는 공개 키 |

> 무료 플랜은 7일 동안 요청이 없으면 일시정지된다. 대시보드에서 "Restore"를 누르면 데이터 그대로 다시 켜진다. 시연 전날 꼭 확인.

---

## MVP 범위 (2026-11-23 결정): 게임은 폰 저장, 봉그깅만 서버

MVP 배포(갤럭시 APK, 아이폰 웹 링크)에서는 로그인 화면 없이 깔면 바로 쓰게 한다.

| 기능 | MVP에서 | 이유 |
|---|---|---|
| 귤 잔액, 상점, 섬 꾸미기, 탐험, 알, 걷기 | **폰 저장소(AsyncStorage)에만 저장. 서버 연결 안 함** | 지금 앱 코드 그대로. 서버 DB는 쓰지 않는다 |
| **봉그깅 사진 판별** | **서버 연결** (`POST /bongging/certifications`) | Gemini 키를 앱에 넣으면 누구나 꺼내 쓸 수 있다. 판별 기록이 서버에 남아 참여 통계를 낼 수 있다 |

- 봉그깅을 부르기 위해 앱은 **화면 없이 익명 로그인**만 한다(아래 "앱 연결 방법" 1·2번). 사용자에게 보이는 로그인·회원가입 화면은 없다.
- 서버가 돌려준 봉그깅 경험치(`xp`, `growthStacks`)는 **앱이 폰 저장소에 더한다.** MVP 동안 서버의 `user_stats`(재화)는 화면에 쓰지 않는다.
- 앱의 `.env`에서 `EXPO_PUBLIC_GEMINI_API_KEY`는 비워 두고, `EXPO_PUBLIC_API_URL`도 비워 둔다(비어 있으면 걷기·탐험이 폰 저장소로만 동작한다).
- 걷기·탐험·내 정보 API는 만들어 두었다. **정식 출시 때 카카오 등 로그인과 함께 연결**한다.
- 폰 저장이라 앱을 지우거나 앱 데이터를 지우면 기록이 사라진다. 아이폰 웹은 사파리 데이터 삭제·개인정보 보호 모드에서도 사라지니 **"홈 화면에 추가"해서 쓰도록 안내**한다.
- 익명 가입은 같은 IP(같은 와이파이)에서 **시간당 300번**까지다(Authentication → Rate Limits, 2026-11-23 기본값 30에서 올림).

## 프론트가 할 일 (MVP)

> 백엔드에서 받을 것은 **publishable 키 하나**다(따로 전달). 나머지는 이 문서에 있다.
> 키는 앱에 들어가도 되는 공개 키지만, 레포·공개 채팅방에는 올리지 않는다. 앱의 `.env`에 넣는다.

**MVP에서 연결할 것은 봉그깅 하나다.** 귤·상점·섬·탐험·걷기는 지금처럼 폰 저장 그대로 둔다.

1. **패키지 설치**: `npx expo install @supabase/supabase-js @react-native-async-storage/async-storage`
2. **`.env`**
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://rlhdjijbnstdlfzjmxcd.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<백엔드에서 받은 publishable 키>
   EXPO_PUBLIC_GEMINI_API_KEY=        # 비워 둔다 (Gemini는 서버가 부른다)
   EXPO_PUBLIC_API_URL=               # 비워 둔다 (걷기·탐험은 MVP에서 폰 저장)
   ```
   - `.env`는 앱 폴더 맨 위(`package.json`과 같은 곳)에 있는 **파일**이다. `.gitignore`에 있어서 GitHub에 안 올라가니 팀원이 각자 만든다.
   - 코드에는 키를 직접 쓰지 않는다. `process.env.EXPO_PUBLIC_...`로 읽기만 한다.
   - **EAS로 APK를 빌드할 때는 `.env`가 EAS 서버로 올라가지 않는다**(git이 무시하는 파일은 빠진다). 빌드하는 사람이 EAS에 한 번 등록한다.
     ```
     eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://rlhdjijbnstdlfzjmxcd.supabase.co --environment preview --visibility plaintext
     eas env:create --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value <publishable 키> --environment preview --visibility plaintext
     ```
     expo.dev → 프로젝트 → Environment variables 화면에서 넣어도 같다. 그다음 `eas build --profile preview`.
     (`production` 프로필로도 빌드하면 `--environment production`으로 한 번 더 등록한다.)
3. **익명 로그인 (화면 없음)**: 앱 시작할 때 세션이 없으면 한 번만 로그인한다. 세션은 폰 저장소에 남아서 다음부터는 같은 사용자다.
   ```ts
   // lib/supabase.ts
   import AsyncStorage from '@react-native-async-storage/async-storage';
   import { createClient } from '@supabase/supabase-js';

   export const supabase = createClient(
     process.env.EXPO_PUBLIC_SUPABASE_URL!,
     process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
     { auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } },
   );

   export async function ensureSignedIn() {
     const { data } = await supabase.auth.getSession();
     if (data.session) return data.session;
     const { data: signed, error } = await supabase.auth.signInAnonymously();
     if (error) throw error;
     return signed.session!;
   }
   ```
4. **사진을 줄여서** 서버로 보낸다. 긴 변 1280px JPEG 정도 (`expo-image-manipulator`).
   서버는 10MB까지 받지만, 원본 그대로 보내면 올리는 데 오래 걸리고 무료 저장 용량(1GB)이 300장 정도에서 찬다.
5. **봉그깅 판별을 서버로**: `lib/bongging-recognition.ts`의 Gemini 직접 호출 대신 아래처럼 보낸다. 필드와 응답은 아래 [봉그깅 명세](#봉그깅-post-bonggingcertifications-앱-기준).
   ```ts
   const session = await ensureSignedIn();
   const form = new FormData();
   form.append('image', { uri: resizedUri, name: 'bongging.jpg', type: 'image/jpeg' } as any); // 웹에서는 Blob
   form.append('capturedAt', new Date().toISOString());
   form.append('locationSource', 'none'); // 위치가 있으면 'exif' | 'device' + latitude, longitude

   const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/bongging/certifications`, {
     method: 'POST',
     headers: {
       apikey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
       Authorization: `Bearer ${session.access_token}`,
     },
     body: form, // Content-Type은 넣지 않는다 (fetch가 알아서 넣는다)
   });
   const body = await res.json();
   // 성공: body.status === 'success' | 'failure', 실패: body.error.code (아래 실패 응답 표)
   ```
6. **경험치는 폰 저장소에 더한다**: 응답의 `xp`·`growthStacks`를 지금 앱이 하던 대로 폰 저장소에 더한다. 응답의 `stats`(서버 재화)는 MVP에서 쓰지 않는다.

**참고: 아이폰 웹 버전**
- 웹에서는 `Alert.alert` 창이 뜨지 않는다. 봉그깅의 위치 확인(`lib/resolve-bongging-location.ts`)·오프라인 확인 단계에서 답을 기다리다 멈추니, 웹에서는 다른 확인 창을 써야 한다.
- 웹에서는 걸음 수를 읽을 수 없다(걷기 화면에 "이 기기에서는 걸음 수를 읽을 수 없어요").
- 아이폰 사파리에서 카메라를 쓰려면 사이트가 https여야 한다.

## API 기준: 앱(FE) 코드를 따른다

- **API 주소·요청·응답 형식은 지금 앱 코드([Gachi-Gochi-FE](https://github.com/Ga-chi-Gochi/Gachi-Gochi-FE))에 적힌 형식을 기준으로 한다.**
  앱 쪽 기준 파일: `lib/walking-api.ts`, `lib/explore-api.ts`, `lib/bongging-certification.ts`, `lib/bongging-reward.ts`
- 보상 숫자도 앱 상수(`constants/walking-reward.ts`, `lib/bongging-reward.ts`, `constants/explore.ts`, `constants/gochi-eggs.ts`)와 같게 둔다. 서버 쪽은 `supabase/functions/_shared/rewards.ts` 한 곳에 있다.
- 형식을 바꾸고 싶으면 **나중에 바꾼다.** 바꿀 때는 이 문서를 먼저 고치고 프론트에 알린 다음, 서버 → 앱 순서로 배포한다.
- **바뀐 것**
  - 2026-11-19 걷기: 걷기 화면 설계에 따라 **자동 지급 → "보상 받게" 버튼으로 받기**로 바꿈.
    요청 형식(`/walking/records`)은 앱 그대로이고, 보상 받기(`/walking/rewards/claim`)와 현황(`/walking/today`)이 추가됨. 앱 코드는 아직 자동 지급이라 맞춰야 함.
- 앱에 없던 것 중 서버에 꼭 필요한 것(로그인 토큰 등)과 서버가 추가로 제공하는 API는 아래에 **(서버 추가)** 로 표시한다.

## 앱 연결 방법 (서버 추가 명세)

앱 코드에 아직 없는 부분이라 앱을 서버에 연결할 때 추가해야 한다.

1. **로그인 (익명)**: 앱을 처음 켤 때 `@supabase/supabase-js`로 `supabase.auth.signInAnonymously()`.
   카카오·구글·애플 로그인을 붙이면 이 익명 계정에 연결(`linkIdentity`)해서 기록을 그대로 잇는다.
2. **모든 API 요청 헤더**에 두 개를 넣는다. 없으면 `401 UNAUTHORIZED`.
   ```
   apikey: <publishable 키>
   Authorization: Bearer <로그인 세션의 access_token>
   ```
3. **서버 주소** (정식 출시 때. MVP에서는 비워 둔다): 앱의 `WALKING_API_BASE_URL`, `EXPLORE_API_BASE_URL` 등에
   `https://rlhdjijbnstdlfzjmxcd.supabase.co/functions/v1` 을 넣는다. (그 뒤에 `/walking/records` 등이 붙는다)
4. **봉그깅**: 앱이 Gemini를 직접 부르는 `lib/bongging-recognition.ts` 대신 사진을 서버로 보낸다. 판별은 서버가 한다.
   사진은 올리기 전에 긴 변 1280px JPEG 정도로 줄인다. (무료 저장 용량 1GB)
5. **테스트 데이터 초기화**: 로그아웃 후 다시 익명 로그인하면 새 사용자(재화 0, 기록 없음)로 시작한다.

---

## API

날짜(`date`)는 `YYYY-MM-DD`이고, 서버는 한국 시간 기준으로 미래 날짜를 거부한다.

### 걷기 ("보상 받게" 버튼 방식)

화면: 걸음이 1,000 · 3,000 · 5,000보에 닿으면 그 단계의 귤이 **활성화**되고, "보상 받게" 버튼을 누르면 **지금까지 활성화된 귤을 한꺼번에** 받는다.
단계마다 귤(코인) 10 · 경험치 5. 같은 날짜·단계는 한 번만 받는다. 하루 목표(진행 막대 끝)는 10,000보.

| 요청 | 언제 |
|---|---|
| `POST /walking/records` | 걸음 수가 바뀔 때마다. **저장만** 하고 보상은 주지 않는다 |
| `POST /walking/rewards/claim` | "보상 받게" 버튼을 눌렀을 때 |
| `GET /walking/today?date=` | 걷기 화면을 열 때 (`date` 없으면 오늘) |

세 요청 모두 아래 **걷기 현황**을 돌려준다.
```json
{
  "date": "2026-11-19",
  "steps": 3200,
  "distanceMeters": 2240,
  "goalSteps": 10000,
  "tiers": [
    { "steps": 1000, "coins": 10, "xp": 5, "reached": true,  "claimed": true  },
    { "steps": 3000, "coins": 10, "xp": 5, "reached": true,  "claimed": false },
    { "steps": 5000, "coins": 10, "xp": 5, "reached": false, "claimed": false }
  ],
  "claimableSteps": [3000],
  "claimedSteps": [1000]
}
```
- 단계 카드: `claimed` → 체크 표시, `reached && !claimed` → 활성화(받을 수 있음), `!reached` → 잠김
- "보상 받게" 버튼: `claimableSteps`가 비어 있지 않을 때만 켠다

#### `POST /walking/records` (요청 형식은 앱 `lib/walking-api.ts` 그대로)

요청
```json
{
  "date": "2026-11-18",
  "steps": 3200,
  "distanceMeters": 2240,
  "source": "mock",
  "syncedAt": "2026-11-18T05:30:00.000Z"
}
```
- `steps`, `distanceMeters`: 그날 0시부터의 **누적값**. 저장된 값보다 작으면 무시한다(줄어들지 않음). 각각 0 ~ 100,000
- `source`: `mock` | `healthkit` | `healthconnect`

응답 200: `{ "reward": null, ...걷기 현황 }`
- `reward`는 항상 `null`이다. (앱의 기존 응답 해석 코드가 깨지지 않게 남겨 둔 값)

#### `POST /walking/rewards/claim`

요청
```json
{ "date": "2026-11-19" }
```
응답 200: `{ "reward": { "coins": 20, "xp": 10 }, "rewardedSteps": [1000, 3000], ...걷기 현황 }`
- `reward`: 이번에 받은 합계, `rewardedSteps`: 이번에 받은 단계
- 받을 것이 없으면 `409 NOTHING_TO_CLAIM` (버튼을 두 번 눌렀을 때 등)

### 탐험: `POST /explore/trips` (앱 기준)

앱 `lib/explore-api.ts`.

요청
```json
{ "gochiId": "sprout", "durationMs": 3000, "dispatchedAt": "2026-11-18T05:30:00.000Z" }
```
- `gochiId`: `sprout` | `buddy` | `gachi`
- `durationMs`, `dispatchedAt`은 받지만 쓰지 않는다. **끝나는 시각은 서버가 정한다**(지금 3초, 조작 방지).

응답 201
```json
{ "tripId": "uuid", "endsAt": "2026-11-18T05:30:03.000Z", "gochiId": "sprout", "dispatchedAt": "...", "finished": false, "remaining": 2 }
```
- 앱이 쓰는 값은 `tripId`, `endsAt`. 나머지는 서버 추가 정보.
- 아직 끝나지 않은 탐험이 있으면 `409 EXPLORE_IN_PROGRESS`, 하루 3번을 넘으면 `429 DAILY_LIMIT_EXCEEDED`.
- 보상(알)은 지금 앱이 기기에서 뽑는다. 서버의 보상 받기 API(아래)를 부르지 않아도 다음 파견이 된다.

### 봉그깅: `POST /bongging/certifications` (앱 기준)

앱 `lib/bongging-certification.ts`의 `createBonggingSubmission`이 만드는 `multipart/form-data`.

| 필드 | | |
|---|---|---|
| `image` | 필수 | jpeg · png · heic · heif · webp, 10MB 이하 |
| `capturedAt` | 선택 | ISO 시각 |
| `locationSource` | 선택 | `exif` \| `device` \| `none` |
| `latitude`, `longitude` | 선택 | 둘 다 있을 때만 |

응답 200: 앱 `lib/bongging-reward.ts`의 `BonggingVerification` 모양 + 서버 추가 정보
```json
{
  "status": "success",
  "items": [{ "name": "플라스틱 병", "count": 5, "confidence": 95 }],
  "xp": 50,
  "growthStacks": 5,
  "message": "플라스틱 병을 확인했어요.",
  "certificationId": "uuid",
  "receivedAt": "...",
  "mode": "live",
  "stats": { "coins": 0, "xp": 50, "growth_stacks": 5 },
  "remainingToday": 4
}
```
- 쓰레기를 못 찾은 것은 오류가 아니라 `200` + `"status": "failure"`.
- 보상: 쓰레기 1개당 경험치 10 · 성장 1 (앱과 같음).
- 서버 추가 규칙: 사진 한 장에서 최대 10개까지만 보상, 같은 사진(내용 기준) 재사용 `409 DUPLICATE_IMAGE`,
  하루 성공 5번 · 시도 20번 넘으면 `429 DAILY_LIMIT_EXCEEDED`, Gemini가 바쁘거나 사용량 초과면 `503 AI_UNAVAILABLE`.

### (서버 추가) 그 밖의 API

| 요청 | 응답 |
|---|---|
| `GET /me` | `{ userId, isAnonymous, nickname, stats: { coins, xp, growthStacks }, eggs: { [eggId]: count } }` |
| `GET /explore/today` | `{ date, remaining, dailyLimit, trip }` (`trip`은 진행 중인 탐험 또는 `null`) |
| `POST /explore/trips/<tripId>/claim` | 끝난 탐험의 알을 서버가 뽑아 줌 `{ tripId, eggId, eggCount }`. 아직이면 `409 EXPLORE_NOT_FINISHED`, 이미 받았으면 `409 ALREADY_CLAIMED`. **앱은 아직 안 씀** (알을 서버에서 관리하게 바꿀 때 사용) |
| `GET /bongging/today` | `{ date, successes, attempts, dailyLimit, attemptLimit }` |

### 실패 응답

모든 실패는 `{ "error": { "code": "...", "message": "사용자에게 보여 줄 수 있는 한국어", "details": ... } }`

| 코드 | HTTP | 뜻 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 요청 값이 형식에 안 맞음 (`details.field`에 어느 값인지) |
| `INVALID_IMAGE` | 400 | 사진 형식·크기 |
| `UNAUTHORIZED` | 401 | 로그인 토큰 없음·만료 |
| `NOT_FOUND` | 404 | 없는 주소 |
| `METHOD_NOT_ALLOWED` | 405 | GET/POST 잘못 |
| `DUPLICATE_IMAGE` | 409 | 이미 인증에 쓴 사진 |
| `ALREADY_CLAIMED` | 409 | 이미 받은 보상 |
| `NOTHING_TO_CLAIM` | 409 | 지금 받을 수 있는 걷기 보상이 없음 |
| `EXPLORE_IN_PROGRESS` | 409 | 아직 끝나지 않은 탐험이 있음 |
| `EXPLORE_NOT_FINISHED` | 409 | 탐험이 아직 안 끝나서 보상 불가 |
| `DAILY_LIMIT_EXCEEDED` | 429 | 오늘 횟수 다 씀 |
| `AI_UNAVAILABLE` | 503 | 사진 판별 일시 불가 (잠시 후 다시) |
| `INTERNAL_ERROR` | 500 | 서버 오류 |

---

## DB

`supabase/migrations/` 의 SQL이 DB 구조 전부다. 대시보드에서 직접 표를 고치지 말고 마이그레이션 파일을 추가한다.

| 표 | 내용 |
|---|---|
| `profiles` | 닉네임 (가입하면 자동 생성) |
| `user_stats` | 코인 · 경험치 · 성장 (가입하면 자동 생성) |
| `walk_days` | 사람·날짜별 누적 걸음 수와 거리 |
| `walk_reward_claims` | 걷기 단계 보상 받은 기록 (날짜·단계마다 한 번) |
| `bongging_certifications` | 봉그깅 인증 (사진 경로, 위치, Gemini 결과, 보상) |
| `explore_trips` | 탐험 파견 |
| `user_eggs` | 고치 알 보유 수 |

- 모든 표에 RLS가 켜져 있다. 앱(로그인 사용자)은 **자기 데이터 읽기만** 할 수 있고, 프로필 닉네임만 고칠 수 있다.
- 기록 저장과 보상 지급은 **서버 함수만** 한다. 앱이 DB에 직접 쓰거나 보상 DB 함수를 부르면 403.
- 봉그깅 사진은 비공개 저장소 `bongging-photos/<user_id>/<인증 id>.<확장자>`에 저장되고 본인만 읽을 수 있다.

## 폴더

```
supabase/
  config.toml              로컬 실행 설정 (익명 로그인 켜짐, 함수별 verify_jwt=false: 함수 안에서 토큰 확인)
  migrations/              DB 구조 SQL (순서대로 적용)
  functions/
    _shared/http.ts        공통 응답 형식, 오류 코드, CORS
    _shared/supabase.ts    서버용 DB 연결, 로그인 확인
    _shared/rewards.ts     보상·제한 숫자 (앱 상수와 같게)
    _shared/gemini.ts      봉그깅 사진 판별 (Gemini)
    walking/ explore/ bongging/ me/   API 함수
tests/api-check.mjs        배포 서버가 이 명세대로 동작하는지 확인
```

## 비밀값 (Edge Function Secrets)

대시보드 Edge Functions → Secrets 에 넣는다. 예시는 `supabase/functions/.env.example`.

- `GEMINI_API_KEY` (필수, 넣어 둠)
- `GEMINI_MODEL` (선택, 기본 `gemini-3.5-flash-lite`)
- `ALLOW_MOCK` (선택, `1`이면 봉그깅에 `X-Mock-Result: success|failure|duplicate|limit|ai_down` 헤더로 가짜 결과. 배포에서는 비워 둔다)

## 배포

```bash
npx supabase login
npx supabase link --project-ref rlhdjijbnstdlfzjmxcd
npx supabase db push                                                 # DB 구조 (migrations)
npx supabase functions deploy walking explore bongging me --use-api  # 서버 함수
```

## 확인 (테스트)

```bash
SUPABASE_PUBLISHABLE_KEY=<publishable 키> npm run test:api                 # 걷기(버튼으로 받기)·탐험·권한
SUPABASE_PUBLISHABLE_KEY=<publishable 키> npm run test:api -- 사진.jpg     # 봉그깅(실제 Gemini)까지
```

실행할 때마다 새 익명 사용자를 만들어서 확인한다. 다른 사람의 데이터는 건드리지 않는다.

## 로컬 실행 (Docker 필요)

```bash
npm run db:start        # 로컬 Supabase (migrations 자동 적용)
npm run functions:serve # supabase/functions/.env 의 비밀값으로 함수 실행
```

폰 앱에서 로컬 서버에 붙일 때는 `127.0.0.1` 대신 컴퓨터의 와이파이 내부 IP(예: `http://192.168.0.5:54321`)를 쓴다.
