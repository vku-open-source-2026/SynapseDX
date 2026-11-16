// SPDX-License-Identifier: Apache-2.0
import {
  safeCellText,
  type RuntimeWidget,
  type WidgetData,
} from "../../lib/workspaces";
export function chartSeries(widget: RuntimeWidget, data?: WidgetData) {
  const columns = widget.columns || data?.columns || [],
    label = columns[0] || "name",
    aggregate = widget.aggregation || "none";
  const series = aggregate === "count" ? ["count"] : columns.slice(1, 6);
  const groups = new Map<
    string,
    { count: number; values: number[]; valid: number[] }
  >();
  for (const row of data?.rows || []) {
    const key = safeCellText(row[label], 80);
    const group =
      aggregate === "none"
        ? { count: 0, values: series.map(() => 0), valid: series.map(() => 0) }
        : groups.get(key) || {
            count: 0,
            values: series.map(() => 0),
            valid: series.map(() => 0),
          };
    group.count++;
    series.forEach((field, i) => {
      if (aggregate === "count") {
        group.values[i]++;
        return;
      }
      const raw = row[field],
        n =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.trim()
              ? Number(raw)
              : NaN;
      if (Number.isFinite(n)) {
        group.values[i] += n;
        group.valid[i]++;
      }
    });
    groups.set(aggregate === "none" ? `${groups.size}\0${key}` : key, group);
  }
  return {
    series,
    points: [...groups]
      .slice(0, 50)
      .map(([key, g]) => ({
        label: key.includes("\0") ? key.split("\0")[1] : key,
        values: g.values.map((v, i) =>
          aggregate === "average" ? (g.valid[i] ? v / g.valid[i] : 0) : v,
        ),
      })),
  };
}
const colors = ["#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#38bdf8"];
export function ChartWidget({
  widget,
  data,
  preview,
}: {
  widget: RuntimeWidget;
  data?: WidgetData;
  preview?: boolean;
}) {
  const { points, series } = chartSeries(
    widget,
    preview
      ? {
          rows: [
            { name: "North", value: 45 },
            { name: "Central", value: 72 },
            { name: "South", value: 58 },
          ],
          columns: ["name", "value"],
          total: 3,
        }
      : data,
  );
  const type = widget.chartType || "bar";
  if (!points.length)
    return (
      <p className="py-12 text-center text-sm text-dx-muted">
        No data returned by the assigned query.
      </p>
    );
  const values = points.flatMap((p) => p.values),
    min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    y = (v: number) => 210 - ((v - min) / (max - min)) * 180,
    x = (i: number) => 50 + ((i + 0.5) * 700) / points.length;
  const total = points.reduce((n, p) => n + Math.max(0, p.values[0] || 0), 0);
  let angle = -Math.PI / 2;
  return (
    <div className="space-y-3">
      <svg
        viewBox="0 0 800 260"
        role="img"
        aria-label={`${widget.title} · ${type} chart`}
        className="w-full rounded-xl bg-dx-subtle/40"
      >
        <title>
          {widget.title} · {type} chart · {points.length} categories
        </title>
        {type === "pie" || type === "donut" ? (
          total ? (
            points.map((point, i) => {
              const start = angle;
              angle +=
                (Math.max(0, point.values[0] || 0) / total) * Math.PI * 2;
              const end = angle;
              const a = [
                  400 + 100 * Math.cos(start),
                  130 + 100 * Math.sin(start),
                ],
                b = [400 + 100 * Math.cos(end), 130 + 100 * Math.sin(end)];
              const d = `M 400 130 L ${a.join(" ")} A 100 100 0 ${end - start > Math.PI ? 1 : 0} 1 ${b.join(" ")} Z`;
              return (
                <g key={i}>
                  {end - start >= Math.PI * 2 - 0.00001 ? (
                    <circle
                      cx={400}
                      cy={130}
                      r={100}
                      fill={colors[i % colors.length]}
                    />
                  ) : (
                    <path
                      d={d}
                      fill={colors[i % colors.length]}
                      stroke="white"
                      strokeWidth={1}
                    />
                  )}
                  <title>
                    {point.label}: {point.values[0]} (
                    {(((point.values[0] || 0) / total) * 100).toFixed(1)}%)
                  </title>
                  {type === "donut" && (
                    <circle
                      cx={400}
                      cy={130}
                      r={58}
                      className="fill-dx-surface"
                    />
                  )}
                </g>
              );
            })
          ) : (
            <text x={400} y={130} textAnchor="middle" fill="currentColor">
              No positive values
            </text>
          )
        ) : (
          <>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line
                  x1={50}
                  x2={750}
                  y1={30 + t * 180}
                  y2={30 + t * 180}
                  stroke="currentColor"
                  opacity={0.1}
                />
                <text
                  x={44}
                  y={34 + t * 180}
                  fontSize={10}
                  textAnchor="end"
                  fill="currentColor"
                  opacity={0.6}
                >
                  {(max - t * (max - min)).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                </text>
              </g>
            ))}
            {series.map((field, s) => {
              const coords = points
                .map((p, i) => `${x(i)},${y(p.values[s] || 0)}`)
                .join(" ");
              return (
                <g key={field}>
                  {type === "bar" ? (
                    points.map((p, i) => {
                      const v = p.values[s] || 0,
                        w = Math.max(
                          1,
                          ((700 / points.length) * 0.7) / series.length,
                        );
                      return (
                        <rect
                          key={i}
                          x={x(i) - (w * series.length) / 2 + s * w}
                          y={Math.min(y(0), y(v))}
                          width={w - 1}
                          height={Math.max(1, Math.abs(y(v) - y(0)))}
                          rx={2}
                          fill={colors[s % colors.length]}
                        >
                          <title>
                            {p.label} · {field}: {v}
                          </title>
                        </rect>
                      );
                    })
                  ) : (
                    <>
                      {type === "area" && (
                        <polygon
                          points={`${x(0)},${y(0)} ${coords} ${x(points.length - 1)},${y(0)}`}
                          fill={colors[s % colors.length]}
                          opacity={0.15}
                        />
                      )}
                      <polyline
                        points={coords}
                        fill="none"
                        stroke={colors[s % colors.length]}
                        strokeWidth={2.5}
                      />
                      {points.map((p, i) => (
                        <circle
                          key={i}
                          cx={x(i)}
                          cy={y(p.values[s] || 0)}
                          r={3.5}
                          fill={colors[s % colors.length]}
                        >
                          <title>
                            {p.label} · {field}: {p.values[s] || 0}
                          </title>
                        </circle>
                      ))}
                    </>
                  )}
                </g>
              );
            })}
            {points.map(
              (p, i) =>
                (points.length <= 12 ||
                  i % Math.ceil(points.length / 12) === 0) && (
                  <text
                    key={i}
                    x={x(i)}
                    y={232}
                    fontSize={10}
                    textAnchor="middle"
                    fill="currentColor"
                    opacity={0.7}
                  >
                    {p.label.slice(0, 14)}
                  </text>
                ),
            )}
          </>
        )}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-dx-muted">
        {(type === "pie" || type === "donut"
          ? points.map((p) => p.label)
          : series
        ).map((label, i) => (
          <span key={`${label}-${i}`} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: colors[i % colors.length] }}
            />
            {label}
          </span>
        ))}
      </div>
      <p className="text-[10px] text-dx-muted">
        {widget.aggregation || "none"} · {data?.rows.length || points.length}{" "}
        loaded records · up to 50 categories
      </p>
      <details className="text-xs text-dx-muted">
        <summary className="cursor-pointer">View chart data</summary>
        <div className="max-h-48 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Category</th>
                {series.map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td>{p.label}</td>
                  {p.values.map((v, j) => (
                    <td key={j}>{v.toLocaleString()}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
