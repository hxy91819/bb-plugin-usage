// Period-over-period trend math: the last `period` local days against the
// `period` days before them, overall, per agent, per model, and as model share.

export type TrendPeriod = 7 | 30;
export type TrendMetric = "tokens" | "cost";

export type TrendRow = {
  day: string;
  agentId: string;
  agentName: string;
  modelProviderId: string;
  modelProviderName: string;
  model: string;
  processedTokens: number;
  costUsd: number;
  pricingStatus: string;
};

// `new`: usage only in the current period; `none`: no usage in either.
export type TrendDirection = "up" | "down" | "flat" | "new" | "none";

export type TrendSeries = {
  key: string;
  label: string;
  agentId: string | null;
  agentName: string | null;
  providerId: string | null;
  providerName: string | null;
  agents: string[];
  current: number;
  previous: number;
  dailyAverage: number;
  change: number | null;
  direction: TrendDirection;
  currentDaily: number[];
  previousDaily: number[];
  // Cost mode only: the row includes unpriced usage, so the value is a lower bound.
  unknown: boolean;
};

export type TrendMixShift = {
  key: string;
  label: string;
  providerId: string | null;
  providerName: string | null;
  agents: string[];
  current: number;
  currentShare: number;
  previousShare: number;
  // Fractional points: 0.05 is five percentage points.
  deltaShare: number;
  direction: TrendDirection;
  otherCount: number;
};

export type UsageTrends = {
  period: TrendPeriod;
  metric: TrendMetric;
  currentDays: string[];
  previousDays: string[];
  total: TrendSeries;
  agents: TrendSeries[];
  models: TrendSeries[];
  mix: TrendMixShift[];
};

const FLAT_CHANGE_THRESHOLD = 0.05;
const FLAT_SHARE_THRESHOLD = 0.005;
const MIX_MIN_SHARE = 0.01;
const MIX_TOP_ROWS = 8;
export const MIX_OTHER_KEY = "$other";

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function trendDays(period: TrendPeriod, today: Date) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Array.from({ length: period * 2 }, (_, index) => {
    const day = new Date(end);
    day.setDate(end.getDate() - period * 2 + index + 1);
    return localDay(day);
  });
  return { previousDays: days.slice(0, period), currentDays: days.slice(period) };
}

function trendValue(row: Pick<TrendRow, "processedTokens" | "costUsd">, metric: TrendMetric) {
  return metric === "cost" ? row.costUsd : row.processedTokens;
}

function trendDirection(current: number, previous: number): TrendDirection {
  if (previous <= 0) return current > 0 ? "new" : "none";
  const change = (current - previous) / previous;
  if (Math.abs(change) < FLAT_CHANGE_THRESHOLD) return "flat";
  return change > 0 ? "up" : "down";
}

function modelLabel(model: string) {
  return model === "codex-unknown" ? "Unknown" : model;
}

type Bucket = {
  key: string;
  label: string;
  agentId: string | null;
  agentName: string | null;
  providerId: string | null;
  providerName: string | null;
  agents: Set<string>;
  currentDaily: number[];
  previousDaily: number[];
  unknown: boolean;
};

function finishBucket(bucket: Bucket, period: TrendPeriod): TrendSeries {
  const current = bucket.currentDaily.reduce((sum, value) => sum + value, 0);
  const previous = bucket.previousDaily.reduce((sum, value) => sum + value, 0);
  return {
    key: bucket.key,
    label: bucket.label,
    agentId: bucket.agentId,
    agentName: bucket.agentName,
    providerId: bucket.providerId,
    providerName: bucket.providerName,
    agents: [...bucket.agents],
    current,
    previous,
    dailyAverage: current / period,
    change: previous > 0 ? (current - previous) / previous : null,
    direction: trendDirection(current, previous),
    currentDaily: bucket.currentDaily,
    previousDaily: bucket.previousDaily,
    unknown: bucket.unknown,
  };
}

export function buildUsageTrends(
  rows: TrendRow[],
  options: { period: TrendPeriod; metric: TrendMetric; today?: Date },
): UsageTrends {
  const { period, metric } = options;
  const { currentDays, previousDays } = trendDays(period, options.today ?? new Date());
  const currentIndex = new Map(currentDays.map((day, index) => [day, index]));
  const previousIndex = new Map(previousDays.map((day, index) => [day, index]));
  const bucket = (seed: Omit<Bucket, "agents" | "currentDaily" | "previousDaily" | "unknown">): Bucket => ({
    ...seed,
    agents: new Set(),
    currentDaily: new Array<number>(period).fill(0),
    previousDaily: new Array<number>(period).fill(0),
    unknown: false,
  });
  const total = bucket({ key: "$total", label: "All usage", agentId: null, agentName: null, providerId: null, providerName: null });
  const agents = new Map<string, Bucket>();
  const models = new Map<string, Bucket>();

  for (const row of rows) {
    const inCurrent = currentIndex.get(row.day);
    const inPrevious = inCurrent === undefined ? previousIndex.get(row.day) : undefined;
    if (inCurrent === undefined && inPrevious === undefined) continue;
    const value = trendValue(row, metric);
    const unknown = metric === "cost" && row.pricingStatus === "unknown";
    const agentKey = row.agentId;
    const modelKey = `${row.modelProviderId}:${row.model}`;
    const agent = agents.get(agentKey) ?? bucket({
      key: agentKey, label: row.agentName, agentId: row.agentId, agentName: row.agentName, providerId: null, providerName: null,
    });
    const model = models.get(modelKey) ?? bucket({
      key: modelKey, label: modelLabel(row.model), agentId: null, agentName: null,
      providerId: row.modelProviderId, providerName: row.modelProviderName,
    });
    for (const target of [total, agent, model]) {
      if (inCurrent !== undefined) target.currentDaily[inCurrent] += value;
      else target.previousDaily[inPrevious!] += value;
      target.unknown = target.unknown || unknown;
      target.agents.add(row.agentName);
    }
    agents.set(agentKey, agent);
    models.set(modelKey, model);
  }

  const byCurrent = (a: TrendSeries, b: TrendSeries) => b.current - a.current || b.previous - a.previous || a.label.localeCompare(b.label);
  const totalSeries = finishBucket(total, period);
  const agentSeries = [...agents.values()].map((item) => finishBucket(item, period)).sort(byCurrent);
  const modelSeries = [...models.values()].map((item) => finishBucket(item, period)).sort(byCurrent);

  return {
    period,
    metric,
    currentDays,
    previousDays,
    total: totalSeries,
    agents: agentSeries,
    models: modelSeries,
    mix: buildMix(modelSeries, totalSeries),
  };
}

// Shares are relative to each period's own total, so a model that grew faster
// than the total gains share even when everything grew. Models outside the top
// rows or below MIX_MIN_SHARE in both periods fold into Other.
function buildMix(models: TrendSeries[], total: TrendSeries): TrendMixShift[] {
  const share = (value: number, sum: number) => (sum > 0 ? value / sum : 0);
  const ranked = models
    .map((model) => ({
      model,
      currentShare: share(model.current, total.current),
      previousShare: share(model.previous, total.previous),
    }))
    .filter((item) => item.currentShare > 0 || item.previousShare > 0)
    .sort((a, b) => b.currentShare - a.currentShare || b.previousShare - a.previousShare || a.model.label.localeCompare(b.model.label));
  const visible = ranked.filter((item, index) =>
    index < MIX_TOP_ROWS && (item.currentShare >= MIX_MIN_SHARE || item.previousShare >= MIX_MIN_SHARE));
  const folded = ranked.filter((item) => !visible.includes(item));
  const shift = (item: typeof ranked[number]): TrendMixShift => {
    const deltaShare = item.currentShare - item.previousShare;
    return {
      key: item.model.key,
      label: item.model.label,
      providerId: item.model.providerId,
      providerName: item.model.providerName,
      agents: item.model.agents,
      current: item.model.current,
      currentShare: item.currentShare,
      previousShare: item.previousShare,
      deltaShare,
      direction: item.previousShare <= 0
        ? (item.currentShare > 0 ? "new" : "none")
        : Math.abs(deltaShare) < FLAT_SHARE_THRESHOLD ? "flat" : deltaShare > 0 ? "up" : "down",
      otherCount: 0,
    };
  };
  const mix = visible.map(shift);
  if (folded.length > 0) {
    const other = shift({
      model: {
        ...total,
        key: MIX_OTHER_KEY,
        label: "Other",
        providerId: null,
        providerName: null,
        agents: [...new Set(folded.flatMap((item) => item.model.agents))],
        current: folded.reduce((sum, item) => sum + item.model.current, 0),
      },
      currentShare: folded.reduce((sum, item) => sum + item.currentShare, 0),
      previousShare: folded.reduce((sum, item) => sum + item.previousShare, 0),
    });
    mix.push({ ...other, otherCount: folded.length });
  }
  return mix;
}
