// 봉그깅 사진에서 쓰레기 찾기 (Gemini). 키는 서버 비밀값 GEMINI_API_KEY 에만 있다.
import { encodeBase64 } from '@std/encoding/base64';

// 앱(FE lib/bongging-recognition.ts)에서 쓰던 모델. 비밀값 GEMINI_MODEL 로 바꿀 수 있다.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const REQUEST_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `너는 쓰레기 줍기(플로깅) 인증 앱의 판별기야. 사용자가 보낸 사진에서 주운 쓰레기나 바닥에 버려진 쓰레기를 찾아.
- 쓰레기가 아닌 것(사람, 손, 풍경, 쓰레기통 자체, 아직 쓰고 있는 물건)은 세지 않아.
- 같은 품목은 하나로 묶고 count에 개수를 적어.
- name은 짧은 한국어 품목 이름으로 적어. 예: 플라스틱 병, 캔, 과자 봉지, 담배꽁초, 종이컵.
- confidence는 그 품목이 쓰레기라고 확신하는 정도를 0~100 정수로 적어.
- 쓰레기가 없거나 사진을 알아볼 수 없으면 items를 빈 배열로 둬.`;

const TRASH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          count: { type: 'INTEGER' },
          confidence: { type: 'INTEGER' },
        },
        required: ['name', 'count', 'confidence'],
      },
    },
  },
  required: ['items'],
};

export type TrashItem = { name: string; count: number; confidence: number };

// 키가 없거나, Gemini가 바쁘거나(503), 사용량을 넘었거나(429), 시간이 지난 경우
export class AiUnavailableError extends Error {}

export function geminiModel(): string {
  return Deno.env.get('GEMINI_MODEL') || DEFAULT_MODEL;
}

export async function recognizeTrash(image: Uint8Array, mimeType: string): Promise<TrashItem[]> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new AiUnavailableError('GEMINI_API_KEY 비밀값이 없어요');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: 'user',
            parts: [
              { text: '이 사진에 있는 쓰레기를 찾아줘.' },
              { inlineData: { mimeType, data: encodeBase64(image) } },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', responseSchema: TRASH_SCHEMA },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AiUnavailableError(`Gemini 요청 실패: ${error}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new AiUnavailableError(`Gemini ${response.status}: ${detail}`);
  }

  const json = await response.json();
  const text: string = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((part: { text?: string }) => part.text ?? '')
    .join('');
  if (!text) throw new AiUnavailableError('Gemini 응답에 글이 없어요');

  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiUnavailableError('Gemini 응답이 JSON이 아니에요');
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return {
        name: String(item.name ?? '').trim().slice(0, 30),
        count: Math.max(0, Math.round(Number(item.count) || 0)),
        confidence: Math.min(100, Math.max(0, Math.round(Number(item.confidence) || 0))),
      };
    })
    .filter((item) => item.name.length > 0 && item.count > 0);
}
