import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const assets = resolve(process.argv[2] ?? "release-assets");
const repo = process.env.GITHUB_REPOSITORY;
assert.equal(repo, "hxy91819/bb-plugin-usage");
execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: assets, stdio: "inherit" });
const release = JSON.parse(readFileSync(join(assets, "release.json"), "utf8"));
assert.equal(release.tag, process.env.GITHUB_REF_NAME);
assert.equal(release.sourceCommit, process.env.GITHUB_SHA);
assert.match(release.tag, /^fork-v\d+\.\d+\.\d+-\d{8}\.\d+$/);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim();
const api = (path) => JSON.parse(gh("api", `repos/${repo}/${path}`));
let ref = api(`git/ref/tags/${release.tag}`).object;
assert.equal(ref.type, "tag", "Release requires an annotated tag");
ref = api(`git/tags/${ref.sha}`).object;
assert.equal(ref.type, "commit");
assert.equal(ref.sha, release.sourceCommit);
const expected = [release.archive, "release.json", "RELEASE_NOTES.md", "SHA256SUMS"].sort();
assert.deepEqual(readdirSync(assets).sort(), expected);
const notes = readFileSync(join(assets, "RELEASE_NOTES.md"), "utf8");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(hash(join(assets, release.archive)), release.sha256);
// A successful repository listing distinguishes an absent release from an API
// failure. Never treat authentication, rate-limit, or network errors as absence.
const releases = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`)).flat();
let published = releases.find(({ tag_name }) => tag_name === release.tag);
if (!published) {
  gh("release", "create", release.tag, "--repo", repo, "--verify-tag", "--draft", "--title", `Usage ${release.tag}`, "--notes-file", join(assets, "RELEASE_NOTES.md"));
  published = JSON.parse(gh("release", "view", release.tag, "--repo", repo, "--json", "databaseId"));
  published = api(`releases/${published.databaseId}`);
}
assert.equal(published.tag_name, release.tag);
assert.equal(published.body.trim(), notes.trim());
assert.equal(published.prerelease, false);
const readback = mkdtempSync(join(tmpdir(), "bb-usage-release-readback-"));
try {
  const existing = published.assets.map(({ name }) => name).sort();
  for (const name of existing) assert.ok(expected.includes(name), `Unexpected published asset: ${name}`);
  if (!published.draft) assert.deepEqual(existing, expected, "Public releases are immutable; publish a new tag for changes");
  for (const name of expected) {
    if (!existing.includes(name)) {
      assert.ok(published.draft);
      gh("release", "upload", release.tag, join(assets, name), "--repo", repo);
    }
  }
  gh("release", "download", release.tag, "--repo", repo, "--dir", readback);
  assert.deepEqual(readdirSync(readback).sort(), expected);
  for (const name of expected) assert.equal(hash(join(readback, name)), hash(join(assets, name)), `Release readback mismatch: ${name}`);
  if (published.draft) gh("release", "edit", release.tag, "--repo", repo, "--draft=false", "--latest");
  published = api(`releases/${published.id}`);
  assert.equal(published.draft, false);
  assert.deepEqual(published.assets.map(({ name }) => name).sort(), expected);
  console.log(published.html_url);
} finally { rmSync(readback, { recursive: true, force: true }); }
