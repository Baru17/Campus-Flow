/*
 * The OD workflow's messages, rendered and ready for `sendBrevoEmail`.
 *
 * This file builds messages and sends nothing. The transport, the API key, the sender
 * and the error types all live in `utils/email.ts`, which the password reset
 * mail already uses, so there is one email provider in this project and adding the
 * OD mail did not add a second one.
 *
 * Two rules govern everything here.
 *
 * 1. **The database is the source of truth, and these are only ever called after
 *    the write.** Nothing in this module decides whether a decision happened; the
 *    route stores it first and then asks for the mail. A caller wanting the reverse
 *    could notify a student about an approval that was rolled back, so the ordering
 *    is enforced by where these are called rather than by anything inside them.
 *
 * 2. **A message never carries a credential.** No password, no session token, no
 *    `auth_user_id`, no pwd_hash, and no bearer token. What goes out is the student's
 *    name, ID, department, batch, year, section, the dates, the count, the reason and
 *    the request id: enough for an approver to recognise the request and act on it,
 *    and nothing an approver has no business seeing.
 *
 *    The "Review OD Request" button is a plain dashboard route for all four stages,
 *    including the two that used to receive a signed approval link. Those roles are
 *    permanent authenticated users now, so their mail points at a page they sign in to
 *    like everyone else, and knowing the path authorises nothing. There is no longer
 *    an exception to this rule, which is why it is stated as a flat rule rather than a
 *    rule with a carve-out.
 */

import { escapeHtml } from "./email";

/** A rendered message, with the recipient left to the caller. */
export interface OdMessage {
  subject: string;
  html: string;
  text: string;
}

/**
 * The details every OD message shares.
 *
 * One shape for all thirteen messages, so the tables in them line up and a student
 * comparing the mail about stage two with the one about stage three sees the same
 * request rather than two different-looking ones.
 *
 * `batch` is here because an approver deciding between three years of the same
 * department cannot do it from department/year/section alone, and because a student
 * reading their own approval mail should be able to see the cohort the days were
 * approved against.
 */
export interface OdRequestFacts {
  odRequestId: string;
  studentName: string;
  studentId: string;
  department: string;
  batch: string;
  year: number | string;
  section: string;
  odDates: string[];
  odDays: number;
  reason: string;
}

function factsRows(facts: OdRequestFacts): { label: string; value: string }[] {
  return [
    { label: "Student", value: facts.studentName },
    { label: "Student ID", value: facts.studentId },
    { label: "Department", value: facts.department },
    { label: "Batch", value: facts.batch },
    { label: "Year", value: String(facts.year) },
    { label: "Section", value: facts.section },
    { label: "OD dates", value: facts.odDates.join(", ") },
    { label: "Number of OD days", value: String(facts.odDays) },
    { label: "Reason", value: facts.reason },
    { label: "Request ID", value: facts.odRequestId },
  ];
}

/** The closing line for a message that reports something that has already happened. */
const DECISION_FOOTER =
  "Sign in to Campus-Flow to see the status of your on-duty requests.";

/**
 * The shared shell: a heading, a paragraph, the facts table, an optional action, an
 * optional note, and a closing line.
 *
 * Every part is a parameter and every part is rendered where it belongs. Nothing is
 * patched in afterwards: the previous version built the message and then spliced the
 * approver's note in with `html.replace("</td></tr></table>", ...)`, which put the note
 * inside the last cell of the facts table and -- because `String.replace` honours `$&`,
 * `` $` ``, `$'`, `$$` and `$1` in a replacement string, and the note is free text typed by
 * a human -- destroyed the message entirely whenever an approver's reason contained a
 * dollar sign. A student rejecting "lab fee is $& tuition" received a mail with the table
 * cut off mid-value.
 */
function buildShell(
  heading: string,
  intro: string,
  facts: OdRequestFacts,
  options: { action?: string; actionNote?: string; note?: string; footer?: string } = {}
): { html: string; text: string } {
  const rows = factsRows(facts)
    .map(
      (row) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(
          row.label
        )}</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escapeHtml(row.value)}</td></tr>`
    )
    .join("");

  const plainRows = factsRows(facts).map((row) => `${row.label}: ${row.value}`);

  const footer = options.footer ?? DECISION_FOOTER;

  // Built only when there is an action, and escaped like every other substituted value.
  const button = options.action
    ? `<p style="margin:24px 0 0;">
         <a href="${escapeHtml(options.action)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">Review OD Request</a>
       </p>
       ${
         options.actionNote
           ? `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(
               options.actionNote
             )}</p>`
           : ""
       }`
    : "";

  const note = options.note
    ? `<p style="margin:18px 0 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(
        options.note
      )}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
      <tr>
        <td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;">${escapeHtml(heading)}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(intro)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">${rows}</table>
          ${button}
          ${note}
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#64748b;">${escapeHtml(
            footer
          )}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textSections = [heading, intro, plainRows.join("\n")];
  if (options.action) {
    textSections.push(
      ["Review OD Request:", options.action, "", options.actionNote ?? ""].join("\n").trimEnd()
    );
  }
  if (options.note) textSections.push(`From your approver:\n${options.note}`);
  textSections.push(footer);
  const text = textSections.join("\n\n");

  return { html, text };
}

/**
 * What the "Review OD Request" button in an approver's mail does.
 *
 * One kind, and it is a dashboard route for all four stages. A mentor is staff and has
 * `/staff`; a class advisor has `/advisor`; and a Contest Coordinator and an HOD have
 * `/coordinator` and `/hod` since they became permanent authenticated users. Every one of
 * them signs in, and the server checks the session and the role before anything is decided.
 *
 * There was a second kind once. A Contest Coordinator and an HOD used to be sent a signed,
 * time-limited *bearer* link instead, because they had no account to sign in with: it opened
 * the request directly with no sign-in step, and it expired. That is what this replaced, and
 * the note below is worded to say so -- an approver reading this mail now always has to
 * authenticate, which is the intended behaviour rather than a step to apologise for.
 *
 * The link carries no credential of any kind, so it cannot be forwarded into an approval.
 */
export interface OdApprovalAction {
  url: string;
  kind: "dashboard";
}

/** The closing copy under the button. */
const ACTION_NOTE =
  "You will be asked to sign in. The link only takes you to the right dashboard — it cannot approve anything on its own.";

/** The closing line under the button. */
const ACTION_FOOTER = "Sign in to Campus-Flow to review and action this request.";

/**
 * An approval *request*, addressed to the approver for one stage.
 *
 * One message for all four stages. The subject names the student so an approver with
 * a queue of requests can triage it, and the heading names the role so it is obvious
 * why it reached them. The request id is in the facts table, which is what lets an
 * approver find it again after the mail has scrolled away.
 */
export function odApprovalRequestEmail(
  facts: OdRequestFacts,
  stageLabel: string,
  action: OdApprovalAction
): OdMessage {
  const subject = `CampusFlow — OD approval needed: ${facts.studentName} (${facts.studentId})`;
  const { html, text } = buildShell(
    "OD request awaiting your approval",
    `${facts.studentName} has requested on-duty leave and your approval is needed as the ${stageLabel}.`,
    facts,
    {
      action: action.url,
      actionNote: ACTION_NOTE,
      footer: ACTION_FOOTER,
    }
  );
  return { subject, html, text };
}

/**
 * A decision on the student's request, addressed to the student.
 *
 * `note` carries the approver's own words. It is escaped like everything else, because it
 * is free text typed by whoever holds the stage and is the one part of these messages not
 * derived from the student's own request -- so it is the one part that has to survive
 * arbitrary characters.
 *
 * There is deliberately no string surgery anywhere in this file any more. An earlier
 * version rendered the shell and then spliced the note in with
 * `html.replace("</td></tr></table>", block)`, which was wrong twice over: it dropped the
 * note inside the last cell of the facts table, and because `String.prototype.replace`
 * interprets `$&`, `` $` ``, `$'`, `$$` and `$1` in a replacement string, an approver who
 * rejected a request over "exam fee is $& tuition" produced a mail with the facts table cut
 * off mid-value and the document's closing tags pasted into the middle of the sentence. The
 * student received something unreadable in the one message they most needed to read. The
 * note is now a parameter of `buildShell` and is rendered where it belongs.
 */
export function odDecisionEmail(
  facts: OdRequestFacts,
  headline: string,
  body: string,
  options: { note?: string; subject?: string } = {}
): OdMessage {
  const subject = options.subject ?? headline;
  const { html, text } = buildShell(headline, body, facts, {
    footer: DECISION_FOOTER,
    ...(options.note ? { note: options.note } : {}),
  });
  return { subject, html, text };
}

/** The headline each of the four stage approvals produces. */
export const OD_APPROVED_HEADLINES: Record<string, string> = {
  MENTOR: "Your OD request has been approved by your mentor",
  CONTEST_COORDINATOR: "Your OD request has been approved by the Contest Coordinator",
  CLASS_ADVISOR: "Your OD request has been approved by your Class Advisor",
  HOD: "Your OD request has been approved by your HOD",
};

/** The final, end-of-workflow headline. Deliberately different from the stage ones. */
export const OD_FULLY_APPROVED_HEADLINE = "Your OD request has been fully approved";

/**
 * The subject for the final approval.
 *
 * Split from the headline on purpose. The headline is what a student reads in the body,
 * and reads as prose; in a subject line, sitting in their inbox among everything else,
 * "OD Request Approved" is the phrase they will actually be looking for when they need
 * to know whether their leave was cleared.
 */
export const OD_FULLY_APPROVED_SUBJECT = "CampusFlow — OD Request Approved";

/** The rejection headline. One for every stage, because one thing went wrong. */
export const OD_REJECTED_HEADLINE = "Your OD request has been rejected";

/** The rejection subject. A rejection is the mail a student is most likely to search for. */
export const OD_REJECTED_SUBJECT = "CampusFlow — OD Request Rejected";

/** The mentor-assignment headline, as required by the mentor notification. */
export const OD_MENTOR_ASSIGNED_SUBJECT = "CampusFlow — New Student Mentor Assignment";

/**
 * The mail a newly allocated mentor receives.
 *
 * Separate from the thirteen workflow messages because it is not about a request --
 * there is no request id yet, and no request will exist until the student files one.
 * It tells the mentor what they have taken on and that they will be asked to review
 * on-duty requests, which is the part that is actionable for them.
 *
 * Only the student's own facts travel. No account identifier, no cohort table name,
 * and of course nothing secret: the mentor does not need the student's credentials
 * to approve their OD, and must never be able to act on their account.
 */
export function odMentorAssignedEmail(facts: {
  studentName: string;
  studentId: string;
  department: string;
  year: number | string;
  section: string;
}): OdMessage {
  const heading = "New student mentor assignment";
  const intro =
    "A student has chosen you as their mentor. You will be asked to review their on-duty requests.";

  const rows: { label: string; value: string }[] = [
    { label: "Student", value: facts.studentName },
    { label: "Student ID", value: facts.studentId },
    { label: "Department", value: facts.department },
    { label: "Year", value: String(facts.year) },
    { label: "Section", value: facts.section },
  ];

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;">
    <tr><td style="padding:32px;">
      <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(intro)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">${rows
        .map(
          (row) =>
            `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(
              row.label
            )}</td><td style="padding:6px 0;color:#0f172a;font-size:13px;">${escapeHtml(row.value)}</td></tr>`
        )
        .join("")}</table>
      <p style="margin:20px 0 0;font-size:13px;color:#64748b;">Sign in to Campus-Flow to view your OD approvals.</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: OD_MENTOR_ASSIGNED_SUBJECT,
    html,
    text: [heading, "", intro, "", ...rows.map((row) => `${row.label}: ${row.value}`), "", "Sign in to Campus-Flow to view your OD approvals."].join("\n"),
  };
}