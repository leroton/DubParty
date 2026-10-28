import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Check, ChevronDown, Copy, DoorOpen, Eye, Film, Hash, Link2, LoaderCircle, MessageSquare, Mic2, Plus, Radio, Send, ShieldAlert, Users, Wifi, X } from "lucide-react";
import { api } from "./services/api";
import { projectsApi } from "./services/projects";
import EditorPage from "./features/editor/EditorPage";
import CreateProjectDialog from "./features/lobby/CreateProjectDialog";
import type { SceneProject } from "./types/project";
import type { ActiveProject, ChatMessage, ClientEvent, ConnectionStatus, LobbyStatus, NetworkInterface, Participant, ServerEvent } from "./types/lobby";

const NICK_MAX = 24;
const MESSAGE_MAX = 500;
const DEFAULT_PORT = 8765;

function validIp(value: string) {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) return "Не удалось связаться с локальным сервером. Убедитесь, что backend запущен.";
  return message;
}

export default function App() {
  const [nickname, setNickname] = useState(() => localStorage.getItem("dubparty.nickname") ?? "");
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [selectedIp, setSelectedIp] = useState("");
  const [hostIp, setHostIp] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [lobbyStatus, setLobbyStatus] = useState<LobbyStatus>("stopped");
  const [connection, setConnection] = useState<ConnectionStatus>("disconnected");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [hostId, setHostId] = useState("");
  const [projectRooms, setProjectRooms] = useState<ActiveProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectTab, setProjectTab] = useState<"view" | "editor" | "voice" | "chat">("view");
  const [workspaceView, setWorkspaceView] = useState<"lobby" | "project">("lobby");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const hostTokenRef = useRef("");
  const projectRoomsRef = useRef<ActiveProject[]>([]);
  const selectedProjectIdRef = useRef("");
  const resumeTokenRef = useRef("");
  const retryRef = useRef<number | undefined>(undefined);
  const attemptsRef = useRef(0);
  const manualCloseRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const nicknameError = nickname.trim().length === 0 ? "Введите никнейм" : nickname.trim().length > NICK_MAX ? `Не более ${NICK_MAX} символов` : "";
  const numericPort = Number(port);
  const portError = !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535 ? "Порт: число от 1 до 65535" : "";
  const lobbyAddress = hostIp ? `${hostIp}:${port}` : "";
  const isHost = Boolean(sessionId && sessionId === hostId);
  const selectedProject = projectRooms.find((project) => project.id === selectedProjectId) ?? null;
  const sortedParticipants = useMemo(() => [...participants].sort((a, b) => Number(b.host) - Number(a.host) || a.nickname.localeCompare(b.nickname)), [participants]);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    window.clearTimeout(retryRef.current);
    socketRef.current?.close(1000, "left");
    socketRef.current = null;
    setConnection("disconnected");
    resumeTokenRef.current = "";
    hostTokenRef.current = "";
    setParticipants([]);
    setMessages([]);
    setSessionId("");
    setHostId("");
    setProjectRooms([]);
    projectRoomsRef.current = [];
    setSelectedProjectId("");
    selectedProjectIdRef.current = "";
    setCreateProjectOpen(false);
    setWorkspaceView("lobby");
  }, []);

  const connectSocket = useCallback((ip: string, targetPort: number, name: string, hostToken = "") => {
    manualCloseRef.current = false;
    setConnection(attemptsRef.current ? "reconnecting" : "connecting");
    setError("");
    const ws = new WebSocket(api.wsUrl(ip, targetPort, name, hostToken, resumeTokenRef.current));
    socketRef.current = ws;
    const timeout = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close(4000, "timeout");
    }, 8000);
    ws.onopen = () => { window.clearTimeout(timeout); attemptsRef.current = 0; setConnection("connected"); setError(""); };
    ws.onmessage = (event) => {
      let packet: ServerEvent;
      try { packet = JSON.parse(event.data) as ServerEvent; } catch { setError("Получено некорректное сообщение от сервера."); return; }
      switch (packet.type) {
        case "lobby.snapshot":
          resumeTokenRef.current = packet.resume_token;
          setProjectRooms(packet.project_rooms);
          projectRoomsRef.current = packet.project_rooms;
          setSelectedProjectId(packet.room_id ?? "");
          selectedProjectIdRef.current = packet.room_id ?? "";
          setWorkspaceView(packet.room_id ? "project" : "lobby");
          setSessionId(packet.session_id); setHostId(packet.host_id); setParticipants(packet.participants); setMessages(packet.history);
          if (packet.host_id === packet.session_id) void projectsApi.list().then(({ projects }) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            projects.forEach((project) => ws.send(JSON.stringify({ type: "project.create", project: { id: project.id, title: project.title } } satisfies ClientEvent)));
          }).catch((reason: unknown) => setError(friendlyError(reason)));
          break;
        case "participants.updated": setParticipants(packet.participants); break;
        case "chat.message": setMessages((current) => [...current, packet.message]); break;
        case "projects.updated":
          setProjectRooms(packet.projects);
          projectRoomsRef.current = packet.projects;
          break;
        case "room.snapshot": setMessages(packet.history); break;
        case "error": setError(packet.message); if (packet.code === "duplicate_nickname" || packet.code === "invalid_nickname") disconnect(); break;
        case "heartbeat.pong": break;
      }
    };
    ws.onerror = () => { if (attemptsRef.current === 0) setError("Не удалось подключиться. Проверьте IP, порт и доступность сервера."); };
    ws.onclose = (event) => {
      window.clearTimeout(timeout);
      if (socketRef.current !== ws) return;
      socketRef.current = null;
      if (manualCloseRef.current) { setConnection("disconnected"); return; }
      if (event.code === 4409 || event.code === 4400) {
        manualCloseRef.current = true;
        setConnection("disconnected");
        setParticipants([]);
        return;
      }
      setConnection("reconnecting");
      if (event.code === 4000) setError("Время ожидания подключения истекло.");
      const delay = Math.min(1000 * 2 ** Math.min(attemptsRef.current, 4), 15000);
      attemptsRef.current += 1;
      retryRef.current = window.setTimeout(() => connectSocket(ip, targetPort, name, hostToken), delay);
    };
  }, [disconnect]);

  useEffect(() => {
    let active = true;
    let startupRetry: number | undefined;
    const initialize = async (attempt = 0) => {
      try {
        const [{ interfaces: found }, status] = await Promise.all([api.interfaces(), api.status()]);
        if (!active) return;
        setInterfaces(found);
        const preferred = found.find((item) => item.ip.startsWith("25.")) ?? found.find((item) => item.ip.startsWith("26.")) ?? found[0];
        if (preferred) setSelectedIp(preferred.ip);
        if (status.running && status.ip && status.port) {
          setHostIp(status.ip); setPort(String(status.port)); setLobbyStatus("waiting");
          hostTokenRef.current = status.host_token ?? "";
          if (nickname.trim() && status.host_token) connectSocket(status.ip, status.port, nickname.trim(), status.host_token);
        }
      } catch (reason) {
        if (!active) return;
        if (attempt < 8) startupRetry = window.setTimeout(() => void initialize(attempt + 1), 500 * (attempt + 1));
        else setError(friendlyError(reason));
      }
    };
    void initialize();
    return () => {
      active = false;
      window.clearTimeout(startupRetry);
      manualCloseRef.current = true;
      window.clearTimeout(retryRef.current);
      socketRef.current?.close();
    };
  }, [connectSocket]);

  useEffect(() => {
    if (shouldScrollRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat.ping" } satisfies ClientEvent));
    }, 20000);
    return () => window.clearInterval(timer);
  }, [connection]);

  const saveNickname = () => {
    if (nicknameError) { setError(nicknameError); return false; }
    const trimmed = nickname.trim();
    setNickname(trimmed); localStorage.setItem("dubparty.nickname", trimmed); setError(""); return true;
  };

  const createLobby = async () => {
    if (!saveNickname()) return;
    if (!selectedIp || !validIp(selectedIp)) { setError("Выберите или укажите корректный IPv4 интерфейс хоста."); return; }
    if (portError) { setError(portError); return; }
    setBusy(true); setLobbyStatus("starting"); setError("");
    try {
      const result = await api.start(selectedIp, numericPort, nickname.trim());
      hostTokenRef.current = result.host_token;
      setHostIp(result.ip); setPort(String(result.port)); setLobbyStatus("waiting");
      connectSocket(result.ip, result.port, nickname.trim(), result.host_token);
    } catch (reason) { setLobbyStatus("error"); setError(friendlyError(reason)); }
    finally { setBusy(false); }
  };

  const joinLobby = () => {
    if (!saveNickname()) return;
    if (!validIp(hostIp)) { setError("Введите корректный IPv4-адрес хоста."); return; }
    if (portError) { setError(portError); return; }
    attemptsRef.current = 0;
    connectSocket(hostIp.trim(), numericPort, nickname.trim());
  };

  const leaveLobby = async () => {
    disconnect();
    if (lobbyStatus === "waiting" || lobbyStatus === "starting" || lobbyStatus === "error") {
      setLobbyStatus("stopped");
      try { await api.stop(); } catch (reason) { setError(friendlyError(reason)); }
    }
    setNotice("Вы вышли из лобби.");
  };

  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text || text.length > MESSAGE_MAX) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { setError("Нет соединения с лобби."); return; }
    socket.send(JSON.stringify({ type: "chat.send", text } satisfies ClientEvent));
    setChatInput("");
  };

  const publishProject = useCallback((project: SceneProject | null) => {
    if (!isHost || !project) return;
    const room = { id: project.id, title: project.title };
    const existing = projectRoomsRef.current.find((item) => item.id === room.id);
    if (existing?.title !== room.title) {
      const nextRooms = [room, ...projectRoomsRef.current.filter((item) => item.id !== room.id)];
      projectRoomsRef.current = nextRooms;
      setProjectRooms(nextRooms);
    }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      if (existing?.title !== room.title) socket.send(JSON.stringify({ type: "project.create", project: room } satisfies ClientEvent));
      if (selectedProjectIdRef.current !== room.id) {
        socket.send(JSON.stringify({ type: "room.enter", room_id: room.id } satisfies ClientEvent));
        selectedProjectIdRef.current = room.id;
        setSelectedProjectId(room.id);
        setWorkspaceView("project");
        setProjectTab("view");
      }
    }
  }, [isHost]);

  const enterRoom = (roomId: string | null) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { setError("Нет активного соединения с лобби."); return; }
    socket.send(JSON.stringify({ type: "room.enter", room_id: roomId } satisfies ClientEvent));
    setSelectedProjectId(roomId ?? "");
    selectedProjectIdRef.current = roomId ?? "";
    setWorkspaceView(roomId ? "project" : "lobby");
    if (roomId) setProjectTab("view");
  };

  const projectCreated = (project: SceneProject) => {
    setCreateProjectOpen(false);
    publishProject(project);
    setNotice(`Комната «${project.title}» создана.`);
  };

  const copyAddress = async () => {
    if (!lobbyAddress) return;
    try { await navigator.clipboard.writeText(lobbyAddress); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setError("Не удалось скопировать адрес. Скопируйте его вручную: " + lobbyAddress); }
  };

  const toggleLobby = async () => {
    if (lobbyStatus !== "waiting") { await createLobby(); return; }
    await leaveLobby();
  };

  const joined = Boolean(sessionId);
  const chatWorkspace = <section className="chat-layout">
    <div className="chat-main">
      <div className="chat-welcome"><div className="welcome-icon"><Hash size={23} /></div><div className="chat-welcome-copy"><h2>{selectedProject ? `Чат проекта «${selectedProject.title}»` : "Добро пожаловать в #общий-чат"}</h2><p>{selectedProject ? "Сообщения видны участникам этой проект-комнаты." : "Это общая комната лобби."}</p><div className="welcome-rule" /></div>{isHost && <button className="primary-button chat-create-project" disabled={connection !== "connected"} onClick={() => setCreateProjectOpen(true)}><Plus size={15} />Создать проект</button>}</div>
      <div ref={scrollRef} className="messages-list" onScroll={(event) => { const el = event.currentTarget; shouldScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72; }}>
        {messages.map((message) => message.system ? <div className="system-message" key={message.id}><span className="system-line" /><span>{message.text}</span><span className="system-line" /></div> : <article className="message-row" key={message.id}><div className="avatar message-avatar">{message.nickname.charAt(0).toUpperCase()}</div><div className="message-content"><div className="message-meta"><strong>{message.nickname}</strong><time>{new Date(message.sent_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.text}</p></div></article>)}
      </div>
      <div className="composer-area"><div className="composer"><input aria-label="Сообщение" maxLength={MESSAGE_MAX} placeholder={connection === "connected" ? `Написать в ${selectedProject ? selectedProject.title : "#общий-чат"}` : "Подключение…"} disabled={connection !== "connected"} value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} /><span className="composer-count">{chatInput.length > 0 && `${chatInput.length}/${MESSAGE_MAX}`}</span><button className="send-button" title="Отправить сообщение" disabled={!chatInput.trim() || connection !== "connected"} onClick={sendMessage}><Send size={17} /></button></div>{error && <div className="inline-error"><ShieldAlert size={14} />{error}</div>}</div>
    </div>
    <aside className="members-panel"><div className="members-title"><span>УЧАСТНИКИ</span><span className="member-count">{participants.length}</span></div><div className="member-group-label">В ЛОББИ — {participants.length}</div><div className="members-list">{sortedParticipants.map((person) => <div className="member-row" key={person.id}><div className="avatar member-avatar">{person.nickname.charAt(0).toUpperCase()}</div><div className="member-name"><strong>{person.nickname}{person.id === sessionId && <span className="you-label">вы</span>}</strong><span><i className="online-dot" />В сети</span></div>{person.host && <span className="host-crown" title="Хост">✦</span>}</div>)}</div><div className="members-bottom"><div className={`connection-state ${connection}`}><span className="state-dot" />{connection === "connected" ? "Соединение активно" : connection === "reconnecting" ? "Повторное подключение…" : "Нет соединения"}</div></div></aside>
    <div className="lobby-footer"><div className="footer-left"><span className="online-dot" />{connection === "connected" ? "Подключено" : connection === "reconnecting" ? "Переподключение" : "Отключено"}<span className="footer-sep">·</span>{hostIp}:{port}</div><div className="footer-right"><button onClick={copyAddress} title="Скопировать адрес"><Copy size={13} />{copied ? "Скопировано" : "Пригласить"}</button><button className="leave-button" onClick={() => void leaveLobby()} title="Выйти из лобби"><DoorOpen size={14} />Выйти</button></div></div>
  </section>;
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><AudioLines size={20} /></div><div><div className="brand-name">DubParty</div><div className="brand-caption">СТУДИЯ ОЗВУЧКИ</div></div></div>
        <div className="nav-section-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <button className={`nav-item ${workspaceView === "lobby" ? "active" : ""}`} onClick={() => enterRoom(null)} disabled={!joined}><MessageSquare size={17} /><span>Общий чат</span>{workspaceView === "lobby" && <span className="nav-active-dot" />}</button>
        <div className="sidebar-divider" />
        <div className="rooms-heading"><span>ПРОЕКТЫ</span><button className="icon-button tiny" title="Создать проект-комнату" disabled={!joined || !isHost || connection !== "connected"} onClick={() => setCreateProjectOpen(true)}><Plus size={15} /></button></div>
        <div className="project-room-list">{projectRooms.map((room) => <button className={`room-item ${selectedProjectId === room.id ? "room-active" : ""}`} key={room.id} onClick={() => enterRoom(room.id)} disabled={!joined}><Film size={16} /><span className="project-room-name">{room.title}</span></button>)}</div>
        <div className="sidebar-spacer" />
        <div className="profile-row"><div className="avatar self-avatar">{nickname.trim().charAt(0).toUpperCase() || "?"}</div><div className="profile-copy"><strong>{nickname || "Гость"}</strong><span>Локальный профиль</span></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title"><div className="mobile-mark"><AudioLines size={18} /></div><div className="title-icon">{workspaceView === "project" ? <Film size={19} /> : <Hash size={19} />}</div><div><h1>{!joined ? "Лобби" : selectedProject?.title ?? "общий-чат"}</h1><p>{!joined ? "Создайте комнату или подключитесь к друзьям" : selectedProject ? "Проект-комната" : "Общая комната лобби"}</p></div></div>
          <div className="topbar-actions">{joined && <><div className="connection-badge">{connection === "connected" ? <span className="online-dot" /> : <span className="state-dot" />}{connection === "reconnecting" ? "Переподключение…" : isHost ? "Вы хост" : `Подключено ${hostIp}:${port}`}</div><button className="icon-button copy-top" title="Скопировать адрес" onClick={copyAddress}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></>}</div>
        </header>

        {!joined ? <section className="entry-layout">
          <div className="entry-panel">
            <div className="entry-kicker"><Radio size={15} /> СОВМЕСТНАЯ СЕССИЯ</div>
            <h2>Соберите свою<br />команду озвучки</h2>
            <p className="entry-description">Подключитесь к друзьям через Hamachi или Radmin VPN и начните общаться в общей комнате.</p>
            <label className="field-label" htmlFor="nickname">Ваш никнейм</label>
            <div className="input-wrap"><Users size={16} /><input id="nickname" autoComplete="nickname" maxLength={NICK_MAX + 5} placeholder="Например, Алекс" value={nickname} onChange={(event) => setNickname(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void toggleLobby(); }} /><span className="input-count">{nickname.trim().length}/{NICK_MAX}</span></div>
            <div className="entry-divider"><span>НАЧАТЬ СЕССИЮ</span></div>
            <div className="connection-options">
              <div className="option-block">
                <div className="option-heading"><span className="option-icon host-icon"><Plus size={16} /></span><div><strong>Создать лобби</strong><small>Вы будете хостом комнаты</small></div></div>
                <label className="field-label compact-label" htmlFor="host-interface">Сетевой интерфейс</label>
                <div className="select-wrap"><Wifi size={15} /><select id="host-interface" value={selectedIp} onChange={(event) => setSelectedIp(event.target.value)}><option value="">Выберите IPv4 адрес</option>{interfaces.map((item) => <option value={item.ip} key={item.ip}>{item.name} · {item.ip}</option>)}</select><ChevronDown size={15} /></div>
                <label className="field-label compact-label" htmlFor="host-port">Порт</label>
                <input className="text-input" id="host-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} />
                <button className={lobbyStatus === "waiting" ? "secondary-button full-button" : "primary-button full-button"} disabled={busy || lobbyStatus === "starting"} onClick={() => void toggleLobby()}>{busy || lobbyStatus === "starting" ? <LoaderCircle className="spin" size={17} /> : lobbyStatus === "waiting" ? <DoorOpen size={16} /> : <Radio size={16} />}{lobbyStatus === "starting" ? "Запуск сервера…" : lobbyStatus === "waiting" ? "Завершить лобби" : "Создать лобби"}</button>
              </div>
              <div className="option-block join-block">
                <div className="option-heading"><span className="option-icon join-icon"><Link2 size={16} /></span><div><strong>Подключиться</strong><small>Введите адрес хоста</small></div></div>
                <label className="field-label compact-label" htmlFor="host-ip">IPv4 адрес хоста</label>
                <input className="text-input" id="host-ip" inputMode="decimal" placeholder="25.12.34.56" value={hostIp} onChange={(event) => setHostIp(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") joinLobby(); }} />
                <label className="field-label compact-label" htmlFor="join-port">Порт</label>
                <input className="text-input" id="join-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} onKeyDown={(event) => { if (event.key === "Enter") joinLobby(); }} />
                <button className="secondary-button full-button" onClick={joinLobby}><Link2 size={16} />Подключиться</button>
              </div>
            </div>
            {(error || nicknameError || portError) && <div className="error-banner"><ShieldAlert size={16} /><span>{error || nicknameError || portError}</span><button className="icon-button tiny" title="Скрыть" onClick={() => setError("")}><X size={14} /></button></div>}
            <div className="network-note"><ShieldAlert size={15} /><span>Убедитесь, что друзья находятся в одной виртуальной сети, а порт {port || DEFAULT_PORT} разрешён в брандмауэре.</span></div>
          </div>
          <aside className="entry-aside"><div className="aside-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-core"><AudioLines size={36} /></div><span className="orbit-node node-a"><Mic2 size={15} /></span><span className="orbit-node node-b"><MessageSquare size={14} /></span><span className="orbit-node node-c"><Users size={15} /></span></div><div className="aside-copy"><strong>Звучит лучше вместе</strong><p>Приватная комната в вашей локальной сети. Без регистрации и облачных серверов.</p></div><div className="network-status"><span className="status-indicator" />Сервер {lobbyStatus === "waiting" ? "ожидает подключения" : lobbyStatus === "starting" ? "запускается" : "не запущен"}</div></aside>
        </section> : workspaceView === "project" && selectedProject ? <><nav className="project-tabs" aria-label="Разделы проект-комнаты">
          <button className={`project-tab ${projectTab === "view" ? "active" : ""}`} onClick={() => setProjectTab("view")}><Eye size={15} />Просмотр</button>
          <button className={`project-tab ${projectTab === "editor" ? "active" : ""}`} onClick={() => setProjectTab("editor")}><Film size={15} />Редактор</button>
          <button className="project-tab" disabled title="Раздел озвучки появится на этапе 6"><Mic2 size={15} />Озвучка<span className="soon">ПОЗЖЕ</span></button>
          <button className={`project-tab ${projectTab === "chat" ? "active" : ""}`} onClick={() => setProjectTab("chat")}><MessageSquare size={15} />Чат</button>
        </nav>{projectTab === "chat" ? chatWorkspace : projectTab === "voice" ? <div className="project-empty"><Mic2 size={32} /><h3>Озвучка появится позже</h3></div> : <EditorPage activeProjectId={selectedProject.id} canPublish={isHost} mode={projectTab} onProjectChange={publishProject} onNotice={setNotice} />}</> : chatWorkspace}
        <footer className="statusbar"><div><span className={`status-indicator ${connection === "connected" ? "live" : ""}`} />{connection === "connected" ? "Сеть подключена" : "Локальная сеть"}<span className="footer-sep">·</span>DubParty v0.1.0</div><div><Wifi size={14} /><span className="status-hint">Hamachi / Radmin</span></div></footer>
      </section>
      {notice && <div role="status" className="toast"><Check size={16} />{notice}<button className="icon-button tiny" onClick={() => setNotice("")} title="Закрыть"><X size={14} /></button></div>}
      {createProjectOpen && <CreateProjectDialog onClose={() => setCreateProjectOpen(false)} onCreated={projectCreated} />}
      <div className="sr-only">{busy ? "Подождите" : ""}</div>
    </main>
  );
}
