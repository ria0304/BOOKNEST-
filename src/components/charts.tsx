import React, { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';

const niceMax = (n: number) => {
  if (n <= 0) return 4;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const frac = n / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
};

const PAD = { top: 16, right: 16, bottom: 28, left: 34 };

export function ChartFrame({ title, icon, empty, emptyText, children }: {
  title: string;
  icon: ReactNode;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-purple-950/20 border border-purple-900/50 p-8 rounded-2xl">
      <h3 className="text-xl font-semibold text-white mb-6 flex items-center">
        <span className="w-5 h-5 mr-2 flex items-center justify-center">{icon}</span> {title}
      </h3>
      {empty ? (
        <p className="text-gray-500 text-sm">{emptyText || 'No data available yet.'}</p>
      ) : (
        children
      )}
    </div>
  );
}

export type Point = { label: string; value: number };

export function AreaChart({ title, icon, data, unit }: {
  title: string;
  icon: ReactNode;
  data: Point[];
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 240;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = data.length;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const max = niceMax(Math.max(...data.map(d => d.value), 0));
  const baseline = PAD.top + plotH;
  const x = (i: number) => (n <= 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.value)}`).join(' ');
  const area = `${line} L ${x(n - 1)} ${baseline} L ${x(0)} ${baseline} Z`;
  const band = plotW / Math.max(n, 1);
  const ticks = [0, max / 2, max];
  const active = hover !== null ? data[hover] : null;

  return (
    <ChartFrame title={title} icon={icon} empty={n === 0 || total === 0} emptyText={`No ${unit} recorded for this year yet.`}>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={title}>
          <defs>
            <linearGradient id={`areaFill-${unit.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a855f7" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map(t => (
            <g key={t}>
              <line
                x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)}
                stroke="#4c1d95" strokeWidth="1" strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#9ca3af">
                {Math.round(t)}
              </text>
            </g>
          ))}

          {data.map((d, i) => (
            <text key={d.label} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#9ca3af">
              {d.label}
            </text>
          ))}

          <path d={area} fill={`url(#areaFill-${unit.replace(/\s+/g, '')})`} />
          <motion.path
            d={line}
            fill="none"
            stroke="#c084fc"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />

          {data.map((d, i) => (
            <motion.circle
              key={d.label}
              cx={x(i)}
              cy={y(d.value)}
              r={hover === i ? 5 : 3}
              fill="#ec4899"
              stroke="#1f0033"
              strokeWidth="1.5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 + i * 0.04 }}
            />
          ))}

          {data.map((d, i) => (
            <rect
              key={`hit-${d.label}`}
              x={x(i) - band / 2}
              y={PAD.top}
              width={band}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>

        {active && hover !== null && (
          <div
            className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full mb-2 bg-gray-900 rounded-lg px-3 py-2 shadow-xl border border-purple-800/50"
            style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(active.value) / H) * 100}%` }}
          >
            <p className="text-xs font-semibold text-white whitespace-nowrap">{active.label}</p>
            <p className="text-xs text-gray-300 whitespace-nowrap">
              {active.value} {unit}
            </p>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

export type Series = { key: string; label: string; color: string };

export type SeriesPoint = { label: string; [key: string]: any };

export function BarChart({ title, icon, data, series, unit }: {
  title: string;
  icon: ReactNode;
  data: SeriesPoint[];
  series: Series[];
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 240;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = data.length;
  const total = data.reduce((sum, d) => sum + series.reduce((s, def) => s + (d[def.key] ?? 0), 0), 0);
  const max = niceMax(Math.max(...data.flatMap(d => series.map(s => d[s.key] ?? 0)), 0));
  const baseline = PAD.top + plotH;
  const band = plotW / Math.max(n, 1);
  const groupW = band * 0.62;
  const barW = (groupW - 4) / Math.max(series.length, 1);
  const center = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const active = hover !== null ? data[hover] : null;

  return (
    <ChartFrame title={title} icon={icon} empty={n === 0 || total === 0} emptyText={`No ${unit} recorded for this year yet.`}>
      <div className="flex flex-wrap gap-4 mb-4">
        {series.map(s => (
          <div key={s.key} className="flex items-center gap-2 text-xs text-gray-400">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={title}>
          {ticks.map(t => (
            <g key={t}>
              <line
                x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)}
                stroke="#4c1d95" strokeWidth="1" strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#9ca3af">
                {Math.round(t)}
              </text>
            </g>
          ))}

          {data.map((d, i) =>
            series.map((s, si) => {
              const v = d[s.key] ?? 0;
              const h = Math.max(baseline - y(v), v > 0 ? 2 : 0);
              const bx = center(i) - groupW / 2 + si * (barW + 4);
              return (
                <motion.rect
                  key={`${d.label}-${s.key}`}
                  x={bx}
                  y={baseline - h}
                  width={barW}
                  height={h}
                  rx="2"
                  fill={s.color}
                  opacity={hover === null || hover === i ? 0.9 : 0.35}
                  initial={{ height: 0, y: baseline }}
                  animate={{ height: h, y: baseline - h }}
                  transition={{ duration: 0.5, delay: i * 0.03 }}
                />
              );
            })
          )}

          {data.map((d, i) => (
            <g key={`lbl-${d.label}`}>
              <text x={center(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#9ca3af">
                {d.label}
              </text>
              <rect
                x={center(i) - band / 2}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          ))}
        </svg>

        {active && hover !== null && (
          <div
            className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full bg-gray-900 rounded-lg px-3 py-2 shadow-xl border border-purple-800/50"
            style={{ left: `${(center(hover) / W) * 100}%`, top: `${(PAD.top / H) * 100}%` }}
          >
            <p className="text-xs font-semibold text-white whitespace-nowrap">{active.label}</p>
            {series.map(s => (
              <p key={s.key} className="text-xs text-gray-300 whitespace-nowrap">
                {s.label}: <span className="text-white font-medium">{active[s.key] ?? 0}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

export type Slice = { label: string; value: number; color: string };

export function DonutChart({ title, icon, data, centerLabel }: {
  title: string;
  icon: ReactNode;
  data: Slice[];
  centerLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const size = 220;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  let cumulative = 0;

  return (
    <ChartFrame title={title} icon={icon} empty={total === 0}>
      <div className="flex flex-col sm:flex-row items-center gap-8">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-44 h-44 shrink-0" role="img" aria-label={title}>
          <circle cx={mid} cy={mid} r={r} fill="none" stroke="#2e1065" strokeWidth={stroke} />
          {data.map((d, i) => {
            const len = total > 0 ? (d.value / total) * c : 0;
            const offset = -cumulative;
            cumulative += len;
            if (len <= 0) return null;
            return (
              <motion.circle
                key={d.label}
                cx={mid}
                cy={mid}
                r={r}
                fill="none"
                stroke={d.color}
                strokeWidth={hover === i ? stroke + 6 : stroke}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={offset}
                transform={`rotate(-90 ${mid} ${mid})`}
                opacity={hover === null || hover === i ? 1 : 0.4}
                initial={{ opacity: 0 }}
                animate={{ opacity: hover === null || hover === i ? 1 : 0.4 }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`}</title>
              </motion.circle>
            );
          })}
          <text x={mid} y={mid - 2} textAnchor="middle" fontSize="34" fontWeight="700" fill="#ffffff">
            {total}
          </text>
          <text x={mid} y={mid + 18} textAnchor="middle" fontSize="11" fill="#9ca3af">
            {centerLabel}
          </text>
        </svg>

        <div className="w-full space-y-3">
          {data.map((d, i) => (
            <div
              key={d.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="flex items-center justify-between gap-3 text-sm cursor-default"
              style={{ opacity: hover === null || hover === i ? 1 : 0.5 }}
            >
              <span className="flex items-center gap-2 text-gray-300 min-w-0">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
                <span className="truncate capitalize">{d.label.replace(/_/g, ' ')}</span>
              </span>
              <span className="text-gray-400 shrink-0">
                {d.value} ({total > 0 ? Math.round((d.value / total) * 100) : 0}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
