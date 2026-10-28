import type { SceneProject } from "../types/project";

const API = "http://127.0.0.1:8765/api/projects";
const CONTROL_API = "http://127.0.0.1:8765/api";

export interface FfmpegStatus {
  available: boolean;
  version: string | null;
  message: string;
}

export interface AudioOperation {
  state: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  output_file: string | null;
}

export interface DemucsStatus {
  available: boolean;
  version: string | null;
  torch_version: string | null;
  cuda_available: boolean;
  model_cached: boolean;
  message: string;
  install?: StemsOperation;
}

export interface StemsOperation {
  state: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  vocals_file: string | null;
  accompaniment_file: string | null;
}

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
  ffmpegStatus: async () => {
    let response: Response;
    try { response = await fetch(`${CONTROL_API}/ffmpeg/status`, { signal: AbortSignal.timeout(8000) }); }
    catch { throw new Error("Не удалось проверить FFmpeg. Проверьте, что локальный backend запущен."); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail ?? `Ошибка FFmpeg (${response.status})`);
    return body as FfmpegStatus;
  },
  audioStatus: (id: string) => projectRequest<AudioOperation>(`/${encodeURIComponent(id)}/audio/status`),
  prepareAudio: (id: string) => projectRequest<AudioOperation>(`/${encodeURIComponent(id)}/audio/prepare`, { method: "POST" }),
  cancelAudio: (id: string) => projectRequest<AudioOperation>(`/${encodeURIComponent(id)}/audio/prepare`, { method: "DELETE" }),
  preparedAudioUrl: (id: string) => `${API}/${encodeURIComponent(id)}/audio/prepared`,
  demucsStatus: async () => {
    let response: Response;
    try { response = await fetch(`${CONTROL_API}/stems/status`, { signal: AbortSignal.timeout(25000) }); }
    catch { throw new Error("Не удалось проверить Demucs. Проверьте, что локальный backend запущен."); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail ?? `Ошибка Demucs (${response.status})`);
    return body as DemucsStatus;
  },
  installDemucs: async () => {
    const response = await fetch(`${CONTROL_API}/stems/install`, { method: "POST", signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail ?? `Ошибка установки Demucs (${response.status})`);
    return body as StemsOperation;
  },
  installDemucsStatus: async () => {
    const response = await fetch(`${CONTROL_API}/stems/install/status`, { signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail ?? `Ошибка установки Demucs (${response.status})`);
    return body as StemsOperation;
  },
  cancelDemucsInstall: async () => {
    const response = await fetch(`${CONTROL_API}/stems/install`, { method: "DELETE", signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail ?? `Ошибка отмены установки Demucs (${response.status})`);
    return body as StemsOperation;
  },
  stemsStatus: (id: string) => projectRequest<StemsOperation>(`/${encodeURIComponent(id)}/stems/status`),
  separateStems: (id: string, device: "auto" | "cpu" | "cuda") => projectRequest<StemsOperation>(`/${encodeURIComponent(id)}/stems`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device }),
  }),
  cancelStems: (id: string) => projectRequest<StemsOperation>(`/${encodeURIComponent(id)}/stems`, { method: "DELETE" }),
  stemUrl: (id: string, stem: "vocals" | "accompaniment") => `${API}/${encodeURIComponent(id)}/stems/${stem}`,
  videoUrl: (id: string) => `${API}/${encodeURIComponent(id)}/video`,
};
