import type { HeightTile } from "./height-tile";

interface FormLineSelectionOptions {
  steepness?: number;
  addition?: number;
  minimumGap?: number;
}

// Form line selection adapted from Karttapullautin's terrain classification
// in src/render.rs (GPL-3.0). See LICENSE and README.md.
// Sample the original algorithm's 2 m grid in physical space using bilinear
// interpolation. This cannot recover details absent from a coarser DEM.
export function formlineSteepness(
  tile: HeightTile,
  x: number,
  y: number,
  spacing: number,
  interval: number,
  threshold = 0.16,
): number {
  const ratio = 2 / spacing;
  const sample = (dx: number, dy: number): number => {
    const px = x + dx * ratio,
      py = y + dy * ratio;
    const ix = Math.floor(px),
      iy = Math.floor(py),
      fx = px - ix,
      fy = py - iy;
    const a = tile.get(ix, iy),
      b = tile.get(ix + 1, iy);
    const c = tile.get(ix, iy + 1),
      d = tile.get(ix + 1, iy + 1);
    if (![a, b, c, d].every(Number.isFinite)) return NaN;
    return (
      (((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) *
        5) /
      interval
    );
  };
  const center = sample(0, 0);
  if (!Number.isFinite(center)) return NaN;
  let high = 0,
    det = 0,
    porr = 0;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    const diagonal = dx !== 0 && dy !== 0;
    const before = sample(-4 * dx, -4 * dy),
      after = sample(4 * dx, 4 * dy);
    const wideBefore = sample(-6 * dx, -6 * dy),
      wideAfter = sample(6 * dx, 6 * dy);
    const nearBefore = sample(-3 * dx, -3 * dy),
      nearAfter = sample(3 * dx, 3 * dy);
    if (
      ![before, after, wideBefore, wideAfter, nearBefore, nearAfter].every(
        Number.isFinite,
      )
    )
      return NaN;
    const divisor = diagonal ? 5.6 : 4;
    high = Math.max(
      high,
      Math.min(Math.abs(before - center), Math.abs(center - after)) / divisor,
    );
    det = Math.max(
      det,
      Math.abs(center - 0.5 * (before + after)) -
        0.05 * Math.abs(before - after),
    );
    const wideDiv = diagonal ? 17 : 12,
      nearDiv = diagonal ? 8.5 : 6;
    porr = Math.max(
      porr,
      Math.abs(
        Math.abs((wideBefore - wideAfter) / wideDiv) -
          Math.abs((nearBefore - nearAfter) / nearDiv),
      ),
    );
  }
  let value = (12 * high) / (1 + 8 * det);
  if (porr > (0.25 * 0.67) / (0.3 + threshold)) value = 0.01;
  return Math.max(high, value);
}

export function selectFormline(
  line: number[],
  tile: HeightTile,
  extent: number,
  interval: number,
  spacing: number | ((y: number) => number) = 2,
  cache: Map<string, number> = new Map(),
  options: FormLineSelectionOptions = {},
): number[][] {
  const { steepness = 0.16, addition = 17, minimumGap = 30 } = options;
  const n = line.length / 2;
  if (n < 2) return [];
  const scale = (tile.width - 1) / extent;
  const eligible: boolean[] = [];
  const valid: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const x = line[2 * i] * scale,
      y = line[2 * i + 1] * scale;
    const values = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([dx, dy]) => {
      const gx = Math.floor(x) + dx,
        gy = Math.floor(y) + dy;
      const key = `${gx},${gy},${steepness}`;
      if (!cache.has(key)) {
        const groundSpacing =
          typeof spacing === "function" ? spacing(gy) : spacing;
        cache.set(
          key,
          formlineSteepness(tile, gx, gy, groundSpacing, interval, steepness),
        );
      }
      return cache.get(key)!;
    });
    const hasFullContext = values.every(Number.isFinite);
    valid.push(hasFullContext);
    eligible.push(hasFullContext && values.some((value) => value < steepness));
  }
  const closed =
    line[0] === line[line.length - 2] && line[1] === line[line.length - 1];
  const count = closed ? n - 1 : n;
  const selected = eligible.map((_, i) => {
    let votes = 0,
      total = 0;
    for (let j = -5; j < 4; j++) {
      const k = closed
        ? (i + j + count * 6) % count
        : Math.max(0, Math.min(n - 1, i + j));
      votes += eligible[k] ? 1 : 0;
      total++;
    }
    return valid[i] && votes >= Math.ceil((total * 5) / 9);
  });
  // The configured extension is in vertices, as in the original. This remains
  // vertex-density dependent, as in the source; distance-based adaptation is pending.
  const expanded = selected.slice();
  for (let i = 0; i < count; i++)
    if (selected[i]) {
      const radius = Math.max(0, addition - 1);
      for (const direction of [-1, 1])
        for (let d = 1; d <= radius; d++) {
          const raw = i + d * direction;
          const j = closed ? ((raw % count) + count) % count : raw;
          if (j < 0 || j >= count || !valid[j]) break;
          expanded[j] = true;
        }
    }
  if (
    closed &&
    count < 121 &&
    valid.slice(0, count).every(Boolean) &&
    expanded.slice(0, count).some(Boolean)
  )
    expanded.fill(true);
  if (closed) expanded[n - 1] = expanded[0];
  // Join short gaps, including a gap crossing the start of a ring.
  let last = -1;
  for (let i = 0; i < (closed ? count * 2 : count); i++) {
    const j = i % count;
    if (expanded[j]) {
      if (last >= 0 && i - last < minimumGap) {
        let complete = true;
        for (let k = last; k < i; k++)
          if (!valid[k % count]) {
            complete = false;
            break;
          }
        if (complete) for (let k = last; k < i; k++) expanded[k % count] = true;
      }
      last = i;
    }
  }
  if (closed) expanded[n - 1] = expanded[0];
  const result: number[][] = [];
  let current: number[] = [];
  for (let i = 1; i < n; i++) {
    if (expanded[i - 1] && expanded[i]) {
      if (!current.length)
        current.push(line[2 * (i - 1)], line[2 * (i - 1) + 1]);
      current.push(line[2 * i], line[2 * i + 1]);
    } else if (current.length) {
      result.push(current);
      current = [];
    }
  }
  if (current.length) result.push(current);
  return result;
}

/** Clip generated linework back to the configured vector-tile buffer. */
export function clipLines(
  lines: number[][],
  extent: number,
  buffer: number,
): number[][] {
  const min = -buffer;
  const max = extent + buffer;
  const clipped: number[][] = [];
  for (const line of lines) {
    let part: number[] = [];
    for (let i = 2; i < line.length; i += 2) {
      const x0 = line[i - 2],
        y0 = line[i - 1],
        x1 = line[i],
        y1 = line[i + 1];
      const dx = x1 - x0,
        dy = y1 - y0;
      let t0 = 0,
        t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [x0 - min, max - x0, y0 - min, max - y0];
      let visible = true;
      for (let edge = 0; edge < 4; edge++) {
        if (p[edge] === 0) {
          if (q[edge] < 0) visible = false;
        } else {
          const ratio = q[edge] / p[edge];
          if (p[edge] < 0) t0 = Math.max(t0, ratio);
          else t1 = Math.min(t1, ratio);
          if (t0 > t1) visible = false;
        }
      }
      if (!visible) {
        if (part.length) clipped.push(part);
        part = [];
        continue;
      }
      const start = [x0 + t0 * dx, y0 + t0 * dy];
      const end = [x0 + t1 * dx, y0 + t1 * dy];
      if (!part.length) part.push(...start);
      else if (
        part[part.length - 2] !== start[0] ||
        part[part.length - 1] !== start[1]
      ) {
        if (part.length >= 4) clipped.push(part);
        part = [...start];
      }
      part.push(...end);
      if (t1 < 1) {
        if (part.length >= 4) clipped.push(part);
        part = [];
      }
    }
    if (part.length >= 4) clipped.push(part);
  }
  return clipped;
}

export function isMultiple(value: number, interval: number): boolean {
  const quotient = value / interval;
  return Math.abs(quotient - Math.round(quotient)) < 1e-7;
}
