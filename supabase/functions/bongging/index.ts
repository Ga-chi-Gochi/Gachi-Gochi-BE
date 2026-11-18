// 봉그깅 인증 API
//   POST /functions/v1/bongging/certifications   (multipart/form-data)
//     image (필수, jpeg·png·heic·heif·webp, 10MB 이하)
//     capturedAt (선택, ISO 시각) · locationSource (선택, exif|device|none) · latitude · longitude (선택)
//   GET  /functions/v1/bongging/today            → 오늘 성공·시도 횟수
//
// 순서: 같은 사진인지 → 오늘 횟수 → Gemini 판별 → 사진 저장 → 기록 저장 → 성공이면 보상 지급
//
// 테스트용: 비밀값 ALLOW_MOCK=1 일 때만 헤더 X-Mock-Result(success|failure|duplicate|limit|ai_down)로
// Gemini와 DB 없이 정해진 응답을 받을 수 있다. 이때는 아무것도 저장하지 않고 보상도 주지 않는다.
import { fail, ok, subPath, todayKst } from '../_shared/http.ts';
import { admin, serveWithUser } from '../_shared/supabase.ts';
import { AiUnavailableError, geminiModel, recognizeTrash, type TrashItem } from '../_shared/gemini.ts';
import {
  BONGGING_DAILY_ATTEMPT_LIMIT,
  BONGGING_DAILY_LIMIT,
  BONGGING_GROWTH_PER_TRASH,
  BONGGING_MAX_TRASH_PER_PHOTO,
  BONGGING_MIN_CONFIDENCE,
  BONGGING_XP_PER_TRASH,
} from '../_shared/rewards.ts';

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LOCATION_SOURCES = ['exif', 'device', 'none'];
const PHOTO_BUCKET = 'bongging-photos';

// 마지막 글자에 받침이 있으면 '을', 없으면 '를' (FE와 같은 규칙)
function objectParticle(word: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return '을(를)';
  return code % 28 === 0 ? '를' : '을';
}

function verify(allItems: TrashItem[]) {
  const items = allItems.filter((item) => item.confidence >= BONGGING_MIN_CONFIDENCE);
  const total = Math.min(
    BONGGING_MAX_TRASH_PER_PHOTO,
    items.reduce((sum, item) => sum + item.count, 0),
  );
  if (total === 0) {
    return {
      status: 'failure' as const,
      items: [] as TrashItem[],
      xp: 0,
      growthStacks: 0,
      message: '이번 사진에서는 쓰레기를 확인하지 못했어요.',
    };
  }
  const names = items.map((item) => item.name).join(', ');
  return {
    status: 'success' as const,
    items,
    xp: total * BONGGING_XP_PER_TRASH,
    growthStacks: total * BONGGING_GROWTH_PER_TRASH,
    message: `${names}${objectParticle(names)} 확인했어요.`,
  };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function optionalNumber(value: FormDataEntryValue | null, min: number, max: number): number | null | undefined {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined; // undefined = 잘못된 값
}

function mockResponse(kind: string) {
  const base = { certificationId: crypto.randomUUID(), receivedAt: new Date().toISOString(), mode: 'mock' };
  switch (kind) {
    case 'duplicate':
      return fail('DUPLICATE_IMAGE');
    case 'limit':
      return fail('DAILY_LIMIT_EXCEEDED', { limit: BONGGING_DAILY_LIMIT });
    case 'ai_down':
      return fail('AI_UNAVAILABLE');
    case 'failure':
      return ok({ ...base, ...verify([]) });
    default:
      return ok({
        ...base,
        ...verify([
          { name: '플라스틱 병', count: 1, confidence: 92 },
          { name: '과자 봉지', count: 1, confidence: 88 },
        ]),
      });
  }
}

async function todayCounts(userId: string, date: string) {
  const { data, error } = await admin
    .from('bongging_certifications')
    .select('status')
    .eq('user_id', userId)
    .eq('kst_date', date);
  if (error) throw error;
  return {
    successes: data.filter((row) => row.status === 'success').length,
    attempts: data.length,
  };
}

serveWithUser(async (req, user) => {
  const path = subPath(req, 'bongging');

  if (path === '/today') {
    if (req.method !== 'GET') return fail('METHOD_NOT_ALLOWED');
    const date = todayKst();
    const counts = await todayCounts(user.id, date);
    return ok({
      date,
      successes: counts.successes,
      attempts: counts.attempts,
      dailyLimit: BONGGING_DAILY_LIMIT,
      attemptLimit: BONGGING_DAILY_ATTEMPT_LIMIT,
    });
  }

  if (path !== '/certifications') return fail('NOT_FOUND');
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');

  const mock = req.headers.get('x-mock-result');
  if (mock && Deno.env.get('ALLOW_MOCK') === '1') return mockResponse(mock);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('VALIDATION_ERROR', { field: 'body' }, 'multipart/form-data 형식으로 보내 주세요.');
  }

  const image = form.get('image');
  if (!(image instanceof File)) {
    return fail('VALIDATION_ERROR', { field: 'image' }, '사진(image)이 없어요.');
  }
  const extension = IMAGE_TYPES[image.type];
  if (!extension) {
    return fail('INVALID_IMAGE', { field: 'image', type: image.type, allowed: Object.keys(IMAGE_TYPES) });
  }
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
    return fail('INVALID_IMAGE', { field: 'image', size: image.size, maxBytes: MAX_IMAGE_BYTES });
  }

  const latitude = optionalNumber(form.get('latitude'), -90, 90);
  const longitude = optionalNumber(form.get('longitude'), -180, 180);
  if (latitude === undefined || longitude === undefined) {
    return fail('VALIDATION_ERROR', { field: 'latitude/longitude' }, '위치 값이 올바르지 않아요.');
  }
  const locationSourceRaw = String(form.get('locationSource') ?? 'none');
  const locationSource = LOCATION_SOURCES.includes(locationSourceRaw) ? locationSourceRaw : 'none';
  const capturedAtRaw = form.get('capturedAt');
  const capturedAtDate = typeof capturedAtRaw === 'string' ? new Date(capturedAtRaw) : null;
  const capturedAt = capturedAtDate && !Number.isNaN(capturedAtDate.getTime()) ? capturedAtDate.toISOString() : null;

  const bytes = new Uint8Array(await image.arrayBuffer());
  const imageSha256 = await sha256Hex(bytes);

  // 1) 같은 사진
  const { data: duplicate, error: dupError } = await admin
    .from('bongging_certifications')
    .select('id')
    .eq('user_id', user.id)
    .eq('image_sha256', imageSha256)
    .maybeSingle();
  if (dupError) throw dupError;
  if (duplicate) return fail('DUPLICATE_IMAGE');

  // 2) 오늘 횟수
  const today = todayKst();
  const counts = await todayCounts(user.id, today);
  if (counts.successes >= BONGGING_DAILY_LIMIT) {
    return fail('DAILY_LIMIT_EXCEEDED', { limit: BONGGING_DAILY_LIMIT, kind: 'success' });
  }
  if (counts.attempts >= BONGGING_DAILY_ATTEMPT_LIMIT) {
    return fail('DAILY_LIMIT_EXCEEDED', { limit: BONGGING_DAILY_ATTEMPT_LIMIT, kind: 'attempt' });
  }

  // 3) Gemini 판별
  let found: TrashItem[];
  try {
    found = await recognizeTrash(bytes, image.type);
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      console.error('[bongging] AI unavailable:', error.message);
      return fail('AI_UNAVAILABLE');
    }
    throw error;
  }
  const result = verify(found);

  // 4) 사진 저장 (실패해도 인증은 계속한다)
  const certificationId = crypto.randomUUID();
  const imagePath = `${user.id}/${certificationId}.${extension}`;
  const { error: uploadError } = await admin.storage
    .from(PHOTO_BUCKET)
    .upload(imagePath, bytes, { contentType: image.type, upsert: false });
  if (uploadError) console.error('[bongging] photo upload failed:', uploadError.message);

  // 5) 기록 저장
  const receivedAt = new Date().toISOString();
  const { error: insertError } = await admin.from('bongging_certifications').insert({
    id: certificationId,
    user_id: user.id,
    kst_date: today,
    received_at: receivedAt,
    captured_at: capturedAt,
    latitude,
    longitude,
    location_source: locationSource,
    image_path: uploadError ? null : imagePath,
    image_sha256: imageSha256,
    status: result.status,
    items: result.items,
    xp: result.xp,
    growth_stacks: result.growthStacks,
    model: geminiModel(),
  });
  if (insertError) {
    // 동시에 같은 사진을 두 번 보낸 경우
    if (insertError.code === '23505') return fail('DUPLICATE_IMAGE');
    throw insertError;
  }

  // 6) 보상
  let stats = null;
  if (result.status === 'success') {
    const { data, error } = await admin.rpc('add_user_stats', {
      p_user: user.id,
      p_coins: 0,
      p_xp: result.xp,
      p_growth: result.growthStacks,
    });
    if (error) throw error;
    stats = data;
  }

  // 쓰레기를 못 찾은 것은 오류가 아니라 정상 판정 결과라서 200으로 돌려준다
  return ok({
    certificationId,
    receivedAt,
    mode: 'live',
    ...result,
    stats,
    remainingToday: Math.max(0, BONGGING_DAILY_LIMIT - counts.successes - (result.status === 'success' ? 1 : 0)),
  });
});
