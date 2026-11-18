// 모든 Edge Function이 같이 쓰는 응답 형식
// - 성공: HTTP 2xx, 본문은 결과 객체 그대로
// - 실패: HTTP 4xx/5xx, 본문은 { error: { code, message, details? } }

export const ERRORS = {
  VALIDATION_ERROR: { status: 400, message: '요청 내용이 올바르지 않아요.' },
  INVALID_IMAGE: { status: 400, message: '사진 형식이나 크기를 확인해 주세요.' },
  UNAUTHORIZED: { status: 401, message: '로그인이 필요해요.' },
  NOT_FOUND: { status: 404, message: '요청한 주소를 찾을 수 없어요.' },
  METHOD_NOT_ALLOWED: { status: 405, message: '지원하지 않는 요청 방식이에요.' },
  DUPLICATE_IMAGE: { status: 409, message: '이미 인증에 쓴 사진이에요.' },
  ALREADY_CLAIMED: { status: 409, message: '이미 받은 보상이에요.' },
  NOT_ENOUGH_STEPS: { status: 409, message: '아직 걸음 수가 모자라요.' },
  EXPLORE_IN_PROGRESS: { status: 409, message: '이미 탐험 중인 고치가 있어요.' },
  EXPLORE_NOT_FINISHED: { status: 409, message: '아직 탐험이 끝나지 않았어요.' },
  DAILY_LIMIT_EXCEEDED: { status: 429, message: '오늘 할 수 있는 횟수를 다 썼어요.' },
  AI_UNAVAILABLE: { status: 503, message: '사진 확인이 잠시 어려워요. 조금 뒤에 다시 시도해 주세요.' },
  INTERNAL_ERROR: { status: 500, message: '서버에 문제가 생겼어요. 조금 뒤에 다시 시도해 주세요.' },
} as const;

export type ErrorCode = keyof typeof ERRORS;

// 웹 버전(브라우저)에서도 부를 수 있게 CORS를 연다. 앱(iOS·안드로이드)에는 영향이 없다.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-mock-result',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function ok(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

export function fail(code: ErrorCode, details?: unknown, message?: string): Response {
  const { status, message: fallback } = ERRORS[code];
  const error: Record<string, unknown> = { code, message: message ?? fallback };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status, headers: CORS_HEADERS });
}

// /functions/v1/<함수 이름>/<하위 경로> 에서 하위 경로만 꺼낸다. 예: /bongging/certifications → /certifications
export function subPath(req: Request, functionName: string): string {
  const path = new URL(req.url).pathname;
  const marker = `/${functionName}`;
  const at = path.indexOf(marker);
  const rest = at === -1 ? path : path.slice(at + marker.length);
  return rest === '' ? '/' : rest.replace(/\/+$/, '') || '/';
}

// 한국 시간 기준 오늘 날짜 (YYYY-MM-DD)
export function todayKst(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
