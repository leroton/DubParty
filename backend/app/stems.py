import asyncio
import os
import re
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .projects import project_directory, read_project, save_project

router = APIRouter(prefix="/api", tags=["stems"])
jobs: dict[str, "StemJob"] = {}
install_job: "StemJob | None" = None
jobs_lock = asyncio.Lock()
StemState = Literal["idle", "queued", "running", "completed", "failed", "cancelled"]
MODEL_NAME = "htdemucs"
MODEL_CHECKPOINT = "955717e8-8726e21a.th"


@dataclass
class StemJob:
    project_id: str | None
    kind: Literal["install", "separate"]
    state: StemState = "queued"
    progress: float = 0
    message: str = "Задача ожидает запуска."
    device: str = "cpu"
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    output: list[str] = field(default_factory=list)


class SeparationRequest(BaseModel):
    device: Literal["auto", "cpu", "cuda"] = "auto"


def _tail(job: StemJob, message: str) -> None:
    cleaned = message.strip()
    if cleaned:
        job.output.append(cleaned)
        del job.output[:-20]


async def _read_output(job: StemJob, process: asyncio.subprocess.Process) -> None:
    if process.stdout is None:
        return
    while chunk := await process.stdout.read(4096):
        text = chunk.decode("utf-8", errors="replace")
        for match in re.finditer(r"(?:^|\s)(\d{1,3})%", text):
            job.progress = max(job.progress, min(99, float(match.group(1))))
        for match in re.finditer(r"(?:segment|track)\s+(\d+)\s*(?:/|of)\s*(\d+)", text, re.IGNORECASE):
            current, total = int(match.group(1)), max(1, int(match.group(2)))
            job.progress = max(job.progress, min(99, 10 + current * 85 / total))
        for line in text.replace("\r", "\n").splitlines():
            _tail(job, line)
        if job.kind == "install" and job.output:
            job.message = job.output[-1][:240]


async def _probe_demucs() -> dict[str, object]:
    probe = (
        "import pathlib, torch, demucs; "
        "print(getattr(demucs, '__version__', 'installed')); "
        "print(torch.__version__); print(int(torch.cuda.is_available())); "
        "print(pathlib.Path(torch.hub.get_dir()) / 'checkpoints')"
    )
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", probe,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        output, error = await asyncio.wait_for(process.communicate(), timeout=20)
    except (OSError, asyncio.TimeoutError):
        return {
            "available": False, "version": None, "torch_version": None,
            "cuda_available": False, "model_cached": False,
            "message": "Не удалось проверить Demucs и PyTorch в локальном Python.",
        }
    if process.returncode != 0:
        detail = error.decode("utf-8", errors="replace").strip().splitlines()
        return {
            "available": False, "version": None, "torch_version": None,
            "cuda_available": False, "model_cached": False,
            "message": "Demucs или PyTorch не установлены. Их можно установить здесь; загрузка займёт время и место.",
        }
    lines = output.decode("utf-8", errors="replace").splitlines()
    if len(lines) < 4:
        return {
            "available": False, "version": None, "torch_version": None,
            "cuda_available": False, "model_cached": False,
            "message": "Проверка Demucs вернула неполные данные.",
        }
    checkpoint_dir = Path(lines[3])
    cached = (checkpoint_dir / MODEL_CHECKPOINT).is_file()
    return {
        "available": True,
        "version": lines[0],
        "torch_version": lines[1],
        "cuda_available": lines[2] == "1",
        "model_cached": cached,
        "message": "Demucs и PyTorch готовы." if cached else "Зависимости готовы. Веса htdemucs будут загружены при первом разделении.",
    }


def _format_job(job: StemJob | None, project_id: str | None = None) -> dict[str, object]:
    project = read_project(uuid.UUID(project_id)) if project_id else None
    if job is None:
        done = bool(project and project.vocals_stem_file and project.accompaniment_stem_file)
        return {
            "state": "completed" if done else "idle",
            "progress": 100 if done else 0,
            "message": "Стемы готовы." if done else "Разделение ещё не запускалось.",
            "vocals_file": project.vocals_stem_file if project else None,
            "accompaniment_file": project.accompaniment_stem_file if project else None,
        }
    return {
        "state": job.state,
        "progress": round(job.progress, 1),
        "message": job.message,
        "vocals_file": project.vocals_stem_file if project and job.state == "completed" else None,
        "accompaniment_file": project.accompaniment_stem_file if project and job.state == "completed" else None,
    }


async def _run_install(job: StemJob) -> None:
    try:
        job.state = "running"
        job.message = "Устанавливаются Demucs и PyTorch. Это может занять несколько минут…"
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "demucs==4.0.1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        job.process = process
        output_task = asyncio.create_task(_read_output(job, process))
        return_code = await process.wait()
        await output_task
        if job.cancel_requested:
            job.state = "cancelled"
            job.progress = 0
            job.message = "Установка Demucs отменена."
        elif return_code != 0:
            job.state = "failed"
            detail = job.output[-1] if job.output else "pip завершился с ошибкой."
            job.message = f"Не удалось установить Demucs: {detail}"
        else:
            status = await _probe_demucs()
            if not status["available"]:
                raise RuntimeError(str(status["message"]))
            job.state = "completed"
            job.progress = 100
            job.message = "Demucs и PyTorch установлены."
    except Exception as error:
        job.state = "failed"
        job.message = str(error) or "Не удалось установить Demucs."
    finally:
        job.process = None


@router.get("/stems/status")
async def stems_status() -> dict[str, object]:
    status = await _probe_demucs()
    status["install"] = _format_job(install_job)
    return status


@router.get("/stems/install/status")
async def install_status() -> dict[str, object]:
    return _format_job(install_job)


@router.post("/stems/install", status_code=202)
async def install_demucs() -> dict[str, object]:
    global install_job
    async with jobs_lock:
        if install_job and install_job.state in {"queued", "running"}:
            return _format_job(install_job)
        if any(job.state in {"queued", "running"} for job in jobs.values()):
            raise HTTPException(status_code=409, detail="Сначала дождитесь завершения текущей обработки стемов.")
        install_job = StemJob(project_id=None, kind="install", message="Установка запускается…")
        install_job.task = asyncio.create_task(_run_install(install_job))
    return _format_job(install_job)


@router.delete("/stems/install")
async def cancel_install() -> dict[str, object]:
    job = install_job
    if not job or job.state not in {"queued", "running"}:
        return _format_job(job)
    job.cancel_requested = True
    job.message = "Отменяем установку Demucs…"
    if job.process and job.process.returncode is None:
        job.process.terminate()
    return _format_job(job)


async def _run_separation(job: StemJob, request: SeparationRequest) -> None:
    project_uuid = uuid.UUID(job.project_id or "")
    work_id = uuid.uuid4().hex
    audio_dir = project_directory(project_uuid) / "audio"
    work_dir = audio_dir / f"stems-work-{work_id}"
    out_dir = work_dir / "demucs"
    published_dir: Path | None = None
    output_task: asyncio.Task[None] | None = None
    try:
        project = read_project(project_uuid)
        if project.prepared_audio_file != "audio/prepared.wav":
            raise RuntimeError("Сначала подготовьте аудио из видео.")
        source = audio_dir / "prepared.wav"
        if not source.is_file():
            raise RuntimeError("Подготовленный WAV не найден. Повторите извлечение аудио.")
        status = await _probe_demucs()
        if not status["available"]:
            raise RuntimeError(str(status["message"]))
        if request.device == "cuda" and not status["cuda_available"]:
            raise RuntimeError("CUDA недоступна в установленном PyTorch. Выберите CPU или установите сборку PyTorch с CUDA.")
        job.device = "cuda" if request.device == "cuda" or request.device == "auto" and status["cuda_available"] else "cpu"
        job.state = "running"
        job.message = "Загружаются веса Demucs…" if not status["model_cached"] else f"Разделение аудио на {job.device.upper()}…"
        audio_dir.mkdir(parents=True, exist_ok=True)
        out_dir.mkdir(parents=True, exist_ok=False)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "demucs.separate", "--two-stems=vocals",
            "-n", MODEL_NAME, "--device", job.device, "--out", str(out_dir), str(source),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        job.process = process
        output_task = asyncio.create_task(_read_output(job, process))
        return_code = await process.wait()
        await output_task
        output_task = None
        if job.cancel_requested:
            job.state = "cancelled"
            job.progress = 0
            job.message = "Разделение аудио отменено."
            return
        if return_code != 0:
            detail = job.output[-1] if job.output else f"код завершения {return_code}"
            raise RuntimeError(f"Demucs завершился с ошибкой: {detail}")
        result_dir = out_dir / MODEL_NAME / source.stem
        vocals = result_dir / "vocals.wav"
        accompaniment = result_dir / "no_vocals.wav"
        if not vocals.is_file() or vocals.stat().st_size <= 44 or not accompaniment.is_file() or accompaniment.stat().st_size <= 44:
            raise RuntimeError("Demucs не создал обе ожидаемые дорожки (vocals и no_vocals).")

        stem_id = str(uuid.uuid4())
        published_dir = audio_dir / "stems" / stem_id
        staging_dir = audio_dir / "stems" / f".{stem_id}.part"
        staging_dir.mkdir(parents=True, exist_ok=False)
        shutil.copy2(vocals, staging_dir / "vocals.wav")
        shutil.copy2(accompaniment, staging_dir / "accompaniment.wav")
        published_dir.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging_dir, published_dir)
        latest = read_project(project_uuid)
        latest.vocals_stem_file = f"audio/stems/{stem_id}/vocals.wav"
        latest.accompaniment_stem_file = f"audio/stems/{stem_id}/accompaniment.wav"
        latest.updated_at = datetime.now(timezone.utc).isoformat()
        save_project(latest)
        job.state = "completed"
        job.progress = 100
        job.message = "Получены голосовой и фоновый стемы."
    except Exception as error:
        job.state = "cancelled" if job.cancel_requested else "failed"
        job.progress = 0 if job.cancel_requested else job.progress
        job.message = "Разделение аудио отменено." if job.cancel_requested else str(error) or "Не удалось разделить аудио."
        if published_dir and published_dir.exists() and job.state != "completed":
            shutil.rmtree(published_dir, ignore_errors=True)
    finally:
        if output_task and not output_task.done():
            output_task.cancel()
            await asyncio.gather(output_task, return_exceptions=True)
        if job.process and job.process.returncode is None:
            job.process.terminate()
            await job.process.wait()
        shutil.rmtree(work_dir, ignore_errors=True)
        job.process = None


@router.get("/projects/{project_id}/stems/status")
async def stems_operation_status(project_id: uuid.UUID) -> dict[str, object]:
    read_project(project_id)
    return _format_job(jobs.get(str(project_id)), str(project_id))


@router.post("/projects/{project_id}/stems", status_code=202)
async def separate_stems(project_id: uuid.UUID, request: SeparationRequest) -> dict[str, object]:
    project = read_project(project_id)
    status = await _probe_demucs()
    if not status["available"]:
        raise HTTPException(status_code=503, detail=str(status["message"]))
    if not project.prepared_audio_file:
        raise HTTPException(status_code=409, detail="Сначала подготовьте аудио из видео.")
    project_key = str(project_id)
    async with jobs_lock:
        if install_job and install_job.state in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="Дождитесь завершения установки Demucs.")
        current = jobs.get(project_key)
        if current and current.state in {"queued", "running"}:
            return _format_job(current, project_key)
        if any(job.state in {"queued", "running"} for job in jobs.values()):
            raise HTTPException(status_code=409, detail="На компьютере уже выполняется другая обработка стемов.")
        job = StemJob(project_id=project_key, kind="separate", message="Разделение запускается…")
        jobs[project_key] = job
        job.task = asyncio.create_task(_run_separation(job, request))
    return _format_job(job, project_key)


@router.delete("/projects/{project_id}/stems")
async def cancel_separation(project_id: uuid.UUID) -> dict[str, object]:
    project_key = str(project_id)
    read_project(project_id)
    job = jobs.get(project_key)
    if not job or job.state not in {"queued", "running"}:
        return _format_job(job, project_key)
    job.cancel_requested = True
    job.message = "Отменяем разделение стемов…"
    if job.process and job.process.returncode is None:
        job.process.terminate()
    return _format_job(job, project_key)


@router.get("/projects/{project_id}/stems/{stem_name}")
async def get_stem(project_id: uuid.UUID, stem_name: Literal["vocals", "accompaniment"]) -> FileResponse:
    project = read_project(project_id)
    relative = project.vocals_stem_file if stem_name == "vocals" else project.accompaniment_stem_file
    if not relative:
        raise HTTPException(status_code=404, detail="Стем ещё не создан.")
    path = project_directory(project_id).joinpath(*Path(relative).parts)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл стема отсутствует. Повторите разделение аудио.")
    return FileResponse(path, filename=f"{project.title}-{stem_name}.wav", media_type="audio/wav")
