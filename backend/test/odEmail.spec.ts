import { describe, expect, it } from "vitest";

import { appUrl, resolveAppOrigin } from "../src/utils/appUrl";
import {
  odApprovalRequestEmail,
  odDecisionEmail,
  odMentorAssignedEmail,
  type OdRequestFacts,
} from "../src/utils/odEmail";

/**
 * Unit coverage for the two pure pieces of the mail layer: where a link points, and what
 * an approval request says.
 *
 * Both are pure string builders, so nothing is sent and no network is touched. Delivery
 * itself is the integration suite's business, and it deliberately does not assert on mail
 * either -- see `studentOd.integration.spec.ts`. What is worth pinning down here is that
 * the URL is always one of ours, and that the link carries no credential.
 */

const FACTS: OdRequestFacts = {
  odRequestId: "od-20261101-abc123",
  studentName: "Asha Raman",
  studentId: "22CS014",
  department: "CSE",
  year: 3,
  section: "A",
  odDates: ["2026-11-20", "2026-11-21"],
  odDays: 2,
  reason: "Attending an inter-college technical event",
};

describe("resolveAppOrigin", () => {
  it("keeps localhost usable so the flow can be exercised in development", () => {
    expect(resolveAppOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(resolveAppOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    // Trailing whitespace from a header must not defeat the comparison.
    expect(resolveAppOrigin("  http://localhost:5173  ")).toBe("http://localhost:5173");
  });

  it("resolves anything else to production, including a missing header", () => {
    expect(resolveAppOrigin("https://evil.example")).toBe("https://campus-flow-cdl.pages.dev");
    expect(resolveAppOrigin("http://localhost:9999")).toBe("https://campus-flow-cdl.pages.dev");
    expect(resolveAppOrigin("http://localhost:5173.evil.example")).toBe(
      "https://campus-flow-cdl.pages.dev"
    );
    expect(resolveAppOrigin(null)).toBe("https://campus-flow-cdl.pages.dev");
    expect(resolveAppOrigin(undefined)).toBe("https://campus-flow-cdl.pages.dev");
    expect(resolveAppOrigin("")).toBe("https://campus-flow-cdl.pages.dev");
  });

  it("refuses a look-alike host that merely starts with a local one", () => {
    /*
     * The prefix case is the one an allow-list written with `startsWith` would let
     * through, handing a valid token to `localhost:5173.evil.example`. Exact comparison
     * is what prevents it, so it is worth a test of its own.
     */
    expect(resolveAppOrigin("https://localhost:5173.evil.example/steal")).toBe(
      "https://campus-flow-cdl.pages.dev"
    );
    expect(resolveAppOrigin("http://localhost:5173@evil.example")).toBe(
      "https://campus-flow-cdl.pages.dev"
    );
  });
});

describe("appUrl", () => {
  it("joins an origin and a path without doubling the slash", () => {
    expect(appUrl("https://campus-flow-cdl.pages.dev", "/staff")).toBe(
      "https://campus-flow-cdl.pages.dev/staff"
    );
    expect(appUrl("https://campus-flow-cdl.pages.dev/", "/staff")).toBe(
      "https://campus-flow-cdl.pages.dev/staff"
    );
    expect(appUrl("https://campus-flow-cdl.pages.dev", "staff")).toBe(
      "https://campus-flow-cdl.pages.dev/staff"
    );
  });
});

describe("odApprovalRequestEmail", () => {
  it("names the student in the subject and the role in the body", () => {
    const message = odApprovalRequestEmail(FACTS, "Contest Coordinator", "https://campus-flow-cdl.pages.dev/approver/login");

    expect(message.subject).toContain("Asha Raman");
    expect(message.subject).toContain("22CS014");
    expect(message.text).toContain("Contest Coordinator");
    expect(message.text).toContain("Attending an inter-college technical event");
    // Enough to find the request again without opening the database.
    expect(message.text).toContain(FACTS.odRequestId);
  });

  it("offers the action link in both the HTML and the plain text", () => {
    const url = "https://campus-flow-cdl.pages.dev/approver/login";
    const message = odApprovalRequestEmail(FACTS, "HOD", url);

    expect(message.html).toContain(`href="${url}"`);
    expect(message.html).toContain("Review OD Request");
    expect(message.text).toContain(url);
  });

  it("carries no credential in the link, in any stage", () => {
    /*
     * The whole reason a link is safe to put in mail is that it is only an address to
     * arrive at. A token, a session id or an approval in the query string would make the
     * chain approvable by forwarding, so every stage is checked for the absence of one.
     *
     * Matched against the query and fragment only: `/approver/login` contains the letters
     * of "approve", and a substring test over the whole URL would trip over the very path
     * these links are supposed to have.
     */
    for (const stage of ["Mentor", "Contest Coordinator", "Class Advisor", "HOD"]) {
      const message = odApprovalRequestEmail(FACTS, stage, "https://campus-flow-cdl.pages.dev/approver/login");
      const link = message.html.match(/href="([^"]+)"/)?.[1] ?? "";
      const credentials = link.split(/[?#]/).slice(1).join("");
      expect(credentials).not.toMatch(/token|session|approve|decision|sig|auth/i);
      expect(link).not.toContain(FACTS.odRequestId);
    }
  });

  it("says the link cannot approve anything on its own", () => {
    const message = odApprovalRequestEmail(FACTS, "HOD", "https://campus-flow-cdl.pages.dev/approver/login");
    expect(message.html).toContain("it cannot approve anything on its own");
    expect(message.text).toContain("Sign in to Campus-Flow");
  });

  it("renders a hostile reason as text rather than markup", () => {
    /*
     * `reason` is the one field a student types freely and an approver reads in a mail
     * client, so it is the one worth proving is escaped in both renderings.
     *
     * Asserted on the tag delimiters, not on `onerror=`: escaping turns `<img ...>` into
     * `&lt;img ...&gt;`, and the literal characters `onerror=` survive inside that inert
     * text. What matters is that no `<` survives to open a tag.
     */
    const hostile: OdRequestFacts = {
      ...FACTS,
      studentName: '<img src=x onerror="alert(1)">',
      reason: "<script>alert('xss')</script>",
    };
    const message = odApprovalRequestEmail(hostile, "Mentor", "https://campus-flow-cdl.pages.dev/staff");

    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Nothing between the escaped form and the end of the document opens a tag.
    expect(message.html).not.toMatch(/<(script|img)\b/i);
    // The plain-text rendering is not markup at all, so the raw characters are correct there.
    expect(message.text).toContain("<script>");
  });

  it("escapes an ampersand in the link so the href stays intact", () => {
    const message = odApprovalRequestEmail(
      FACTS,
      "Mentor",
      'https://campus-flow-cdl.pages.dev/staff?a=1&b=2'
    );
    expect(message.html).toContain("&amp;b=2");
    expect(message.html).not.toMatch(/href="[^"]*[^;]&b=2/);
  });
});

describe("messages with no action", () => {
  it("omits the button entirely for a mentor assignment", () => {
    const message = odMentorAssignedEmail(FACTS);
    expect(message.html).not.toContain("Review OD Request");
    expect(message.html).not.toContain("<a ");
  });

  it("omits the button for a decision, which has nowhere to go", () => {
    /*
     * A decision is a report of what has already happened, so there is nothing to click.
     * A link here would invite an approver to try to decide a settled request.
     */
    const message = odDecisionEmail(
      FACTS,
      "OD request rejected by the Mentor",
      "Your on-duty request was rejected at the Mentor stage.",
      "Reason given: Lab clash"
    );

    expect(message.html).not.toContain("Review OD Request");
    expect(message.html).not.toContain("<a ");
    expect(message.text).toContain("Lab clash");
  });
});