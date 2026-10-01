/*
 * The short-lived, single-use credential behind an emailed OD approval link.
 *
 * A Contest Coordinator and an HOD are reached by mail and nothing else: they have no
 * dashboard anyone reaches from the role selection, and asking them to type an email and
 * a password before they can read a request is a door in front of the request rather
 * than around it. So the link in their mail *is* their authorisation, and this module is
 * the whole of it.
 *
 * ## The shape of a token
 *
 * Two base64url segments joined by a dot:
 *
 *     <payload>.<hmac-sha256(payload)>
 *
 * The payload is JSON naming the request, the stage, the approver, when it was issued,
 * when it expires, and 32 bytes of cryptographically random nonce. The signature is
 * HMAC-SHA256 over the encoded payload under `OD_APPROVAL_TOKEN_SECRET`.
 *
 * ## Why it is signed rather than a row in the database
 *
 * A stored token needs a table, and this deliberately does not use one. There is already
 * a durable record of everything that matters -- the request row itself:
 *
 *   - *single use* is a property the workflow already enforces. `applyDecision` writes
 *     the verdict with `WHERE status = <the status this stage was waiting on>`, so a
 *     stage can be decided exactly once ever. Once it has been, this token's stage no
 *     longer matches the request's status and the token grants nothing. The verify path
 *     checks exactly that, so a spent link is indistinguishable from a forged one.
 *   - *bound to a request, a stage and an approver* is the payload's contents.
 *   - *time limited* is `expiresAt`, which the signature covers.
 *
 * So the security properties come from the state machine plus the signature, and adding
 * a table would add a second source of truth for "has this been used" that could
 * disagree with the first. It would also put token material in the same database as the
 * requests it authorises, which is exactly the pairing a leak would want.
 *
 * The consequence is stated rather than hidden: an unspent token stays *verifiable* until
 * it expires. What it cannot do is act -- the second it is used, or the second another
 * approver decides first, the request has moved on and the token is refused. Authority is
 * the request's status, never the token's age.
 *
 * ## What is deliberately not in a token
 *
 * No password, no API key, no session id, no `auth_user_id`, no `pwd_hash`, no student
 * address. The approver's own address is in there because it has to be -- it is the
 * identity the decision is recorded against, and without it a link could be forwarded to
 * whoever the forwarder liked. The request id is in there because the resolve route has
 * nothing else to look the request up by. Both are identifiers the intended recipient can
 * already see in the same email.
 */

import { STAGES, type OdStage } from "./odWorkflow";

/**
 * How long an emailed approval link stays usable.
 *
 * Long enough to cover a coordinator or an HOD who reads their mail once a day, short
 * enough that a link forwarded or left in a shared mailbox stops being useful quickly.
 * Three days also comfortably covers the whole chain: a student can be waiting on the
 * HOD for longer than this, and then the request simply needs a fresh link rather than a
 * fresh decision.
 */
export const OD_APPROVAL_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

/** The same figure in whole hours, for the email copy. */
export const OD_APPROVAL_TOKEN_TTL_HOURS = Math.round(OD_APPROVAL_TOKEN_TTL_MS / 3_600_000);

/**
 * Shortest secret accepted for signing.
 *
 * Signing with an empty or one-character secret would make the signature decorative, so
 * this refuses rather than degrading. 32 characters is the usual bar for an HMAC key.
 */
export const MIN_APPROVAL_TOKEN_SECRET_LENGTH = 32;

/** The Worker binding holding the signing secret. Never logged, never returned. */
export interface OdApprovalTokenBindings {
  OD_APPROVAL_TOKEN_SECRET?: string;
}

/** What a verified token authorises. Nothing here comes from the browser. */
export interface OdApprovalToken {
  /** The `od_requests` row this link is about. */
  odRequestId: string;
  /** The one stage this link may act at. */
  stage: OdStage;
  /** The address the decision will be recorded against. */
  approverEmail: string;
  /** Epoch milliseconds after which the link is refused. */
  expiresAt: number;
}

/** Raised when a link cannot be minted. Never carries the secret. */
export class OdApprovalTokenError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "OdApprovalTokenError";
    this.code = code;
  }
}

/** Payload version, so a future format change is detectable rather than misread. */
const TOKEN_VERSION = 1;

/** 32 bytes of nonce. */
const NONCE_BYTES = 32;

/**
 * The wire shape of the payload.
 *
 * Short keys because this is base64-encoded into a URL, and a readable name in a link
 * that gets copied and pasted is worth avoiding. `a` is the approver's address, `r` the
 * request id, `s` the stage key, `i` issued-at, `x` expires-at, `n` the nonce.
 */
interface TokenPayload {
  v: number;
  r: string;
  s: string;
  a: string;
  i: number;
  x: number;
  n: string;
}

/*
 * A token is `base64url(base64url(json))` plus a dot plus a signature, and both segments
 * are restricted to the URL-safe alphabet by construction. Pinning the shape anyway means
 * a hostile path segment is rejected before it is decoded, rather than becoming a decode
 * error that has to be told apart from a bad signature.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/* A generous ceiling. A real token is a few hundred bytes; anything larger is not one. */
const MAX_TOKEN_LENGTH = 4096;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  const remainder = value.length % 4;
  // A single trailing character cannot be the tail of any base64 block.
  if (remainder === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(remainder === 0 ? 0 : 4 - remainder);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < MIN_APPROVAL_TOKEN_SECRET_LENGTH) {
    /*
     * Thrown rather than defaulted. A weak or absent secret would still produce
     * tokens that verify against themselves, which is the worst outcome available: the
     * flow would look correct and the link would be forgeable. Failing closed surfaces it
     * in the log instead.
     */
    throw new OdApprovalTokenError(
      "The OD approval link signing secret is missing or too short.",
      "od-approval-secret-unusable"
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    // Not extractable: nothing can read the key back out of the Worker.
    false,
    ["sign", "verify"]
  );
}

function stageByKey(key: string): OdStage | null {
  const wanted = String(key ?? "").trim().toUpperCase();
  return STAGES.find((stage) => stage.key === wanted) ?? null;
}

/**
 * Mints a link for one approval action.
 *
 * The four inputs are the whole authorisation and every one of them comes from the
 * database -- the request being handed on, the stage it is now waiting on, and the
 * address that stage resolves to. Nothing here is taken from a request body.
 */
export async function issueApprovalToken(
  bindings: OdApprovalTokenBindings,
  input: { odRequestId: string; stage: OdStage; approverEmail: string; now?: number }
): Promise<{ token: string; expiresAt: string }> {
  const secret = (bindings.OD_APPROVAL_TOKEN_SECRET ?? "").trim();
  const key = await hmacKey(secret);

  const now = input.now ?? Date.now();
  const expiresAtMs = now + OD_APPROVAL_TOKEN_TTL_MS;
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    r: input.odRequestId,
    s: input.stage.key,
    a: input.approverEmail.trim().toLowerCase(),
    i: now,
    x: expiresAtMs,
    n: nonce,
  };

  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));

  return {
    token: `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Verifies a token and returns what it authorises, or null.
 *
 * Null covers every way a link can be unusable -- malformed, forged, expired, from a
 * different version of this format, or naming a stage that does not exist -- and callers
 * are expected to answer all of them identically. One message for every failure is what
 * stops the endpoint telling an attacker which of the checks they got past.
 *
 * Note what is *not* checked here: whether the request still exists, still waits on that
 * stage, or still belongs to that approver's department. Those need the database, so they
 * are the caller's next step, and `verifyApprover` makes them authoritatively for a
 * decision.
 */
export async function verifyApprovalToken(
  bindings: OdApprovalTokenBindings,
  token: unknown,
  now: number = Date.now()
): Promise<OdApprovalToken | null> {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(trimmed)) return null;

  const secret = (bindings.OD_APPROVAL_TOKEN_SECRET ?? "").trim();
  // A secret too short to have minted anything cannot verify anything.
  if (secret.length < MIN_APPROVAL_TOKEN_SECRET_LENGTH) return null;

  const separator = trimmed.indexOf(".");
  const encoded = trimmed.slice(0, separator);
  const signature = base64UrlDecode(trimmed.slice(separator + 1));
  if (!signature) return null;

  let key: CryptoKey;
  try {
    key = await hmacKey(secret);
  } catch {
    return null;
  }

  /*
   * `crypto.subtle.verify` is the comparison. It rejects a wrong length and compares the
   * rest without an early exit, so a byte-by-byte loop is not needed to avoid leaking the
   * signature through timing.
   */
  let authentic = false;
  try {
    authentic = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(encoded));
  } catch {
    return null;
  }
  if (!authentic) return null;

  const payloadBytes = base64UrlDecode(encoded);
  if (!payloadBytes) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as TokenPayload;
  } catch {
    return null;
  }

  if (!payload || payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.r !== "string" || !payload.r) return null;
  if (typeof payload.a !== "string" || !payload.a.includes("@")) return null;
  if (typeof payload.n !== "string" || !payload.n) return null;
  if (!Number.isFinite(payload.i) || !Number.isFinite(payload.x)) return null;

  const stage = stageByKey(String(payload.s));
  if (!stage) return null;

  /*
   * Expiry is checked last, after the signature has proved the payload is ours. Doing it
   * first would let an unsigned payload be probed for how long it claims to be alive,
   * which is a small leak about a link the caller already holds, but there is no reason
   * to make it possible.
   */
  if (payload.x <= now) return null;

  return {
    odRequestId: payload.r,
    stage,
    approverEmail: payload.a.trim().toLowerCase(),
    expiresAt: payload.x,
  };
}