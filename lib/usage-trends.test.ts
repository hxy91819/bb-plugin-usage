import { describe, expect, it } from "vitest";
import { MIX_OTHER_KEY, buildUsageTrends, type TrendRow } from "./usage-trends";

const today = new Date(2026, 10, 6, 15, 30);

function dayOffset(offset: number) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function row(overrides: Partial<TrendRow> & { day: string }): TrendRow {
  return {
    agentId: "codex", agentName: "Codex", modelProviderId: "openai", modelProviderName: "OpenAI",
    model: "gpt-5", processedTokens: 1000, costUsd: 1, pricingStatus: "models-dev-exact",
    ...overrides,
  };
}

describe("buildUsageTrends", () => {
  it("splits the last 2×period local days into previous and current windows ending today", () => {
    const { previousDays, currentDays } = buildUsageTrends([], { period: 7, metric: "tokens", today });
    expect(currentDays).toHaveLength(7);
    expect(previousDays).toHaveLength(7);
    expect(currentDays.at(-1)).toBe("2026-11-06");
    expect(currentDays[0]).toBe("2026-10-31");
    expect(previousDays.at(-1)).toBe("2026-10-30");
    expect(previousDays[0]).toBe("2026-10-24");
  });

  it("crosses month boundaries without skipping or repeating days", () => {
    const { previousDays, currentDays } = buildUsageTrends([], { period: 30, metric: "tokens", today });
    const all = [...previousDays, ...currentDays];
    expect(new Set(all).size).toBe(60);
    expect(all[0]).toBe("2026-09-08");
  });

  it.each([
    [120, 100, "up"], [80, 100, "down"], [104, 100, "flat"], [96, 100, "flat"], [5, 0, "new"], [0, 0, "none"], [0, 100, "down"],
  ] as const)("classifies %s tokens against %s before as %s", (current, previous, direction) => {
    const rows = [row({ day: dayOffset(0), processedTokens: current }), row({ day: dayOffset(7), processedTokens: previous })];
    expect(buildUsageTrends(rows, { period: 7, metric: "tokens", today }).total.direction).toBe(direction);
  });

  it("compares the current window with the previous one and ignores older or future days", () => {
    const rows = [
      row({ day: dayOffset(0), processedTokens: 300 }),
      row({ day: dayOffset(6), processedTokens: 300 }),
      row({ day: dayOffset(7), processedTokens: 200 }),
      row({ day: dayOffset(13), processedTokens: 200 }),
      row({ day: dayOffset(14), processedTokens: 9_000 }),
      row({ day: dayOffset(-1), processedTokens: 9_000 }),
    ];
    const trends = buildUsageTrends(rows, { period: 7, metric: "tokens", today });
    expect(trends.total.current).toBe(600);
    expect(trends.total.previous).toBe(400);
    expect(trends.total.change).toBeCloseTo(0.5);
    expect(trends.total.direction).toBe("up");
    expect(trends.total.dailyAverage).toBeCloseTo(600 / 7);
    expect(trends.total.currentDaily).toEqual([300, 0, 0, 0, 0, 0, 300]);
    expect(trends.total.previousDaily).toEqual([200, 0, 0, 0, 0, 0, 200]);
  });

  it("ranks agents and models by the current period and reports new and vanished usage", () => {
    const rows = [
      row({ day: dayOffset(1), agentId: "codex", agentName: "Codex", processedTokens: 500 }),
      row({ day: dayOffset(1), agentId: "claude", agentName: "Claude Code", modelProviderId: "anthropic", modelProviderName: "Anthropic", model: "claude-sonnet-4-5", processedTokens: 900 }),
      row({ day: dayOffset(9), agentId: "codex", agentName: "Codex", processedTokens: 1_000 }),
      row({ day: dayOffset(9), agentId: "pi", agentName: "Pi", modelProviderId: "openai", modelProviderName: "OpenAI", model: "gpt-5-mini", processedTokens: 400 }),
    ];
    const trends = buildUsageTrends(rows, { period: 7, metric: "tokens", today });
    expect(trends.agents.map((agent) => [agent.key, agent.current, agent.previous, agent.direction])).toEqual([
      ["claude", 900, 0, "new"],
      ["codex", 500, 1_000, "down"],
      ["pi", 0, 400, "down"],
    ]);
    expect(trends.agents[1]!.change).toBeCloseTo(-0.5);
    expect(trends.agents[2]!.change).toBe(-1);
    expect(trends.models.map((model) => [model.key, model.label, model.providerName, model.agents])).toEqual([
      ["anthropic:claude-sonnet-4-5", "claude-sonnet-4-5", "Anthropic", ["Claude Code"]],
      ["openai:gpt-5", "gpt-5", "OpenAI", ["Codex"]],
      ["openai:gpt-5-mini", "gpt-5-mini", "OpenAI", ["Pi"]],
    ]);
  });

  it("merges the same model across agents and names every agent that used it", () => {
    const rows = [
      row({ day: dayOffset(0), agentId: "codex", agentName: "Codex", processedTokens: 100 }),
      row({ day: dayOffset(0), agentId: "pi", agentName: "Pi", processedTokens: 50 }),
    ];
    const trends = buildUsageTrends(rows, { period: 7, metric: "tokens", today });
    expect(trends.models).toHaveLength(1);
    expect(trends.models[0]!.current).toBe(150);
    expect(trends.models[0]!.agents).toEqual(["Codex", "Pi"]);
  });

  it("uses cost in cost mode and flags rows that include unpriced usage", () => {
    const rows = [
      row({ day: dayOffset(0), costUsd: 2, processedTokens: 1 }),
      row({ day: dayOffset(0), model: "mystery", costUsd: 0, processedTokens: 5_000, pricingStatus: "unknown" }),
      row({ day: dayOffset(8), costUsd: 4, processedTokens: 1 }),
    ];
    const trends = buildUsageTrends(rows, { period: 7, metric: "cost", today });
    expect(trends.total.current).toBe(2);
    expect(trends.total.previous).toBe(4);
    expect(trends.total.direction).toBe("down");
    expect(trends.total.unknown).toBe(true);
    expect(trends.models.find((model) => model.label === "mystery")?.unknown).toBe(true);
    expect(trends.models.find((model) => model.label === "gpt-5")?.unknown).toBe(false);
    expect(buildUsageTrends(rows, { period: 7, metric: "tokens", today }).total.unknown).toBe(false);
  });

  it("reports model share shifts relative to each period's own total", () => {
    const rows = [
      row({ day: dayOffset(0), model: "gpt-5", processedTokens: 600 }),
      row({ day: dayOffset(0), model: "gpt-5-mini", processedTokens: 400 }),
      row({ day: dayOffset(8), model: "gpt-5", processedTokens: 200 }),
      row({ day: dayOffset(8), model: "gpt-5-mini", processedTokens: 300 }),
    ];
    const trends = buildUsageTrends(rows, { period: 7, metric: "tokens", today });
    expect(trends.mix.map((item) => [item.label, item.currentShare, item.previousShare, item.direction])).toEqual([
      ["gpt-5", 0.6, 0.4, "up"],
      ["gpt-5-mini", 0.4, 0.6, "down"],
    ]);
    expect(trends.mix[0]!.deltaShare).toBeCloseTo(0.2);
  });

  it("folds long-tail and sub-one-percent models into Other", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({ day: dayOffset(0), model: `model-${index}`, processedTokens: 1_000 - index }));
    rows.push(row({ day: dayOffset(0), model: "trace", processedTokens: 1 }));
    const trends = buildUsageTrends(rows, { period: 7, metric: "tokens", today });
    expect(trends.mix).toHaveLength(9);
    const other = trends.mix.at(-1)!;
    expect(other.key).toBe(MIX_OTHER_KEY);
    expect(other.otherCount).toBe(3);
    expect(other.direction).toBe("new");
    expect(trends.mix.reduce((sum, item) => sum + item.currentShare, 0)).toBeCloseTo(1);
  });

  it("returns empty, directionless trends when no rows fall in either window", () => {
    const trends = buildUsageTrends([row({ day: dayOffset(90) })], { period: 30, metric: "tokens", today });
    expect(trends.total.direction).toBe("none");
    expect(trends.total.change).toBeNull();
    expect(trends.agents).toEqual([]);
    expect(trends.models).toEqual([]);
    expect(trends.mix).toEqual([]);
  });
});
