import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/*
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
 * means a stray `"remote": true` in this config still cannot open a proxy session
 * to a real database.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.integration.jsonc" },
		}),
	],
	test: {
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