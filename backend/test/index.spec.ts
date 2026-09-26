import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { isTransientD1Error } from "../src/utils/databaseErrors";
import { studentMatchesAttendanceClass } from "../src/utils/attendance";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Campus-Flow worker", () => {
	it("serves the health endpoint (unit style)", async () => {
		const request = new IncomingRequest("http://example.com/api/health");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });
	});

	it("serves the health endpoint (integration style)", async () => {
		const response = await SELF.fetch("https://example.com/api/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });
	});

	it("exposes a scheduled handler on the default export", () => {
		expect(typeof worker.fetch).toBe("function");
		expect(typeof (worker as { scheduled?: unknown }).scheduled).toBe("function");
	});

	it("requires authentication before OTP verification", async () => {
		const response = await SELF.fetch("https://example.com/api/attendance/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ otp: "123456" }),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth-required" });
	});

	it("limits attendance to the matching year and section", () => {
		const student = { year: 3, section: "a" };
		expect(studentMatchesAttendanceClass(student, { year: 3, section: "A" })).toBe(true);
		expect(studentMatchesAttendanceClass(student, { year: 2, section: "A" })).toBe(false);
		expect(studentMatchesAttendanceClass(student, { year: 3, section: "B" })).toBe(false);
	});

	it("distinguishes transient D1 overloads from SQL errors", () => {
		expect(isTransientD1Error(new Error("D1 DB is overloaded. Requests queued for too long."))).toBe(true);
		expect(isTransientD1Error(new Error("D1_EXEC_ERROR: no such column"))).toBe(false);
	});
});
