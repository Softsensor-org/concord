import 'server-only';
import path from 'node:path';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { COORD_DIR } from './coord-paths';
import { requireExternal } from './external-require';

/**
 * SEC-001 — coord-ui server-side access guard.
 *
 * STRICTLY READ-ONLY. This module decides whether a request may read a view and
 * at what role, and exposes role-aware redaction. It never mutates, spawns, or
 * executes anything — it only gates and redacts *reads*.
 *
 * The decision logic lives in coord/scripts/coord-ui-access-core.js: a zero-dep,
 * pure, edge-safe CJS module that is the SINGLE source of truth shared by this
 * server guard, the Next middleware, and the node:test suite — exactly the
 * in-process-load pattern lib/runtime-health.ts uses for gate-proc-registry.js,
 * so the gate (node:test) and the served behavior cannot drift.
 */

export type Role = 'viewer' | 'operator' | 'admin' | 'local';
export type RedactKind = 'path' | 'pid' | 'cmdline' | 'identity' | 'pr' | 'cost';

export interface AccessDecision {
  allowed: boolean;
  role: Role | null;
  reason: string;
  mode: string;
  redact: boolean;
}

interface AccessCore {
  decideAccess: (
    req: { host?: string; roleHeader?: string | null; authToken?: string | null },
    env: Record<string, unknown>
  ) => AccessDecision;
  shouldRedactForRole: (role: string | null) => boolean;
  redactField: (kind: RedactKind, value: unknown, role: string | null) => unknown;
  redactPath: (value: string) => string;
  DEFAULT_TRUSTED_HEADER: string;
  REDACTED: string;
}

function loadCore(): AccessCore {
  const modPath = path.join(COORD_DIR, 'scripts', 'coord-ui-access-core.js');
  return requireExternal<AccessCore>(modPath);
}

const core = loadCore();

/** Operator configuration, read from env once per request (read-only). */
function readEnv() {
  const trustLoopbackRaw = process.env.COORD_UI_TRUST_LOOPBACK;
  return {
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
}

function bearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

/**
 * Resolve the access decision for the current request from its headers. Server
 * components call this; it is the gate every sensitive view passes through.
 */
export async function getAccess(): Promise<AccessDecision> {
  const env = readEnv();
  const h = await headers();
  const host = h.get('host') || '';
  const roleHeader = h.get(env.trustedHeader);
  const authToken = bearer(h.get('authorization'));
  return core.decideAccess({ host, roleHeader, authToken }, env);
}

/** The effective role for the current request, or null if denied. */
export async function getRole(): Promise<Role | null> {
  const d = await getAccess();
  return d.allowed ? d.role : null;
}

/**
 * Guard a sensitive route. If the request is denied, render notFound() (a 404 —
 * we do not even confirm the route exists to an unauthorized caller). If a
 * minimum role is supplied, a lower-privilege role is also denied.
 *
 * Returns the effective role so the caller can drive redaction.
 */
export async function requireRole(min?: Role): Promise<Role> {
  const d = await getAccess();
  if (!d.allowed || !d.role) {
    notFound();
  }
  if (min && !roleMeets(d.role, min)) {
    notFound();
  }
  return d.role;
}

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3, local: 3 };
function roleMeets(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** True when the current role must have sensitive fields redacted. */
export function shouldRedact(role: Role | null): boolean {
  return core.shouldRedactForRole(role);
}

/** Role-aware redaction of a single sensitive field. Pure passthrough when privileged. */
export function redact<T>(kind: RedactKind, value: T, role: Role | null): T | string | null {
  return core.redactField(kind, value, role) as T | string | null;
}

export const REDACTED = core.REDACTED;
