import { z } from "zod";

const homesSchema = z.array(z.object({
  name: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  path: z.string().trim().min(1).refine((value) => value.startsWith("/") || value.startsWith("~/")),
  hostId: z.string().trim().min(1).optional(),
}).strict());

export function configuredCodexHomes(value: string, home: string, hostId: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim() || "[]"); }
  catch { throw new Error("Codex homes must be a JSON array of {name, path, hostId?} entries."); }
  const result = homesSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid Codex homes: use unique names (letters, numbers, dot, underscore, hyphen), absolute or ~/ paths, and optional hostId.");
  const homes = result.data.filter((entry) => !entry.hostId || entry.hostId === hostId);
  if (new Set(homes.map((entry) => entry.name)).size !== homes.length) {
    throw new Error("Codex home names must be unique on each host.");
  }
  return homes.map(({ name, path }) => ({ name, path: path.startsWith("~/") ? `${home}/${path.slice(2)}` : path }));
}
