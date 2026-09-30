import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
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
			"test/adminNoMigration.integration.spec.ts",
		],
	},
});