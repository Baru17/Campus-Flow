import { describe, expect, it } from "vitest";

import { appUrl, resolveAppOrigin } from "../src/utils/appUrl";
import { escapeHtml } from "../src/utils/email";
import {
  OD_APPROVED_HEADLINES,
  OD_FULLY_APPROVED_HEADLINE,
  OD_FULLY_APPROVED_SUBJECT,
  OD_REJECTED_HEADLINE,
  OD_REJECTED_SUBJECT,
  odApprovalRequestEmail,
  odDecisionEmail,
  odMentorAssignedEmail,
  type OdRequestFacts,
} from "../src/utils/odEmail";

/**
 * Unit coverage for the pure pieces of the mail layer: where a link points, and what a
 * message says.
 *
 * Both are pure string builders, so nothing is sent and no network is touched. Delivery is
 * the integration suite's business. What is pinned here is that the URL is always one of
 * ours, that the link carries no credential at all for any of the four stages, and that
 * nothing an approver types can corrupt the message they receive.
 *
 * There used to be a second action kind here -- `"email-link"`, a signed bearer token for a
 * Contest Coordinator or an HOD -- with three tests asserting what that token could do and
 * when it expired. Those are gone with the mechanism: all four roles now receive a dashboard
 * route and authenticate against it, so there is one kind of link and the credential check
 * below now covers every stage rather than two of them.
 */

const FACTS: OdRequestFacts = {
  odRequestId: "od-20261101-abc123",
  studentName: "Asha Raman",
  studentId: "22CS014",
  department: "CSE",
  batch: "2022_2026",
  year: 3,
  section: "A",
  odDates: ["2026-11-20", "2026-11-21"],
  odDays: 2,
  reason: "Attending an inter-college technical event",
};

const DASHBOARD_ACTION = {
  url: "https://campus-flow-cdl.pages.dev/staff",
  kind: "dashboard" as const,
};

/** The two roles that used to get a bearer link, now pointed at their own dashboards. */
const COORDINATOR_ACTION = {
  url: "https://campus-flow-cdl.pages.dev/coordinator",
  kind: "dashboard" as const,
};

const HOD_ACTION = {
  url: "https://campus-flow-cdl.pages.dev/hod",
  kind: "dashboard" as const,
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
    const message = odApprovalRequestEmail(FACTS, "Contest Coordinator", COORDINATOR_ACTION);

    expect(message.subject).toContain("Asha Raman");
    expect(message.subject).toContain("22CS014");
    expect(message.text).toContain("Contest Coordinator");
    expect(message.text).toContain("Attending an inter-college technical event");
    // Enough to find the request again without opening the database.
    expect(message.text).toContain(FACTS.odRequestId);
  });

  it("offers the action link in both the HTML and the plain text", () => {
    const message = odApprovalRequestEmail(FACTS, "HOD", HOD_ACTION);

    expect(message.html).toContain(`href="${HOD_ACTION.url}"`);
    expect(message.html).toContain("Review OD Request");
    expect(message.text).toContain(HOD_ACTION.url);
  });

  it("carries no credential in the link, for any stage", () => {
    /*
     * A dashboard link is only an address to arrive at. A token, a session id or an
     * approval in the query string would make the chain approvable by forwarding, so every
     * stage is checked for the absence of one -- all four, now that the coordinator and the
     * HOD get a link rather than a credential.
     */
    const stages: [string, typeof DASHBOARD_ACTION][] = [
      ["Mentor", DASHBOARD_ACTION],
      ["Class Advisor", DASHBOARD_ACTION],
      ["Contest Coordinator", COORDINATOR_ACTION],
      ["HOD", HOD_ACTION],
    ];
    for (const [stage, action] of stages) {
      const message = odApprovalRequestEmail(FACTS, stage, action);
      const link = message.html.match(/href="([^"]+)"/)?.[1] ?? "";
      const credentials = link.split(/[?#]/).slice(1).join("");
      expect(credentials, stage).not.toMatch(/token|session|approve|decision|sig|auth/i);
      expect(link, stage).not.toContain(FACTS.odRequestId);
    }
  });

  it("says the link cannot approve anything on its own, for every stage", () => {
    /*
     * This used to be true of only two stages. A coordinator and an HOD were told the
     * opposite -- that their link approved the request outright with no sign-in -- because
     * it was a bearer token. They no longer are, so the copy is now uniform, and this
     * asserts it holds for the two roles whose mail said otherwise.
     */
    for (const [stage, action] of [
      ["Mentor", DASHBOARD_ACTION],
      ["Contest Coordinator", COORDINATOR_ACTION],
      ["HOD", HOD_ACTION],
    ] as const) {
      const message = odApprovalRequestEmail(FACTS, stage, action);
      expect(message.html, stage).toContain("it cannot approve anything on its own");
      expect(message.text, stage).toContain("Sign in to Campus-Flow to review and action");
    }
  });

  it("tells every approver they will have to sign in", () => {
    for (const [stage, action] of [
      ["Mentor", DASHBOARD_ACTION],
      ["Class Advisor", DASHBOARD_ACTION],
      ["Contest Coordinator", COORDINATOR_ACTION],
      ["HOD", HOD_ACTION],
    ] as const) {
      const message = odApprovalRequestEmail(FACTS, stage, action);
      expect(message.text, stage).toContain("You will be asked to sign in");
    }
  });

  it("never mentions an expiry, because there is no longer a credential to expire", () => {
    // The 72-hour token is gone, so no approver mail may claim a link that times out.
    for (const [stage, action] of [
      ["Contest Coordinator", COORDINATOR_ACTION],
      ["HOD", HOD_ACTION],
    ] as const) {
      const message = odApprovalRequestEmail(FACTS, stage, action);
      expect(message.html, stage).not.toMatch(/expires?\b/i);
      expect(message.text, stage).not.toMatch(/expires?\b/i);
    }
  });

  it("never names a password, a session or an API key in any link", () => {
    for (const action of [DASHBOARD_ACTION, COORDINATOR_ACTION, HOD_ACTION]) {
      for (const stage of ["Mentor", "Class Advisor", "Contest Coordinator", "HOD"]) {
        const message = odApprovalRequestEmail(FACTS, stage, action);
        const link = message.html.match(/href="([^"]+)"/)?.[1] ?? "";
        expect(link.toLowerCase(), `${stage} ${action.url}`).not.toMatch(/password|pwd|api[-_]?key|session/i);
      }
    }
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
    const message = odApprovalRequestEmail(hostile, "Mentor", DASHBOARD_ACTION);

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
      { ...DASHBOARD_ACTION, url: "https://campus-flow-cdl.pages.dev/staff?a=1&b=2" }
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
    const message = odDecisionEmail(FACTS, OD_REJECTED_HEADLINE, "Your on-duty request was rejected.", {
      note: "Reason given: Lab clash",
    });

    expect(message.html).not.toContain("Review OD Request");
    expect(message.html).not.toContain("<a ");
    expect(message.text).toContain("Lab clash");
  });
});

describe("odDecisionEmail", () => {
  it("puts the batch in the facts table, not just the department", () => {
    /*
     * Three years of one department are indistinguishable from department + year + section
     * alone in some cohorts, and the student reading their own approval mail should be
     * able to see the cohort the days were granted against.
     */
    const message = odDecisionEmail(FACTS, OD_FULLY_APPROVED_HEADLINE, "Every stage has approved it.");
    expect(message.html).toContain("Batch");
    expect(message.html).toContain(FACTS.batch);
    expect(message.text).toContain(`Batch: ${FACTS.batch}`);
  });

  it("defaults its subject to the headline when none is given", () => {
    const message = odDecisionEmail(FACTS, "Some headline", "Body.");
    expect(message.subject).toBe("Some headline");
  });

  it("uses the search-friendly subject when one is given", () => {
    const rejected = odDecisionEmail(FACTS, OD_REJECTED_HEADLINE, "Body.", { subject: OD_REJECTED_SUBJECT });
    const approved = odDecisionEmail(FACTS, OD_FULLY_APPROVED_HEADLINE, "Body.", {
      subject: OD_FULLY_APPROVED_SUBJECT,
    });

    // This is what a student greps their inbox for, so the exact phrase has to be in it.
    expect(approved.subject).toContain("OD Request Approved");
    expect(rejected.subject).toContain("OD Request Rejected");
    // ...while the body still reads as a sentence rather than as a status name.
    expect(approved.html).toContain(OD_FULLY_APPROVED_HEADLINE);
    expect(rejected.html).toContain(OD_REJECTED_HEADLINE);
  });

  it("does not tell a student to sign in to review a request that has already been decided", () => {
    /*
     * This used to be the footer on every message built by the shared shell, so a student
     * whose leave had been fully approved was invited to go and action it. There is nothing
     * to action, and the mail is a report.
     */
    const message = odDecisionEmail(FACTS, OD_FULLY_APPROVED_HEADLINE, "Every stage has approved it.");
    expect(message.html).not.toContain("review and action this request");
    expect(message.text).not.toContain("review and action this request");
    expect(message.html).toContain("status of your on-duty requests");
  });

  it("renders an approver's note verbatim, whatever substitution patterns it contains", () => {
    /*
     * The bug this pins is real and was shipping. `String.replace` treats `$&`, `` $` ``,
     * `$'`, `$$` and `$1` in a *replacement string* as substitution patterns, and the
     * note is the one field in this module a human types freely -- so an approver who
     * rejected a request over "lab fee is $& the registration fee" produced a mail whose
     * facts table was cut off mid-value and whose closing tags were pasted into the middle
     * of the sentence. The student then received something unreadable, in the one message
     * they most needed to be able to read.
     */
    const hostileNotes = [
      "$&",
      "exam fee is $& tuition",
      "$$",
      "cost was $1 out of the budget",
      "$` and $' both",
      "100$ and 50$",
    ];

    for (const note of hostileNotes) {
      const message = odDecisionEmail(FACTS, OD_REJECTED_HEADLINE, "Rejected.", { note });

      // The whole facts table survives, so the message is still readable.
      expect(message.html, note).toContain(`>${FACTS.odRequestId}</td>`);
      // Exactly one closing sequence per tag level: the note is inserted, not spliced in.
      expect((message.html.match(/<\/table>/g) ?? []).length, note).toBe(2);
      expect((message.html.match(/<\/body>/g) ?? []).length, note).toBe(1);
      // The note appears in both renderings, escaped in the HTML and plain in the text.
      // `escapeHtml` is imported rather than reimplemented so this cannot quietly agree
      // with a bug in the escaping itself.
      expect(message.html, note).toContain(escapeHtml(note));
      expect(message.text, note).toContain(note);
      // No leftover substitution artefacts spliced in from the search string.
      expect(message.html, note).not.toContain("</td></tr></table>amp;");
      expect(message.html, note).not.toContain("#39; tick");
    }
  });

  it("escapes markup in an approver's note rather than rendering it", () => {
    const message = odDecisionEmail(FACTS, OD_REJECTED_HEADLINE, "Rejected.", {
      note: "<img src=x onerror=\"alert(1)\">",
    });

    expect(message.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(message.html).not.toMatch(/<img\b/i);
    // The plain-text rendering is not markup, so the raw characters are correct there.
    expect(message.text).toContain("<img src=x");
  });

  it("omits the note block entirely when there is no note", () => {
    const message = odDecisionEmail(FACTS, OD_APPROVED_HEADLINES.MENTOR, "Approved.");
    expect(message.html).not.toContain("From your approver");
    expect(message.text).not.toContain("From your approver");
    // And the table is still well formed.
    expect((message.html.match(/<\/table>/g) ?? []).length).toBe(2);
  });
});