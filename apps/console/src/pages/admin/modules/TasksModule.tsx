// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, Circle, Loader2, Search } from 'lucide-react';
import { api } from '../../../lib/api';
import { Button, EmptyState, inputClassName } from '../../../components/ui';

interface Task {
  id: string;
  projectId: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  assignee?: string;
}
const STAGES = [
  { id: 'todo', label: 'To do', icon: Circle },
  { id: 'doing', label: 'In progress', icon: Loader2 },
  { id: 'done', label: 'Done', icon: CheckCircle2 },
] as const;
export function TasksModule() {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const tasks = useQuery({
    queryKey: ['shared-tasks', offset],
    queryFn: () =>
      api.get<{ items: Task[]; total: number }>(
        `/v1/capabilities/project-tasks?limit=200&offset=${offset}`,
      ),
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string }> }>('/v1/capabilities/projects'),
    retry: false,
  });
  const mutate = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      await client.invalidateQueries({ queryKey: ['shared-tasks'] });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows = (tasks.data?.items ?? []).filter((task) =>
    `${task.title} ${task.assignee ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-500">
            Common workspace
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-dx-fg">Task board</h2>
          <p className="mt-1 text-sm text-dx-muted">
            Coordinate tasks across your app team’s projects.
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-dx-line bg-dx-surface px-3 py-2">
          <Search size={16} />
          <input
            aria-label="Search tasks"
            className="bg-transparent text-sm outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search this page…"
          />
        </label>
      </div>
      <form
        className="flex flex-wrap gap-2 rounded-2xl border border-dx-line bg-dx-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!project || !title.trim() || busy) return;
          void mutate(async () => {
            await api.post(`/v1/capabilities/projects/${encodeURIComponent(project)}/tasks`, {
              title,
              assignee,
            });
            setTitle('');
          });
        }}
      >
        <input
          aria-label="Task title"
          className={`${inputClassName} min-w-48 flex-1`}
          placeholder="What needs to get done?"
          required
          maxLength={240}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          aria-label="Project"
          className={`${inputClassName} !w-auto`}
          required
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">Choose project</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Assignee"
          className={`${inputClassName} !w-40`}
          maxLength={128}
          placeholder="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        />
        <Button variant="primary" disabled={busy || !project}>
          <Plus size={15} /> Add task
        </Button>
      </form>
      {error || tasks.isError || projects.isError ? (
        <p role="alert" className="text-sm text-red-600">
          {error || (tasks.error ?? projects.error)?.message}
        </p>
      ) : null}
      {tasks.isLoading ? (
        <p role="status">Loading tasks…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {STAGES.map(({ id, label, icon: Icon }) => (
            <div key={id} className="min-h-64 rounded-2xl border border-dx-line bg-dx-subtle p-3">
              <h3 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold">
                <Icon
                  size={16}
                  className={id === 'done' ? 'text-emerald-500' : 'text-indigo-500'}
                />
                {label}
                <span className="ml-auto rounded-md bg-dx-surface px-2 text-xs text-dx-muted">
                  {rows.filter((t) => t.status === id).length}
                </span>
              </h3>
              <div className="space-y-2">
                {rows
                  .filter((t) => t.status === id)
                  .map((task) => (
                    <article
                      key={task.id}
                      className="rounded-xl border border-dx-line bg-dx-surface p-4 shadow-sm"
                    >
                      <p className="text-sm font-medium">{task.title}</p>
                      <p className="mt-2 text-xs text-dx-muted">
                        {projects.data?.items.find((p) => p.id === task.projectId)?.name ??
                          'Project'}{' '}
                        · {task.assignee || 'Unassigned'}
                      </p>
                      <select
                        aria-label={`Status of ${task.title}`}
                        disabled={busy}
                        className="mt-3 rounded-md border border-dx-line bg-dx-subtle px-2 py-1 text-xs"
                        value={task.status}
                        onChange={(e) =>
                          void mutate(() =>
                            api.patch(
                              `/v1/capabilities/project-tasks/${encodeURIComponent(task.id)}`,
                              { status: e.target.value },
                            ),
                          )
                        }
                      >
                        {STAGES.map((stage) => (
                          <option key={stage.id} value={stage.id}>
                            {stage.label}
                          </option>
                        ))}
                      </select>
                    </article>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!tasks.isLoading && !tasks.isError && rows.length === 0 ? (
        <EmptyState
          title="A clear board"
          message="Create a task in an existing project to get started."
        />
      ) : null}
      <div className="flex items-center justify-end gap-3 text-xs text-dx-muted">
        <span>{tasks.data?.total ?? 0} tasks</span>
        <Button
          variant="ghost"
          disabled={offset === 0 || tasks.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 200))}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          disabled={offset + 200 >= (tasks.data?.total ?? 0) || tasks.isFetching}
          onClick={() => setOffset(offset + 200)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}
