// Browser stand-in for "node:module". Verovio's Emscripten glue imports it
// only when it runs under Node (`if (ENVIRONMENT_IS_NODE)`), so in the
// browser this is never called; aliasing it here keeps Vite from
// externalizing a Node built-in into the bundle.
export function createRequire() {
	throw new Error("node:module is not available in the browser");
}
