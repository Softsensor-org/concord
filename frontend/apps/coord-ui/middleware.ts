import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { requireExternal } from './lib/external-require';

/**
 * SEC-001 — coord-ui edge access-control boundary.
 *
 * This is the FIRST fail-closed gate: in production an unauthenticated request is
 * rejected here before any server component runs. Localhost/dev stays ergonomic
 * (trusted-loopback → full local role, no auth). The per-route server guard
 * (lib/access.ts `requireRole`) is the defense-in-depth second layer that also
 * drives role-aware redaction.
 *
 * STRICTLY READ-ONLY: this middleware only ALLOWS or DENIES a read. It never
 * mutates, spawns, or executes anything.
 *
 * Runs on the Node.js runtime so it can load the SAME zero-dep decision core
 * (coord/scripts/coord-ui-access-core.js) the server guard and node:test use —
 * no duplicated, drift-prone edge reimplementation of the security decision.
 */
export const config = {
  // Gate everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs'
};

interface AccessCore {
  decideAccess: (
    req: { host?: string; roleHeader?: string | null; authToken?: string | null },
    env: Record<string, unknown>
  ) => { allowed: boolean; role: string | null; reason: string };
  DEFAULT_TRUSTED_HEADER: string;
}

function resolveCoreDir(): string {
  const env = process.env.COORD_DIR;
  if (env) return path.resolve(env, 'scripts');
  // Standard layout: coord/ is a sibling of frontend/.
  return path.resolve(process.cwd(), '../../../coord/scripts');
}

let cachedCore: AccessCore | null = null;
function loadCore(): AccessCore {
  if (cachedCore) return cachedCore;
  cachedCore = requireExternal<AccessCore>(path.join(resolveCoreDir(), 'coord-ui-access-core.js'));
  return cachedCore;
}

function bearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

export function middleware(request: NextRequest) {
  const core = loadCore();
  const trustLoopbackRaw = process.env.COORD_UI_TRUST_LOOPBACK;
  const env = {
    nodeEnv: process.env.NODE_ENV,
    authMode: process.env.COORD_UI_AUTH_MODE,
    trustedHeader: process.env.COORD_UI_TRUSTED_ROLE_HEADER || core.DEFAULT_TRUSTED_HEADER,
    sharedToken: process.env.COORD_UI_AUTH_TOKEN,
    defaultRole: process.env.COORD_UI_DEFAULT_ROLE,
    trustLoopback:
      trustLoopbackRaw === undefined
        ? undefined
        : trustLoopbackRaw === '1' || trustLoopbackRaw.toLowerCase() === 'true'
  };

  const trustedHeader = (env.trustedHeader as string) || core.DEFAULT_TRUSTED_HEADER;
  const host = request.headers.get('host') || '';
  const roleHeader = request.headers.get(trustedHeader);
  const authToken = bearer(request.headers.get('authorization'));

  const decision = core.decideAccess({ host, roleHeader, authToken }, env);

  if (!decision.allowed) {
    // Fail closed. No body detail that would aid enumeration.
    return new NextResponse('Forbidden', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  // Forward the resolved role to server components via a request header so the
  // per-route guard and redaction agree with the edge decision.
  const requestHeaders = new Headers(request.headers);
  if (decision.role) requestHeaders.set('x-coord-resolved-role', decision.role);
  return NextResponse.next({ request: { headers: requestHeaders } });
}
