import { loadProjects, readProjects } from '../lib/projects.mjs';
import { coreObservation } from '../lib/core/observe.mjs';

export function coreSnapshot(dataDir) {
  const registry = loadProjects(dataDir);
  if (registry.corrupt)
    return { ok: false, error: 'Registo de projetos ilegível.' };
  return {
    ok: true,
    at: new Date().toISOString(),
    projects: readProjects(dataDir)
      .map((p) => ({
        name: p.name,
        core: coreObservation(p.path, { details: true }),
      }))
      .filter((p) => p.core)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
