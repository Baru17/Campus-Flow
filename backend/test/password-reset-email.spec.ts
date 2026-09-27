import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendPasswordResetEmail,
  EmailNotConfiguredError,
  EmailDeliveryError,
} from "../src/utils/email";

const API_KEY = "xkeysib-test-secret-value";

function stubFetch(response: { status: number; body?: unknown }) {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(response.body ?? {}), {
			status: response.status,
			headers: { "Content-Type": "application/json" },
		});
	});
	return calls;
}

const resetUrl =
	"https://campus-flow-cdl.pages.dev/reset-password?token=11111111-2222-3333-4444-555555555555";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Brevo password reset email", () => {
	it("refuses to send without a configured API key", async () => {
		stubFetch({ status: 202 });
		await expect(
			sendPasswordResetEmail({}, { to: "student@kiot.ac.in", resetUrl })
		).rejects.toBeInstanceOf(EmailNotConfiguredError);

		await expect(
			sendPasswordResetEmail({ BREVO_API_KEY: "   " }, { to: "student@kiot.ac.in", resetUrl })
		).rejects.toBeInstanceOf(EmailNotConfiguredError);
	});

	it("posts to the Brevo REST endpoint with the key in the header only", async () => {
		const calls = stubFetch({ status: 202, body: { messageId: "<abc@brevo>" } });

		await sendPasswordResetEmail(
			{ BREVO_API_KEY: API_KEY },
			{ to: "Student@KIOT.ac.in ", toName: "Test Student", resetUrl }
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
		expect(calls[0].init.method).toBe("POST");

		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers["api-key"]).toBe(API_KEY);
		expect(headers["Content-Type"]).toBe("application/json");

		const payload = JSON.parse(String(calls[0].init.body));
		expect(payload.sender).toEqual({ name: "Campus-Flow", email: "campusflow.kiot@gmail.com" });
		expect(payload.to[0].email).toBe("student@kiot.ac.in");
		expect(payload.to[0].name).toBe("Test Student");
	});

	it("embeds the reset link in both the HTML and plain-text parts", async () => {
		const calls = stubFetch({ status: 202 });

		await sendPasswordResetEmail({ BREVO_API_KEY: API_KEY }, { to: "student@kiot.ac.in", resetUrl });

        const payload = JSON.parse(String(calls[0].init.body));
        expect(payload.htmlContent).toContain(resetUrl);
        expect(payload.textContent).toContain(resetUrl);
        expect(payload.htmlContent).toContain("30 minutes");
	});

	it("escapes a hostile display name instead of injecting markup", async () => {
		const calls = stubFetch({ status: 202 });

		await sendPasswordResetEmail(
			{ BREVO_API_KEY: API_KEY },
			{ to: "student@kiot.ac.in", toName: '<img src=x onerror="alert(1)">', resetUrl }
		);

        const payload = JSON.parse(String(calls[0].init.body));
        expect(payload.htmlContent).not.toContain("<img src=x");
        expect(payload.htmlContent).toContain("&lt;img src=x");
	});

	it("rejects a recipient that is not an address", async () => {
		stubFetch({ status: 202 });
		await expect(
			sendPasswordResetEmail({ BREVO_API_KEY: API_KEY }, { to: "not-an-email", resetUrl })
		).rejects.toBeInstanceOf(EmailDeliveryError);
	});

	/*
	 * A provider rejection must not turn into a response or a log line carrying
	 * the key or the live reset link.
	 */
	it("keeps the API key and the reset link out of the failure", async () => {
		stubFetch({ status: 401, body: { code: "unauthorized", message: API_KEY } });

		const error = await sendPasswordResetEmail(
			{ BREVO_API_KEY: API_KEY },
			{ to: "student@kiot.ac.in", resetUrl }
		).catch((err) => err as EmailDeliveryError);

		expect(error).toBeInstanceOf(EmailDeliveryError);
		expect((error as EmailDeliveryError).status).toBe(401);
		expect(String((error as EmailDeliveryError).message)).not.toContain(API_KEY);
		expect(String((error as Error).stack ?? "")).not.toContain(resetUrl);
	});
});
