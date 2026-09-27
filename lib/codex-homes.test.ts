import { describe, expect, it } from "vitest";
import { configuredCodexHomes } from "./codex-homes";

describe("configured Codex homes", () => {
  it("resolves user-relative paths on each host and filters host-specific entries", () => {
    const config = JSON.stringify([
      { name: "work", path: "~/.work codex" },
      { name: "lab", path: "/srv/lab/codex", hostId: "lab-host" },
    ]);
    expect(configuredCodexHomes(config, "/home/alice", "laptop")).toEqual([{ name: "work", path: "/home/alice/.work codex" }]);
    expect(configuredCodexHomes(config, "/Users/bob", "lab-host")).toEqual([
      { name: "work", path: "/Users/bob/.work codex" }, { name: "lab", path: "/srv/lab/codex" },
    ]);
  });

  it("rejects ambiguous or invalid configuration without leaking paths", () => {
    expect(configuredCodexHomes("", "/home/user", "host")).toEqual([]);
    for (const input of ["not json", "{}", '[{"name":"x","path":"relative"}]', '[{"name":"x","path":"/private/path","extra":true}]',
      '[{"name":"x","path":"/a"},{"name":"x","path":"/b"}]']) {
      expect(() => configuredCodexHomes(input, "/home/user", "host")).toThrow();
      try { configuredCodexHomes(input, "/home/user", "host"); }
      catch (error) { expect(String(error)).not.toContain("/private/path"); }
    }
  });

  it("allows the same label for disjoint hosts", () => {
    expect(configuredCodexHomes('[{"name":"work","path":"/a","hostId":"a"},{"name":"work","path":"/b","hostId":"b"}]', "/home/user", "b"))
      .toEqual([{ name: "work", path: "/b" }]);
  });
});
