import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.integration.jsonc" },
		}),
	],
	test: {
		include: ["test/attendance.integration.spec.ts"],
	},
});