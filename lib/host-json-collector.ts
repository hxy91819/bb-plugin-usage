import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AgentId, HostUsageAggregate } from "../collectors";
import { hostJsonCollectorSource } from "./host-scripts.generated";

// Agents collected by walking JSONL session logs. "devin" and "kilocode" are
// excluded: their usage lives in SQLite databases handled by their own
// collectors, and "opencode" is queried through the opencode CLI.
export type HostJsonAgentId = Exclude<AgentId, "amp" | "opencode" | "devin" | "kilocode">;

// Agents whose host scan emits the shared aggregate-row wire format.
export type HostScanAgentId = Exclude<AgentId, "amp" | "opencode">;

export type HostJsonScanInput = {
  agentId: HostJsonAgentId;
  roots: string[];
  cachePath: string;
  sinceDay: string;
  // Parent directories whose immediate children are per-account agent homes
  // (e.g. ~/.codex-profiles/<name> or ~/.codex-<name> for extra Codex
  // accounts). Each child's sessions/ and archived_sessions/ trees are scanned;
  // rows carry `account` = the child name minus `prefix` when one is set.
  accountRoots?: Array<{ root: string; prefix?: string }>;
  // Explicitly labelled per-account homes: each home's sessions/ and
  // archived_sessions/ trees are scanned and its rows carry `account`. An empty
  // account leaves rows untagged, so a relocated primary still merges.
  accountHomes?: Array<{ account: string; home: string }>;
};

export type HostJsonScanResult = {
  agentId: HostScanAgentId;
  fileCount: number;
  changedFileCount: number;
  reusedFileCount: number;
  failureCount: number;
  error: string | null;
  rows: HostUsageAggregate[];
  homes?: Array<{ homeTag: string; account: string }>;
};

type CollectorDependencies = {
  buffer: typeof Buffer;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  crypto: typeof import("node:crypto");
  readline: typeof import("node:readline");
  zlib: typeof import("node:zlib");
  loadSqlite?: () => typeof import("node:sqlite");
};

const SCAN_BEGIN = "__BB_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_USAGE_SCAN_END__";
const aggregateSchema = z.object({
  day: z.string(),
  modelProviderId: z.string(),
  model: z.string(),
  project: z.string().default("Unknown"),
  account: z.string().optional(),
  homeTag: z.string().optional(),
  loggedCostUsd: z.number().finite().nullable(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const scanResultSchema = z.object({
  agentId: z.enum(["codex", "claude", "codebuddy", "cursor", "copilot", "dsh", "devin", "fx", "grok", "kilocode", "pi", "prime", "antigravity", "thaura"]),
  fileCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  reusedFileCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  rows: z.array(aggregateSchema),
  homes: z.array(z.object({ homeTag: z.string(), account: z.string() })).optional(),
});

// This function is compiled by generate:collectors and executed on the host. Keep
// every runtime dependency inside the function or pass it through `dependencies`.
async function hostJsonCollector(encodedInput: string, dependencies: CollectorDependencies) {
  const { buffer, fs, path, crypto, readline, zlib, loadSqlite } = dependencies;
  // v2: retained hashed Claude response identities so repeated transcript rows
  // and copied/forked transcripts can be deduplicated before aggregation.
  // v3: added the per-session project label to every aggregate row.
  // v4: buckets days in the host's local timezone instead of UTC and drops
  // zero-token / zero-cost rows. Cached rows store a precomputed `day`, so the
  // version MUST rise or upgraded hosts keep serving UTC buckets forever,
  // silently mixed with newly parsed local ones.
  // v5: keep recorded and unpriced Pi/Prime usage in separate buckets.
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as HostJsonScanInput;
  // v6 (dsh): replace repeated attempt samples and reject missing fork cuts.
  // v6 (codex): retain hashed session/bucket identities across archive moves and copies.
  // v6 (copilot): add session summaries.
  // v7 (copilot): uncached input subtracts cache reads and writes; rows cached
  // under v6 keep the double-counted values and must be reparsed.
  // v7 (codex): skip history copied into older forks and back-to-back repeated
  // token_count records, and key buckets by the rollout's own session.
  // v8 (codex): retain an account-independent event identity so cached rows
  // can rebuild their dedup key when a configured account label changes.
  // v9 (codex): rows carry the owning home so a label rename rewrites exactly
  // that home's retained buckets instead of every row sharing the label.
  // v10 (cursor): accept corrected SDK v2 rows and retain their precedence in caches.
  // Other agents retain their existing versions; adding Copilot must not
  // force users without Copilot to reparse unrelated session logs.
  // v10 (antigravity): read token usage and model enum from conversations/<id>.db
  // steps.metadata when transcript.jsonl PLANNER_RESPONSE omits token fields, and
  // preserve decimal model names in Model Selection lines.
  const cacheVersion = input.agentId === "cursor" ? 10 : input.agentId === "codex" ? 9
    : input.agentId === "copilot" ? 7 : input.agentId === "dsh" ? 6 : input.agentId === "antigravity" ? 10 : 5;
  const allowedAgents = new Set<HostJsonAgentId>(["codex", "claude", "codebuddy", "cursor", "copilot", "dsh", "fx", "grok", "pi", "prime", "antigravity", "thaura"]);
  if (!allowedAgents.has(input.agentId)) throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");
  // Extra per-account homes (e.g. Codex profiles). Only the codex parser knows
  // how to attribute them today, so other agents ignore both fields.
  const accountRoots = input.agentId === "codex" && Array.isArray(input.accountRoots)
    ? input.accountRoots.flatMap((entry) => {
      const root = typeof entry?.root === "string" ? entry.root.replace(/\/+$/, "") : "";
      return root ? [{ root, prefix: typeof entry.prefix === "string" ? entry.prefix : undefined }] : [];
    })
    : [];
  const accountHomes = input.agentId === "codex" && Array.isArray(input.accountHomes)
    ? input.accountHomes.flatMap((entry) => {
      const home = typeof entry?.home === "string" ? entry.home.replace(/\/+$/, "") : "";
      return home ? [{ account: typeof entry.account === "string" ? entry.account : "", home }] : [];
    })
    : [];

  type CachedUsageRow = HostUsageAggregate & { eventKey?: string; eventIdentity?: string; cursorVersion?: number };
  type CacheEntry = { signature: string; rows: CachedUsageRow[] };
  type Cache = { version: number; agentId: HostJsonAgentId; files: Record<string, CacheEntry> };
  const failures: string[] = [];
  let discoveryFailed = false;
  const cutoffMs = Date.parse(`${input.sinceDay}T00:00:00Z`);
  const canDecompressZstd = typeof zlib.zstdDecompressSync === "function";
  // Files discovered under an account home map to that account name.
  const accountByPath = new Map<string, string>();
  const homeByPath = new Map<string, string>();
  const homeTagFor = (home: string) => crypto.createHash("sha256").update(home).digest("hex").slice(0, 12);
  // Every observed Codex home reports its opaque tag and the account label it
  // carried this scan so the server can detect relabels of homes it never
  // configured (e.g. convention-discovered ~/.codex-* directories).
  const observedHomes = new Map<string, string>();

  function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function count(value: unknown) {
    return Math.max(0, Math.round(finite(value) ?? 0));
  }

  function text(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  // Only the working directory's final segment is recorded, so usage can be
  // grouped by project without storing the machine's directory layout.
  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.trim() ? segment.trim().slice(0, 80) : "Unknown";
  }

  function day(value: unknown) {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    const result = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  function validRow(value: unknown): value is CachedUsageRow {
    const row = object(value);
    return Boolean(row
      && typeof row.day === "string"
      && typeof row.modelProviderId === "string"
      && typeof row.model === "string"
      && typeof row.project === "string"
      && (row.account === undefined || typeof row.account === "string")
      && (row.loggedCostUsd === null || finite(row.loggedCostUsd) !== null)
      && finite(row.uncachedInputTokens) !== null
      && finite(row.cachedInputTokens) !== null
      && finite(row.cacheWriteTokens) !== null
      && finite(row.outputTokens) !== null
      && (row.eventKey === undefined || typeof row.eventKey === "string")
      && (row.eventIdentity === undefined || typeof row.eventIdentity === "string")
      && (row.cursorVersion === undefined || row.cursorVersion === 1 || row.cursorVersion === 2)
      && (row.homeTag === undefined || typeof row.homeTag === "string"));
  }

  function validCacheEntry(value: unknown): value is CacheEntry {
    const entry = object(value);
    return Boolean(entry && typeof entry.signature === "string"
      && Array.isArray(entry.rows) && entry.rows.every(validRow));
  }

  function add(target: Map<string, HostUsageAggregate>, raw: HostUsageAggregate) {
    if (raw.day < input.sinceDay) return;
    const row: HostUsageAggregate = {
      day: raw.day,
      modelProviderId: text(raw.modelProviderId, "unknown"),
      model: text(raw.model, "unknown"),
      project: text(raw.project, "Unknown"),
      loggedCostUsd: finite(raw.loggedCostUsd),
      uncachedInputTokens: count(raw.uncachedInputTokens),
      cachedInputTokens: count(raw.cachedInputTokens),
      cacheWriteTokens: count(raw.cacheWriteTokens),
      outputTokens: count(raw.outputTokens),
    };
    const account = text(raw.account, "");
    if (account) row.account = account;
    const homeTag = text(raw.homeTag, "");
    if (homeTag) row.homeTag = homeTag;
    const keyed = new Set<HostJsonAgentId>(["pi", "prime", "thaura"]).has(input.agentId);
    const key = JSON.stringify([row.day, row.modelProviderId, row.model, row.project, row.account ?? null,
      row.homeTag ?? null,
      keyed ? (row.loggedCostUsd !== null && row.loggedCostUsd > 0 ? "logged" : "estimate") : "all"]);
    const prior = target.get(key);
    if (!prior) {
      target.set(key, row);
      return;
    }
    prior.uncachedInputTokens += row.uncachedInputTokens;
    prior.cachedInputTokens += row.cachedInputTokens;
    prior.cacheWriteTokens += row.cacheWriteTokens;
    prior.outputTokens += row.outputTokens;
    if (row.loggedCostUsd !== null) prior.loggedCostUsd = (prior.loggedCostUsd ?? 0) + row.loggedCostUsd;
  }

  function mergeEvent(target: Map<string, CachedUsageRow>, raw: CachedUsageRow) {
    if (!raw.eventKey) return;
    const prior = target.get(raw.eventKey);
    if (!prior) {
      target.set(raw.eventKey, { ...raw });
      return;
    }
    // SDK v2 rows correct legacy inclusive input counters. Maxima would keep
    // the wrong v1 input; choose the newer format before merging equal versions.
    if (input.agentId === "cursor" && (prior.cursorVersion ?? 1) !== (raw.cursorVersion ?? 1)) {
      if ((raw.cursorVersion ?? 1) > (prior.cursorVersion ?? 1)) target.set(raw.eventKey, { ...raw });
      return;
    }
    // Some agents repeat the same final counters on every content-block
    // row. Maxima also handle a partially-written/incremental row safely
    // without multiplying one API response's usage. Codex rows hold session
    // bucket totals; maxima merge an older archive copy with a continued log.
    prior.uncachedInputTokens = Math.max(prior.uncachedInputTokens, raw.uncachedInputTokens);
    prior.cachedInputTokens = Math.max(prior.cachedInputTokens, raw.cachedInputTokens);
    prior.cacheWriteTokens = Math.max(prior.cacheWriteTokens, raw.cacheWriteTokens);
    prior.outputTokens = Math.max(prior.outputTokens, raw.outputTokens);
    if (raw.loggedCostUsd !== null) prior.loggedCostUsd = Math.max(prior.loggedCostUsd ?? 0, raw.loggedCostUsd);
  }

  function matches(filePath: string) {
    const name = path.basename(filePath);
    if (input.agentId === "codex") return name.startsWith("rollout-") && name.endsWith(".jsonl");
    if (input.agentId === "dsh") return name === "session.v3.jsonl.zstd" || name === "session.v4.jsonl.zstd";
    if (input.agentId === "copilot") return name === "events.jsonl";
    if (input.agentId === "antigravity") return name === "transcript.jsonl" || name === "usage.jsonl";
    if (input.agentId === "fx" || input.agentId === "thaura") return name === "usage.jsonl";
    if (input.agentId === "grok") return name === "unified.jsonl";
    return name.endsWith(".jsonl");
  }

  async function walk(directory: string, files: string[]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        try {
          const stat = await fs.promises.stat(directory);
          if (stat.isFile() && matches(directory)) {
            files.push(directory);
            return;
          }
        } catch {
          // The standard discovery error below is sufficient.
        }
      }
      if (code !== "ENOENT") {
        discoveryFailed = true;
        failures.push("A usage directory could not be read.");
      }
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath, files);
      else if (entry.isFile() && matches(entryPath)) files.push(entryPath);
    }
  }

  // DeepSeek Harness writes one Zstandard frame per append batch and
  // concatenates them in a single file, while Node's zlib decoder stops at the
  // end of the first frame. Frame boundaries are scanned structurally so each
  // frame can be decompressed on its own; a torn final frame (an interrupted
  // append) is returned separately instead of failing the whole file.
  function zstdFrames(source: Buffer) {
    const frames: Array<{ start: number; end: number }> = [];
    let offset = 0;
    while (offset < source.length) {
      const start = offset;
      if (source.length - offset < 4) return { frames, tornStart: start };
      if (source.readUInt32LE(offset) !== 0xfd2fb528) throw new Error("Invalid Zstandard frame magic.");
      offset += 4;
      if (offset === source.length) return { frames, tornStart: start };
      const descriptor = source.readUInt8(offset);
      offset += 1;
      if ((descriptor & 24) !== 0) throw new Error("Invalid Zstandard frame header.");
      const singleSegment = (descriptor & 32) !== 0;
      const contentSizeFlag = descriptor >>> 6;
      const dictionaryBytes = (descriptor & 3) === 3 ? 4 : descriptor & 3;
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
      const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
      if (source.length - offset < headerBytes) return { frames, tornStart: start };
      offset += headerBytes;
      for (;;) {
        if (source.length - offset < 3) return { frames, tornStart: start };
        const blockHeader = source.readUIntLE(offset, 3);
        offset += 3;
        const blockType = (blockHeader >>> 1) & 3;
        if (blockType === 3) throw new Error("Invalid Zstandard block type.");
        const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3;
        if (source.length - offset < payloadBytes) return { frames, tornStart: start };
        offset += payloadBytes;
        if ((blockHeader & 1) !== 0) break;
      }
      if ((descriptor & 4) !== 0) {
        if (source.length - offset < 4) return { frames, tornStart: start };
        offset += 4;
      }
      frames.push({ start, end: offset });
    }
    return { frames };
  }

  async function* zstdLines(filePath: string) {
    if (!canDecompressZstd) throw new Error("This Node.js cannot decompress Zstandard usage logs.");
    const source = await fs.promises.readFile(filePath);
    const { frames, tornStart } = zstdFrames(source);
    for (const frame of frames) {
      yield* zlib.zstdDecompressSync(source.subarray(frame.start, frame.end)).toString("utf8").split("\n");
    }
    // The torn tail still yields the complete records written before the
    // interrupted append; the rest becomes readable once the log is repaired.
    if (tornStart !== undefined) {
      try {
        yield* zlib.zstdDecompressSync(source.subarray(tornStart), { finishFlush: zlib.constants.ZSTD_e_flush }).toString("utf8").split("\n");
      } catch { /* unreadable bytes stay unread until a later scan */ }
    }
  }

  // An attempt that never committed a message carries its usage in the
  // stream's last usage chunk; committed messages carry it on data.usage.
  function lastStreamUsage(stream: unknown) {
    if (!Array.isArray(stream)) return null;
    let usage: Record<string, unknown> | null = null;
    for (const entry of stream) {
      const chunk = object(object(entry)?.chunk);
      if (chunk?.type !== "usage") continue;
      const candidate = object(chunk.usage);
      if (candidate) usage = candidate;
    }
    return usage;
  }

  const agyMetadataCache = new Map<string, Record<string, string>>();
  const agyModelEnumMap: Record<number, string> = {
    1318: "gemini-3.8-flash",
    1319: "gemini-3.8-flash",
    1320: "gemini-3.8-flash",
    1401: "claude-opus-5-5",
    1437: "gemini-4-carbon",
    1526: "gemini-4-hydrogen",
    1532: "gemini-4-neon",
    1533: "gemini-4-neon",
    1535: "gemini-4-neon",
  };
  type AgyStepDbUsage = {
    modelEnum?: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  };
  function agyConversationDbPath(transcriptPath: string): string | null {
    if (path.basename(transcriptPath) !== "transcript.jsonl") return null;
    const convId = path.basename(path.resolve(transcriptPath, "../../.."));
    if (!convId) return null;
    const cliDir = path.resolve(transcriptPath, "../../../../..");
    return path.join(cliDir, "conversations", `${convId}.db`);
  }
  function decodeProtoVarint(buf: Uint8Array, start: number): [number, number] | null {
    let val = 0;
    let factor = 1;
    let pos = start;
    while (pos < buf.length && pos < start + 10) {
      const byte = buf[pos++]!;
      val += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return [val, pos];
      factor *= 128;
    }
    return null;
  }
  function parseAgyStepMetadataUsage(buf: Uint8Array): AgyStepDbUsage | null {
    let pos = 0;
    while (pos < buf.length) {
      const tagRes = decodeProtoVarint(buf, pos);
      if (!tagRes) return null;
      const [tag, nextPos] = tagRes;
      pos = nextPos;
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (wire === 0) {
        const v = decodeProtoVarint(buf, pos);
        if (!v) return null;
        pos = v[1];
      } else if (wire === 2) {
        const lenRes = decodeProtoVarint(buf, pos);
        if (!lenRes) return null;
        const [len, dataStart] = lenRes;
        const dataEnd = dataStart + len;
        if (dataEnd > buf.length) return null;
        if (field === 9) {
          let subPos = dataStart;
          let modelEnum: number | undefined;
          let inputTokens = 0;
          let cacheReadTokens = 0;
          let outputTokens = 0;
          while (subPos < dataEnd) {
            const subTag = decodeProtoVarint(buf, subPos);
            if (!subTag) break;
            const [sTag, sNext] = subTag;
            subPos = sNext;
            const sField = Math.floor(sTag / 8);
            const sWire = sTag & 7;
            if (sWire === 0) {
              const sVal = decodeProtoVarint(buf, subPos);
              if (!sVal) break;
              subPos = sVal[1];
              if (sField === 1) modelEnum = sVal[0];
              else if (sField === 2) inputTokens = sVal[0];
              else if (sField === 3) outputTokens = sVal[0];
              else if (sField === 5) cacheReadTokens = sVal[0];
            } else if (sWire === 2) {
              const sLen = decodeProtoVarint(buf, subPos);
              if (!sLen) break;
              subPos = sLen[1] + sLen[0];
            } else if (sWire === 1) {
              subPos += 8;
            } else if (sWire === 5) {
              subPos += 4;
            } else {
              break;
            }
          }
          return { modelEnum, inputTokens, cacheReadTokens, outputTokens };
        }
        pos = dataEnd;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else {
        return null;
      }
    }
    return null;
  }
  function readAgyConversationUsage(transcriptPath: string): Map<number, AgyStepDbUsage> | null {
    if (!loadSqlite) return null;
    const dbPath = agyConversationDbPath(transcriptPath);
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | undefined;
    try {
      const { DatabaseSync } = loadSqlite();
      db = new DatabaseSync(dbPath, { readOnly: true }) as unknown as typeof db;
      const rows = db!.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL").all() as Array<{ idx?: unknown; metadata?: unknown }>;
      const map = new Map<number, AgyStepDbUsage>();
      for (const row of rows) {
        const idx = finite(row.idx);
        if (idx === null || !(row.metadata instanceof Uint8Array)) continue;
        const parsed = parseAgyStepMetadataUsage(row.metadata);
        if (parsed) map.set(idx, parsed);
      }
      return map;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  function inferAgyProvider(modelName: string): string {
    const lower = modelName.toLowerCase();
    if (lower.startsWith("claude")) return "anthropic";
    if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
    if (lower.startsWith("gemini")) return "google";
    if (lower.startsWith("deepseek")) return "deepseek";
    if (lower.startsWith("grok")) return "xai";
    return "google";
  }

  function normalizeAgyModel(rawModel: string): string {
    let cleaned = rawModel.trim();
    cleaned = cleaned.replace(/\s*\((?:low|medium|high|xhigh|max|none|default)\)/gi, "");
    cleaned = cleaned.toLowerCase().replace(/\s+/g, "-");
    cleaned = cleaned.replace(/-(?:low|medium|high|xhigh|max)$/i, "");
    if (cleaned === "claude-opus-5") cleaned = "claude-opus-5-5";
    return cleaned || "unknown";
  }

  function getAgyProject(transcriptPath: string): string {
    try {
      const convId = path.basename(path.resolve(transcriptPath, "../../.."));
      const cliDir = path.resolve(transcriptPath, "../../../../..");
      const metaPath = path.join(cliDir, "cache", "conversation_metadata.json");
      let mapping = agyMetadataCache.get(metaPath);
      if (!mapping) {
        mapping = {};
        if (fs.existsSync(metaPath)) {
          const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const convs = object(raw?.conversations);
          if (convs) {
            for (const [id, item] of Object.entries(convs)) {
              const summary = object((item as Record<string, unknown>)?.summary);
              const uris = Array.isArray(summary?.WorkspaceURIs) ? summary.WorkspaceURIs : [];
              const firstUri = typeof uris[0] === "string" ? uris[0] : "";
              if (firstUri) mapping[id] = firstUri.replace(/^file:\/\//, "");
            }
          }
        }
        agyMetadataCache.set(metaPath, mapping);
      }
      if (mapping[convId]) return projectName(mapping[convId]);
    } catch {}
    return "Unknown";
  }

  async function parseFile(filePath: string): Promise<CachedUsageRow[]> {
    const rows = new Map<string, HostUsageAggregate>();
    const events = new Map<string, CachedUsageRow>();
    const fileAccount = accountByPath.get(filePath);
    const fileHome = homeByPath.get(filePath);
    const fileHomeTag = fileHome === undefined ? undefined : homeTagFor(fileHome);
    let codexModel = "codex-unknown";
    let codexSessionId = path.basename(filePath);
    let codexSessionKnown = false;
    // Older Codex forks start by replaying every ancestor's session_meta and
    // history, re-stamped within milliseconds of the fork.
    // Those calls already count in the ancestors' rollouts, so a fork carrying
    // ancestor metadata skips token counts stamped within two seconds of its
    // start. Without a usable timestamp nothing is skipped.
    let codexForkStart = NaN;
    let codexCopiedHistory = false;
    // Codex can log the same call twice in a row; counters and running totals
    // identify the repeat. Totals can reset, so only the previous call matches.
    let codexLastCall = "";
    // Session-scoped project, learned from the first record that carries a
    // working directory and reused for later rows in the same file.
    let sessionProject = "Unknown";
    // dsh keeps the active request's provider/model on request/context rows;
    // settlements without a committed message fall back to it.
    let dshProvider = "unknown";
    let dshModel = "unknown";
    // A forked/seeded dsh session replays its parent's leading events before a
    // session/end-seed marker; events at or before the last marker are the
    // parent's, not this session's usage. The marker is sequenced after the
    // inherited prefix, so settlements are buffered and applied once the
    // boundary is known.
    let dshSeeded = false;
    let dshEndSeedSeq = -1;
    let currentAgyModel = "unknown";
    let agyDbUsageLoaded = false;
    let agyDbUsage: Map<number, AgyStepDbUsage> | null = null;
    type DshSettlement = { seq: number; turn: number; step: number; row: HostUsageAggregate };
    const dshSettlements: DshSettlement[] = [];
    // Samples within one attempt replace each other; a retry closes that slot.
    let dshLastSettlement: DshSettlement | undefined;
    const lines: AsyncIterable<string> = filePath.endsWith(".zstd")
      ? zstdLines(filePath)
      : readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const value = object(raw);
      if (!value) continue;

      if (input.agentId === "codex") {
        const payload = object(value.payload);
        const stamp = typeof value.timestamp === "string" || typeof value.timestamp === "number"
          ? new Date(value.timestamp).getTime() : NaN;
        if (value.type === "session_meta" && payload) {
          if (!codexSessionKnown) {
            codexSessionId = text(payload.id, codexSessionId);
            codexForkStart = stamp;
          } else if (payload.id !== codexSessionId) codexCopiedHistory = true;
          codexSessionKnown = true;
        }
        if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
          codexModel = text(payload.model, codexModel);
          if (typeof payload.cwd === "string") sessionProject = projectName(payload.cwd);
        }
        if (value.type !== "event_msg" || payload?.type !== "token_count") continue;
        const usage = object(object(payload.info)?.last_token_usage);
        const usageDay = day(value.timestamp);
        if (!usage || !usageDay) continue;
        const totals = object(object(payload.info)?.total_token_usage);
        const call = finite(totals?.total_tokens) === null ? "" : JSON.stringify([usage.input_tokens,
          usage.cached_input_tokens, usage.output_tokens, usage.reasoning_output_tokens, totals?.total_tokens, totals?.input_tokens]);
        const repeated = call !== "" && call === codexLastCall;
        codexLastCall = call;
        const sinceFork = stamp - codexForkStart;
        if (repeated || (codexCopiedHistory && sinceFork >= 0 && sinceFork < 2000)) continue;
        const inputTokens = count(usage.input_tokens);
        const cached = Math.min(inputTokens, count(usage.cached_input_tokens));
        add(rows, {
          day: usageDay, modelProviderId: "openai", model: codexModel, project: sessionProject, loggedCostUsd: null,
          account: fileAccount, homeTag: fileHomeTag,
          uncachedInputTokens: inputTokens - cached, cachedInputTokens: cached,
          cacheWriteTokens: count(usage.cache_write_input_tokens), outputTokens: count(usage.output_tokens),
        });
        continue;
      }

      if (input.agentId === "claude") {
        if (value.type !== "assistant") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp);
        if (!message || !usage || !usageDay) continue;
        const model = text(message.model, "claude-unknown");
        const uncached = count(usage.input_tokens);
        const cached = count(usage.cache_read_input_tokens);
        const writes = count(usage.cache_creation_input_tokens);
        const output = count(usage.output_tokens);
        if (model === "<synthetic>" && uncached + cached + writes + output === 0) continue;
        const rawIdentity = typeof message.id === "string" && message.id
          ? `message:${message.id}`
          : typeof value.requestId === "string" && value.requestId ? `request:${value.requestId}` : null;
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        const row: CachedUsageRow = {
          day: usageDay, modelProviderId: "anthropic", model, project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: writes, outputTokens: output,
          eventKey: rawIdentity ? crypto.createHash("sha256").update(rawIdentity).digest("hex") : undefined,
        };
        if (row.eventKey) mergeEvent(events, row);
        else add(rows, row);
        continue;
      }

      if (input.agentId === "copilot") {
        const data = object(value.data);
        if (value.type === "session.start") {
          const context = object(data?.context);
          if (typeof context?.cwd === "string") sessionProject = projectName(context.cwd);
          continue;
        }
        if (value.type !== "session.shutdown") continue;
        const usageDay = day(value.timestamp);
        const eventId = typeof value.id === "string" ? value.id : "";
        const modelMetrics = object(data?.modelMetrics);
        if (!usageDay || !eventId || !modelMetrics) continue;
        for (const [modelName, rawMetrics] of Object.entries(modelMetrics)) {
          const usage = object(object(rawMetrics)?.usage);
          if (!usage) continue;
          const inputTokens = count(usage.inputTokens);
          const cached = count(usage.cacheReadTokens);
          const writes = count(usage.cacheWriteTokens);
          const output = count(usage.outputTokens);
          const uncached = Math.max(0, inputTokens - cached - writes);
          if (uncached + cached + writes + output === 0) continue;
          mergeEvent(events, {
            eventKey: crypto.createHash("sha256").update(`copilot:${eventId}:${modelName}`).digest("hex"),
            day: usageDay, modelProviderId: "github-copilot", model: text(modelName, "unknown"), project: sessionProject,
            loggedCostUsd: null, uncachedInputTokens: uncached, cachedInputTokens: cached,
            cacheWriteTokens: writes, outputTokens: output,
          });
        }
        continue;
      }

      if (input.agentId === "codebuddy" || input.agentId === "cursor") {
        const buddy = input.agentId === "codebuddy";
        if (buddy ? !["assistant", "message", "function_call"].includes(String(value.type)) || value.role === "user"
          : value.kind !== "cursor-response"
            || !(value.version === 1 || (value.version === 2 && value.source === "cursor-sdk"))) continue;
        const provider = object(value.providerData);
        const usage = buddy ? object(object(value.message)?.usage) : value;
        const usageDay = day(value.timestamp);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.input_tokens);
        const rawUsage = object(provider?.rawUsage);
        const cached = buddy ? Math.min(inputTokens, Math.max(count(usage.cache_read_input_tokens),
          count(rawUsage?.cache_read_input_tokens), count(rawUsage?.prompt_cache_hit_tokens),
          count(object(rawUsage?.prompt_tokens_details)?.cached_tokens))) : count(usage.cache_read_tokens);
        const writes = buddy ? Math.min(inputTokens - cached, Math.max(count(usage.cache_creation_input_tokens),
          count(rawUsage?.cache_creation_input_tokens), count(rawUsage?.prompt_cache_write_tokens))) : count(usage.cache_write_tokens);
        const output = count(usage.output_tokens);
        // CodeBuddy persists SDK input totals including caches; Cursor's
        // afterAgentResponse hook already subtracts cache reads and writes.
        const uncached = buddy ? Math.max(0, inputTokens - cached - writes) : inputTokens;
        if (uncached + cached + writes + output === 0) continue;
        const identity = buddy ? provider?.messageId ?? object(value.message)?.id ?? value.id : value.eventId;
        if (typeof identity !== "string" || !identity) continue;
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        mergeEvent(events, {
          eventKey: crypto.createHash("sha256").update(`${input.agentId}:${identity}`).digest("hex"),
          cursorVersion: buddy ? undefined : Number(value.version),
          day: usageDay, modelProviderId: input.agentId,
          model: text(buddy ? provider?.model ?? object(value.message)?.model : value.model, "unknown"),
          project: buddy ? sessionProject : projectName(value.project), loggedCostUsd: null,
          uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: writes, outputTokens: output,
        });
        continue;
      }

      if (input.agentId === "grok") {
        if (value.msg !== "shell.turn.inference_done") continue;
        const usage = object(value.ctx);
        const usageDay = day(value.ts);
        if (!usage || usage.prompt_tokens === undefined || !usageDay) continue;
        const prompt = count(usage.prompt_tokens);
        const cached = Math.min(prompt, count(usage.cached_prompt_tokens));
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        add(rows, {
          day: usageDay, modelProviderId: "xai", model: text(usage.model, "grok-build-0.1"), project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: prompt - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
          outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
        });
        continue;
      }

      if (input.agentId === "fx") {
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const model = text(fact.model, "unknown");
        const separator = model.indexOf("/");
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        const cacheWrite = Math.min(inputTokens - cached, count(fact.cache_write_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: separator > 0 ? model.slice(0, separator) : "unknown",
          model,
          project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached - cacheWrite,
          cachedInputTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "antigravity") {
        if (typeof value.model === "string" && value.model.trim()) {
          currentAgyModel = normalizeAgyModel(value.model);
        } else if (typeof value.content === "string") {
          const match = /Model Selection` from .*? to ([^\n]+?)\.(?:\s|$)/.exec(value.content);
          if (match?.[1]) {
            currentAgyModel = normalizeAgyModel(match[1]);
          }
        }

        if (value.kind === "generation") {
          // Written by bb-plugin-antigravity-acp's provider bridge, one line
          // per turn it forwards to the local `agy` CLI (agy has no session
          // log of its own in this shape — the bridge is the source of truth).
          const fact = object(value.fact);
          const usageDay = day(fact?.created_at_ms);
          if (!fact || !usageDay) continue;
          const rawModel = normalizeAgyModel(text(fact.model, "unknown"));
          const inputTokens = count(fact.input_tokens);
          const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
          add(rows, {
            day: usageDay,
            modelProviderId: text(fact.provider, inferAgyProvider(rawModel)),
            model: rawModel,
            project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
            loggedCostUsd: finite(fact.total_cost),
            uncachedInputTokens: inputTokens - cached,
            cachedInputTokens: cached,
            cacheWriteTokens: 0,
            outputTokens: count(fact.output_tokens),
          });
          continue;
        }

        // Native Antigravity CLI transcript.jsonl log format
        if (value.type === "PLANNER_RESPONSE" || (value.source === "MODEL" && value.input_tokens !== undefined)) {
          const usageDay = day(value.created_at);
          if (!usageDay) continue;
          const hasInlineTokens = value.input_tokens !== undefined
            || value.cache_read_tokens !== undefined
            || value.output_tokens !== undefined;
          let dbEntry: AgyStepDbUsage | undefined;
          if (!hasInlineTokens) {
            if (!agyDbUsageLoaded) {
              agyDbUsageLoaded = true;
              agyDbUsage = readAgyConversationUsage(filePath);
            }
            const stepIdx = finite(value.step_index);
            if (stepIdx !== null && agyDbUsage) {
              dbEntry = agyDbUsage.get(stepIdx);
            }
          }
          const enumModel = dbEntry?.modelEnum !== undefined ? agyModelEnumMap[dbEntry.modelEnum] : undefined;
          const rawModel = normalizeAgyModel(text(
            value.model ?? enumModel ?? (currentAgyModel !== "unknown" ? currentAgyModel : undefined),
            "unknown",
          ));
          const uncached = hasInlineTokens ? count(value.input_tokens) : count(dbEntry?.inputTokens);
          const cached = hasInlineTokens ? count(value.cache_read_tokens) : count(dbEntry?.cacheReadTokens);
          const output = hasInlineTokens ? count(value.output_tokens) : count(dbEntry?.outputTokens);
          if (uncached + cached + output === 0) continue;
          add(rows, {
            day: usageDay,
            modelProviderId: inferAgyProvider(rawModel),
            model: rawModel,
            project: getAgyProject(filePath),
            loggedCostUsd: null,
            uncachedInputTokens: uncached,
            cachedInputTokens: cached,
            cacheWriteTokens: 0,
            outputTokens: output,
          });
          continue;
        }
      }

      if (input.agentId === "thaura") {
        // Written by the Thaura integration, one line per API call it makes
        // to thaura.ai (OpenAI-compatible usage shape).
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const model = text(fact.model, "thaura");
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: "thaura",
          model,
          project: projectName(fact.cwd ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached,
          cachedInputTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "pi" || input.agentId === "prime") {
        const directory = value.cwd ?? value.directory ?? object(value.session)?.cwd;
        if (typeof directory === "string") sessionProject = projectName(directory);
        if (value.type !== "message") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp ?? message?.timestamp);
        if (!message || message.role !== "assistant" || !usage || !usageDay) continue;
        const loggedCostUsd = finite(object(usage.cost)?.total);
        const hasTokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output) > 0;
        if (!hasTokens && !(loggedCostUsd !== null && loggedCostUsd > 0)) continue;
        add(rows, {
          day: usageDay,
          modelProviderId: text(message.provider, "unknown"),
          model: text(message.responseModel, text(message.model, "unknown")),
          project: sessionProject,
          loggedCostUsd,
          uncachedInputTokens: count(usage.input), cachedInputTokens: count(usage.cacheRead),
          cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
        });
      }

      if (input.agentId === "dsh") {
        if (value.type === "session") {
          dshSeeded = value.isSeeded === true;
          if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
          continue;
        }
        if (value.type === "session/end-seed") {
          // Only a tagged marker is a fork boundary; dsh also writes untagged
          // end-seed records at ordinary resume/restore boundaries.
          if (object(value.data)?.inherited === true && typeof value.seq === "number") {
            dshEndSeedSeq = Math.max(dshEndSeedSeq, value.seq);
          }
          continue;
        }
        const data = object(value.data);
        if (value.type === "llm/retry-started") {
          if (dshLastSettlement?.turn === data?.turn && dshLastSettlement?.step === data?.step) {
            dshLastSettlement = undefined;
          }
          continue;
        }
        if (value.type === "request/context" && data) {
          dshProvider = text(data.provider, dshProvider);
          dshModel = text(data.model, dshModel);
          continue;
        }
        if (value.type !== "assistant/message" && value.type !== "assistant/attempt") continue;
        const usage = object(data?.usage) ?? lastStreamUsage(data?.stream);
        const usageDay = day(value.time);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.inputTokens);
        const cached = count(usage.cacheReadTokens);
        const writes = count(usage.cacheWriteTokens);
        const output = count(usage.outputTokens);
        const source = object(object(data?.message)?.source);
        const replay = object(object(source?.replayState)?.response);
        const settlement = {
          seq: count(value.seq),
          turn: count(data?.turn),
          step: count(data?.step),
          row: {
            day: usageDay,
            modelProviderId: text(source?.provider ?? replay?.provider, dshProvider),
            model: text(replay?.responseModel ?? source?.model ?? replay?.model, dshModel),
            project: sessionProject,
            loggedCostUsd: null,
            uncachedInputTokens: inputTokens, cachedInputTokens: cached,
            cacheWriteTokens: writes, outputTokens: output,
          },
        };
        if (dshLastSettlement?.turn === settlement.turn && dshLastSettlement.step === settlement.step) {
          Object.assign(dshLastSettlement, settlement);
        } else {
          dshSettlements.push(settlement);
          dshLastSettlement = settlement;
        }
        continue;
      }
    }
    // Without the cut, recovered fork history cannot be attributed safely.
    // Throw so the caller preserves any prior valid cache instead.
    if (dshSeeded && dshEndSeedSeq < 0) throw new Error("A seeded usage log is missing its inherited boundary.");
    for (const settlement of dshSettlements) {
      if (dshSeeded && settlement.seq <= dshEndSeedSeq) continue;
      const row = settlement.row;
      // A zero final sample still replaces earlier usage, but creates no row.
      if (row.uncachedInputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens > 0) add(rows, row);
    }
    if (input.agentId === "codex") {
      return [...rows.values()].map((row) => {
        const eventIdentity = crypto.createHash("sha256").update(JSON.stringify([
          "codex", codexSessionId, row.day, row.modelProviderId, row.model, row.project,
        ])).digest("hex");
        return {
          ...row,
          eventIdentity,
          eventKey: crypto.createHash("sha256").update(JSON.stringify([eventIdentity, row.account ?? null])).digest("hex"),
        };
      });
    }
    return input.agentId === "claude" || input.agentId === "codebuddy" || input.agentId === "cursor" || input.agentId === "copilot"
      ? [...events.values(), ...rows.values()]
      : [...rows.values()];
  }

  let cache: Cache = { version: cacheVersion, agentId: input.agentId, files: {} };
  try {
    const parsed = object(JSON.parse(await fs.promises.readFile(input.cachePath, "utf8")));
    const parsedFiles = object(parsed?.files);
    if (parsed?.version === cacheVersion && parsed.agentId === input.agentId && parsedFiles) {
      const files: Record<string, CacheEntry> = {};
      for (const [sourceId, entry] of Object.entries(parsedFiles)) {
        if (validCacheEntry(entry)) files[sourceId] = entry;
      }
      cache = { version: cacheVersion, agentId: input.agentId, files };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push("The prior metadata cache could not be read.");
  }

  const discovered: string[] = [];
  const roots = [...input.roots];
  if (input.agentId === "codebuddy" && process.env.CODEBUDDY_CONFIG_DIR?.trim()) {
    const home = process.env.CODEBUDDY_CONFIG_DIR.trim();
    if (path.isAbsolute(home)) roots.push(path.join(home, "projects"));
  }
  for (const root of [...new Set(roots)]) {
    const before = discovered.length;
    await walk(root, discovered);
    // Codex scan roots are <home>/sessions and <home>/archived_sessions, so
    // the home owning each discovered file is the walked root's parent.
    if (input.agentId === "codex") {
      const rootHome = path.dirname(root);
      observedHomes.set(homeTagFor(rootHome), "");
      for (const filePath of discovered.slice(before)) {
        if (!homeByPath.has(filePath)) homeByPath.set(filePath, rootHome);
      }
    }
  }
  const accountDiscovered: string[] = [];
  // Configured homes are discovered before convention-based parents so a
  // configured label wins when the same file is reached through both.
  for (const { account, home } of accountHomes) {
    const files: string[] = [];
    await walk(path.join(home, "sessions"), files);
    await walk(path.join(home, "archived_sessions"), files);
    files.sort();
    for (const filePath of files) {
      if (!accountByPath.has(filePath)) accountByPath.set(filePath, account);
      if (!homeByPath.has(filePath)) homeByPath.set(filePath, home);
    }
    observedHomes.set(homeTagFor(home), account);
    accountDiscovered.push(...files);
  }
  for (const parent of accountRoots) {
    let accountEntries: import("node:fs").Dirent[] = [];
    try {
      accountEntries = await fs.promises.readdir(parent.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        discoveryFailed = true;
        failures.push("A usage directory could not be read.");
      }
    }
    for (const entry of accountEntries) {
      // Dirent type bits describe the link itself, so a symlinked profile home
      // is followed here; the inode dedup below keeps an account aliased to the
      // primary home from being counted twice.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (parent.prefix !== undefined && !entry.name.startsWith(parent.prefix)) continue;
      const account = entry.name.slice(parent.prefix?.length ?? 0);
      if (!account) continue;
      const files: string[] = [];
      await walk(path.join(parent.root, entry.name, "sessions"), files);
      await walk(path.join(parent.root, entry.name, "archived_sessions"), files);
      files.sort();
      for (const filePath of files) {
        if (!accountByPath.has(filePath)) accountByPath.set(filePath, account);
        if (!homeByPath.has(filePath)) homeByPath.set(filePath, path.join(parent.root, entry.name));
      }
      // A configured label beats a conventional one; a conventional label
      // still upgrades a home the config left unlabeled.
      const conventionTag = homeTagFor(path.join(parent.root, entry.name));
      if (!observedHomes.get(conventionTag)) observedHomes.set(conventionTag, account);
      accountDiscovered.push(...files);
    }
  }
  // Primary roots come first so the inode dedup attributes an aliased file to
  // the primary home; account paths keep discovery order (and dedupe by first
  // occurrence) so an explicit label beats a convention-discovered one.
  const uniquePaths = [...new Set(discovered)].sort().concat([...new Set(accountDiscovered)]);
  const nextFiles: Record<string, CacheEntry> = {};
  const allRows = new Map<string, HostUsageAggregate>();
  const allEvents = new Map<string, CachedUsageRow>();
  const seenFiles = new Set<string>();
  let fileCount = 0;
  let changedFileCount = 0;
  let reusedFileCount = 0;

  for (const filePath of uniquePaths) {
    const sourceId = crypto.createHash("sha256").update(filePath).digest("hex");
    // DSH preserves the immutable v3 predecessor when publishing v4.
    // Select the successor before merging cached rows to avoid replaying history twice.
    if (input.agentId === "dsh" && path.basename(filePath) === "session.v3.jsonl.zstd"
      && fs.existsSync(path.join(path.dirname(filePath), "session.v4.jsonl.zstd"))) {
      delete cache.files[sourceId];
      continue;
    }
    const prior = cache.files[sourceId];
    // Attribution lives outside the file-derived signature, so rows reused
    // from cache take the current account mapping when a configured label
    // or convention path changes.
    const reattribute = (rows: CachedUsageRow[]): CachedUsageRow[] => {
      const account = accountByPath.get(filePath);
      const home = homeByPath.get(filePath);
      return account === undefined && home === undefined ? rows : rows.map((row) => {
        const homeTag = home === undefined ? undefined : homeTagFor(home);
        const attributed = { ...row, account: account || undefined, homeTag };
        if (row.eventIdentity) {
          attributed.eventKey = crypto.createHash("sha256")
            .update(JSON.stringify([row.eventIdentity, attributed.account ?? null])).digest("hex");
        }
        return attributed;
      });
    };
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoffMs) continue;
      const fileIdentity = `${stat.dev}:${stat.ino}`;
      if (seenFiles.has(fileIdentity)) continue;
      seenFiles.add(fileIdentity);
      fileCount += 1;
      let signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      if (input.agentId === "antigravity") {
        const dbPath = agyConversationDbPath(filePath);
        if (dbPath) {
          try {
            const dbStat = await fs.promises.stat(dbPath);
            signature += `:db=${dbStat.size}:${Math.trunc(dbStat.mtimeMs)}`;
          } catch {}
          try {
            const walStat = await fs.promises.stat(`${dbPath}-wal`);
            signature += `:wal=${walStat.size}:${Math.trunc(walStat.mtimeMs)}`;
          } catch {}
        }
      }
      if (prior?.signature === signature && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        const rows = reattribute(prior.rows);
        nextFiles[sourceId] = { signature, rows };
        for (const row of rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
        reusedFileCount += 1;
        continue;
      }
      const rows = await parseFile(filePath);
      nextFiles[sourceId] = { signature, rows };
      for (const row of rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      changedFileCount += 1;
    } catch {
      // Absolute host paths and raw errors must not cross the host boundary;
      // this string is persisted in sync state and shown in the dashboard.
      failures.push(!canDecompressZstd && filePath.endsWith(".zstd")
        ? "A Zstandard usage log needs Node.js 22.15+ on this host."
        : "A usage log could not be read.");
      if (prior && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        const rows = reattribute(prior.rows);
        nextFiles[sourceId] = { signature: prior.signature, rows };
        for (const row of rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      }
    }
  }

  if (discoveryFailed) {
    for (const [sourceId, prior] of Object.entries(cache.files)) {
      if (nextFiles[sourceId] || !Array.isArray(prior.rows) || !prior.rows.every(validRow)) continue;
      nextFiles[sourceId] = prior;
      for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
    }
  }

  try {
    await fs.promises.mkdir(path.dirname(input.cachePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({
      version: cacheVersion,
      agentId: input.agentId,
      files: nextFiles,
    }), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, input.cachePath);
  } catch {
    failures.push("The metadata-only usage cache could not be updated.");
  }

  for (const row of allEvents.values()) add(allRows, row);
  const rows = [...allRows.values()].sort((a, b) => a.day.localeCompare(b.day)
    || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model)
    || a.project.localeCompare(b.project));
  const result: HostJsonScanResult = {
    agentId: input.agentId,
    fileCount,
    changedFileCount,
    reusedFileCount,
    failureCount: failures.length,
    error: failures[0]?.replace(/[\r\n]+/g, " ").slice(0, 200) ?? null,
    rows,
    homes: input.agentId === "codex"
      ? [...observedHomes].map(([homeTag, account]) => ({ homeTag, account }))
      : undefined,
  };
  const encoded = zlib.gzipSync(JSON.stringify(result)).toString("base64");
  process.stdout.write(`${scanBegin}\n${encoded}\n${scanEnd}\n`);
}

export function hostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),path:require('node:path'),crypto:require('node:crypto'),readline:require('node:readline'),zlib:require('node:zlib'),loadSqlite:function(){return require('node:sqlite');}}";
  return `(${hostJsonCollectorSource})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedHostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedScript = gzipSync(hostJsonCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}

export function extractHostJsonScan(output: string): HostJsonScanResult {
  const normalized = output.replace(/\r/g, "");
  const start = normalized.lastIndexOf(`${SCAN_BEGIN}\n`);
  const end = normalized.lastIndexOf(`\n${SCAN_END}`);
  if (start < 0 || end < 0 || end <= start) throw new Error("Host usage scan returned incomplete output.");
  const encoded = normalized.slice(start + SCAN_BEGIN.length + 1, end).trim();
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  } catch {
    throw new Error("Host usage scan returned malformed output.");
  }
  const parsed = scanResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Host usage scan returned an unexpected result shape.");
  return parsed.data;
}
