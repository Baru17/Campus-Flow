import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Integration tests.
 *
 * These read `wrangler.integration.jsonc`, which is a test-only configuration: a
 * different database name and an all-zeroes placeholder `database_id`. They never
 * read `wrangler.jsonc`, the production configuration.
 *
 * The integration suites issue DDL and DML -- they apply the migrations themselves
 * and then drive the Worker over HTTP -- so this file's database must be local. It
 * is: `wrangler.integration.jsonc` declares no `"remote"` key, so the pool's
 * `pickRemoteBindings` finds no remote bindings, opens no remote dev session, and D1
 * is served from Miniflare's isolated per-test-file storage under `.wrangler/state/`.
 *
 * `remoteBindings: false` is belt and braces for the same reason as in
 * `vitest.config.mts`: the plugin defaults it to `true`, so stating it explicitly
 * means a stray `"remote": true` added to this config still cannot open a proxy session
 * to a real database.
 *
 * ## Why `miniflare.bindings` repeats the two secrets
 *
 * Wrangler loads `.dev.vars` for *any* local invocation in this directory, and a
 * `.dev.vars` overrides the `vars` block of the config being used. That is correct
 * behaviour for `wrangler dev` and wrong for this suite: a developer's local
 * `.dev.vars` almost certainly has an empty `BREVO_API_KEY`, which would silently
 * override the placeholder below and make `sendBrevoEmail` refuse before its `fetch` is
 * ever reached. Every mail assertion in the OD suites would then fail, with a stack that
 * points at the workflow rather than at the environment.
 *
 * Stating the bindings here makes the suite hermetic: the two values the tests depend on
 * come from this file, not from whatever happens to sit next to it. They are placeholders
 * in a test-only config and are never deployed. `wrangler.integration.jsonc` keeps its own
 * copy so the Worker still sees them as `vars` rather than as opaque Miniflare bindings.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.integration.jsonc" },
			miniflare: {
				bindings: {
					BREVO_API_KEY: "integration-test-key",
					OD_APPROVAL_TOKEN_SECRET: "integration-test-approval-secret",
				},
			},
		}),
	],
	test: {
		/*
		 * Timeouts, raised for a suite that talks to a real Worker.
		 *
		 * These tests drive the Worker over HTTP against a real (local) D1: applying
		 * fifteen migrations in `beforeAll`, then a chain of decisions where each one is
		 * a conditional UPDATE plus one or two emails. That is dozens of sequential
		 * round trips per test, which is nothing like the pure unit tests next door.
		 *
		 * Vitest's 5s default is under that. Left alone it does not fail consistently --
		 * it fails whichever test happened to be slowest on the machine that minute, which
		 * is worse than useless, because a timeout in the middle of a chain asserts
		 * nothing and points at nothing. `hookTimeout` gets the same treatment because
		 * `beforeAll` applying fifteen migrations is the same kind of work.
		 *
		 * Nothing here hides a hang: a genuine deadlock still fails, just at 20s.
		 */
		testTimeout: 20_000,
		hookTimeout: 60_000,
		include: [
			"test/attendance.integration.spec.ts",
			"test/session-cookie.integration.spec.ts",
			"test/password-reset.integration.spec.ts",
			"test/migration0013.integration.spec.ts",
			"test/migration0015.integration.spec.ts",
			"test/cseBatch.integration.spec.ts",
			"test/adminApi.integration.spec.ts",
			"test/adminEdit.integration.spec.ts",
			"test/adminNoMigration.integration.spec.ts",
			"test/adminBulkImport.integration.spec.ts",
			"test/adminDirectory.integration.spec.ts",
			"test/studentOd.integration.spec.ts",
			"test/staffBatches.integration.spec.ts",
		],
	},
});