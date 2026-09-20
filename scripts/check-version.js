import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MONITOR_VERSION } from "../src/version.js";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [manifest, lock] = await Promise.all([
  readJson("../package.json"),
  readJson("../package-lock.json"),
]);

assert.match(MONITOR_VERSION, /^0\.[1-9]\d*$/, "Product version must be 0.X");
const npmVersion = `${MONITOR_VERSION}.0`;
assert.equal(manifest.version, npmVersion, "package.json must mirror the product version");
assert.equal(lock.version, npmVersion, "Lockfile version must match package.json");
assert.equal(lock.packages[""].version, npmVersion, "Lockfile root package version must match");
console.log(`Monitor version ${MONITOR_VERSION}; npm metadata ${npmVersion}`);
