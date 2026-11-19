// 배포된 서버가 API 명세대로 동작하는지 확인한다. 실행할 때마다 새 익명 사용자를 만든다.
//
//   SUPABASE_PUBLISHABLE_KEY=sb_publishable_... node tests/api-check.mjs [봉그깅 테스트 사진 경로]
//
// - 사진 경로를 주면 봉그깅(실제 Gemini 호출)까지 확인한다. 안 주면 건너뛴다. (Gemini 무료 사용량 절약)
// - SUPABASE_URL 을 주면 다른 서버(로컬 등)를 확인한다. 기본은 배포 서버.
import { readFileSync } from 'node:fs';

const BASE = process.env.SUPABASE_URL ?? 'https://rlhdjijbnstdlfzjmxcd.supabase.co';
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const photoPath = process.argv[2];
if (!KEY) {
  console.error('SUPABASE_PUBLISHABLE_KEY 가 필요해요. (대시보드 Project Settings → API Keys 의 publishable 키)');
  process.exit(1);
}
const FN = `${BASE}/functions/v1`;

let pass = 0;
let failed = 0;
function check(name, cond, extra) {
  cond ? pass++ : failed++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 익명 로그인 (앱에서는 supabase.auth.signInAnonymously())
const signup = await fetch(`${BASE}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: KEY, 'content-type': 'application/json' },
  body: '{"data":{}}',
}).then((r) => r.json());
check('익명 로그인', !!signup.access_token, { isAnonymous: signup.user?.is_anonymous });
if (!signup.access_token) process.exit(1);

const H = { apikey: KEY, Authorization: `Bearer ${signup.access_token}` };
async function post(path, body) {
  const res = await fetch(`${FN}${path}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 로그인 없이
const noAuth = await fetch(`${FN}/me`);
check('토큰 없이 → 401', noAuth.status === 401, noAuth.status);

// 걷기 ("보상 받게" 버튼 방식: 저장은 records, 받기는 rewards/claim)
const walk = (steps, distanceMeters) =>
  post('/walking/records', { date: today, steps, distanceMeters, source: 'mock', syncedAt: new Date().toISOString() });
const pick = (j) => ({ steps: j.steps, claimable: j.claimableSteps, claimed: j.claimedSteps, reward: j.reward });
let r = await walk(500, 350);
check('걷기 500보 저장 → 받을 것 없음', r.status === 200 && r.json.reward === null && r.json.claimableSteps?.length === 0, pick(r.json));
r = await post('/walking/rewards/claim', { date: today });
check('받을 것 없을 때 버튼 → NOTHING_TO_CLAIM', r.json.error?.code === 'NOTHING_TO_CLAIM', r.json.error?.code);
r = await walk(3200, 2240);
check('걷기 3200보 저장 → 1000·3000 활성화, 아직 지급 안 함', r.json.reward === null && JSON.stringify(r.json.claimableSteps) === '[1000,3000]', pick(r.json));
r = await post('/walking/rewards/claim', { date: today });
check('버튼 → 활성화된 두 단계 한꺼번에 받기 (귤 20)', r.json.reward?.coins === 20 && r.json.reward?.xp === 10 && r.json.claimableSteps?.length === 0, pick(r.json));
r = await post('/walking/rewards/claim', { date: today });
check('바로 다시 버튼 → NOTHING_TO_CLAIM', r.json.error?.code === 'NOTHING_TO_CLAIM', r.json.error?.code);
r = await walk(100, 50);
check('더 작은 걸음 수 → 무시', r.json.steps === 3200, pick(r.json));
r = await walk(5100, 3600);
check('5100보 → 5000만 새로 활성화', JSON.stringify(r.json.claimableSteps) === '[5000]', pick(r.json));
const status = await fetch(`${FN}/walking/today?date=${today}`, { headers: H }).then((x) => x.json());
check('오늘 현황 (화면 열 때)', status.goalSteps === 10000 && status.distanceMeters === 3600 && status.tiers?.length === 3, status.tiers?.map((t) => [t.steps, t.reached, t.claimed]));
r = await post('/walking/rewards/claim', { date: today });
check('버튼 → 5000 단계 받기 (귤 10)', r.json.reward?.coins === 10 && JSON.stringify(r.json.rewardedSteps) === '[5000]', pick(r.json));
r = await post('/walking/records', { date: '2099-01-01', steps: 1, distanceMeters: 1, source: 'mock' });
check('미래 날짜 → 400', r.status === 400, r.json.error?.code);

// 탐험 (앱 lib/explore-api.ts 형식)
r = await post('/explore/trips', { gochiId: 'sprout', durationMs: 3000, dispatchedAt: new Date().toISOString() });
check('탐험 파견', r.status === 201 && typeof r.json.tripId === 'string' && typeof r.json.endsAt === 'string', { endsAt: r.json.endsAt });
const firstTrip = r.json.tripId;
r = await post('/explore/trips', { gochiId: 'buddy', durationMs: 3000 });
check('진행 중 다시 파견 → EXPLORE_IN_PROGRESS', r.json.error?.code === 'EXPLORE_IN_PROGRESS', r.json.error?.code);
await sleep(3500);
r = await post(`/explore/trips/${firstTrip}/claim`, {});
check('(서버 추가) 끝난 탐험 보상 받기 → 알', r.status === 200 && !!r.json.eggId, r.json);
r = await post('/explore/trips', { gochiId: 'buddy', durationMs: 3000 });
check('끝난 뒤 다시 파견', r.status === 201, { remaining: r.json.remaining });

// 봉그깅 (실제 Gemini)
if (photoPath) {
  const photo = readFileSync(photoPath);
  const type = photoPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const form = () => {
    const f = new FormData();
    f.append('image', new Blob([photo], { type }), photoPath.split(/[\\/]/).pop());
    f.append('capturedAt', new Date().toISOString());
    f.append('locationSource', 'none');
    return f;
  };
  const started = Date.now();
  const cert = await fetch(`${FN}/bongging/certifications`, { method: 'POST', headers: H, body: form() }).then((x) => x.json());
  check(`봉그깅 판별 (${((Date.now() - started) / 1000).toFixed(1)}초)`, cert.mode === 'live' && ['success', 'failure'].includes(cert.status), {
    status: cert.status,
    items: cert.items,
    xp: cert.xp,
    error: cert.error?.code,
  });
  const dup = await fetch(`${FN}/bongging/certifications`, { method: 'POST', headers: H, body: form() }).then((x) => x.json());
  check('같은 사진 → DUPLICATE_IMAGE', dup.error?.code === 'DUPLICATE_IMAGE', dup.error?.code);
} else {
  console.log('---- 봉그깅은 건너뜀 (사진 경로를 주면 확인)');
}

// 내 정보
const me = await fetch(`${FN}/me`, { headers: H }).then((x) => x.json());
check('내 정보 (귤코인 30)', me.stats?.coins === 30, me.stats);

// 권한: 앱이 DB에 직접 쓰거나 보상 DB 함수를 부를 수 없어야 한다
const rest = `${BASE}/rest/v1`;
const write = await fetch(`${rest}/user_stats?user_id=eq.${me.userId}`, {
  method: 'PATCH',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: '{"coins":999999}',
});
check('재화 직접 수정 → 거부', write.status === 401 || write.status === 403, write.status);
const rpc = await fetch(`${rest}/rpc/add_user_stats`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_user: me.userId, p_coins: 999, p_xp: 999, p_growth: 999 }),
});
check('보상 DB 함수 직접 호출 → 거부', [401, 403, 404].includes(rpc.status), rpc.status);

console.log(`\n통과 ${pass} / 실패 ${failed}`);
process.exit(failed ? 1 : 0);
