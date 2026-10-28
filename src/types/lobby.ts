export type LobbyStatus = "stopped" | "starting" | "waiting" | "error";
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface NetworkInterface { ip: string; name: string; }
export interface Participant { id: string; nickname: string; host: boolean; connected: boolean; }
export interface ChatMessage {
  id: string;
  nickname: string;
  text: string;
  sent_at: string;
  system: boolean;
  room_id: string | null;
}

export interface ActiveProject { id: string; title: string; }

export type ServerEvent =
  | { type: "lobby.snapshot"; session_id: string; host_id: string; resume_token: string; active_project: ActiveProject | null; project_rooms: ActiveProject[]; room_id: string | null; participants: Participant[]; history: ChatMessage[] }
  | { type: "participants.updated"; participants: Participant[] }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "projects.updated"; projects: ActiveProject[]; active_project: ActiveProject }
  | { type: "room.snapshot"; room_id: string | null; history: ChatMessage[] }
  | { type: "error"; code: string; message: string }
  | { type: "heartbeat.pong" };

export type ClientEvent =
  | { type: "chat.send"; text: string }
  | { type: "heartbeat.ping" }
  | { type: "project.create"; project: ActiveProject }
  | { type: "room.enter"; room_id: string | null };
