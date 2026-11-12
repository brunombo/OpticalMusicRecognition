// SPDX-License-Identifier: Apache-2.0 — Copyright 2026 Bruno Menon
// Fetch the sound bank and cut it down to the app's instruments:
// GeneralUser GS by S. Christian Collins (its own licence, see
// LICENSES/GeneralUser-GS.txt), at a pinned commit, into
// public/soundfonts/catalogue.sf2. Needs git.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const REPO = "https://github.com/mrbumpy409/GeneralUser-GS";
const COMMIT = "684543d5e5efaef08d02be50dcda8d552478fa60"; // v2.0.3
const FILE = "GeneralUser-GS.sf2";
const dir = `.cache/soundfont-${COMMIT.slice(0, 12)}`;

const git = (...args) =>
	execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });

if (!existsSync(`${dir}/${FILE}`)) {
	mkdirSync(dir, { recursive: true });
	git("init", "-q");
	// the bank alone, not the repository's demos and documents
	git("sparse-checkout", "set", "--no-cone", `/${FILE}`);
	git("fetch", "-q", "--depth", "1", "--filter=blob:none", REPO, COMMIT);
	git("checkout", "-q", "FETCH_HEAD");
}
execFileSync(
	process.execPath,
	["scripts/soundfont/subset.mjs", `${dir}/${FILE}`],
	{ stdio: "inherit" },
);
