import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import thirdPartyLicences from "./scripts/licenses/vite-plugin.mjs";

export default defineConfig(({ command }) => ({
	// The site's path: "/" locally, "/<repo>/" on GitHub Pages (set by CI)
	base: process.env.BASE_PATH ?? "/",
	plugins: [vue(), thirdPartyLicences()],
	resolve: {
		// Verovio imports node:module only when running under Node; the
		// browser bundle gets a stub (tests and node scripts keep the real one)
		alias:
			command === "build"
				? {
						"node:module": fileURLToPath(
							new URL("./src/node-module-stub.js", import.meta.url),
						),
					}
				: {},
	},
	build: {
		// verovio-module (~7.5 MB) is Verovio's WASM embedded in JS; it is
		// already lazy-loaded via dynamic import() and cannot be split
		// further. The limit sits just above it so any other oversized chunk
		// still warns.
		chunkSizeWarningLimit: 8000,
	},
	// COOP/COEP headers enable SharedArrayBuffer → multithreaded ONNX WASM
	server: {
		port: 3000,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	preview: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	// onnxruntime-web ships worker code that must not be pre-bundled
	optimizeDeps: {
		exclude: ["onnxruntime-web"],
	},
	// Our recognition worker uses dynamic imports → must be an ES module
	worker: {
		format: "es",
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.js"],
	},
}));
