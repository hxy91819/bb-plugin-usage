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

// `new`: usage only in the current period; `none`: no usage in either;
// `unknown`: a period's cost is entirely unpriced, so no comparison exists.
export type TrendDirection = "up" | "down" | "flat" | "new" | "none" | "unknown";

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
  // Cost mode only: that period includes unpriced usage, so its value is a
  // lower bound, or entirely unknown when the priced value is zero.
  currentUnknown: boolean;
  previousUnknown: boolean;
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
  currentUnknown: boolean;
  previousUnknown: boolean;
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

// Whether any period or metric could show a trend, independent of the
// current selection, so the section and its controls stay reachable.
export function hasTrendUsage(rows: Array<Pick<TrendRow, "day" | "processedTokens" | "costUsd">>, today = new Date()) {
  const { previousDays, currentDays } = trendDays(30, today);
  const earliest = previousDays[0]!;
  const latest = currentDays[currentDays.length - 1]!;
  return rows.some((row) => row.day >= earliest && row.day <= latest && (row.processedTokens > 0 || row.costUsd > 0));
}

export function isUnknownValue(value: number, unknown: boolean) {
  return unknown && value === 0;
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
  currentUnknown: boolean;
  previousUnknown: boolean;
};

function finishBucket(bucket: Bucket, period: TrendPeriod): TrendSeries {
  const current = bucket.currentDaily.reduce((sum, value) => sum + value, 0);
  const previous = bucket.previousDaily.reduce((sum, value) => sum + value, 0);
  const incomparable = isUnknownValue(current, bucket.currentUnknown) || isUnknownValue(previous, bucket.previousUnknown);
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
    change: !incomparable && previous > 0 ? (current - previous) / previous : null,
    direction: incomparable ? "unknown" : trendDirection(current, previous),
    currentDaily: bucket.currentDaily,
    previousDaily: bucket.previousDaily,
    currentUnknown: bucket.currentUnknown,
    previousUnknown: bucket.previousUnknown,
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
  const bucket = (seed: Omit<Bucket, "agents" | "currentDaily" | "previousDaily" | "currentUnknown" | "previousUnknown">): Bucket => ({
    ...seed,
    agents: new Set(),
    currentDaily: new Array<number>(period).fill(0),
    previousDaily: new Array<number>(period).fill(0),
    currentUnknown: false,
    previousUnknown: false,
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
      if (inCurrent !== undefined) {
        target.currentDaily[inCurrent] += value;
        target.currentUnknown = target.currentUnknown || unknown;
      } else {
        target.previousDaily[inPrevious!] += value;
        target.previousUnknown = target.previousUnknown || unknown;
      }
      target.agents.add(row.agentName);
    }
    agents.set(agentKey, agent);
    models.set(modelKey, model);
  }

  // Rows whose priced value is unknown rank ahead of true zeros so they stay visible.
  const byCurrent = (a: TrendSeries, b: TrendSeries) =>
    b.current - a.current
    || Number(isUnknownValue(b.current, b.currentUnknown)) - Number(isUnknownValue(a.current, a.currentUnknown))
    || b.previous - a.previous
    || a.label.localeCompare(b.label);
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

// Shares are relative to each period's own priced total, so a model that grew
// faster than the total gains share even when everything grew. Models outside
// the top rows or below MIX_MIN_SHARE in both periods fold into Other; a model
// whose priced value is unknown in a period stays visible with that marked.
function buildMix(models: TrendSeries[], total: TrendSeries): TrendMixShift[] {
  const share = (value: number, sum: number) => (sum > 0 ? value / sum : 0);
  const unknownIn = (model: Pick<TrendSeries, "current" | "previous" | "currentUnknown" | "previousUnknown">) =>
    isUnknownValue(model.current, model.currentUnknown) || isUnknownValue(model.previous, model.previousUnknown);
  const ranked = models
    .map((model) => ({
      model,
      currentShare: share(model.current, total.current),
      previousShare: share(model.previous, total.previous),
    }))
    .filter((item) => item.currentShare > 0 || item.previousShare > 0 || unknownIn(item.model))
    .sort((a, b) =>
      b.currentShare - a.currentShare
      || Number(unknownIn(b.model)) - Number(unknownIn(a.model))
      || b.previousShare - a.previousShare
      || a.model.label.localeCompare(b.model.label));
  const visible = ranked
    .filter((item) => item.currentShare >= MIX_MIN_SHARE || item.previousShare >= MIX_MIN_SHARE || unknownIn(item.model))
    .slice(0, MIX_TOP_ROWS);
  const folded = ranked.filter((item) => !visible.includes(item));
  const shift = (item: typeof ranked[number]): TrendMixShift => {
    const deltaShare = item.currentShare - item.previousShare;
    const incomparable = unknownIn(item.model);
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
      direction: incomparable
        ? "unknown"
        : item.previousShare <= 0
          ? (item.currentShare > 0 ? "new" : "none")
          : Math.abs(deltaShare) < FLAT_SHARE_THRESHOLD ? "flat" : deltaShare > 0 ? "up" : "down",
      currentUnknown: item.model.currentUnknown,
      previousUnknown: item.model.previousUnknown,
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
        previous: folded.reduce((sum, item) => sum + item.model.previous, 0),
        currentUnknown: folded.some((item) => item.model.currentUnknown),
        previousUnknown: folded.some((item) => item.model.previousUnknown),
      },
      currentShare: folded.reduce((sum, item) => sum + item.currentShare, 0),
      previousShare: folded.reduce((sum, item) => sum + item.previousShare, 0),
    });
    mix.push({ ...other, otherCount: folded.length });
  }
  return mix;
}
