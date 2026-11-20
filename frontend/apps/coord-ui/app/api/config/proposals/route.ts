import { NextResponse } from 'next/server';
import { requireRole } from '../../../../lib/access';
import { proposeConfig } from '../../../../lib/config-proposals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  await requireRole('operator');
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) {
    return NextResponse.json({ refusal: 'config proposal refused: same-origin request required' }, { status: 403 });
  }
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16 * 1024) {
    return NextResponse.json({ refusal: 'config proposal refused: request exceeds 16 KiB' }, { status: 413 });
  }
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('request body is missing');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 16 * 1024) {
        await reader.cancel();
        return NextResponse.json({ refusal: 'config proposal refused: request exceeds 16 KiB' }, { status: 413 });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ refusal: 'config proposal refused: request body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ refusal: 'config proposal refused: request body must be an object' }, { status: 400 });
  }
  const input = body as { target?: unknown; value?: unknown };
  if (typeof input.target !== 'string' || !input.value || typeof input.value !== 'object' || Array.isArray(input.value)) {
    return NextResponse.json({ refusal: 'config proposal refused: target and JSON object value are required' }, { status: 400 });
  }
  try {
    return NextResponse.json(proposeConfig(input.target, input.value));
  } catch (error) {
    return NextResponse.json({ refusal: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
