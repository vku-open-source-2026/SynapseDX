// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Generic emergency/operations plan (EOP) orchestration.
 *
 * This module owns only the domain-neutral mechanics: plan/task phases,
 * activation due-time computation, dependency-aware task transitions, a
 * grounded status brief and an AI-assisted draft. Emergency operations policy,
 * approvals, dispatch and SITREP/AAR semantics stay in SynapseCitySOS; this
 * layer never executes a plan or invents domain event types.
 *
 * Everything is persisted by the route layer in Tier-1 Base documents. The
 * functions here are pure or take a `SynapseOneClient` for inference calls and
 * hold no process state.
 */
import { SynapseOneClient } from '@synapseone/sdk';
import { apiError } from './errors';

export type PlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type PlanTaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

export interface PlanTask {
  id: string;
  title: string;
  ownerRole?: string;
  dueOffsetMinutes: number;
  dependsOn: string[];
  status: PlanTaskStatus;
  assignee?: string;
  notes?: string;
  completedAt?: string;
  dueAt?: string;
}

export interface PlanPhase {
  id: string;
  title: string;
  objective?: string;
  startOffsetMinutes: number;
  tasks: PlanTask[];
}

export interface PlanRecord {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  objective: string;
  eventId?: string;
  severity?: string;
  status: PlanStatus;
  context?: Record<string, unknown>;
  activatedAt?: string;
  completedAt?: string;
  phases: PlanPhase[];
}

export interface PlanTaskInput {
  id: string;
  title: string;
  ownerRole?: string;
  dueOffsetMinutes: number;
  dependsOn?: string[];
}

export interface PlanPhaseInput {
  id: string;
  title: string;
  objective?: string;
  startOffsetMinutes: number;
  tasks: PlanTaskInput[];
}

export interface PlanInput {
  title: string;
  objective: string;
  eventId?: string;
  severity?: string;
  context?: Record<string, unknown>;
  /** Normalised phases; every task is pending and has no dueAt yet. */
  phases: PlanPhase[];
}

export interface PlanDraftRequest {
  objective: string;
  eventType?: string;
  context?: Record<string, unknown>;
  phaseCount: number;
}

export interface PlanDraft {
  title: string;
  objective: string;
  eventId?: string;
  severity?: string;
  context?: Record<string, unknown>;
  phases: PlanPhase[];
}

export interface PlanDraftResult {
  planDraft: PlanDraft;
  model: string | null;
  fallback: boolean;
  reason?: string;
}

export interface PlanBriefCitation {
  index: number;
  taskId: string;
  phaseId: string;
  title: string;
  status: PlanTaskStatus;
  ownerRole?: string;
  dueAt?: string;
  dependsOn: string[];
}

export interface PlanBriefResult {
  brief: string;
  citations: PlanBriefCitation[];
  language: 'vi' | 'en';
  model: string | null;
  fallback: boolean;
  generated_at: string;
}

export const PLAN_LIMITS = {
  titleMin: 3,
  titleMax: 200,
  objectiveMax: 4000,
  contextMaxBytes: 16 * 1024,
  phasesMin: 1,
  phasesMax: 20,
  tasksPerPhaseMin: 1,
  tasksPerPhaseMax: 50,
  tasksTotalMax: 200,
  offsetMin: 0,
  offsetMax: 10_080,
  idMax: 64,
  noteMax: 2_000,
  assigneeMax: 128,
} as const;

export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'active', 'paused', 'completed', 'archived'];
export const PLAN_TASK_STATUSES: readonly PlanTaskStatus[] = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];

/** Plan-level transitions. Activation is the only draft exit. */
export const PLAN_STATUS_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['active'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived'],
  archived: [],
};

/** Task-level transitions. `done` and `skipped` are terminal. */
export const TASK_STATUS_TRANSITIONS: Record<PlanTaskStatus, readonly PlanTaskStatus[]> = {
  pending: ['in_progress', 'done', 'skipped'],
  in_progress: ['done', 'blocked', 'skipped'],
  blocked: ['in_progress', 'skipped'],
  done: [],
  skipped: [],
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value);
}

export function isPlanTaskStatus(value: unknown): value is PlanTaskStatus {
  return typeof value === 'string' && (PLAN_TASK_STATUSES as readonly string[]).includes(value);
}

export function validatePlanTitle(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length < PLAN_LIMITS.titleMin || text.length > PLAN_LIMITS.titleMax) {
    throw apiError(400, 'invalid_request', `title must be ${PLAN_LIMITS.titleMin}..${PLAN_LIMITS.titleMax} characters`);
  }
  return text;
}

export function validatePlanObjective(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length < 1 || text.length > PLAN_LIMITS.objectiveMax) {
    throw apiError(400, 'invalid_request', `objective must be 1..${PLAN_LIMITS.objectiveMax} characters`);
  }
  return text;
}

/** Optional free text. Empty/null clears the field at the caller's discretion. */
export function validateOptionalPlanText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > max) throw apiError(400, 'invalid_request', `${name} must be ≤${max} characters`);
  return text;
}

export function validatePlanContext(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_request', 'context must be a JSON object');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw apiError(400, 'invalid_request', 'context must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > PLAN_LIMITS.contextMaxBytes) {
    throw apiError(400, 'invalid_request', `context must be at most ${PLAN_LIMITS.contextMaxBytes} bytes of JSON`);
  }
  return value as Record<string, unknown>;
}

function planIdValue(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!ID_PATTERN.test(text)) {
    throw apiError(400, 'invalid_request', `${name} must match [A-Za-z0-9_-]{1,${PLAN_LIMITS.idMax}}`);
  }
  return text;
}

function offsetValue(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < PLAN_LIMITS.offsetMin || value > PLAN_LIMITS.offsetMax) {
    throw apiError(400, 'invalid_request', `${name} must be an integer ${PLAN_LIMITS.offsetMin}..${PLAN_LIMITS.offsetMax} minutes`);
  }
  return value;
}

function dependencyList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw apiError(400, 'invalid_request', `${name} must be an array of task ids`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const id = planIdValue(entry, `${name} entry`);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function assertAcyclic(tasks: PlanTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw apiError(400, 'dependency_cycle', 'task dependencies must be acyclic', { taskId: id });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    for (const dependency of task?.dependsOn || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

/**
 * Validate and normalise a create/draft plan payload. The same validator is
 * used for user input and for model-generated JSON so an AI draft cannot bypass
 * id, offset, count, duplicate or dependency rules.
 */
export function normalizePlanInput(value: unknown): PlanInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_request', 'plan body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const title = validatePlanTitle(body.title);
  const objective = validatePlanObjective(body.objective);
  const eventId = validateOptionalPlanText(body.eventId, 'eventId', 128);
  const severity = validateOptionalPlanText(body.severity, 'severity', 32);
  const context = validatePlanContext(body.context);
  if (!Array.isArray(body.phases)
    || body.phases.length < PLAN_LIMITS.phasesMin
    || body.phases.length > PLAN_LIMITS.phasesMax) {
    throw apiError(400, 'invalid_request', `phases must contain ${PLAN_LIMITS.phasesMin}..${PLAN_LIMITS.phasesMax} entries`);
  }

  const ids = new Set<string>();
  let totalTasks = 0;
  const phases: PlanPhase[] = body.phases.map((rawPhase, phaseIndex) => {
    if (!rawPhase || typeof rawPhase !== 'object' || Array.isArray(rawPhase)) {
      throw apiError(400, 'invalid_request', `phases[${phaseIndex}] must be a JSON object`);
    }
    const phase = rawPhase as Record<string, unknown>;
    const id = planIdValue(phase.id, `phases[${phaseIndex}].id`);
    if (ids.has(id)) throw apiError(400, 'invalid_request', `duplicate plan id: ${id}`, { id });
    ids.add(id);
    const phaseTitle = String(phase.title ?? '').trim();
    if (phaseTitle.length < 1 || phaseTitle.length > 200) {
      throw apiError(400, 'invalid_request', `phases[${phaseIndex}].title must be 1..200 characters`);
    }
    const phaseObjective = validateOptionalPlanText(phase.objective, `phases[${phaseIndex}].objective`, 2000);
    const startOffsetMinutes = offsetValue(phase.startOffsetMinutes, `phases[${phaseIndex}].startOffsetMinutes`);
    if (!Array.isArray(phase.tasks)
      || phase.tasks.length < PLAN_LIMITS.tasksPerPhaseMin
      || phase.tasks.length > PLAN_LIMITS.tasksPerPhaseMax) {
      throw apiError(400, 'invalid_request', `phases[${phaseIndex}].tasks must contain ${PLAN_LIMITS.tasksPerPhaseMin}..${PLAN_LIMITS.tasksPerPhaseMax} entries`);
    }
    totalTasks += phase.tasks.length;
    if (totalTasks > PLAN_LIMITS.tasksTotalMax) {
      throw apiError(400, 'invalid_request', `a plan may contain at most ${PLAN_LIMITS.tasksTotalMax} tasks`);
    }
    const tasks: PlanTask[] = phase.tasks.map((rawTask, taskIndex) => {
      if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
        throw apiError(400, 'invalid_request', `phases[${phaseIndex}].tasks[${taskIndex}] must be a JSON object`);
      }
      const task = rawTask as Record<string, unknown>;
      const taskId = planIdValue(task.id, `phases[${phaseIndex}].tasks[${taskIndex}].id`);
      if (ids.has(taskId)) throw apiError(400, 'invalid_request', `duplicate plan id: ${taskId}`, { id: taskId });
      ids.add(taskId);
      const taskTitle = String(task.title ?? '').trim();
      if (taskTitle.length < 1 || taskTitle.length > 200) {
        throw apiError(400, 'invalid_request', `phases[${phaseIndex}].tasks[${taskIndex}].title must be 1..200 characters`);
      }
      const ownerRole = validateOptionalPlanText(task.ownerRole, `phases[${phaseIndex}].tasks[${taskIndex}].ownerRole`, 64);
      const dueOffsetMinutes = offsetValue(task.dueOffsetMinutes, `phases[${phaseIndex}].tasks[${taskIndex}].dueOffsetMinutes`);
      const dependsOn = dependencyList(task.dependsOn, `phases[${phaseIndex}].tasks[${taskIndex}].dependsOn`);
      return {
        id: taskId,
        title: taskTitle,
        ...(ownerRole ? { ownerRole } : {}),
        dueOffsetMinutes,
        dependsOn,
        // A newly created plan always starts with unstarted tasks; status and
        // dueAt are owned by activation/task transitions, never by the author.
        status: 'pending',
      };
    });
    return {
      id,
      title: phaseTitle,
      ...(phaseObjective ? { objective: phaseObjective } : {}),
      startOffsetMinutes,
      tasks,
    };
  });

  const tasks = phases.flatMap((phase) => phase.tasks);
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        throw apiError(400, 'invalid_request', `task ${task.id} depends on unknown task ${dependency}`, {
          taskId: task.id,
          missing: [dependency],
        });
      }
    }
  }
  assertAcyclic(tasks);

  return {
    title,
    objective,
    ...(eventId ? { eventId } : {}),
    ...(severity ? { severity } : {}),
    ...(context ? { context } : {}),
    phases,
  };
}

export function countPlanTasks(plan: Pick<PlanRecord, 'phases'>): number {
  return plan.phases.reduce((total, phase) => total + phase.tasks.length, 0);
}

/** `dueAt = activatedAt + (phase.startOffsetMinutes + task.dueOffsetMinutes)`. */
export function dueAtFor(activatedAt: string, startOffsetMinutes: number, dueOffsetMinutes: number): string {
  const base = Date.parse(activatedAt);
  if (!Number.isFinite(base)) throw apiError(400, 'invalid_request', 'activatedAt must be an ISO timestamp');
  return new Date(base + (startOffsetMinutes + dueOffsetMinutes) * 60_000).toISOString();
}

/** Apply computed due times for every task in the plan (activation/resume). */
export function withComputedDueDates(plan: PlanRecord, activatedAt: string): PlanRecord {
  return {
    ...plan,
    phases: plan.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({
        ...task,
        dueAt: dueAtFor(activatedAt, phase.startOffsetMinutes, task.dueOffsetMinutes),
      })),
    })),
  };
}

export function assertPlanTransition(from: PlanStatus, to: PlanStatus): void {
  if (!PLAN_STATUS_TRANSITIONS[from].includes(to)) {
    throw apiError(409, 'invalid_transition', `cannot change a plan from ${from} to ${to}`, {
      from,
      to,
      allowed: PLAN_STATUS_TRANSITIONS[from],
    });
  }
}

export function assertTaskTransition(from: PlanTaskStatus, to: PlanTaskStatus): void {
  if (!TASK_STATUS_TRANSITIONS[from].includes(to)) {
    throw apiError(409, 'invalid_transition', `cannot change a task from ${from} to ${to}`, {
      from,
      to,
      allowed: TASK_STATUS_TRANSITIONS[from],
    });
  }
}

export function findPlanTask(plan: PlanRecord, taskId: string): { phase: PlanPhase; task: PlanTask } | undefined {
  for (const phase of plan.phases) {
    const task = phase.tasks.find((entry) => entry.id === taskId);
    if (task) return { phase, task };
  }
  return undefined;
}

export function incompleteDependencies(plan: PlanRecord, task: PlanTask): string[] {
  const statusById = new Map(plan.phases.flatMap((phase) => phase.tasks.map((entry) => [entry.id, entry.status] as const)));
  return task.dependsOn.filter((id) => statusById.get(id) !== 'done');
}

/* ------------------------------------------------------------------------- *
 * Grounded brief
 * ------------------------------------------------------------------------- */

function planCitations(plan: PlanRecord): PlanBriefCitation[] {
  const citations: PlanBriefCitation[] = [];
  let index = 1;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      citations.push({
        index,
        taskId: task.id,
        phaseId: phase.id,
        title: task.title,
        status: task.status,
        ...(task.ownerRole ? { ownerRole: task.ownerRole } : {}),
        ...(task.dueAt ? { dueAt: task.dueAt } : {}),
        dependsOn: [...task.dependsOn],
      });
      index += 1;
    }
  }
  return citations;
}

export function planLanguage(plan: Pick<PlanRecord, 'title' | 'objective' | 'context'>, extra = ''): 'vi' | 'en' {
  const locale = String((plan.context as Record<string, unknown> | undefined)?.locale
    ?? (plan.context as Record<string, unknown> | undefined)?.language
    ?? '').trim().toLowerCase();
  if (/^vi\b/.test(locale)) return 'vi';
  if (/^en\b/.test(locale)) return 'en';
  const sample = `${plan.title} ${plan.objective} ${extra}`;
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(sample) ? 'vi' : 'en';
}

const PLAN_STATUS_LABELS: Record<'vi' | 'en', Record<PlanStatus, string>> = {
  vi: { draft: 'bản nháp', active: 'đang hoạt động', paused: 'tạm dừng', completed: 'hoàn thành', archived: 'lưu trữ' },
  en: { draft: 'draft', active: 'active', paused: 'paused', completed: 'completed', archived: 'archived' },
};

const TASK_STATUS_LABELS: Record<'vi' | 'en', Record<PlanTaskStatus, string>> = {
  vi: { pending: 'chờ xử lý', in_progress: 'đang thực hiện', done: 'hoàn thành', blocked: 'bị chặn', skipped: 'bỏ qua' },
  en: { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked', skipped: 'skipped' },
};

function countsFor(citations: PlanBriefCitation[]): Record<PlanTaskStatus, number> {
  const counts: Record<PlanTaskStatus, number> = { pending: 0, in_progress: 0, done: 0, blocked: 0, skipped: 0 };
  for (const citation of citations) counts[citation.status] += 1;
  return counts;
}

function citationLabel(index: number): string {
  return `[T${index}]`;
}

/**
 * Deterministic, fully grounded brief. It only uses plan fields and task rows;
 * it cannot hallucinate because every statement is derived from citations.
 */
export function deterministicPlanBrief(plan: PlanRecord, language: 'vi' | 'en'): string {
  const citations = planCitations(plan);
  const counts = countsFor(citations);
  const labels = TASK_STATUS_LABELS[language];
  const planLabel = PLAN_STATUS_LABELS[language][plan.status];
  const total = citations.length;
  const shown = citations.slice(0, 40);
  const idToIndex = new Map(citations.map((citation) => [citation.taskId, citation.index] as const));
  const dashes = (ids: string[]): string => ids
    .map((id) => idToIndex.get(id))
    .filter((index): index is number => index !== undefined)
    .map((index) => citationLabel(index))
    .join(', ');

  if (language === 'vi') {
    const lines = [
      `Kế hoạch EOP "${plan.title}" — trạng thái: ${planLabel}.`,
      `Mục tiêu: ${plan.objective}`,
      `Tiến độ: ${counts.done}/${total} nhiệm vụ hoàn thành; ${counts.in_progress} đang thực hiện; ${counts.blocked} bị chặn; ${counts.pending} chờ xử lý; ${counts.skipped} bỏ qua.`,
    ];
    if (!plan.activatedAt) {
      lines.push('Kế hoạch chưa được kích hoạt nên chưa có hạn xử lý.');
    } else {
      lines.push(`Kích hoạt lúc: ${plan.activatedAt}.`);
    }
    lines.push('Nhiệm vụ:');
    for (const citation of shown) {
      const due = citation.dueAt ? `hạn ${citation.dueAt}` : 'chưa có hạn';
      const owner = citation.ownerRole ? `; phụ trách: ${citation.ownerRole}` : '';
      lines.push(`${citationLabel(citation.index)} ${citation.title} — ${labels[citation.status]}; ${due}${owner}.`);
    }
    if (total > shown.length) lines.push(`… và ${total - shown.length} nhiệm vụ khác.`);
    const blocked = citations.filter((citation) => citation.status === 'blocked');
    if (blocked.length) {
      lines.push('Nhiệm vụ bị chặn:');
      for (const citation of blocked.slice(0, 20)) {
        const pending = dashes(citation.dependsOn);
        lines.push(`${citationLabel(citation.index)} ${citation.title}${pending ? ` (phụ thuộc chưa xong: ${pending})` : ''}.`);
      }
      if (blocked.length > 20) lines.push(`… và ${blocked.length - 20} nhiệm vụ bị chặn khác.`);
    }
    return lines.join('\n');
  }

  const lines = [
    `EOP plan "${plan.title}" is ${planLabel}.`,
    `Objective: ${plan.objective}`,
    `Progress: ${counts.done}/${total} tasks done; ${counts.in_progress} in progress; ${counts.blocked} blocked; ${counts.pending} pending; ${counts.skipped} skipped.`,
  ];
  if (!plan.activatedAt) {
    lines.push('The plan has not been activated, so no task due times exist yet.');
  } else {
    lines.push(`Activated at: ${plan.activatedAt}.`);
  }
  lines.push('Tasks:');
  for (const citation of shown) {
    const due = citation.dueAt ? `due ${citation.dueAt}` : 'no due time';
    const owner = citation.ownerRole ? `; owner: ${citation.ownerRole}` : '';
    lines.push(`${citationLabel(citation.index)} ${citation.title} — ${labels[citation.status]}; ${due}${owner}.`);
  }
  if (total > shown.length) lines.push(`… and ${total - shown.length} more tasks.`);
  const blocked = citations.filter((citation) => citation.status === 'blocked');
  if (blocked.length) {
    lines.push('Blocked tasks:');
    for (const citation of blocked.slice(0, 20)) {
      const pending = dashes(citation.dependsOn);
      lines.push(`${citationLabel(citation.index)} ${citation.title}${pending ? ` (waiting on ${pending})` : ''}.`);
    }
    if (blocked.length > 20) lines.push(`… and ${blocked.length - 20} more blocked tasks.`);
  }
  return lines.join('\n');
}

function validCitations(text: string, count: number): boolean {
  const matches = [...text.matchAll(/\[T(\d+)\]/g)];
  if (!matches.length) return false;
  return matches.every((match) => {
    const value = Number(match[1]);
    return Number.isInteger(value) && value >= 1 && value <= count;
  });
}

function briefPrompt(plan: PlanRecord, language: 'vi' | 'en', focus: string, citations: PlanBriefCitation[]): string {
  const idToIndex = new Map(citations.map((citation) => [citation.taskId, citation.index] as const));
  const context = citations.map((citation) => {
    const dependencies = citation.dependsOn
      .map((id) => idToIndex.get(id))
      .filter((index): index is number => index !== undefined)
      .map((index) => citationLabel(index))
      .join(', ');
    return `${citationLabel(citation.index)} id=${citation.taskId} | phase=${citation.phaseId} | title=${citation.title} | `
      + `status=${citation.status} | owner=${citation.ownerRole || 'unassigned'} | due=${citation.dueAt || 'not scheduled'}`
      + (dependencies ? ` | dependsOn=${dependencies}` : '');
  }).join('\n');

  return [
    'You are an emergency operations planning assistant writing a status brief for one EOP.',
    'Use ONLY the PLAN CONTEXT below. Never invent tasks, owners, dates, facts or citation numbers.',
    `Cite tasks only with their exact bracket marker, for example [T1]. There are ${citations.length} citation(s); never use a higher number.`,
    'Structure: current plan status, progress, next due tasks, blockers/risks and the recommended next action.',
    `Reply in ${language === 'vi' ? 'Vietnamese' : 'English'} and keep the brief under 220 words.`,
    `PLAN: ${plan.title} | status=${plan.status} | severity=${plan.severity || 'unspecified'} | activated=${plan.activatedAt || 'not activated'}`,
    `OBJECTIVE: ${plan.objective}`,
    `PLAN CONTEXT:\n${context}`,
    ...(focus ? [`FOCUS: ${focus}`] : []),
  ].join('\n\n');
}

/** Build an LLM brief with one attempt, then fall back to the deterministic brief. */
export async function buildPlanBrief(
  client: SynapseOneClient,
  plan: PlanRecord,
  options: { focus?: string } = {},
): Promise<PlanBriefResult> {
  const focus = String(options.focus || '').trim().slice(0, 500);
  const language = planLanguage(plan, focus);
  const citations = planCitations(plan);
  const generatedAt = new Date().toISOString();
  const fallback = (): PlanBriefResult => ({
    brief: deterministicPlanBrief(plan, language),
    citations,
    language,
    model: null,
    fallback: true,
    generated_at: generatedAt,
  });

  if (!citations.length) return fallback();
  try {
    const response: any = await client.inference.chat(
      [
        { role: 'system' as const, content: briefPrompt(plan, language, focus, citations) },
        { role: 'user' as const, content: 'Write the status brief for the plan.' },
      ],
      { temperature: 0.2, max_tokens: 450 },
      { timeoutMs: 12_000, maxAttempts: 1 },
    );
    const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
    const brief = String(choice?.message?.content ?? response?.message ?? '').trim();
    if (!brief || !validCitations(brief, citations.length)) return fallback();
    return {
      brief,
      citations,
      language,
      model: response?.model ? String(response.model) : null,
      fallback: false,
      generated_at: generatedAt,
    };
  } catch (error) {
    console.warn(`[plans][brief] inference failed, using deterministic brief: ${(error as Error)?.message || error}`);
    return fallback();
  }
}

/* ------------------------------------------------------------------------- *
 * AI-assisted draft (never persisted)
 * ------------------------------------------------------------------------- */

export function parsePlanDraftRequest(value: unknown): PlanDraftRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_request', 'request body must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const objective = validatePlanObjective(body.objective);
  const eventType = validateOptionalPlanText(body.eventType, 'eventType', 64);
  const context = validatePlanContext(body.context);
  const rawCount = body.phaseCount === undefined ? 3 : body.phaseCount;
  if (typeof rawCount !== 'number' || !Number.isInteger(rawCount)
    || rawCount < PLAN_LIMITS.phasesMin || rawCount > PLAN_LIMITS.phasesMax) {
    throw apiError(400, 'invalid_request', `phaseCount must be an integer ${PLAN_LIMITS.phasesMin}..${PLAN_LIMITS.phasesMax}`);
  }
  return {
    objective,
    ...(eventType ? { eventType } : {}),
    ...(context ? { context } : {}),
    phaseCount: rawCount,
  };
}

function draftContext(request: PlanDraftRequest): Record<string, unknown> | undefined {
  const context = { ...(request.context || {}), ...(request.eventType ? { eventType: request.eventType } : {}) };
  return Object.keys(context).length ? context : undefined;
}

function draftTitle(value: unknown, objective: string): string {
  const candidate = String(value ?? '').trim();
  if (candidate.length >= 3 && candidate.length <= 200) return candidate;
  return `EOP — ${objective.slice(0, 120)}`;
}

/** Parse a JSON object out of an LLM reply, tolerating a ```json fence. */
export function extractJsonObject(content: string): unknown | undefined {
  let text = String(content || '').trim();
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  else if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Deterministic 3-phase fallback template (Prepare / Respond / Recover). */
export function deterministicPlanDraft(request: PlanDraftRequest): PlanDraft {
  const raw = {
    title: `EOP — ${request.objective.slice(0, 120)}`,
    objective: request.objective,
    ...(draftContext(request) ? { context: draftContext(request) } : {}),
    phases: [
      {
        id: 'phase-prepare',
        title: 'Prepare',
        objective: 'Confirm authority, objectives, resources and communications before response.',
        startOffsetMinutes: 0,
        tasks: [
          {
            id: 'task-prepare-activate',
            title: 'Confirm plan activation and command roles',
            ownerRole: 'incident_commander',
            dueOffsetMinutes: 15,
            dependsOn: [],
          },
          {
            id: 'task-prepare-assess',
            title: 'Assess the event and confirm operational objectives',
            ownerRole: 'operations_chief',
            dueOffsetMinutes: 30,
            dependsOn: ['task-prepare-activate'],
          },
          {
            id: 'task-prepare-resources',
            title: 'Check response resources and contact lists',
            ownerRole: 'logistics_chief',
            dueOffsetMinutes: 45,
            dependsOn: ['task-prepare-assess'],
          },
        ],
      },
      {
        id: 'phase-respond',
        title: 'Respond',
        objective: 'Deploy and coordinate the response while monitoring the hazard.',
        startOffsetMinutes: 60,
        tasks: [
          {
            id: 'task-respond-deploy',
            title: 'Deploy response teams to affected areas',
            ownerRole: 'operations_chief',
            dueOffsetMinutes: 60,
            dependsOn: ['task-prepare-resources'],
          },
          {
            id: 'task-respond-coordinate',
            title: 'Coordinate response and publish a situation update',
            ownerRole: 'public_information_officer',
            dueOffsetMinutes: 90,
            dependsOn: ['task-respond-deploy'],
          },
          {
            id: 'task-respond-monitor',
            title: 'Monitor hazards and adjust the response',
            ownerRole: 'planning_chief',
            dueOffsetMinutes: 120,
            dependsOn: ['task-respond-coordinate'],
          },
        ],
      },
      {
        id: 'phase-recover',
        title: 'Recover',
        objective: 'Stabilize services, assess recovery needs and capture lessons.',
        startOffsetMinutes: 240,
        tasks: [
          {
            id: 'task-recover-stabilize',
            title: 'Stabilize critical services',
            ownerRole: 'operations_chief',
            dueOffsetMinutes: 60,
            dependsOn: ['task-respond-monitor'],
          },
          {
            id: 'task-recover-assess',
            title: 'Assess damage and recovery needs',
            ownerRole: 'planning_chief',
            dueOffsetMinutes: 120,
            dependsOn: ['task-recover-stabilize'],
          },
          {
            id: 'task-recover-transition',
            title: 'Transition to recovery and capture lessons',
            ownerRole: 'incident_commander',
            dueOffsetMinutes: 180,
            dependsOn: ['task-recover-assess'],
          },
        ],
      },
    ],
  };
  return normalizePlanInput(raw);
}

function draftPrompt(request: PlanDraftRequest): string {
  const context = request.context ? JSON.stringify(request.context).slice(0, 16 * 1024) : '{}';
  return [
    'You are an emergency operations planning assistant. Build a phased task plan as STRICT JSON only.',
    'Return one JSON object, no prose and no markdown fence.',
    'Schema:',
    '{"title":"string 3..200","objective":"string","severity":"low|moderate|high|critical (optional)",'
      + '"phases":[{"id":"[A-Za-z0-9_-]{1,64}","title":"string","objective":"string (optional)",'
      + '"startOffsetMinutes":0,"tasks":[{"id":"[A-Za-z0-9_-]{1,64}","title":"string",'
      + '"ownerRole":"string (optional)","dueOffsetMinutes":0,"dependsOn":["existing task id"]}]}]}',
    `Rules: exactly ${request.phaseCount} phase(s); 1..50 tasks per phase; at most 200 tasks total; `
      + 'ids are globally unique across phases and tasks; every dependsOn id must exist; dependencies must be acyclic; '
      + `all offsets are integer minutes 0..${PLAN_LIMITS.offsetMax}.`,
    'Use generic emergency-management roles (incident_commander, operations_chief, planning_chief, logistics_chief, public_information_officer).',
    'The plan must be actionable, chronological and grounded in the objective; do not invent an event id or local facts.',
    `OBJECTIVE:\n${request.objective}`,
    `EVENT TYPE: ${request.eventType || 'unspecified'}`,
    `CONTEXT JSON:\n${context}`,
  ].join('\n');
}

/**
 * One inference attempt. Any error, empty reply, unparseable JSON or payload
 * that fails the shared plan validator returns the deterministic template with
 * `fallback: true`; the draft is never persisted here.
 */
export async function generatePlanDraft(client: SynapseOneClient, request: PlanDraftRequest): Promise<PlanDraftResult> {
  let response: any;
  try {
    response = await client.inference.chat(
      [
        { role: 'system' as const, content: draftPrompt(request) },
        { role: 'user' as const, content: `Draft a ${request.phaseCount}-phase emergency operations plan for the objective above.` },
      ],
      { temperature: 0.2, max_tokens: 1_800 },
      { timeoutMs: 20_000, maxAttempts: 1 },
    );
  } catch (error) {
    console.warn(`[plans][draft] inference failed, using template: ${(error as Error)?.message || error}`);
    return { planDraft: deterministicPlanDraft(request), model: null, fallback: true, reason: 'inference_unavailable' };
  }

  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const content = String(choice?.message?.content ?? response?.message ?? '').trim();
  if (!content) {
    return { planDraft: deterministicPlanDraft(request), model: null, fallback: true, reason: 'empty_response' };
  }
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { planDraft: deterministicPlanDraft(request), model: null, fallback: true, reason: 'invalid_json' };
  }

  const modelPlan = parsed as Record<string, unknown>;
  const rawSeverity = typeof modelPlan.severity === 'string' ? modelPlan.severity.trim() : '';
  const severity = rawSeverity && rawSeverity.length <= 32 ? rawSeverity : undefined;
  const context = draftContext(request);
  try {
    const planDraft = normalizePlanInput({
      title: draftTitle(modelPlan.title, request.objective),
      objective: request.objective,
      ...(severity ? { severity } : {}),
      ...(context ? { context } : {}),
      phases: modelPlan.phases,
    });
    if (planDraft.phases.length !== request.phaseCount) {
      return { planDraft: deterministicPlanDraft(request), model: null, fallback: true, reason: 'invalid_plan' };
    }
    return {
      planDraft,
      model: response?.model ? String(response.model) : null,
      fallback: false,
    };
  } catch (error) {
    console.warn(`[plans][draft] model plan rejected: ${(error as Error)?.message || error}`);
    return { planDraft: deterministicPlanDraft(request), model: null, fallback: true, reason: 'invalid_plan' };
  }
}
