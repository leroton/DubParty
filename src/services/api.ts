import type { NetworkInterface } from "../types/lobby";

const API = "http://127.0.0.1:8765";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("Локальный backend не отвечает на 127.0.0.1:8765. В окне run-dubparty.cmd введите status; если backend остановлен, перезапустите приложение и проверьте, что порт 8765 свободен.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `Ошибка сервера (${response.status})`);
  return body as T;
}

export const api = {
  interfaces: () => request<{ interfaces: NetworkInterface[] }>("/api/interfaces"),
  status: () => request<{ running: boolean; ip: string | null; port: number | null; host_token: string | null; error: string | null }>("/api/lobby/status"),
  start: (ip: string, port: number, nickname: string) => request<{ running: boolean; ip: string; port: number; host_token: string }>("/api/lobby/start", {
    method: "POST", body: JSON.stringify({ ip, port, nickname }),
  }),
  stop: () => request<{ running: boolean }>("/api/lobby/stop", { method: "POST", body: "{}" }),
  wsUrl: (ip: string, port: number, nickname: string, hostToken?: string, resumeToken?: string) => {
    const params = new URLSearchParams({ nickname });
    if (hostToken) params.set("host_token", hostToken);
    if (resumeToken) params.set("resume_token", resumeToken);
    return `ws://${ip}:${port}/ws?${params.toString()}`;
  },
};
