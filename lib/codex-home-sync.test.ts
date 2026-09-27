import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

vi.mock("@bb/plugin-sdk", () => ({ defineRpcContract: <T>(contract: T) => contract }));
import plugin from "../server";

it("syncs a configured custom home into dashboard records and replaces renamed attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-custom-home-sync-"));
  const db = new Database(":memory:");
  const files = new Map<string, string>();
  const outputs = new Map<string, string>();
  let accountName = "work";
  let rpc: { sync(): unknown; dashboard(input: unknown): Promise<unknown> };
  const bb = {
    settings: { define: () => ({ get: async () => ({ piSessionRoots: "", primeSessionRoots: "", codexHomes: JSON.stringify([
      { name: accountName, path: "~/custom home", hostId: "test-host" },
      { name: "other-host", path: "~/ignored", hostId: "elsewhere" },
    ]) }) }) },
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => statements.forEach((sql) => db.exec(sql)) },
    rpc: { register: (_contract: unknown, handlers: typeof rpc) => { rpc = handlers; } },
    sdk: {
      hosts: { list: async () => [{ id: "test-host", name: "Test", status: "connected" }], directory: async () => ({ directory }) },
      files: { write: async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content);
        return { outcome: "written", sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: content.length };
      } },
      terminals: {
        create: async ({ start }: { start: { command: string } }) => {
          const staged = start.command.match(/sh '([^']+\.sh)'/)?.[1];
          const command = staged ? files.get(staged)! : start.command;
          const encoded = command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)"/)?.[1];
          const source = encoded ? gunzipSync(Buffer.from(encoded, "base64")).toString("utf8") : "";
          const input = source.match(/\}\)\("([A-Za-z0-9+/=]+)"/)?.[1];
          const agent = input ? JSON.parse(Buffer.from(input, "base64").toString("utf8")).agentId : "unknown";
          let stdout: string;
          if (agent === "codex") {
            ({ stdout } = await promisify(execFile)(process.execPath, ["-e", source], { env: { ...process.env, CODEX_HOME: "" } }));
          } else {
            const result = { agentId: agent, fileCount: 0, changedFileCount: 0, reusedFileCount: 0, failureCount: 0, error: null, rows: [] };
            stdout = `__BB_USAGE_SCAN_BEGIN__\n${gzipSync(JSON.stringify(result)).toString("base64")}\n__BB_USAGE_SCAN_END__\n`;
          }
          const id = String(outputs.size);
          outputs.set(id, `${stdout}\n__BB_HOST_COMMAND_DONE__:0\n`);
          return { id };
        },
        get: async () => ({ status: "running" }),
        output: async ({ terminalId }: { terminalId: string }) => ({ chunks: [{ seq: 0, dataBase64: Buffer.from(outputs.get(terminalId)!).toString("base64") }], truncated: false }),
        close: async () => {},
      },
    },
    realtime: { publish: vi.fn() }, background: { service: vi.fn() },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as BbPluginApi;
  try {
    await mkdir(join(directory, "custom home", "sessions"), { recursive: true });
    await writeFile(join(directory, "custom home", "sessions", "rollout-test.jsonl"), [
      { type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/projects/example" } },
      { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } } } },
    ].map((row) => JSON.stringify(row)).join("\n"));
    await plugin(bb);
    rpc!.sync();
    await vi.waitFor(() => expect(db.prepare("SELECT provider_id, processed_tokens FROM usage_events").all())
      .toEqual([{ provider_id: "codex-work", processed_tokens: 120 }]), { timeout: 5000 });
    // Wait for the coordinator to finish before requesting the renamed scan.
    await vi.waitFor(() => expect(db.prepare("SELECT status FROM usage_sync_state WHERE provider_id = 'codex'").get()).toEqual({ status: "ready" }));
    accountName = "renamed";
    rpc!.sync();
    await vi.waitFor(() => expect(db.prepare("SELECT provider_id, processed_tokens FROM usage_events").all())
      .toEqual([{ provider_id: "codex-renamed", processed_tokens: 120 }]), { timeout: 5000 });
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
