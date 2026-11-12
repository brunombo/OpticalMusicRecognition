// At build time, write THIRD_PARTY_LICENSES.txt into the site: NOTICE, the
// licences in LICENSES/, then every npm package whose code ends up in the
// bundle, with its licence files. The list comes from the bundle itself, so
// it follows the dependencies without being kept by hand.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NOTICES_FILE = "THIRD_PARTY_LICENSES.txt";
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\b|[.-])/i;
const RULE = "=".repeat(78);

/** The directory of the npm package a module id belongs to (or null). */
export function packageDir(id) {
	const path = id.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
	const at = path.lastIndexOf("/node_modules/");
	if (at < 0) {
		return null;
	}
	const rest = path.slice(at + "/node_modules/".length).split("/");
	const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	return `${path.slice(0, at)}/node_modules/${name}`;
}

/** The nearest package.json at or above `dir` that names a package. */
function manifest(dir) {
	for (let d = dir; d !== dirname(d); d = dirname(d)) {
		const file = join(d, "package.json");
		if (existsSync(file)) {
			const json = JSON.parse(readFileSync(file, "utf8"));
			if (json.name) {
				return { dir: d, json };
			}
		}
	}
	return null;
}

const licenceOf = (json) =>
	typeof json.license === "string"
		? json.license
		: (json.license?.type ??
			json.licenses?.map((l) => l.type ?? l).join(" OR ") ??
			null);

// the packages seen so far: Web Workers are bundled apart (and before the
// main bundle's generateBundle), so their instance collects into the same set
const dirs = new Set();

function collect(bundle) {
	for (const chunk of Object.values(bundle)) {
		for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
			const dir = packageDir(id);
			if (dir) {
				dirs.add(dir);
			}
		}
	}
}

/** For `worker.plugins`: collects the workers' packages, writes nothing. */
export function workerLicences() {
	return {
		name: "third-party-licences-worker",
		apply: "build",
		generateBundle(_, bundle) {
			collect(bundle);
		},
	};
}

export default function thirdPartyLicences({ root = process.cwd() } = {}) {
	return {
		name: "third-party-licences",
		apply: "build",
		generateBundle(_, bundle) {
			collect(bundle);
			const packages = new Map();
			for (const dir of dirs) {
				const found = manifest(dir);
				if (!found) {
					this.warn(`no package.json for ${dir}`);
					continue;
				}
				const { json } = found;
				const key = `${json.name}@${json.version}`;
				if (packages.has(key)) {
					continue;
				}
				const files = readdirSync(found.dir)
					.filter((f) => LICENCE_FILE.test(f))
					.sort();
				packages.set(key, {
					key,
					licence: licenceOf(json),
					homepage: json.homepage ?? json.repository?.url ?? json.repository,
					texts: files.map((f) => ({
						file: f,
						text: readFileSync(join(found.dir, f), "utf8").trim(),
					})),
				});
			}
			const list = [...packages.values()].sort((a, b) =>
				a.key.localeCompare(b.key),
			);
			for (const p of list) {
				if (!p.licence) {
					this.warn(`${p.key}: no licence in package.json`);
				}
				if (p.texts.length === 0) {
					this.warn(`${p.key}: no licence file`);
				}
			}

			const own = join(root, "LICENSES");
			const parts = [
				"Third-party software and data in this site, and their licences.",
				"",
				readFileSync(join(root, "NOTICE"), "utf8").trim(),
				"",
				"npm packages in the bundle:",
				...list.map(
					(p) => `  ${p.key}  ${p.licence ?? "(licence not stated)"}`,
				),
			];
			for (const f of readdirSync(own).sort()) {
				parts.push(
					"",
					RULE,
					`LICENSES/${f}`,
					RULE,
					"",
					readFileSync(join(own, f), "utf8").trim(),
				);
			}
			for (const p of list) {
				parts.push("", RULE, `${p.key} — ${p.licence ?? "licence not stated"}`);
				if (p.homepage) {
					parts.push(String(p.homepage));
				}
				parts.push(RULE);
				for (const t of p.texts) {
					parts.push("", `--- ${t.file} ---`, "", t.text);
				}
			}
			this.emitFile({
				type: "asset",
				fileName: NOTICES_FILE,
				source: `${parts.join("\n")}\n`,
			});
			// in the build log, for review
			console.log(
				`\n${NOTICES_FILE}: ${list.length} npm packages\n` +
					list
						.map(
							(p) =>
								`  ${p.key}  ${p.licence ?? "?"}  [${p.texts.map((t) => t.file).join(", ") || "no file"}]`,
						)
						.join("\n"),
			);
		},
	};
}
