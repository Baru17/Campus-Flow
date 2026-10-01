import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/*
 * Unit tests.
 *
 * These read `wrangler.unittest.jsonc`, which is a test-only configuration, and
 * deliberately NOT `wrangler.jsonc`. The latter is the production configuration: it
 * names the production D1 database and sets `"remote": true` on the `DB` binding.
 *
 * That combination is dangerous here, because the plugin's pool options default
 * `remoteBindings` to `true`. A binding marked `remote` is then opened as a real
 * remote dev session against its `database_id`, and D1 queries are proxied to it --
 * so unit tests would run against production, and `tableResolver.spec.ts` drops and
 * deletes tables. `wrangler.unittest.jsonc` has no `remote` key, so no session is
 * opened and D1 is served from isolated per-test-file local storage.
 *
 * `remoteBindings: false` below is the second lock on the same door: it stops a
 * remote session even if a `"remote": true` is ever added to that config. Remove it
 * only alongside the `remote` key it is guarding against.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.unittest.jsonc" },
		}),
	],
	test: {
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/cypress/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/coverage/**",
			// Integration tests apply the migrations themselves and drive the Worker
			// over HTTP; they run under `npm run test:integration`, which uses
			// `wrangler.integration.jsonc`.
			"test/*.integration.spec.ts",
		],
	},
});