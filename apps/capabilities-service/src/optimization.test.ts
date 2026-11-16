// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeAssignments, OPTIMIZATION_LIMITS } from './optimization';
import { api, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';

function assignmentFor(result: ReturnType<typeof optimizeAssignments>, demandId: string) {
  return result.assignments.find((assignment) => assignment.demandId === demandId);
}

function unassignedFor(result: ReturnType<typeof optimizeAssignments>, demandId: string) {
  return result.unassigned.find((entry) => entry.demandId === demandId);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error: any) {
    return error?.code;
  }
}

test('picks the nearest resource, independent of input order', () => {
  const result = optimizeAssignments({
    resources: [
      { id: 'far', lat: 16.1, lng: 108.1, capacity: 1 },
      { id: 'near', lat: 16.0, lng: 108.0, capacity: 1 },
    ],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
  });

  assert.equal(result.assignedCount, 1);
  assert.equal(result.unassigned.length, 0);
  assert.equal(assignmentFor(result, 'd1')?.resourceId, 'near');
  assert.equal(assignmentFor(result, 'd1')?.cost, 0);
  assert.equal(result.algorithm, 'min_cost_flow');
  assert.equal(result.totalCost, 0);
});

test('capacity forces a farther resource and reports per-resource usage', () => {
  const result = optimizeAssignments({
    resources: [
      { id: 'near', lat: 16.0, lng: 108.0, capacity: 1 },
      { id: 'far', lat: 16.1, lng: 108.1, capacity: 1 },
    ],
    demands: [
      { id: 'd1', lat: 16.0, lng: 108.0 },
      { id: 'd2', lat: 16.0, lng: 108.0 },
    ],
  });

  assert.equal(result.assignedCount, 2);
  assert.equal(result.unassigned.length, 0);
  // Equal-cost tie: the earlier demand keeps the closer slot.
  assert.equal(assignmentFor(result, 'd1')?.resourceId, 'near');
  assert.equal(assignmentFor(result, 'd2')?.resourceId, 'far');
  assert.ok((assignmentFor(result, 'd2')?.cost || 0) > 0);
  assert.equal(result.resourceSlots, 2);
  assert.deepEqual(
    result.resourceUsage.map((entry) => [entry.resourceId, entry.used, entry.remaining]),
    [['near', 1, 0], ['far', 1, 0]],
  );
});

test('capacity above one serves multiple demands from the same resource', () => {
  const result = optimizeAssignments({
    resources: [{ id: 'team', lat: 16.0, lng: 108.0, capacity: 3 }],
    demands: [
      { id: 'd1', lat: 16.0, lng: 108.0 },
      { id: 'd2', lat: 16.0, lng: 108.0 },
      { id: 'd3', lat: 16.0, lng: 108.0 },
    ],
  });
  assert.equal(result.assignedCount, 3);
  assert.equal(result.resourceUsage[0].used, 3);
  assert.equal(result.resourceUsage[0].remaining, 0);
});

test('requires every demanded skill and ignores unavailable resources', () => {
  const result = optimizeAssignments({
    resources: [
      { id: 'medical', lat: 16.0, lng: 108.0, capacity: 2, skills: ['medical', 'driver'] },
      { id: 'fire', lat: 16.0, lng: 108.0, skills: ['fire'] },
      { id: 'offline', lat: 16.0, lng: 108.0, skills: ['medical'], available: false },
    ],
    demands: [
      { id: 'medical-need', lat: 16.0, lng: 108.0, requiredSkills: ['medical'] },
      { id: 'fire-need', lat: 16.0, lng: 108.0, requiredSkills: ['fire'] },
      { id: 'both-need', lat: 16.0, lng: 108.0, requiredSkills: ['medical', 'driver'] },
    ],
  });

  assert.equal(result.assignedCount, 3);
  assert.equal(assignmentFor(result, 'medical-need')?.resourceId, 'medical');
  assert.equal(assignmentFor(result, 'fire-need')?.resourceId, 'fire');
  assert.equal(assignmentFor(result, 'both-need')?.resourceId, 'medical');
  assert.equal(result.resourceUsage.find((entry) => entry.resourceId === 'offline')?.available, false);
});

test('maxDistanceMeters excludes farther edges and reports the distance reason', () => {
  const farOnly = optimizeAssignments({
    resources: [{ id: 'far', lat: 16.2, lng: 108.2 }],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
    options: { maxDistanceMeters: 1000 },
  });
  assert.equal(farOnly.assignedCount, 0);
  assert.equal(farOnly.unassigned[0].reason, 'distance');

  const nearAndFar = optimizeAssignments({
    resources: [
      { id: 'near', lat: 16.0, lng: 108.0 },
      { id: 'far', lat: 16.2, lng: 108.2 },
    ],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
    options: { maxDistanceMeters: 1000 },
  });
  assert.equal(nearAndFar.assignedCount, 1);
  assert.equal(assignmentFor(nearAndFar, 'd1')?.resourceId, 'near');
});

test('priority is a deterministic tie-break, not a reason to increase cost', () => {
  // Same cost, one slot: the higher priority demand wins.
  const tie = optimizeAssignments({
    resources: [{ id: 'r1', capacity: 1 }],
    demands: [
      { id: 'low', priority: 1 },
      { id: 'high', priority: 5 },
    ],
    options: { costMatrix: [[10], [10]] },
  });
  assert.equal(assignmentFor(tie, 'high')?.resourceId, 'r1');
  assert.equal(unassignedFor(tie, 'low')?.reason, 'capacity');

  // Cost is minimized first: priority never buys a more expensive assignment.
  const cheaperLow = optimizeAssignments({
    resources: [{ id: 'r1', capacity: 1 }],
    demands: [
      { id: 'high', priority: 5 },
      { id: 'low', priority: 1 },
    ],
    options: { costMatrix: [[100], [1]] },
  });
  assert.equal(assignmentFor(cheaperLow, 'low')?.resourceId, 'r1');
  assert.equal(cheaperLow.totalCost, 1);
  assert.equal(unassignedFor(cheaperLow, 'high')?.reason, 'capacity');
});

test('unassignedPenalty never lowers the served count and serviceMinutes is accepted', () => {
  const input = {
    resources: [{ id: 'r1', capacity: 1 }],
    demands: [{ id: 'd1', serviceMinutes: 45 }],
  };
  for (const unassignedPenalty of [0, 1_000_000_000, OPTIMIZATION_LIMITS.maxCost]) {
    const result = optimizeAssignments({
      ...input,
      options: { costMatrix: [[10]], unassignedPenalty },
    });
    assert.equal(result.assignedCount, 1);
    assert.equal(result.totalCost, 10);
  }
});

test('costMatrix overrides haversine distance and keeps distanceMeters informational', () => {
  const result = optimizeAssignments({
    resources: [
      { id: 'near', lat: 16.0, lng: 108.0 },
      { id: 'far', lat: 16.1, lng: 108.1 },
    ],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
    options: { costMatrix: [[1000, 5]] },
  });

  assert.equal(result.assignedCount, 1);
  assert.equal(assignmentFor(result, 'd1')?.resourceId, 'far');
  assert.equal(assignmentFor(result, 'd1')?.cost, 5);
  assert.ok((assignmentFor(result, 'd1')?.distanceMeters || 0) > 0);
  assert.equal(result.totalCost, 5);
});

test('null matrix entries mark edges unavailable, and distance-only calls need coordinates', () => {
  const matrixNull = optimizeAssignments({
    resources: [{ id: 'r1' }, { id: 'r2' }],
    demands: [{ id: 'd1' }],
    options: { costMatrix: [[null, 12]] },
  });
  assert.equal(assignmentFor(matrixNull, 'd1')?.resourceId, 'r2');
  assert.equal(assignmentFor(matrixNull, 'd1')?.cost, 12);

  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1' }],
    demands: [{ id: 'd1' }],
  })), 'cost_unavailable');

  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1' }],
    demands: [{ id: 'd1' }],
    options: { costMatrix: [[null]] },
  })), undefined);
});

test('returns deterministic unassigned reasons for skills, capacity, distance and no resource', () => {
  const skills = optimizeAssignments({
    resources: [{ id: 'r1', lat: 1, lng: 1, skills: ['fire'] }],
    demands: [{ id: 'd1', lat: 1, lng: 1, requiredSkills: ['medical'] }],
  });
  assert.equal(unassignedFor(skills, 'd1')?.reason, 'skills');

  const capacity = optimizeAssignments({
    resources: [{ id: 'r1', lat: 1, lng: 1, capacity: 1 }],
    demands: [
      { id: 'd1', lat: 1, lng: 1 },
      { id: 'd2', lat: 1, lng: 1 },
    ],
  });
  assert.equal(unassignedFor(capacity, 'd2')?.reason, 'capacity');

  const distance = optimizeAssignments({
    resources: [{ id: 'r1', lat: 2, lng: 2 }],
    demands: [{ id: 'd1', lat: 1, lng: 1 }],
    options: { maxDistanceMeters: 1 },
  });
  assert.equal(unassignedFor(distance, 'd1')?.reason, 'distance');

  const noResource = optimizeAssignments({
    resources: [{ id: 'r1', lat: 1, lng: 1, available: false }],
    demands: [{ id: 'd1', lat: 1, lng: 1 }],
  });
  assert.equal(unassignedFor(noResource, 'd1')?.reason, 'no_resource');

  const empty = optimizeAssignments({
    resources: [],
    demands: [{ id: 'd1', lat: 1, lng: 1 }],
    options: { costMatrix: [[]] },
  });
  assert.equal(unassignedFor(empty, 'd1')?.reason, 'no_resource');
});

test('tie-breaks are deterministic by input index for resources and demands', () => {
  const resourceTie = optimizeAssignments({
    resources: [
      { id: 'r-second', lat: 16.0, lng: 108.0 },
      { id: 'r-first', lat: 16.0, lng: 108.0 },
    ],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
  });
  assert.equal(assignmentFor(resourceTie, 'd1')?.resourceId, 'r-second');
  assert.deepEqual(resourceTie, optimizeAssignments({
    resources: [
      { id: 'r-second', lat: 16.0, lng: 108.0 },
      { id: 'r-first', lat: 16.0, lng: 108.0 },
    ],
    demands: [{ id: 'd1', lat: 16.0, lng: 108.0 }],
  }));

  const demandTie = optimizeAssignments({
    resources: [{ id: 'r1', capacity: 1 }],
    demands: [
      { id: 'd-second', priority: 3 },
      { id: 'd-first', priority: 3 },
    ],
    options: { costMatrix: [[10], [10]] },
  });
  assert.equal(assignmentFor(demandTie, 'd-second')?.resourceId, 'r1');
  assert.equal(unassignedFor(demandTie, 'd-first')?.reason, 'capacity');
});

test('rejects invalid cost matrices, dimensions and numeric values', () => {
  const base = {
    resources: [{ id: 'r1' }, { id: 'r2' }],
    demands: [{ id: 'd1' }],
  };
  const cases: unknown[] = [
    { ...base, options: { costMatrix: [[1, 2], [3, 4]] } },
    { ...base, options: { costMatrix: [[1]] } },
    { ...base, options: { costMatrix: [[1, Number.NaN]] } },
    { ...base, options: { costMatrix: [[1, Number.POSITIVE_INFINITY]] } },
    { ...base, options: { costMatrix: [[1, -1]] } },
    { ...base, options: { costMatrix: [[1, '2' as unknown as number]] } },
    { ...base, options: { costMatrix: [[1, 2, 3] as unknown as number[]] } },
    { ...base, options: { costMatrix: [['x' as unknown as number, null]] } },
  ];
  for (const input of cases) {
    assert.equal(codeOf(() => optimizeAssignments(input)), 'invalid_cost_matrix', JSON.stringify(input));
  }
});

test('rejects invalid identifiers, ranges, option values and oversized inputs', () => {
  assert.equal(codeOf(() => optimizeAssignments({ demands: [] })), 'field_required');
  assert.equal(codeOf(() => optimizeAssignments({ resources: [] })), 'field_required');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1' }, { id: 'r1' }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [{ id: 'd1' }, { id: 'd1' }],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: '' }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1', capacity: 0 }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1', capacity: 21 }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1', available: 'no' as unknown as boolean }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [{ id: 'r1', lat: 91 }],
    demands: [],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [{ id: 'd1', priority: 6 }],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [{ id: 'd1', priority: 2.5 }],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [{ id: 'd1', requiredSkills: [''] }],
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [],
    options: { unassignedPenalty: OPTIMIZATION_LIMITS.maxCost + 1 },
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: [],
    options: { maxDistanceMeters: -1 },
  })), 'invalid_request');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: Array.from({ length: OPTIMIZATION_LIMITS.maxResources + 1 }, (_, index) => ({ id: `r${index}` })),
    demands: [],
  })), 'too_many_resources');
  assert.equal(codeOf(() => optimizeAssignments({
    resources: [],
    demands: Array.from({ length: OPTIMIZATION_LIMITS.maxDemands + 1 }, (_, index) => ({ id: `d${index}` })),
  })), 'too_many_demands');
});

test('200 resources x 200 demands completes within the performance budget', { timeout: 15000 }, () => {
  const resources = Array.from({ length: 200 }, (_, index) => ({
    id: `r${String(index).padStart(3, '0')}`,
    capacity: 1,
  }));
  const demands = Array.from({ length: 200 }, (_, index) => ({
    id: `d${String(index).padStart(3, '0')}`,
    priority: (index % 5) + 1,
  }));
  const costMatrix = demands.map((_demand, demandIndex) => resources.map((_resource, resourceIndex) =>
    ((demandIndex * 197 + resourceIndex * 31) % 1000) / 10,
  ));
  const started = Date.now();
  const result = optimizeAssignments({ resources, demands, options: { costMatrix } });
  const elapsed = Date.now() - started;
  assert.equal(result.assignedCount, 200);
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.demandCount, 200);
  assert.equal(result.resourceSlots, 200);
  assert.ok(result.totalCost > 0);
  assert.ok(elapsed < 2500, `200x200 solve took ${elapsed}ms`);
});

/* ------------------------------------------------------------------------- *
 * Route contract
 * ------------------------------------------------------------------------- */

const routeBody = {
  resources: [
    { id: 'unit-1', lat: 16.0, lng: 108.0, capacity: 1, skills: ['medical'] },
    { id: 'unit-2', lat: 16.1, lng: 108.1, capacity: 1, skills: ['medical'] },
  ],
  demands: [
    { id: 'demand-1', lat: 16.0, lng: 108.0, priority: 5, requiredSkills: ['medical'] },
  ],
};

test('optimization route requires authentication but not a write scope', async () => {
  const harness = await startHarness();
  try {
    const anonymous = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      body: routeBody,
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'unauthorized');

    const readOnly = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: routeBody,
    });
    assert.equal(readOnly.status, 200, JSON.stringify(readOnly.body));
    assert.equal(readOnly.body.assignedCount, 1);
    assert.equal(readOnly.body.demandCount, 1);
    assert.equal(readOnly.body.algorithm, 'min_cost_flow');
    assert.equal(readOnly.body.assignments[0].demandId, 'demand-1');
    assert.equal(readOnly.body.assignments[0].resourceId, 'unit-1');
    assert.deepEqual(readOnly.body.limits, {
      maxResources: 200,
      maxDemands: 200,
      maxSlots: 4000,
      maxCost: 1_000_000_000_000,
    });
    assert.ok(Date.parse(readOnly.body.at));
  } finally {
    await harness.close();
  }
});

test('optimization route writes a count-only audit row', async () => {
  const harness = await startHarness();
  try {
    const response = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: routeBody,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const audit = [...(harness.fake.collections.get(COLLECTIONS.audit)?.values() || [])]
      .map((document: any) => document.data)
      .find((entry: any) => entry.action === 'optimization.assign');
    assert.ok(audit);
    assert.equal(audit.actor, 'reader');
    assert.equal(audit.tenant, 'org-a');
    assert.equal(audit.details.resourceCount, 2);
    assert.equal(audit.details.demandCount, 1);
    assert.equal(audit.details.assignedCount, 1);
    assert.equal(audit.details.unassignedCount, 0);
    assert.equal(audit.details.resourceSlots, 2);
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes('demand-1'), false);
    assert.equal(serialized.includes('unit-1'), false);
    assert.equal(serialized.includes('costMatrix'), false);
  } finally {
    await harness.close();
  }
});

test('optimization route validates the body, limits and arrays', async () => {
  const harness = await startHarness();
  try {
    const missingDemands = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: { resources: [] },
    });
    assert.equal(missingDemands.status, 400);
    assert.equal(missingDemands.body.error.code, 'field_required');

    const notAnArray = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: { resources: 'nope', demands: [] },
    });
    assert.equal(notAnArray.status, 400);
    assert.equal(notAnArray.body.error.code, 'invalid_request');

    const tooMany = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: {
        resources: Array.from({ length: 201 }, (_, index) => ({ id: `r${index}` })),
        demands: [],
      },
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'too_many_resources');

    const badMatrix = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: {
        resources: [{ id: 'r1' }],
        demands: [{ id: 'd1' }],
        options: { costMatrix: [[1, 2]] },
      },
    });
    assert.equal(badMatrix.status, 400);
    assert.equal(badMatrix.body.error.code, 'invalid_cost_matrix');

    const noCost = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: { resources: [{ id: 'r1' }], demands: [{ id: 'd1' }] },
    });
    assert.equal(noCost.status, 400);
    assert.equal(noCost.body.error.code, 'cost_unavailable');

    const oversized = await api(harness, '/v1/capabilities/optimization/assign', {
      method: 'POST',
      token: 'read-token',
      body: { ...routeBody, padding: 'x'.repeat(300_000) },
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload_too_large');
  } finally {
    await harness.close();
  }
});

test('optimization route is advertised as POST-only', async () => {
  const harness = await startHarness();
  try {
    const wrongMethod = await api(harness, '/v1/capabilities/optimization/assign', {
      token: 'read-token',
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.error.code, 'method_not_allowed');
    assert.match(String(wrongMethod.headers.get('allow')), /POST/);

    const advertisement = await api(harness, '/v1/capabilities');
    assert.equal(advertisement.status, 200);
    const entry = advertisement.body.capabilities.find((capability: any) => capability.name === 'optimization');
    assert.equal(entry.status, 'available');
    assert.equal(entry.algorithm, 'min_cost_flow');
  } finally {
    await harness.close();
  }
});
