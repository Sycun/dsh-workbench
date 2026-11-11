import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Bounded cursor metadata only: unchanged tasks and audit events never cross the poll boundary. */
export class ChangeFeed {
  constructor() { this.cursors = new Map(); }
  read(snapshot, cursor) {
    const { events, projects, tasks, ...meta } = snapshot;
    const signatures = { projects: Object.fromEntries(projects.map(p => [p.id, hash(p)])), tasks: Object.fromEntries(tasks.map(t => [t.id, hash(t)])), meta: hash(meta) };
    const next = hash(signatures), previous = this.cursors.get(cursor);
    this.cursors.set(next, signatures);
    while (this.cursors.size > 32) this.cursors.delete(this.cursors.keys().next().value);
    if (!previous) return { cursor: next, reset: true, projects, tasks, ...meta };
    if (next === cursor) return { cursor: next, unchanged: true };
    return { cursor: next, reset: false,
      projects: projects.filter(p => previous.projects[p.id] !== signatures.projects[p.id]),
      tasks: tasks.filter(t => previous.tasks[t.id] !== signatures.tasks[t.id]),
      removedProjects: Object.keys(previous.projects).filter(id => !signatures.projects[id]),
      removedTasks: Object.keys(previous.tasks).filter(id => !signatures.tasks[id]),
      ...(previous.meta === signatures.meta ? {} : meta)
    };
  }
}
