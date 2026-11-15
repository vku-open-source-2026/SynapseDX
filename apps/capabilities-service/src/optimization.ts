// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Generic resource-to-demand assignment.
 *
 * The capability is deliberately domain-neutral: callers pass resource and
 * demand arrays plus an optional cost matrix and receive assignments. No
 * incident, dispatch, vehicle or responder field is part of this module; SOS
 * dispatch maps its own domain model onto this contract and remains
 * responsible for applying the result through its reviewed workflow.
 *
 * Objective (lexicographic):
 *   1. maximize the number of fully served demands;
 *   2. minimize the total cost of the selected edges;
 *   3. among equal-cost solutions, prefer higher-priority demands.
 *
 * The exact solver is a maximum-cardinality bipartite b-matching followed by
 * successive-shortest-path min-cost flow for that fixed cardinality. The cost
 * comparator is the pair `(cost, -priority)`; both components add, so the
 * lexicographic order is preserved under residual rerouting. Priority therefore
 * never buys a more expensive assignment and never reduces the served count.
 */
import { apiError } from './errors';

export const OPTIMIZATION_LIMITS = {
  maxResources: 200,
  maxDemands: 200,
  /** 200 resources x the maximum capacity of 20. */
  maxSlots: 4000,
  /** Maximum accepted per-edge cost (matrix value); also the penalty ceiling. */
  maxCost: 1_000_000_000_000,
} as const;

export const OPTIMIZATION_DEFAULT_UNASSIGNED_PENALTY = 1_000_000_000;

const MAX_ID_LENGTH = 128;
const MAX_SKILL_LENGTH = 64;
const MAX_SKILLS = 32;
const MAX_SERVICE_MINUTES = 1_000_000_000;
const MAX_PRIORITY = 5;
const MAX_CAPACITY = 20;
const EARTH_RADIUS_METERS = 6_371_008.8;

export interface OptimizationResource {
  id: string;
  lat?: number;
  lng?: number;
  /** Number of simultaneous demands this resource can serve (default 1). */
  capacity?: number;
  skills?: string[];
  /** `false` removes every slot from the problem (default `true`). */
  available?: boolean;
}

export interface OptimizationDemand {
  id: string;
  lat?: number;
  lng?: number;
  /** 1 (lowest) .. 5 (highest), default 3. */
  priority?: number;
  requiredSkills?: string[];
  /** Accepted for caller semantics; the solver's capacity is slot based. */
  serviceMinutes?: number;
}

export interface OptimizationOptions {
  /** `matrix[demandIndex][resourceIndex]`; `null` means that edge is unusable. */
  costMatrix?: Array<Array<number | null>>;
  /** Excludes edges whose cost is greater than this value. */
  maxDistanceMeters?: number;
  /** Declared cost of leaving a demand unassigned (default 1e9, max 1e12). */
  unassignedPenalty?: number;
}

export interface OptimizationInput {
  resources: OptimizationResource[];
  demands: OptimizationDemand[];
  options?: OptimizationOptions;
}

export type OptimizationUnassignedReason = 'no_resource' | 'capacity' | 'distance' | 'skills';

export interface OptimizationAssignment {
  demandId: string;
  resourceId: string;
  cost: number;
  /** Haversine distance when both endpoints have coordinates. */
  distanceMeters?: number;
}

export interface OptimizationUnassigned {
  demandId: string;
  reason: OptimizationUnassignedReason;
}

export interface OptimizationResourceUsage {
  resourceId: string;
  capacity: number;
  used: number;
  remaining: number;
  available: boolean;
}

export interface OptimizationResult {
  assignments: OptimizationAssignment[];
  unassigned: OptimizationUnassigned[];
  totalCost: number;
  assignedCount: number;
  demandCount: number;
  resourceSlots: number;
  resourceUsage: OptimizationResourceUsage[];
  algorithm: 'min_cost_flow';
}

interface NormalizedResource {
  index: number;
  id: string;
  lat?: number;
  lng?: number;
  capacity: number;
  skills: string[];
  available: boolean;
}

interface NormalizedDemand {
  index: number;
  id: string;
  lat?: number;
  lng?: number;
  priority: number;
  requiredSkills: string[];
  serviceMinutes?: number;
}

interface NormalizedInput {
  resources: NormalizedResource[];
  demands: NormalizedDemand[];
  costMatrix?: Array<Array<number | null>>;
  maxDistanceMeters: number;
  unassignedPenalty: number;
}

interface PairEdge {
  demandIndex: number;
  resourceIndex: number;
  edge: CostEdge;
}

function invalid(message: string, details?: unknown): never {
  throw apiError(400, 'invalid_request', message, details);
}

function invalidMatrix(message: string, details?: unknown): never {
  throw apiError(400, 'invalid_cost_matrix', message, details);
}

function requiredId(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw apiError(400, 'field_required', `${field} is required`);
  }
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const text = value.trim();
  if (text.length < 1 || text.length > MAX_ID_LENGTH) {
    invalid(`${field} must be ${MAX_ID_LENGTH} characters or fewer and must not be empty`);
  }
  return text;
}

function optionalFinite(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function optionalCoordinate(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${field} must be an array of strings`);
  if (value.length > MAX_SKILLS) invalid(`${field} must contain at most ${MAX_SKILLS} entries`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') invalid(`${field} must contain only strings`);
    const skill = entry.trim();
    if (skill.length < 1 || skill.length > MAX_SKILL_LENGTH) {
      invalid(`${field} entries must be 1..${MAX_SKILL_LENGTH} characters`);
    }
    if (!result.includes(skill)) result.push(skill);
  }
  return result;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalizeResources(value: unknown): NormalizedResource[] {
  if (value === undefined) throw apiError(400, 'field_required', 'resources is required');
  if (!Array.isArray(value)) invalid('resources must be an array');
  if (value.length > OPTIMIZATION_LIMITS.maxResources) {
    throw apiError(400, 'too_many_resources', `at most ${OPTIMIZATION_LIMITS.maxResources} resources are supported`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const resource = asObject(raw, `resources[${index}]`);
    const id = requiredId(resource.id, `resources[${index}].id`);
    if (seen.has(id)) invalid(`resources[${index}].id duplicates another resource id`, { id });
    seen.add(id);
    const capacity = resource.capacity === undefined ? 1 : resource.capacity;
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      invalid(`resources[${index}].capacity must be an integer 1..${MAX_CAPACITY}`);
    }
    if (resource.available !== undefined && typeof resource.available !== 'boolean') {
      invalid(`resources[${index}].available must be a boolean`);
    }
    const lat = optionalCoordinate(resource.lat, `resources[${index}].lat`, -90, 90);
    const lng = optionalCoordinate(resource.lng, `resources[${index}].lng`, -180, 180);
    return {
      index,
      id,
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      capacity,
      skills: stringArray(resource.skills, `resources[${index}].skills`),
      available: resource.available !== false,
    };
  });
}

function normalizeDemands(value: unknown): NormalizedDemand[] {
  if (value === undefined) throw apiError(400, 'field_required', 'demands is required');
  if (!Array.isArray(value)) invalid('demands must be an array');
  if (value.length > OPTIMIZATION_LIMITS.maxDemands) {
    throw apiError(400, 'too_many_demands', `at most ${OPTIMIZATION_LIMITS.maxDemands} demands are supported`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const demand = asObject(raw, `demands[${index}]`);
    const id = requiredId(demand.id, `demands[${index}].id`);
    if (seen.has(id)) invalid(`demands[${index}].id duplicates another demand id`, { id });
    seen.add(id);
    const priority = demand.priority === undefined ? 3 : demand.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > MAX_PRIORITY) {
      invalid(`demands[${index}].priority must be an integer 1..${MAX_PRIORITY}`);
    }
    const lat = optionalCoordinate(demand.lat, `demands[${index}].lat`, -90, 90);
    const lng = optionalCoordinate(demand.lng, `demands[${index}].lng`, -180, 180);
    const serviceMinutes = optionalFinite(
      demand.serviceMinutes,
      `demands[${index}].serviceMinutes`,
      0,
      MAX_SERVICE_MINUTES,
    );
    return {
      index,
      id,
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      priority,
      requiredSkills: stringArray(demand.requiredSkills, `demands[${index}].requiredSkills`),
      ...(serviceMinutes !== undefined ? { serviceMinutes } : {}),
    };
  });
}

function normalizeCostMatrix(value: unknown, resourceCount: number, demandCount: number): Array<Array<number | null>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidMatrix('options.costMatrix must be an array of rows');
  if (value.length !== demandCount) {
    invalidMatrix('options.costMatrix must have one row per demand', {
      expectedRows: demandCount,
      actualRows: value.length,
    });
  }
  return value.map((rawRow, demandIndex) => {
    if (!Array.isArray(rawRow)) invalidMatrix(`options.costMatrix[${demandIndex}] must be an array`);
    if (rawRow.length !== resourceCount) {
      invalidMatrix(`options.costMatrix[${demandIndex}] must have one column per resource`, {
        expectedColumns: resourceCount,
        actualColumns: rawRow.length,
      });
    }
    return rawRow.map((raw, resourceIndex) => {
      if (raw === null) return null;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        invalidMatrix(`options.costMatrix[${demandIndex}][${resourceIndex}] must be a finite non-negative number or null`);
      }
      if (raw > OPTIMIZATION_LIMITS.maxCost) {
        invalidMatrix(`options.costMatrix[${demandIndex}][${resourceIndex}] exceeds the maximum cost`, {
          maxCost: OPTIMIZATION_LIMITS.maxCost,
        });
      }
      return raw;
    });
  });
}

function normalizeInput(input: unknown): NormalizedInput {
  const body = asObject(input, 'request body');
  const resources = normalizeResources(body.resources);
  const demands = normalizeDemands(body.demands);
  const rawOptions = body.options === undefined ? {} : asObject(body.options, 'options');
  const maxDistanceMeters = optionalFinite(
    rawOptions.maxDistanceMeters,
    'options.maxDistanceMeters',
    0,
    OPTIMIZATION_LIMITS.maxCost,
  ) ?? OPTIMIZATION_LIMITS.maxCost;
  // Validated for contract stability. Maximum cardinality is solved first, so
  // in the fixed-cardinality cost stage every unassigned demand contributes the
  // same constant; the penalty can never drop an assignable demand.
  const unassignedPenalty = optionalFinite(
    rawOptions.unassignedPenalty,
    'options.unassignedPenalty',
    0,
    OPTIMIZATION_LIMITS.maxCost,
  ) ?? OPTIMIZATION_DEFAULT_UNASSIGNED_PENALTY;
  const costMatrix = normalizeCostMatrix(rawOptions.costMatrix, resources.length, demands.length);
  return {
    resources,
    demands,
    ...(costMatrix ? { costMatrix } : {}),
    maxDistanceMeters,
    unassignedPenalty,
  };
}

function hasAllSkills(resourceSkills: string[], requiredSkills: string[]): boolean {
  return requiredSkills.every((skill) => resourceSkills.includes(skill));
}

function haversineMeters(latA: number, lngA: number, latB: number, lngB: number): number {
  const toRadians = Math.PI / 180;
  const dLat = (latB - latA) * toRadians;
  const dLng = (lngB - lngA) * toRadians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(latA * toRadians) * Math.cos(latB * toRadians) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function roundMeters(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundCost(value: number): number {
  // Keep large integer totals exact; only smooth binary floating-point noise
  // from fractional matrix costs and haversine sums.
  if (Number.isSafeInteger(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/* ------------------------------------------------------------------------- *
 * Maximum cardinality b-matching (Dinic)
 * ------------------------------------------------------------------------- */

interface DinicEdge {
  to: number;
  rev: number;
  cap: number;
}

class Dinic {
  private readonly graph: DinicEdge[][];

  constructor(size: number) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addEdge(from: number, to: number, cap: number): void {
    const forward: DinicEdge = { to, rev: this.graph[to].length, cap };
    const backward: DinicEdge = { to: from, rev: this.graph[from].length, cap: 0 };
    this.graph[from].push(forward);
    this.graph[to].push(backward);
  }

  maxFlow(source: number, sink: number): number {
    let flow = 0;
    for (;;) {
      const level = new Array<number>(this.graph.length).fill(-1);
      level[source] = 0;
      const queue = [source];
      for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head];
        for (const edge of this.graph[node]) {
          if (edge.cap > 0 && level[edge.to] < 0) {
            level[edge.to] = level[node] + 1;
            queue.push(edge.to);
          }
        }
      }
      if (level[sink] < 0) return flow;
      const next = new Array<number>(this.graph.length).fill(0);
      const send = (node: number, available: number): number => {
        if (node === sink) return available;
        while (next[node] < this.graph[node].length) {
          const edge = this.graph[node][next[node]];
          if (edge.cap > 0 && level[edge.to] === level[node] + 1) {
            const pushed = send(edge.to, Math.min(available, edge.cap));
            if (pushed > 0) {
              edge.cap -= pushed;
              this.graph[edge.to][edge.rev].cap += pushed;
              return pushed;
            }
          }
          next[node] += 1;
        }
        return 0;
      };
      let pushed = 0;
      do {
        pushed = send(source, Number.MAX_SAFE_INTEGER);
        if (pushed > 0) flow += pushed;
      } while (pushed > 0);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Min-cost flow with lexicographic (cost, -priority) weights
 * ------------------------------------------------------------------------- */

interface CostEdge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
  priority: number;
}

/** True when `(costA, priorityA)` is lexicographically smaller than `(costB, priorityB)`. */
function lessPair(costA: number, priorityA: number, costB: number, priorityB: number): boolean {
  return costA < costB || (costA === costB && priorityA < priorityB);
}

class MinCostFlow {
  private readonly graph: CostEdge[][];

  constructor(size: number) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addEdge(from: number, to: number, cap: number, cost: number, priority: number): CostEdge {
    const forward: CostEdge = { to, rev: this.graph[to].length, cap, cost, priority };
    const backward: CostEdge = { to: from, rev: this.graph[from].length, cap: 0, cost: -cost, priority: -priority };
    this.graph[from].push(forward);
    this.graph[to].push(backward);
    return forward;
  }

  /** Initial shortest distances; the original graph has no residual cycles. */
  private initialPotentials(source: number, potCost: number[], potPriority: number[]): void {
    potCost.fill(Infinity);
    potPriority.fill(0);
    potCost[source] = 0;
    const queue = [source];
    const queued = new Array<boolean>(this.graph.length).fill(false);
    queued[source] = true;
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      queued[node] = false;
      for (const edge of this.graph[node]) {
        if (edge.cap <= 0) continue;
        const candidateCost = potCost[node] + edge.cost;
        const candidatePriority = potPriority[node] + edge.priority;
        if (lessPair(candidateCost, candidatePriority, potCost[edge.to], potPriority[edge.to])) {
          potCost[edge.to] = candidateCost;
          potPriority[edge.to] = candidatePriority;
          if (!queued[edge.to]) {
            queued[edge.to] = true;
            queue.push(edge.to);
          }
        }
      }
    }
  }

  /** Send exactly `required` units or as many as the residual network allows. */
  run(source: number, sink: number, required: number): number {
    const size = this.graph.length;
    const potCost = new Array<number>(size).fill(0);
    const potPriority = new Array<number>(size).fill(0);
    this.initialPotentials(source, potCost, potPriority);
    let flow = 0;
    while (flow < required) {
      const distCost = new Array<number>(size).fill(Infinity);
      const distPriority = new Array<number>(size).fill(0);
      const previousNode = new Array<number>(size).fill(-1);
      const previousEdge = new Array<number>(size).fill(-1);
      const visited = new Array<boolean>(size).fill(false);
      distCost[source] = 0;
      for (let iteration = 0; iteration < size; iteration += 1) {
        let node = -1;
        for (let candidate = 0; candidate < size; candidate += 1) {
          if (visited[candidate] || distCost[candidate] === Infinity) continue;
          if (node < 0
            || lessPair(distCost[candidate], distPriority[candidate], distCost[node], distPriority[node])
            || (distCost[candidate] === distCost[node]
              && distPriority[candidate] === distPriority[node]
              && candidate < node)) {
            node = candidate;
          }
        }
        if (node < 0) break;
        visited[node] = true;
        const edges = this.graph[node];
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
          const edge = edges[edgeIndex];
          if (edge.cap <= 0 || visited[edge.to]) continue;
          const reducedCost = edge.cost + potCost[node] - potCost[edge.to];
          const reducedPriority = edge.priority + potPriority[node] - potPriority[edge.to];
          const candidateCost = distCost[node] + reducedCost;
          const candidatePriority = distPriority[node] + reducedPriority;
          if (lessPair(candidateCost, candidatePriority, distCost[edge.to], distPriority[edge.to])) {
            distCost[edge.to] = candidateCost;
            distPriority[edge.to] = candidatePriority;
            previousNode[edge.to] = node;
            previousEdge[edge.to] = edgeIndex;
          }
        }
      }
      if (previousNode[sink] < 0) break;
      for (let node = 0; node < size; node += 1) {
        if (distCost[node] === Infinity) continue;
        potCost[node] += distCost[node];
        potPriority[node] += distPriority[node];
      }
      let amount = required - flow;
      for (let node = sink; node !== source; node = previousNode[node]) {
        amount = Math.min(amount, this.graph[previousNode[node]][previousEdge[node]].cap);
      }
      if (amount <= 0) break;
      for (let node = sink; node !== source; node = previousNode[node]) {
        const from = previousNode[node];
        const edge = this.graph[from][previousEdge[node]];
        edge.cap -= amount;
        this.graph[node][edge.rev].cap += amount;
      }
      flow += amount;
    }
    return flow;
  }
}

/* ------------------------------------------------------------------------- *
 * Public solver
 * ------------------------------------------------------------------------- */

/**
 * Validate and solve one resource-to-demand assignment problem.
 *
 * Throws an `ApiError` for invalid input (`invalid_request`,
 * `field_required`, `too_many_resources`, `too_many_demands`,
 * `invalid_cost_matrix`, `cost_unavailable`).
 */
export function optimizeAssignments(input: unknown): OptimizationResult {
  const normalized = normalizeInput(input);
  const { resources, demands, costMatrix, maxDistanceMeters } = normalized;

  const availableCount = resources.filter((resource) => resource.available).length;
  const skillCompatible = new Array<number>(demands.length).fill(0);
  const reachable = new Array<number>(demands.length).fill(0);
  const excludedByDistance = new Array<number>(demands.length).fill(0);
  const edgeCost: number[][] = demands.map(() => new Array<number>(resources.length).fill(-1));
  const edgeDistance: Array<Array<number | undefined>> = demands.map(() => new Array<number | undefined>(resources.length));
  const eligible: number[][] = demands.map(() => []);

  for (const demand of demands) {
    for (const resource of resources) {
      if (demand.lat !== undefined && demand.lng !== undefined
        && resource.lat !== undefined && resource.lng !== undefined) {
        edgeDistance[demand.index][resource.index] = roundMeters(
          haversineMeters(demand.lat, demand.lng, resource.lat, resource.lng),
        );
      }
      if (!resource.available || !hasAllSkills(resource.skills, demand.requiredSkills)) continue;
      skillCompatible[demand.index] += 1;
      const matrixValue = costMatrix ? costMatrix[demand.index][resource.index] : undefined;
      if (costMatrix && matrixValue === null) continue;
      let cost: number;
      if (costMatrix) {
        cost = matrixValue as number;
      } else {
        const distance = edgeDistance[demand.index][resource.index];
        if (distance === undefined) {
          throw apiError(400, 'cost_unavailable', 'no cost is available for this demand/resource pair', {
            demandId: demand.id,
            resourceId: resource.id,
            reason: 'coordinates_or_cost_matrix_required',
          });
        }
        cost = distance;
      }
      if (cost > maxDistanceMeters) {
        excludedByDistance[demand.index] += 1;
        continue;
      }
      edgeCost[demand.index][resource.index] = cost;
      eligible[demand.index].push(resource.index);
      reachable[demand.index] += 1;
    }
  }

  const demandBase = 1;
  const resourceBase = demandBase + demands.length;
  const source = 0;
  const sink = resourceBase + resources.length;
  const nodeCount = sink + 1;

  const maxMatching = new Dinic(nodeCount);
  for (const demand of demands) maxMatching.addEdge(source, demandBase + demand.index, 1);
  for (const demand of demands) {
    for (const resourceIndex of eligible[demand.index]) {
      maxMatching.addEdge(demandBase + demand.index, resourceBase + resourceIndex, 1);
    }
  }
  for (const resource of resources) {
    if (!resource.available) continue;
    maxMatching.addEdge(resourceBase + resource.index, sink, resource.capacity);
  }
  const servableCount = maxMatching.maxFlow(source, sink);

  const assignments: OptimizationAssignment[] = [];
  if (servableCount > 0) {
    const flow = new MinCostFlow(nodeCount);
    for (const demand of demands) {
      flow.addEdge(source, demandBase + demand.index, 1, 0, 0);
    }
    const pairEdges: PairEdge[] = [];
    for (const demand of demands) {
      for (const resourceIndex of eligible[demand.index]) {
        const resource = resources[resourceIndex];
        const edge = flow.addEdge(
          demandBase + demand.index,
          resourceBase + resourceIndex,
          1,
          edgeCost[demand.index][resourceIndex],
          -demand.priority,
        );
        pairEdges.push({ demandIndex: demand.index, resourceIndex, edge });
      }
    }
    for (const resource of resources) {
      if (!resource.available) continue;
      flow.addEdge(resourceBase + resource.index, sink, resource.capacity, 0, 0);
    }
    const sent = flow.run(source, sink, servableCount);
    if (sent !== servableCount) {
      throw new Error('optimization invariant violated: the fixed-cardinality flow could not be completed');
    }
    for (const pair of pairEdges) {
      if (pair.edge.cap !== 0) continue;
      const demand = demands[pair.demandIndex];
      const resource = resources[pair.resourceIndex];
      const distance = edgeDistance[pair.demandIndex][pair.resourceIndex];
      assignments.push({
        demandId: demand.id,
        resourceId: resource.id,
        cost: edgeCost[pair.demandIndex][pair.resourceIndex],
        ...(distance !== undefined ? { distanceMeters: distance } : {}),
      });
    }
  }

  // pairEdges is built in demand-input order, so assignments already follow the
  // deterministic demand order; no secondary sorting is required.

  const served = new Set<string>(assignments.map((assignment) => assignment.demandId));
  const usedByResource = new Map<string, number>();
  for (const assignment of assignments) {
    usedByResource.set(assignment.resourceId, (usedByResource.get(assignment.resourceId) || 0) + 1);
  }

  const unassigned: OptimizationUnassigned[] = [];
  for (const demand of demands) {
    if (served.has(demand.id)) continue;
    let reason: OptimizationUnassignedReason;
    if (reachable[demand.index] > 0) {
      reason = 'capacity';
    } else if (availableCount === 0) {
      reason = 'no_resource';
    } else if (skillCompatible[demand.index] === 0) {
      reason = 'skills';
    } else if (excludedByDistance[demand.index] > 0) {
      reason = 'distance';
    } else {
      reason = 'no_resource';
    }
    unassigned.push({ demandId: demand.id, reason });
  }

  const resourceUsage: OptimizationResourceUsage[] = resources.map((resource) => {
    const used = usedByResource.get(resource.id) || 0;
    return {
      resourceId: resource.id,
      capacity: resource.capacity,
      used,
      remaining: resource.available ? Math.max(0, resource.capacity - used) : 0,
      available: resource.available,
    };
  });

  const totalCost = roundCost(
    assignments.reduce((sum, assignment) => sum + assignment.cost, 0),
  );

  return {
    assignments,
    unassigned,
    totalCost,
    assignedCount: assignments.length,
    demandCount: demands.length,
    resourceSlots: resources.reduce(
      (sum, resource) => sum + (resource.available ? resource.capacity : 0),
      0,
    ),
    resourceUsage,
    algorithm: 'min_cost_flow',
  };
}
