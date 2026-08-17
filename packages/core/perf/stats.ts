// perf-lab core stats — pure, no host imports.
import type { CompareResult } from "./types";

export function quantile(values: number[], q: number): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

export function mad(values: number[]): number {
  if (!values || values.length === 0) return 0;
  const med = median(values)!;
  const devs = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return quantile(devs, 0.5)!;
}

export function filterOutliers(values: number[]): number[] {
  if (!values || values.length === 0) return [];
  const med = median(values)!;
  const m = mad(values);
  if (m === 0) return [...values]; // all-identical / MAD=0 → keep everything
  const k = 3.5 * m;
  return values.filter((v) => Math.abs(v - med) <= k);
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26 (max error 1.5e-7)
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function mannWhitney(
  a: number[],
  b: number[]
): { u: number; z: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 8 || n2 < 8) return { u: Number.NaN, z: Number.NaN, p: 1 }; // conservative
  const combined = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v
  );
  // average ranks with tie correction
  const ranks = new Array<number>(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let R1 = 0;
  for (let k = 0; k < combined.length; k++) if (combined[k].g === 0) R1 += ranks[k];
  const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - R1;
  const mu = (n1 * n2) / 2;
  const counts = new Map<number, number>();
  for (const c of combined) counts.set(c.v, (counts.get(c.v) ?? 0) + 1);
  let tieSum = 0;
  for (const c of counts.values()) if (c > 1) tieSum += c * c * c - c;
  const N = n1 + n2;
  const sigma2 = ((n1 * n2) / 12) * ((N * N * N - N - tieSum) / (N * (N - 1)));
  const sigma = Math.sqrt(sigma2);
  const z = (u1 - mu) / sigma;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { u: u1, z, p };
}

export function compareStats(
  base: { values: number[]; label: string },
  cand: { values: number[]; label: string },
  opts: { direction: "lower" | "higher" }
): CompareResult {
  const b = filterOutliers(base.values);
  const c = filterOutliers(cand.values);
  const p50Base = quantile(b, 0.5) ?? 0;
  const p50Cand = quantile(c, 0.5) ?? 0;
  const deltaPct = p50Base !== 0 ? ((p50Cand - p50Base) / p50Base) * 100 : 0;
  const mw = mannWhitney(b, c);
  const significant = mw.p < 0.05;
  let verdict: "improve" | "regress" | "noise";
  if (!significant) {
    verdict = "noise";
  } else {
    const better = opts.direction === "lower" ? p50Cand < p50Base : p50Cand > p50Base;
    verdict = better ? "improve" : "regress";
  }
  const advice =
    verdict === "noise"
      ? "Difference not statistically significant — increase runs before deciding."
      : verdict === "improve"
        ? "Statistically significant improvement — keep."
        : "Statistically significant regression — revert.";
  return {
    base: base.label,
    cand: cand.label,
    unit: "",
    p50Base,
    p50Cand,
    deltaPct,
    p: mw.p,
    significant,
    verdict,
    advice,
  };
}
