import type { SceneProject } from "../types/project";

const API = "http://127.0.0.1:8765/api/projects";

async function projectRequest<T>(path: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("Не удалось связаться с локальным backend по адресу 127.0.0.1:8765. В окне run-dubparty.cmd введите status; если backend остановлен, перезапустите приложение.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `Ошибка проектов (${response.status})`);
  return body as T;
}

export const projectsApi = {
  list: () => projectRequest<{ projects: SceneProject[] }>(""),
  get: (id: string) => projectRequest<SceneProject>(`/${encodeURIComponent(id)}`),
  upload: (file: File, title = file.name.replace(/\.[^.]+$/, "")) => {
    const body = new FormData();
    body.append("file", file);
    body.append("title", title);
    return projectRequest<SceneProject>("", { method: "POST", body }, 2 * 60 * 60 * 1000);
  },
  save: (project: SceneProject) => projectRequest<SceneProject>(`/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  }),
  videoUrl: (id: string) => `${API}/${encodeURIComponent(id)}/video`,
};
