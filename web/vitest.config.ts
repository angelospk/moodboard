import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: { alias: [{ find: /^#lib\/(.*)\.js$/, replacement: fileURLToPath(new URL('./src/lib/$1', import.meta.url)) }] },
	test: {
		include: ['tests/**/*.test.ts'],
		testTimeout: 20000,
		globalSetup: ['tests/pb-server.ts'],
		// Node 22 has EventSource (PocketBase realtime) only behind this flag.
		execArgv: ['--experimental-eventsource']
	}
});
