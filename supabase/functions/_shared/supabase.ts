// 서버 전용 Supabase 연결과 로그인 확인
import { createClient, type User } from '@supabase/supabase-js';
import { CORS_HEADERS, fail } from './http.ts';

// 배포된 함수에는 Supabase가 이 값들을 자동으로 넣어 준다. (로컬은 `supabase functions serve`가 넣어 준다)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = secretKey();

// 새 방식 비밀 키(SUPABASE_SECRET_KEYS, JSON)를 먼저 쓰고, 없으면 예전 service_role 키를 쓴다.
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    const key = keys.default ?? Object.values(keys)[0];
    if (key) return key;
  } catch {
    // 형식이 다르면 아래 예전 키로
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

// service_role 연결: RLS를 거치지 않으므로 서버 코드 안에서만 쓴다.
export const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Authorization: Bearer <사용자 토큰> 을 확인해 사용자를 돌려준다. 앱 키(anon)만 보낸 요청은 사용자가 없다.
export async function getUser(req: Request): Promise<User | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

type Handler = (req: Request, user: User) => Promise<Response>;

// 모든 함수의 바깥 껍데기: CORS 사전 요청 처리 → 로그인 확인 → 예외를 500으로
export function serveWithUser(handler: Handler) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: CORS_HEADERS });
    }
    try {
      const user = await getUser(req);
      if (!user) return fail('UNAUTHORIZED');
      return await handler(req, user);
    } catch (error) {
      console.error('[unhandled]', error);
      return fail('INTERNAL_ERROR');
    }
  });
}
