import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [tag, output] = process.argv.slice(2);
assert.match(tag ?? "", /^fork-v\d+\.\d+\.\d+-\d{8}\.\d+$/);
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim(), source);
assert.equal(execFileSync("git", ["cat-file", "-t", tag], { encoding: "utf8" }).trim(), "tag");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(tag.startsWith(`fork-v${manifest.version}-`), "Tag must name the upstream package version");
const serverMeta = JSON.parse(readFileSync("dist/server.meta.json", "utf8"));
const appMeta = JSON.parse(readFileSync("dist/app.meta.json", "utf8"));
for (const meta of [serverMeta, appMeta]) {
  assert.equal(meta.pluginId, "usage");
  assert.equal(meta.pluginVersion, manifest.version);
  assert.equal(meta.sdkVersion, serverMeta.sdkVersion);
}
const out = resolve(output ?? "release-assets");
mkdirSync(out, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "bb-usage-package-"));
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
try {
  const root = join(temporary, "bb-plugin-usage");
  mkdirSync(root);
  mkdirSync(join(root, "dist"));
  for (const file of ["server.js", "server.meta.json", "app.js", "app.css", "app.meta.json", "package.json"]) {
    cpSync(join("dist", file), join(root, "dist", file));
  }
  mkdirSync(join(root, "assets"));
  for (const file of ["server.js", "app.js", "app.css"]) {
    cpSync(join("dist", file), join(root, "assets", file));
  }
  // Path installs rewrap the compiled JS with BB's own toolchain. The CSS
  // import preserves the original styles without installing source dependencies.
  writeFileSync(join(root, "server.js"), 'export { default } from "./assets/server.js";\nexport * from "./assets/server.js";\n');
  writeFileSync(join(root, "app.js"), 'import "./assets/app.css";\nexport { default } from "./assets/app.js";\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: manifest.name, version: manifest.version, type: "module",
    engines: { bb: ">=0.44.0", bbPluginSdk: `^${serverMeta.sdkVersion}` },
    bb: { ...manifest.bb, server: "./server.js", app: "./app.js" },
  }, null, 2) + "\n");
  for (const file of ["LICENSE", "README.md"]) cpSync(file, join(root, file));
  cpSync("docs", join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  cpSync("scripts/cursor-usage-hook.mjs", join(root, "scripts/cursor-usage-hook.mjs"));
  const archive = `bb-plugin-usage-${tag}-portable.tar.gz`;
  execFileSync("tar", ["-czf", join(out, archive), "-C", temporary, "bb-plugin-usage"]);
  const registry = JSON.parse(readFileSync("config/local-aggregate-features.json", "utf8"));
  const metadata = {
    tag, sourceCommit: source, packageVersion: manifest.version,
    platform: "portable JavaScript (BB on Linux/macOS)", testedPlatform: "linux-x64",
    bbBuildVersion: serverMeta.builtWith.bbVersion, sdkVersion: serverMeta.sdkVersion,
    minimumBbVersion: "0.44.0", archive, sha256: digest(join(out, archive)),
    upstreamCommit: registry.aggregate.lastIntegratedUpstreamCommit,
    features: registry.features.map(({ branch, lastPackaged }) => ({ branch, ...lastPackaged })),
  };
  writeFileSync(join(out, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
  const notes = `# Usage fork ${tag}\n\nSource: \`${source}\`. Upstream package: ${manifest.version}.\n\nIncludes all ${metadata.features.length} registered aggregate branches. Requires BB 0.44.0 or newer with a compatible SDK (${metadata.sdkVersion}).\n\nDownload \`${archive}\`, \`release.json\`, \`RELEASE_NOTES.md\`, and \`SHA256SUMS\`; run \`sha256sum -c SHA256SUMS\`, extract to a permanent directory, and run \`bb plugin install path:/absolute/path/bb-plugin-usage --yes\`. See docs/fork-maintenance.md in the archive for installation and upgrades.\n\nContains compiled JavaScript and CSS; no npm install or manual source build is needed. BB may rewrap the JS during path installation. Linux x64 installation is verified in CI; macOS uses the same portable assets but is not smoke-tested. Host collector runtime requirements remain documented in README.md.\n`;
  writeFileSync(join(out, "RELEASE_NOTES.md"), notes);
  writeFileSync(join(out, "SHA256SUMS"), [archive, "release.json", "RELEASE_NOTES.md"].map((file) => `${digest(join(out, file))}  ${file}\n`).join(""));
  console.log(JSON.stringify(metadata, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
