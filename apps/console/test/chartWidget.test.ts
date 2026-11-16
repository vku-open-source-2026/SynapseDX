// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { chartSeries } from "../src/components/workspaces/ChartWidget";
it("groups loaded records, computes averages per numeric series and excludes invalid values", () => {
  const widget = {
    id: "chart",
    type: "chart" as const,
    title: "Chart",
    columns: ["region", "amount", "score"],
    aggregation: "average" as const,
  };
  const data = {
    rows: [
      { region: "North", amount: 10, score: 2 },
      { region: "North", amount: 30, score: "invalid" },
      { region: "South", amount: -2, score: 0 },
    ],
    total: 3,
    columns: widget.columns,
  };
  expect(chartSeries(widget, data).points).toEqual([
    { label: "North", values: [20, 2] },
    { label: "South", values: [-2, 0] },
  ]);
  expect(chartSeries({ ...widget, aggregation: "count" }, data).points).toEqual(
    [
      { label: "North", values: [2] },
      { label: "South", values: [1] },
    ],
  );
});
