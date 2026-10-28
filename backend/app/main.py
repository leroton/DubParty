import asyncio
import ipaddress
import logging
import secrets
import socket
from contextlib import asynccontextmanager

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .lobby import Lobby, create_lobby_app, validate_bind_ip
from .models import InterfaceInfo, StartLobbyRequest
from .projects import router as projects_router

logging.basicConfig(level=logging.INFO)


class LobbyServer:
    def __init__(self) -> None:
        self.server: uvicorn.Server | None = None
        self.task: asyncio.Task[None] | None = None
        self.lobby: Lobby | None = None
        self.ip: str | None = None
        self.port: int | None = None
        self.host_token: str | None = None
        self.error: str | None = None
        self.lock = asyncio.Lock()

    async def start(self, ip: str, port: int, nickname: str) -> None:
        async with self.lock:
            if self.server and self.task and not self.task.done():
                raise HTTPException(status_code=409, detail="Лобби уже запущено. Сначала завершите текущую сессию.")
            try:
                bind_ip = validate_bind_ip(ip)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listener.bind((bind_ip, port))
                listener.listen(socket.SOMAXCONN)
                listener.setblocking(False)
            except OSError as error:
                listener.close()
                self.error = f"Не удалось занять {bind_ip}:{port}. Проверьте адрес интерфейса и доступность порта."
                raise HTTPException(status_code=409, detail=self.error) from error

            host_token = secrets.token_urlsafe(32)
            lobby = Lobby(nickname, host_token)
            app = create_lobby_app(lobby)
            config = uvicorn.Config(app, host=bind_ip, port=port, log_level="warning", access_log=False)
            server = uvicorn.Server(config)

            async def run_server() -> None:
                try:
                    await server.serve(sockets=[listener])
                except asyncio.CancelledError:
                    raise
                except BaseException as error:
                    logging.exception("Lobby server failed")
                    self.error = f"Сервер лобби завершился с ошибкой: {error}"
                finally:
                    listener.close()

            task = asyncio.create_task(run_server())
            self.server, self.task, self.lobby = server, task, lobby
            for _ in range(100):
                if server.started:
                    self.ip, self.port, self.host_token, self.error = bind_ip, port, host_token, None
                    return
                if task.done():
                    break
                await asyncio.sleep(0.05)
            self.error = f"Не удалось запустить сервер на {bind_ip}:{port}. Проверьте IP интерфейса и доступность порта."
            server.should_exit = True
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.server = self.task = self.lobby = None
            raise HTTPException(status_code=409, detail=self.error)

    async def stop(self) -> None:
        async with self.lock:
            if not self.server or not self.task:
                return
            self.server.should_exit = True
            try:
                await asyncio.wait_for(self.task, timeout=5)
            except asyncio.TimeoutError:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            self.server = self.task = self.lobby = None
            self.ip = self.port = None
            self.host_token = None


manager = LobbyServer()


def get_interfaces() -> list[InterfaceInfo]:
    results: list[InterfaceInfo] = []
    stats = psutil.net_if_stats()
    for name, addresses in psutil.net_if_addrs().items():
        if name in stats and not stats[name].isup:
            continue
        for address in addresses:
            if address.family != socket.AF_INET:
                continue
            ip = address.address
            try:
                parsed = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if parsed.is_loopback or parsed.is_link_local or parsed.is_multicast:
                continue
            results.append(InterfaceInfo(ip=ip, name=name))
    return sorted(results, key=lambda item: (not (item.ip.startswith("25.") or item.ip.startswith("26.")), item.name, item.ip))


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await manager.stop()


app = FastAPI(title="DubParty Local Control", docs_url=None, redoc_url=None, lifespan=lifespan)
app.include_router(projects_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "tauri://localhost",
        "http://tauri.localhost",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/interfaces")
async def interfaces() -> dict[str, list[InterfaceInfo]]:
    return {"interfaces": get_interfaces()}


@app.get("/api/lobby/status")
async def lobby_status() -> dict[str, object]:
    return {"running": bool(manager.server and manager.task and not manager.task.done()),
            "ip": manager.ip, "port": manager.port, "host_token": manager.host_token, "error": manager.error}


@app.post("/api/lobby/start")
async def start_lobby(request: StartLobbyRequest) -> dict[str, object]:
    await manager.start(request.ip, request.port, request.nickname)
    return {"running": True, "ip": manager.ip, "port": manager.port, "host_token": manager.host_token}


@app.post("/api/lobby/stop")
async def stop_lobby() -> dict[str, bool]:
    await manager.stop()
    return {"running": False}
