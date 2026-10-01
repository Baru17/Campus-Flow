/**
 * The emailed approval token, tested as a credential rather than as a string builder.
 *
 * Everything here is about the ways a bearer credential gets abused: forged, tampered
 * with, replayed at the wrong request, replayed at the wrong stage, replayed after it has
 * expired, or minted with a secret so weak that none of the above means anything. None of
 * it needs a database -- the token is self-contained -- so this runs in the unit suite.
 *
 * What this file deliberately does *not* claim is single-use enforcement. The token is
 * spent by the workflow, not by the token: once the stage's decision is recorded the
 * request's status has moved on and every check in `resolveApprovalToken` refuses. That is
 * asserted in `odEmailApproval.integration.spec.ts` against a real request, because it is
 * a claim about the state machine rather than about this module.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_APPROVAL_TOKEN_SECRET_LENGTH,
  OD_APPROVAL_TOKEN_TTL_MS,
  OdApprovalTokenError,
  issueApprovalToken,
  verifyApprovalToken,
} from "../src/utils/odApprovalToken";
import { STAGES } from "../src/utils/odWorkflow";

/**
 * A 48-character secret. Long enough to clear the minimum, obviously not a real one --
 * and it lives in this test file only, which is the point.
 */
const SECRET = "unit-test-od-approval-secret-0123456789abcdef";
const OTHER_SECRET = "a-completely-different-secret-0123456789abc";

const COORDINATOR = STAGES.find((stage) => stage.key === "CONTEST_COORDINATOR")!;
const HOD = STAGES.find((stage) => stage.key === "HOD")!;

const NOW = 1_800_000_000_000;

function payloadOf(token: string): Record<string, unknown> {
  const encoded = token.split(".")[0];
  const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

describe("issuing an approval token", () => {
  it("produces something URL-safe with two segments", async () => {
    const { token } = await issueApprovalToken(
      { OD_APPROVAL_TOKEN_SECRET: SECRET },
      { odRequestId: "od-1", stage: COORDINATOR, approverEmail: "c@kiot.ac.in", now: NOW }
    );

    // Both segments are base64url, so the whole token survives a path segment untouched.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.split(".")).toHaveLength(2);
    // Nothing needs percent-encoding to put this in a link.
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("carries 32 bytes of random nonce, so two links for one request differ", async () => {
    const input = { odRequestId: "od-1", stage: COORDINATOR, approverEmail: "c@kiot.ac.in", now: NOW };
    const first = await issueApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, input);
    const second = await issueApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, input);

    /*
     * The nonce is what makes a re-issued link a *different* link rather than a
     * deterministic function of the request. Without it, re-sending an approval mail would
     * produce a byte-identical URL, and any recipient who had kept the old one would have a
     * credential that outlives the request to replace it.
     */
    expect(first.token).not.toBe(second.token);
    expect(payloadOf(first.token).n).toHaveLength(43); // 32 bytes, base64url, unpadded
    expect(payloadOf(first.token).n).not.toBe(payloadOf(second.token).n);

    // And the entropy is drawn per token, not per secret: 40 in a row are all distinct.
    const nonces = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      nonces.add(payloadOf((await issueApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, input)).token).n as string);
    }
    expect(nonces.size).toBe(40);
  });

  it("binds the request, the stage and the approver into the payload", async () => {
    const { token } = await issueApprovalToken(
      { OD_APPROVAL_TOKEN_SECRET: SECRET },
      {
        odRequestId: "11111111-2222-4333-8444-555555555555",
        stage: HOD,
        approverEmail: "  HOD.One@KIOT.ac.in ",
        now: NOW,
      }
    );

    const payload = payloadOf(token);
    expect(payload.r).toBe("11111111-2222-4333-8444-555555555555");
    expect(payload.s).toBe("HOD");
    // Lower-cased and trimmed, because it is matched against the directory later.
    expect(payload.a).toBe("hod.one@kiot.ac.in");
    expect(payload.v).toBe(1);
  });

  it("expires at the documented TTL", async () => {
    const { token, expiresAt } = await issueApprovalToken(
      { OD_APPROVAL_TOKEN_SECRET: SECRET },
      { odRequestId: "od-1", stage: COORDINATOR, approverEmail: "c@kiot.ac.in", now: NOW }
    );

    expect(new Date(expiresAt).getTime()).toBe(NOW + OD_APPROVAL_TOKEN_TTL_MS);
    // Three days: long enough for a coordinator who reads their mail once, short enough
    // that a link forwarded months later is worthless.
    expect(OD_APPROVAL_TOKEN_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(payloadOf(token).x).toBe(NOW + OD_APPROVAL_TOKEN_TTL_MS);
  });

  it("refuses to mint with a missing or weak secret rather than signing with it", async () => {
    for (const secret of [undefined, "", "   ", "short"]) {
      await expect(
        issueApprovalToken(
          { OD_APPROVAL_TOKEN_SECRET: secret },
          { odRequestId: "od-1", stage: COORDINATOR, approverEmail: "c@kiot.ac.in" }
        )
      ).rejects.toBeInstanceOf(OdApprovalTokenError);
    }
  });

  it("never puts the secret in the error it raises", async () => {
    const weak = "tooshortsecret";
    try {
      await issueApprovalToken(
        { OD_APPROVAL_TOKEN_SECRET: weak },
        { odRequestId: "od-1", stage: COORDINATOR, approverEmail: "c@kiot.ac.in" }
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(weak);
      expect((error as OdApprovalTokenError).code).toBe("od-approval-secret-unusable");
    }
    expect(MIN_APPROVAL_TOKEN_SECRET_LENGTH).toBe(32);
  });
});

describe("verifying an approval token", () => {
  async function mint(overrides: Partial<Parameters<typeof issueApprovalToken>[1]> = {}) {
    return issueApprovalToken(
      { OD_APPROVAL_TOKEN_SECRET: SECRET },
      {
        odRequestId: "od-1",
        stage: COORDINATOR,
        approverEmail: "coordinator.one@kiot.ac.in",
        now: NOW,
        ...overrides,
      }
    );
  }

  it("returns exactly what it authorises", async () => {
    const { token } = await mint({ stage: HOD, approverEmail: "HOD.One@KIOT.ac.in" });
    const resolved = await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, NOW);

    expect(resolved).not.toBeNull();
    expect(resolved!.odRequestId).toBe("od-1");
    expect(resolved!.stage.key).toBe("HOD");
    expect(resolved!.stage.label).toBe("HOD");
    expect(resolved!.approverEmail).toBe("hod.one@kiot.ac.in");
    expect(resolved!.expiresAt).toBe(NOW + OD_APPROVAL_TOKEN_TTL_MS);
  });

  it("refuses a token signed with a different secret", async () => {
    const { token } = await mint();
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: OTHER_SECRET }, token, NOW)).toBeNull();
  });

  it("refuses anything that is not a token at all", async () => {
    const inputs: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "not-a-token",
      "onlyone-segment",
      "one.two.three",
      "no-dots-here",
      "a.b",
      `${"x".repeat(5000)}.y`,
      12345,
      { token: "a.b" },
      ["a", "b"],
    ];

    for (const input of inputs) {
      expect(
        await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, input, NOW),
        JSON.stringify(input)?.slice(0, 40)
      ).toBeNull();
    }
  });

  it("refuses a token whose payload has been edited to name another request", async () => {
    /*
     * The signature covers the *encoded* payload, so any edit to the decoded JSON changes
     * the bytes that were signed and the check fails. This is the attack the whole design
     * exists to stop: rewriting the request id so one coordinator's link decides somebody
     * else's request.
     */
    const { token } = await mint();
    const [encoded, signature] = token.split(".");
    const payload = payloadOf(token);
    payload.r = "someone-elses-request";

    const forgedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${forgedPayload}.${signature}`, NOW)).toBeNull();
    // And the original is untouched.
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${encoded}.${signature}`, NOW)).not.toBeNull();
  });

  it("refuses a token whose payload has been edited to name another stage", async () => {
    const { token } = await mint({ stage: HOD });
    const signature = token.split(".")[1];
    const payload = payloadOf(token);
    payload.s = "CONTEST_COORDINATOR";

    const forgedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("refuses a token whose payload has been edited to name another approver", async () => {
    const { token } = await mint();
    const signature = token.split(".")[1];
    const payload = payloadOf(token);
    payload.a = "someone.else@kiot.ac.in";

    const forgedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("refuses a token whose expiry has been pushed into the future", async () => {
    const { token } = await mint();
    const signature = token.split(".")[1];
    const payload = payloadOf(token);
    payload.x = NOW + 10 * OD_APPROVAL_TOKEN_TTL_MS;

    const forgedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("refuses a truncated or re-signed signature", async () => {
    const { token } = await mint();
    const [encoded, signature] = token.split(".");

    /*
     * One character short, and one character different.
     *
     * The change is made in the middle rather than at the end on purpose. Base64 leaves
     * unused bits in the final character of a segment, so altering *that* character can
     * decode back to the identical bytes -- a different string carrying the very same
     * signature, which would make this test pass without testing anything.
     */
    const midpoint = Math.floor(signature.length / 2);
    const flipped =
      signature.slice(0, midpoint) +
      (signature[midpoint] === "A" ? "B" : "A") +
      signature.slice(midpoint + 1);

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${encoded}.${signature.slice(0, -1)}`, NOW)).toBeNull();
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${encoded}.${flipped}`, NOW)).toBeNull();
    // Sanity: the two really are different strings, so the refusal above was about the bytes.
    expect(flipped).not.toBe(signature);
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, NOW)).not.toBeNull();
  });

  it("refuses an expired token, and accepts it right up to its expiry", async () => {
    const { token } = await mint();
    const expiresAt = NOW + OD_APPROVAL_TOKEN_TTL_MS;

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, expiresAt - 1)).not.toBeNull();
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, expiresAt)).toBeNull();
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, expiresAt + 1)).toBeNull();
    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, token, expiresAt * 4)).toBeNull();
  });

  it("refuses everything when the secret is absent or weak", async () => {
    const { token } = await mint();
    for (const secret of [undefined, "", "  ", "weak"]) {
      expect(
        await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: secret }, token, NOW)
      ).toBeNull();
    }
  });

  it("refuses a payload naming a stage the chain does not have", async () => {
    /*
     * Only reachable by signing one yourself, which needs the secret -- but the check is
     * what stops a future stage, a typo, or a hand-rolled payload from turning into an
     * approver for a role that does not exist.
     */
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const payload = {
      v: 1,
      r: "od-1",
      s: "PRINCIPAL",
      a: "p@kiot.ac.in",
      i: NOW,
      x: NOW + OD_APPROVAL_TOKEN_TTL_MS,
      n: "x".repeat(43),
    };
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded))
    );
    const sigB64 = btoa(String.fromCharCode(...signature))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyApprovalToken({ OD_APPROVAL_TOKEN_SECRET: SECRET }, `${encoded}.${sigB64}`, NOW)).toBeNull();
  });
});