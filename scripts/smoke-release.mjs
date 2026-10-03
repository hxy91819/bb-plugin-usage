import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = resolve(process.argv[2] ?? "release-assets");
execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: assets, stdio: "inherit" });
const release = JSON.parse(readFileSync(join(assets, "release.json"), "utf8"));
const runtime = process.env.BB_RELEASE_RUNTIME;
assert.ok(runtime, "Set BB_RELEASE_RUNTIME to the installed bb-app package directory");
const temporary = mkdtempSync(join(tmpdir(), "bb-usage-install-"));
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const port = await freePort();
const env = { ...process.env, BB_DATA_DIR: join(temporary, "data"), BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_CLI_REEXEC: "1", BB_HOST_DAEMON_PORT: String(await freePort()) };
for (const key of ["BB_CLI", "BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID"]) delete env[key];
let logs = "";
let server;
try {
  execFileSync("tar", ["-xzf", join(assets, release.archive), "-C", temporary]);
  const pluginRoot = join(temporary, "bb-plugin-usage");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, release.packageVersion);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  server = spawn(process.execPath, [join(runtime, "dist/bb-server.js"), "--data-dir", env.BB_DATA_DIR, "--server-bind-host", "127.0.0.1", "--server-port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (data) => { logs += data; });
  server.stderr.on("data", (data) => { logs += data; });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`BB server exited: ${logs}`);
    try {
      const response = await fetch(`${env.BB_SERVER_URL}/api/v1/plugins`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, `BB server did not become ready: ${logs}`);
  const cli = (...args) => execFileSync(process.execPath, [join(runtime, "dist/bb.js"), ...args], { env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  console.log(cli("plugin", "install", `path:${pluginRoot}`, "--yes", "--json"));
  const plugin = JSON.parse(cli("plugin", "list", "--json")).plugins.find(({ id }) => id === "usage");
  assert.ok(plugin, "Usage plugin must be installed");
  assert.equal(plugin.status, "running", JSON.stringify(plugin));
  assert.equal(plugin.version, release.packageVersion);
  assert.equal(plugin.app.bundle.compatible, true);
  assert.ok(plugin.app.bundle.jsBytes > 1000);
  for (const url of [plugin.app.bundle.jsUrl, plugin.app.bundle.cssUrl]) {
    const response = await fetch(new URL(url, env.BB_SERVER_URL));
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 1000, "Compiled app assets must be served");
  }
  console.log(`Installation smoke passed: usage ${plugin.version}, BB ${release.bbBuildVersion}`);
} catch (error) {
  console.error(logs.slice(-12000));
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
  rmSync(temporary, { recursive: true, force: true });
}
