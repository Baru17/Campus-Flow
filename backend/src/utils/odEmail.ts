/*
 * The OD workflow's messages, rendered and ready for `sendBrevoEmail`.
 *
 * This file builds messages and sends nothing. The transport, the API key, the
 * sender and the error types all live in `utils/email.ts`, which the password reset
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
 *    `auth_user_id`, no pwd_hash. What goes out is the student's name, ID,
 *    department, year, section, the dates, the count, the reason and the request
 *    id -- enough for an approver to recognise the request and act on it, and
 *    nothing an approver has no business seeing.
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
 */
export interface OdRequestFacts {
  odRequestId: string;
  studentName: string;
  studentId: string;
  department: string;
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
    { label: "Year", value: String(facts.year) },
    { label: "Section", value: facts.section },
    { label: "OD dates", value: facts.odDates.join(", ") },
    { label: "Number of OD days", value: String(facts.odDays) },
    { label: "Reason", value: facts.reason },
    { label: "Request ID", value: facts.odRequestId },
  ];
}

/**
 * The shared shell: a heading, a paragraph, the facts table, and optionally a button.
 *
 * The button is the only thing that differs between a message with an action and one
 * without, so it is a parameter rather than a second layout.
 */
function buildShell(
  heading: string,
  intro: string,
  facts: OdRequestFacts,
  actionUrl?: string
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

  // Built only when there is an action, and escaped like every other substituted value.
  const button = actionUrl
    ? `<p style="margin:24px 0 0;">
         <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">Review OD Request</a>
       </p>
       <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#64748b;">You will be asked to sign in. The link only takes you to the right dashboard — it cannot approve anything on its own.</p>`
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
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Sign in to Campus-Flow to review and action this request.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    heading,
    "",
    intro,
    "",
    ...plainRows,
    "",
    ...(actionUrl ? ["Review OD Request:", actionUrl, ""] : []),
    "Sign in to Campus-Flow to review and action this request.",
  ].join("\n");

  return { html, text };
}

/**
 * An approval *request*, addressed to the approver for one stage.
 *
 * One message for all four stages. The subject names the student so an approver with
 * a queue of requests can triage it, and the heading names the role so it is obvious
 * why it reached them. The request id is in the facts table, which is what lets an
 * approver find it again after the mail has scrolled away.
 *
 * `actionUrl` is the approver's dashboard. It carries no credential of any kind: a
 * mentor or an advisor has to sign in at the link they already know how to reach, and a
 * coordinator or HOD arrives at the approver sign-in page and authenticates there. A
 * link that could approve on its own would make the whole chain unauthenticated, so the
 * URL is an address to *arrive* at, never a permission.
 */
export function odApprovalRequestEmail(
  facts: OdRequestFacts,
  stageLabel: string,
  actionUrl: string
): OdMessage {
  const subject = `CampusFlow — OD approval needed: ${facts.studentName} (${facts.studentId})`;
  const { html, text } = buildShell(
    "OD request awaiting your approval",
    `${facts.studentName} has requested on-duty leave and your approval is needed as the ${stageLabel}.`,
    facts,
    actionUrl
  );
  return { subject, html, text };
}

/**
 * A decision on the student's request, addressed to the student.
 *
 * `note` carries the approver's own words. It is escaped like everything else,
 * because it is free text typed by whoever holds the stage and is the one part of
 * these messages not derived from the student's own request.
 */
export function odDecisionEmail(
  facts: OdRequestFacts,
  headline: string,
  body: string,
  note?: string
): OdMessage {
  const { html, text } = buildShell(headline, body, facts);
  if (!note) return { subject: headline, html, text };

  const block =
    `<p style="margin:18px 0 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(
      note
    )}</p></td></tr></table>`;

  return {
    subject: headline,
    html: html.replace("</td></tr></table>", block),
    text: `${text}\n\nFrom your approver:\n${note}`,
  };
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

/** The rejection headline. One for every stage, because one thing went wrong. */
export const OD_REJECTED_HEADLINE = "Your OD request has been rejected";

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