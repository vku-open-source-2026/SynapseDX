// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from "node:test";
import assert from "node:assert/strict";
import { CapabilitiesClient, CapabilitiesError } from "./index";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResult {
  status?: number;
  body?: unknown;
}

function mockFetch(handler: (request: Captured) => MockResult | Promise<MockResult>) {
  const requests: Captured[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const captured: Captured = {
      url: String(input),
      method: String(init.method || "GET").toUpperCase(),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    requests.push(captured);
    const result = await handler(captured);
    return new Response(
      result.body === undefined ? "" : JSON.stringify(result.body),
      {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  return { impl, requests };
}

test("optimization.assign posts the domain-neutral input and returns the typed plan", async () => {
  const { impl, requests } = mockFetch(() => ({
    body: {
      assignments: [
        {
          demandId: "demand-1",
          resourceId: "unit-1",
          cost: 0,
          distanceMeters: 0,
        },
      ],
      unassigned: [],
      totalCost: 0,
      assignedCount: 1,
      demandCount: 1,
      resourceSlots: 1,
      resourceUsage: [
        {
          resourceId: "unit-1",
          capacity: 1,
          used: 1,
          remaining: 0,
          available: true,
        },
      ],
      algorithm: "min_cost_flow",
      at: "2026-11-15T18:00:00.000Z",
      limits: {
        maxResources: 200,
        maxDemands: 200,
        maxSlots: 4000,
        maxCost: 1_000_000_000_000,
      },
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  const input = {
    resources: [
      {
        id: "unit-1",
        lat: 16.0,
        lng: 108.0,
        capacity: 1,
        skills: ["medical"],
      },
    ],
    demands: [
      {
        id: "demand-1",
        lat: 16.0,
        lng: 108.0,
        priority: 5,
        requiredSkills: ["medical"],
      },
    ],
    options: {
      maxDistanceMeters: 5000,
      unassignedPenalty: 1_000_000,
    },
  };
  const result = await client.optimization.assign(input);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://dx.example/v1/capabilities/optimization/assign",
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Bearer tok");
  assert.deepEqual(requests[0].body, input);
  assert.equal(result.algorithm, "min_cost_flow");
  assert.equal(result.assignments[0].demandId, "demand-1");
  assert.equal(result.resourceUsage[0].remaining, 0);
  assert.equal(result.limits.maxResources, 200);
});

test("optimization.assign surfaces stable error codes", async () => {
  const { impl } = mockFetch(() => ({
    status: 400,
    body: {
      error: {
        code: "invalid_cost_matrix",
        message: "options.costMatrix must have one column per resource",
        requestId: "req-1",
        details: { expectedColumns: 2, actualColumns: 1 },
      },
    },
  }));
  const client = new CapabilitiesClient({
    baseUrl: "https://dx.example",
    token: "tok",
    fetch: impl,
  });
  await assert.rejects(
    () =>
      client.optimization.assign({
        resources: [{ id: "r1" }, { id: "r2" }],
        demands: [{ id: "d1" }],
        options: { costMatrix: [[1]] },
      }),
    (error: any) => {
      assert.ok(error instanceof CapabilitiesError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_cost_matrix");
      assert.deepEqual(error.details, {
        expectedColumns: 2,
        actualColumns: 1,
      });
      return true;
    },
  );
});
