"use strict";

// COORD-144: [Memory] Cross-cutting — memory permission CLASSIFICATION layer.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 principle 4 ("permission
// classification") and §12.3 ("data governance"), memory artifacts are
// classified into one of FOUR classes and enforced through the EXISTING ENT-012
// RBAC redaction layer (the optional tier's RBAC policy, when that tier ships):
//
//   public            — safe for anyone (ticket id, status, high-level decision).
//   internal          — operational detail (filesystem paths, identities, gate
//                       specifics) — redacted for viewer, shown to operator+.
//   sensitive         — provenance/evidence bodies, costs — redacted below the
//                       operator trust boundary per ENT-012.
//   secret-prohibited — secrets/tokens/keys that MUST NEVER be stored in memory
//                       at all. REFUSE/REDACT-ALWAYS in BOTH cuts; a detector
//                       flags secret-like content so it is never surfaced.
//
// WHY A SEPARATE LAYER (not a recall rewrite): COORD-141's recall.js already
// delegates redaction to ENT-012 (`--role`, best-effort load, graceful community
// degradation). This module adds the EXPLICIT artifact-classification taxonomy
// on TOP of that — it does NOT reimplement RBAC. Each class maps to an ENT-012
// ROLE THRESHOLD (the lowest role at which the class is revealed) and to an
// ENT-012 REDACTION KIND, so enforcement is delegated to ENT-012's
// `shouldRedactForRole` / `redactField` rather than re-derived here.
//
// CARDINAL GUARDRAIL (§5). Classification NEVER fabricates and NEVER weakens the
// guardrail: secret-prohibited content is refused/redacted regardless of role
// AND regardless of cut. A viewer never sees verbatim evidence; nobody — not
// even admin/auditor — sees a stored secret, because secrets must never enter
// memory in the first place.
//
// ZERO new runtime deps. Pure functions; no fs/process/network. ENT-012 is
// loaded BEST-EFFORT by the caller (recall.js) and passed in — there is NO hard
// core->tier dependency, so the community cut (the optional tier stripped)
// degrades to the documented safe default.

// --- the taxonomy (as data) --------------------------------------------------
// Each class declares:
//   - rank          ordering (public < internal < sensitive < secret-prohibited)
//   - minRole       the LOWEST ENT-012 operational role at which the class is
//                   REVEALED unredacted. `null` for public (everyone sees it);
//                   `false` for secret-prohibited (NOBODY sees it — always
//                   refused). Mapped onto ENT-012's role lattice, not redefined.
//   - redactionKind the ENT-012 REDACTION_KIND used to redact a field of this
//                   class (so redaction is delegated to ENT-012.redactField).
//   - desc          human description.
//
// ENT-012's UNREDACTED_ROLES = {operator, maintainer, admin, auditor}; viewer is
// the only redacted operational role. So mapping `internal` and `sensitive` to
// minRole "operator" means: viewer is redacted, operator+ is full — exactly the
// ticket's "viewer gets redacted summaries, operator/admin get full provenance".
const CLASSES = Object.freeze({
  public: Object.freeze({
    rank: 0,
    minRole: null, // everyone, including an unknown/absent role
    redactionKind: null, // never redacted
    desc: "Safe for anyone: ticket id, status, high-level decision label.",
  }),
  internal: Object.freeze({
    rank: 1,
    minRole: "operator", // viewer redacted; operator+ full
    redactionKind: "path", // operational detail (paths/identities) -> path/identity kind
    desc: "Operational detail (filesystem paths, identities, gate specifics).",
  }),
  sensitive: Object.freeze({
    rank: 2,
    minRole: "operator", // viewer redacted; operator+ full (per ENT-012 trust model)
    redactionKind: "evidence", // provenance/evidence bodies, costs
    desc: "Provenance/evidence bodies and costs (verbatim decision text).",
  }),
  "secret-prohibited": Object.freeze({
    rank: 3,
    minRole: false, // NOBODY — always refused/redacted, in BOTH cuts
    redactionKind: "evidence",
    desc: "Secrets/tokens/keys that must NEVER be stored in memory at all.",
  }),
});

const CLASS_NAMES = Object.freeze(Object.keys(CLASSES));

function isClass(name) {
  return Object.prototype.hasOwnProperty.call(CLASSES, name);
}

// --- secret-prohibited detector ----------------------------------------------
// Detect secret-LIKE content so it is never surfaced. This is deliberately
// conservative + deterministic (no model): a small set of high-signal patterns
// for the credential shapes that must never live in governed memory. A match
// means "treat as secret-prohibited regardless of any other classification".
//
// Patterns cover: private key PEM blocks, common provider token prefixes
// (GitHub ghp_/gho_/ghs_, Slack xox*, AWS AKIA, Google AIza, OpenAI/Anthropic
// sk-/sk-ant-), JWTs, and explicit "<secret-word>: <value>" assignments. The
// goal is detect-and-refuse at the memory boundary, not exhaustive DLP.
const SECRET_PATTERNS = Object.freeze([
  // PEM private key blocks.
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  // Provider API key / token prefixes.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, // GitHub PAT / OAuth / server / refresh
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, // Slack tokens
  /\bAKIA[0-9A-Z]{12,}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Google API key
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/, // OpenAI / Anthropic secret keys
  // JWT (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Explicit "<secretword> = / : <value>" assignments (token/secret/password/
  // api[_-]key/private[_-]key/access[_-]key) with a non-trivial value. A
  // prefix like "AWS_" is allowed (no leading word-boundary) since "_" is a word
  // char and would otherwise block "AWS_SECRET_KEY".
  /(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|private[_-]?key|password|passwd|token|bearer|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9/+_=-]{8,}/i,
]);

// True iff `value` contains secret-like content that must never be surfaced.
function looksLikeSecret(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  return SECRET_PATTERNS.some((re) => re.test(value));
}

// --- field-level classification rules ----------------------------------------
// Classify ONE memory field (a logical role within an artifact) given its name
// and value. Secret detection runs FIRST and overrides everything: any value
// that looks like a secret is `secret-prohibited` no matter the field name.
//
// Field-name rules (deterministic, data-driven):
//   id / ticket_id / status / type / confidence / staleness / verified / kind
//       -> public  (high-level, non-sensitive descriptors)
//   path / chain_head / event_hash / identity / owner / handle / session
//   / pid / cmdline / gate / verification
//       -> internal  (operational detail)
//   everything else (snippet / answer / evidence / findings / risks / cost /
//   decision bodies) -> sensitive  (verbatim provenance/evidence)
const PUBLIC_FIELDS = new Set([
  "id",
  "ticket_id",
  "status",
  "type",
  "confidence",
  "staleness",
  "verified",
  "kind",
  "verdict",
  "class",
  "classification",
]);

const INTERNAL_FIELDS = new Set([
  "path",
  "source_path",
  "chain_head",
  "event_hash",
  "identity",
  "owner",
  "handle",
  "session",
  "session_id",
  "pid",
  "cmdline",
  "gate",
  "verification",
  "branch",
  "worktree",
]);

function classifyField(fieldName, value) {
  // Secret detection overrides all field-name rules: a secret value is
  // secret-prohibited even in a field that would otherwise be public/internal.
  if (looksLikeSecret(value)) {
    return "secret-prohibited";
  }
  const name = String(fieldName || "").toLowerCase();
  if (PUBLIC_FIELDS.has(name)) {
    return "public";
  }
  if (INTERNAL_FIELDS.has(name)) {
    return "internal";
  }
  // Default-conservative: unrecognized fields carry verbatim provenance/evidence
  // and are treated as sensitive (revealed only at the operator+ trust boundary).
  return "sensitive";
}

// Classify a whole recall citation `source` object into the HIGHEST (most
// restrictive) class any of its fields warrants. Used to label each cited
// source with a classification for the caller/UI.
function classifySource(source) {
  if (!source || typeof source !== "object") {
    return "public";
  }
  let top = "public";
  for (const [k, v] of Object.entries(source)) {
    const cls = classifyField(k, v);
    if (CLASSES[cls].rank > CLASSES[top].rank) {
      top = cls;
    }
  }
  return top;
}

// --- mapping classification -> ENT-012 enforcement ---------------------------
// Decide whether a field of class `cls` should be redacted for `role`, and how,
// by COMPOSING the ENT-012 policy (passed in best-effort by the caller). This is
// the SINGLE place classification is mapped onto the existing RBAC layer — RBAC
// is NOT reimplemented.
//
// Trust model (mirrors recall.js): the local governed CLI is a trusted
// operational caller, so NO explicit role => the operational (unredacted) view
// — EXCEPT secret-prohibited, which is refused even there. With an explicit
// role, enforcement defers to ENT-012:
//   - public            -> never redacted.
//   - internal/sensitive -> redacted iff the role is below the class minRole
//                           (delegated to ENT-012.shouldRedactForRole, which
//                           makes viewer redacted and operator+ full).
//   - secret-prohibited  -> ALWAYS redacted, every role, both cuts.
//
// Community cut (no ENT-012): `policy` is null/!shouldRedactForRole. We FAIL
// SAFE — public passes; secret-prohibited is ALWAYS redacted; internal/sensitive
// follow recall's documented community default of NOT differentiating by role
// (no role lattice is available), i.e. they pass UNREDACTED for the trusted
// local operational caller. secret-prohibited never relaxes in either cut.
function shouldRedactClass(cls, role, policy) {
  const def = CLASSES[isClass(cls) ? cls : "sensitive"];
  // secret-prohibited: never reveal, any role, any cut.
  if (def.minRole === false) {
    return true;
  }
  // public: never redact.
  if (def.minRole === null) {
    return false;
  }
  // No explicit role => trusted local operational caller => no redaction
  // (matches recall.js resolveRedaction default).
  if (role == null) {
    return false;
  }
  // Explicit role + ENT-012 present: delegate to the RBAC redaction decision.
  // ENT-012's UNREDACTED_ROLES (operator/maintainer/admin/auditor) satisfy the
  // operator+ threshold; viewer (the only redacted operational role) does not.
  if (policy && typeof policy.shouldRedactForRole === "function") {
    return policy.shouldRedactForRole(role);
  }
  // Community cut: no role lattice available -> safe default is no role
  // differentiation for internal/sensitive (recall's documented stance);
  // secret-prohibited already handled above.
  return false;
}

// Redact a classified field value for a role, composing ENT-012's redactField
// when the class is redacted. secret-prohibited is ALWAYS replaced with the
// refusal marker (never the raw value), independent of the policy/cut. For
// internal/sensitive we use the class's ENT-012 redaction kind so the redaction
// SHAPE matches the rest of the cockpit (path -> basename, evidence -> marker).
const SECRET_REFUSAL = "[secret-prohibited: refused — secrets must never be stored in memory]";

function redactClassifiedField(cls, fieldName, value, role, policy) {
  const klass = isClass(cls) ? cls : "sensitive";
  if (klass === "secret-prohibited") {
    return SECRET_REFUSAL;
  }
  if (!shouldRedactClass(klass, role, policy)) {
    return value;
  }
  const kind = CLASSES[klass].redactionKind;
  // Prefer the field's own ENT-012 kind for paths (basename redaction); fall
  // back to the class default kind.
  const useKind =
    String(fieldName || "").toLowerCase() === "path" ? "path" : kind || "evidence";
  if (policy && typeof policy.redactField === "function") {
    return policy.redactField(useKind, value, role);
  }
  // Community-cut fallback (policy absent but redaction still required, i.e.
  // secret handled above already): mask conservatively.
  return "[redacted]";
}

module.exports = {
  CLASSES,
  CLASS_NAMES,
  SECRET_REFUSAL,
  isClass,
  looksLikeSecret,
  classifyField,
  classifySource,
  shouldRedactClass,
  redactClassifiedField,
};
