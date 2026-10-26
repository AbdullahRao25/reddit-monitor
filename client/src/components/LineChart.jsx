import { useMemo, useRef, useState } from 'react';
import { formatDateTime } from '../format.js';
import { useElementWidth } from '../hooks.js';

// Single-series time chart: 2px line over a 10% area wash, hairline grid,
// end-point label, and a crosshair + tooltip that snaps to the nearest
// check (pointer or arrow keys). A single series needs no legend: the
// title names it.

const HEIGHT = 200;
const MARGIN = { top: 14, right: 48, bottom: 30, left: 44 };

function niceStep(range, count) {
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// Whole-number data (karma, scores) never gets fractional ticks.
function niceTicks(min, max, count = 4, integer = false) {
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    [min, max] = [min - pad, max + pad];
  }
  const raw = niceStep(max - min, count);
  const step = integer ? Math.max(1, raw) : raw;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let i = 0; start + i * step <= end + step / 1e6; i++) ticks.push(Number((start + i * step).toPrecision(12)));
  return ticks;
}

function timeTicks(tMin, tMax, count) {
  if (tMin === tMax) return [tMin];
  return Array.from({ length: count }, (_, i) => tMin + ((tMax - tMin) * i) / (count - 1));
}

function formatTimeTick(t, range) {
  const date = new Date(t);
  return range < 36 * 36e5
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function LineChart({ title, description, points, yDomain, yTicks, formatValue = String, formatTick = formatValue }) {
  const bodyRef = useRef(null);
  const width = useElementWidth(bodyRef);
  const [active, setActive] = useState(null);

  const geometry = useMemo(() => {
    if (!width || points.length === 0) return null;
    const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const tMin = points[0].t;
    const tMax = points[points.length - 1].t;
    const x = (t) => (tMax === tMin ? innerW / 2 : ((t - tMin) / (tMax - tMin)) * innerW);

    const values = points.map((p) => p.v);
    const ticks = yTicks ?? niceTicks(Math.min(...values), Math.max(...values), 4, values.every(Number.isInteger));
    const [y0, y1] = yDomain ?? [ticks[0], ticks[ticks.length - 1]];
    const y = (v) => innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const area = `${line}L${x(tMax).toFixed(1)},${innerH}L${x(tMin).toFixed(1)},${innerH}Z`;
    const xs = points.map((p) => x(p.t));
    return {
      innerW,
      innerH,
      x,
      y,
      xs,
      ticks,
      line,
      area,
      range: tMax - tMin,
      xTicks: timeTicks(tMin, tMax, innerW < 320 ? 2 : 4),
    };
  }, [width, points, yDomain, yTicks]);

  function nearestIndex(px) {
    const { xs } = geometry;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
    return best;
  }

  function onPointerMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(event.clientX - rect.left));
  }

  function onKeyDown(event) {
    const last = points.length - 1;
    const moves = {
      ArrowLeft: (i) => Math.max(0, (i ?? last) - 1),
      ArrowRight: (i) => Math.min(last, (i ?? last) + 1),
      Home: () => 0,
      End: () => last,
    };
    if (!moves[event.key]) return;
    event.preventDefault();
    setActive((i) => moves[event.key](i));
  }

  const lastPoint = points[points.length - 1];
  const activePoint = active !== null ? points[active] : null;

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        {description && <span className="chart-sub">{description}</span>}
      </figcaption>
      <div className="chart-body" ref={bodyRef} style={{ height: HEIGHT }}>
        {points.length === 0 && <p className="chart-empty">No data yet. It fills in as checks run.</p>}
        {geometry && (
          <>
            <svg
              width={width}
              height={HEIGHT}
              className="chart-svg"
              tabIndex={0}
              role="group"
              aria-label={`${title}. Use the arrow keys to read each check.`}
              onKeyDown={onKeyDown}
              onFocus={() => setActive((i) => i ?? points.length - 1)}
              onBlur={() => setActive(null)}
            >
              <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                {geometry.ticks.map((v) => (
                  <g key={v}>
                    <line className="chart-grid" x1={0} x2={geometry.innerW} y1={geometry.y(v)} y2={geometry.y(v)} />
                    <text className="chart-tick" x={-8} y={geometry.y(v)} dy="0.32em" textAnchor="end">
                      {formatTick(v)}
                    </text>
                  </g>
                ))}
                <line className="chart-axis" x1={0} x2={geometry.innerW} y1={geometry.innerH} y2={geometry.innerH} />
                {geometry.xTicks.map((t, i, all) => (
                  <text
                    key={t}
                    className="chart-tick"
                    x={geometry.x(t)}
                    y={geometry.innerH + 20}
                    textAnchor={all.length === 1 ? 'middle' : i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}
                  >
                    {formatTimeTick(t, geometry.range)}
                  </text>
                ))}

                <path className="chart-area" d={geometry.area} />
                <path className="chart-line" d={geometry.line} />

                {activePoint && (
                  <line
                    className="chart-crosshair"
                    x1={geometry.x(activePoint.t)}
                    x2={geometry.x(activePoint.t)}
                    y1={0}
                    y2={geometry.innerH}
                  />
                )}
                <circle className="chart-dot" cx={geometry.x(lastPoint.t)} cy={geometry.y(lastPoint.v)} r={4} />
                <text
                  className="chart-end-label"
                  x={geometry.x(lastPoint.t) + 9}
                  y={geometry.y(lastPoint.v)}
                  dy="0.32em"
                >
                  {formatTick(lastPoint.v)}
                </text>
                {activePoint && activePoint !== lastPoint && (
                  <circle className="chart-dot" cx={geometry.x(activePoint.t)} cy={geometry.y(activePoint.v)} r={4} />
                )}

                {/* Hit area: the whole plot, so the reader aims at a date, not a 2px line. */}
                <rect
                  className="chart-hit"
                  x={0}
                  y={0}
                  width={geometry.innerW}
                  height={geometry.innerH}
                  onPointerMove={onPointerMove}
                  onPointerLeave={() => setActive(null)}
                />
              </g>
            </svg>

            {activePoint && (
              <div
                className="chart-tooltip"
                style={{
                  left: MARGIN.left + geometry.x(activePoint.t),
                  top: MARGIN.top,
                  transform:
                    geometry.x(activePoint.t) > geometry.innerW * 0.6
                      ? 'translateX(calc(-100% - 12px))'
                      : 'translateX(12px)',
                }}
              >
                <strong>{formatValue(activePoint.v)}</strong>
                <span>
                  <i className="line-key" aria-hidden="true" />
                  {formatDateTime(activePoint.t)}
                </span>
              </div>
            )}
            <span className="visually-hidden" aria-live="polite">
              {activePoint ? `${formatValue(activePoint.v)} on ${formatDateTime(activePoint.t)}` : ''}
            </span>
          </>
        )}
      </div>
    </figure>
  );
}
