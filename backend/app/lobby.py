import asyncio
import ipaddress
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .models import ChatMessage, Participant, clean_nickname

logger = logging.getLogger(__name__)
MAX_HISTORY = 300
MAX_MESSAGE_LENGTH = 500
HEARTBEAT_TIMEOUT = 45


@dataclass
class Client:
    websocket: WebSocket
    session_id: str
    nickname: str
    host: bool = False
    resume_token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    last_seen: float = field(default_factory=time.monotonic)
    room_id: str | None = None


class Lobby:
    def __init__(self, host_nickname: str, host_token: str):
        self.host_nickname = host_nickname
        self.host_token = host_token
        self.clients: dict[str, Client] = {}
        self.history: list[ChatMessage] = []
        self.active_project: dict[str, str] | None = None
        self.project_rooms: list[dict[str, str]] = []
        self.room_history: dict[str, list[ChatMessage]] = {}
        self.lock = asyncio.Lock()

    def participants(self) -> list[Participant]:
        return [
            Participant(
                id=client.session_id,
                nickname=client.nickname,
                host=client.host,
            )
            for client in self.clients.values()
        ]

    async def send(self, websocket: WebSocket, packet: dict[str, Any]) -> None:
        try:
            await websocket.send_json(packet)
        except (RuntimeError, WebSocketDisconnect):
            pass

    async def broadcast(self, packet: dict[str, Any]) -> None:
        async with self.lock:
            targets = [client.websocket for client in self.clients.values()]
        await asyncio.gather(*(self.send(target, packet) for target in targets))

    async def update_participants(self) -> None:
        async with self.lock:
            participants = [person.model_dump() for person in self.participants()]
            targets = [client.websocket for client in self.clients.values()]
        await asyncio.gather(*(
            self.send(target, {"type": "participants.updated", "participants": participants})
            for target in targets
        ))

    async def add_message(self, message: ChatMessage) -> None:
        history = self.history if message.room_id is None else self.room_history.setdefault(message.room_id, [])
        async with self.lock:
            history.append(message)
            if len(history) > MAX_HISTORY:
                del history[: len(history) - MAX_HISTORY]
            targets = [client.websocket for client in self.clients.values() if client.room_id == message.room_id]
        await asyncio.gather(*(self.send(target, {"type": "chat.message", "message": message.model_dump()}) for target in targets))

    async def join(self, websocket: WebSocket, nickname: str, host_token: str) -> Client | None:
        requested_resume_token = websocket.query_params.get("resume_token", "")
        old_websocket: WebSocket | None = None
        reconnected = False
        async with self.lock:
            previous = next((client for client in self.clients.values()
                             if requested_resume_token and client.resume_token == requested_resume_token), None)
            if previous and previous.nickname.casefold() == nickname.casefold():
                await websocket.accept()
                old_websocket = previous.websocket
                client = Client(websocket, previous.session_id, previous.nickname, previous.host, previous.resume_token, room_id=previous.room_id)
                self.clients[client.session_id] = client
                reconnected = True
            elif any(client.nickname.casefold() == nickname.casefold() for client in self.clients.values()):
                await websocket.accept()
                await self.send(websocket, {
                    "type": "error", "code": "duplicate_nickname",
                    "message": "Этот никнейм уже занят. Выберите другой или дождитесь отключения участника.",
                })
                await websocket.close(code=4409, reason="duplicate nickname")
                return None
            else:
                await websocket.accept()
                client = Client(websocket, str(uuid4()), nickname, bool(host_token and host_token == self.host_token))
                self.clients[client.session_id] = client
            host_id = next((item.session_id for item in self.clients.values() if item.host), "")
            participants = [person.model_dump() for person in self.participants()]
            room_id = client.room_id
            history = [message.model_dump() for message in (self.history if room_id is None else self.room_history.get(room_id, []))]
            project_rooms = list(self.project_rooms)
        await self.send(websocket, {
            "type": "lobby.snapshot", "session_id": client.session_id, "host_id": host_id,
            "resume_token": client.resume_token, "active_project": self.active_project, "project_rooms": project_rooms, "room_id": room_id,
            "participants": participants, "history": history,
        })
        if old_websocket:
            try:
                await old_websocket.close(code=4002, reason="session resumed")
            except (RuntimeError, WebSocketDisconnect):
                pass
        verb = "переподключился" if reconnected else "присоединился"
        await self.add_message(ChatMessage(nickname="Система", text=f"{nickname} {verb} к лобби.", system=True))
        await self.update_participants()
        return client

    async def leave(self, client: Client) -> None:
        async with self.lock:
            removed = None
            if self.clients.get(client.session_id) is client:
                removed = self.clients.pop(client.session_id)
        if removed:
            await self.add_message(ChatMessage(nickname="Система", text=f"{client.nickname} покинул лобби.", system=True))
            await self.update_participants()


def create_lobby_app(lobby: Lobby) -> FastAPI:
    app = FastAPI(title="DubParty Lobby", docs_url=None, redoc_url=None)

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        raw_nickname = websocket.query_params.get("nickname", "")
        host_token = websocket.query_params.get("host_token", "")
        try:
            nickname = clean_nickname(raw_nickname)
        except ValueError as error:
            await websocket.accept()
            await lobby.send(websocket, {"type": "error", "code": "invalid_nickname", "message": str(error)})
            await websocket.close(code=4400, reason="invalid nickname")
            return

        client = await lobby.join(websocket, nickname, host_token)
        if client is None:
            return
        try:
            while True:
                raw = await websocket.receive_text()
                if len(raw) > 2_048:
                    await lobby.send(websocket, {"type": "error", "code": "message_too_large", "message": "Слишком большой пакет."})
                    continue
                try:
                    packet = json.loads(raw)
                except json.JSONDecodeError:
                    await lobby.send(websocket, {"type": "error", "code": "invalid_json", "message": "Некорректный формат сообщения."})
                    continue
                if not isinstance(packet, dict) or not isinstance(packet.get("type"), str):
                    await lobby.send(websocket, {"type": "error", "code": "invalid_packet", "message": "Некорректный формат сообщения."})
                    continue
                client.last_seen = time.monotonic()
                if packet["type"] == "heartbeat.ping":
                    await lobby.send(websocket, {"type": "heartbeat.pong"})
                elif packet["type"] == "chat.send":
                    text = packet.get("text")
                    if not isinstance(text, str):
                        await lobby.send(websocket, {"type": "error", "code": "invalid_message", "message": "Текст сообщения должен быть строкой."})
                        continue
                    text = text.strip()
                    if not text or len(text) > MAX_MESSAGE_LENGTH:
                        await lobby.send(websocket, {"type": "error", "code": "invalid_message", "message": f"Сообщение должно содержать 1–{MAX_MESSAGE_LENGTH} символов."})
                        continue
                    await lobby.add_message(ChatMessage(nickname=client.nickname, text=text, room_id=client.room_id))
                elif packet["type"] == "project.create":
                    if not client.host:
                        await lobby.send(websocket, {"type": "error", "code": "host_only", "message": "Только хост может создать проект-комнату."})
                        continue
                    project = packet.get("project")
                    if (
                        not isinstance(project, dict)
                        or not isinstance(project.get("id"), str)
                        or not isinstance(project.get("title"), str)
                        or len(project["id"]) > 64
                        or not 1 <= len(project["title"].strip()) <= 120
                    ):
                        await lobby.send(websocket, {"type": "error", "code": "invalid_project", "message": "Некорректные данные проекта."})
                        continue
                    try:
                        project_id = str(UUID(project["id"]))
                    except ValueError:
                        await lobby.send(websocket, {"type": "error", "code": "invalid_project", "message": "ID проекта должен быть UUID."})
                        continue
                    room = {"id": project_id, "title": project["title"].strip()}
                    existing_index = next((index for index, item in enumerate(lobby.project_rooms) if item["id"] == project_id), None)
                    if existing_index is None:
                        if len(lobby.project_rooms) >= 100:
                            await lobby.send(websocket, {"type": "error", "code": "project_limit", "message": "В лобби нельзя добавить больше 100 проектов."})
                            continue
                        lobby.project_rooms.append(room)
                        lobby.room_history[project_id] = []
                    else:
                        lobby.project_rooms[existing_index] = room
                    lobby.active_project = room
                    await lobby.broadcast({"type": "projects.updated", "projects": list(lobby.project_rooms), "active_project": room})
                elif packet["type"] == "room.enter":
                    room_id = packet.get("room_id")
                    if room_id is not None and (not isinstance(room_id, str) or not any(item["id"] == room_id for item in lobby.project_rooms)):
                        await lobby.send(websocket, {"type": "error", "code": "unknown_room", "message": "Проект-комната не найдена."})
                        continue
                    client.room_id = room_id
                    history = lobby.history if room_id is None else lobby.room_history.get(room_id, [])
                    await lobby.send(websocket, {"type": "room.snapshot", "room_id": room_id, "history": [item.model_dump() for item in history]})
                else:
                    await lobby.send(websocket, {"type": "error", "code": "unknown_event", "message": "Неизвестное событие."})
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("WebSocket client failed")
        finally:
            await lobby.leave(client)

    @app.on_event("startup")
    async def start_heartbeat_monitor() -> None:
        async def monitor() -> None:
            while True:
                await asyncio.sleep(10)
                now = time.monotonic()
                async with lobby.lock:
                    expired = [client for client in lobby.clients.values()
                               if now - client.last_seen > HEARTBEAT_TIMEOUT]
                for client in expired:
                    try:
                        await client.websocket.close(code=4001, reason="heartbeat timeout")
                    except (RuntimeError, WebSocketDisconnect):
                        pass

        app.state.monitor_task = asyncio.create_task(monitor())

    @app.on_event("shutdown")
    async def stop_heartbeat_monitor() -> None:
        task = getattr(app.state, "monitor_task", None)
        if task:
            task.cancel()

    return app


def validate_bind_ip(value: str) -> str:
    address = ipaddress.ip_address(value)
    if not isinstance(address, ipaddress.IPv4Address) or address.is_unspecified or address.is_loopback or address.is_multicast:
        raise ValueError("Выберите IPv4-адрес сетевого интерфейса, доступный участникам (не localhost).")
    return str(address)

