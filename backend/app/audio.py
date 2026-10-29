import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .projects import project_directory, read_project, save_project

AudioState = Literal["idle", "queued", "running", "completed", "failed", "cancelled"]
router = APIRouter(prefix="/api", tags=["audio"])
jobs: dict[str, "AudioJob"] = {}
jobs_lock = asyncio.Lock()


@dataclass
class AudioJob:
    project_id: str
    state: AudioState = "queued"
    progress: float = 0
    message: str = "Подготовка аудио ожидает запуска."
    duration_ms: int = 0
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    errors: list[str] = field(default_factory=list)


def _ffmpeg_bin() -> Path | None:
    configured = os.environ.get("DUBPARTY_FFMPEG_BIN")
    if configured:
        directory = Path(configured)
        executable = directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if executable.is_file():
            return executable
    project_root = Path(__file__).resolve().parents[2]
    bundled = project_root / ".runtime" / "ffmpeg" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.is_file():
        return bundled
    located = shutil.which("ffmpeg")
    return Path(located) if located else None


def _ffprobe_bin(ffmpeg: Path) -> Path | None:
    name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    sibling = ffmpeg.with_name(name)
    if sibling.is_file():
        return sibling
    located = shutil.which("ffprobe")
    return Path(located) if located else None


def _format_job(job: AudioJob | None, project_id: str) -> dict[str, object]:
    directory = project_directory(uuid.UUID(project_id))
    output = directory / "audio" / "prepared.wav"
    project = read_project(uuid.UUID(project_id))
    if job is None:
        if output.is_file() and project.prepared_audio_file:
            return {"state": "completed", "progress": 100, "message": "Подготовленное аудио готово.", "output_file": project.prepared_audio_file}
        return {"state": "idle", "progress": 0, "message": "Аудио ещё не подготовлено.", "output_file": None}
    return {
        "state": job.state,
        "progress": round(job.progress, 1),
        "message": job.message,
        "output_file": project.prepared_audio_file if job.state == "completed" else None,
    }


async def _read_process_stderr(job: AudioJob, process: asyncio.subprocess.Process) -> None:
    if process.stderr is None:
        return
    while line := await process.stderr.readline():
        message = line.decode("utf-8", errors="replace").strip()
        if message:
            job.errors.append(message)
            del job.errors[:-30]


async def _probe_media(job: AudioJob, ffprobe: Path, source: Path) -> tuple[int, bool]:
    duration_process = await asyncio.create_subprocess_exec(
        str(ffprobe), "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(source),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    job.process = duration_process
    duration_output, duration_error = await duration_process.communicate()
    if job.cancel_requested:
        return 0, False
    if duration_process.returncode != 0:
        detail = duration_error.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "FFprobe не смог прочитать исходное видео.")
    try:
        probed_duration_ms = round(float(duration_output.decode("ascii").strip()) * 1000)
    except (ValueError, UnicodeDecodeError):
        probed_duration_ms = 0

    audio_process = await asyncio.create_subprocess_exec(
        str(ffprobe), "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(source),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    job.process = audio_process
    audio_output, audio_error = await audio_process.communicate()
    if job.cancel_requested:
        return 0, False
    if audio_process.returncode != 0:
        detail = audio_error.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "FFprobe не смог проверить звуковую дорожку.")
    return probed_duration_ms, bool(audio_output.strip())


async def _run_preparation(job: AudioJob, ffmpeg: Path, ffprobe: Path) -> None:
    project_uuid = uuid.UUID(job.project_id)
    project = read_project(project_uuid)
    directory = project_directory(project_uuid)
    source = directory / project.video_file
    audio_directory = directory / "audio"
    temporary = audio_directory / f"prepared-{uuid.uuid4().hex}.part"
    output = audio_directory / "prepared.wav"
    stderr_task: asyncio.Task[None] | None = None
    try:
        if not source.is_file():
            raise RuntimeError("Исходное видео проекта не найдено.")
        job.state = "running"
        job.progress = 2
        job.message = "Проверка исходного видео и звуковой дорожки…"
        duration_ms, has_audio = await _probe_media(job, ffprobe, source)
        if job.cancel_requested:
            job.state = "cancelled"
            job.message = "Подготовка аудио отменена."
            return
        if not has_audio:
            raise RuntimeError("В исходном видео не найдена звуковая дорожка.")
        job.duration_ms = project.duration_ms or duration_ms
        if job.duration_ms <= 0:
            raise RuntimeError("Не удалось определить длительность исходного видео.")

        # Probe time is real work too; reserve an initial part of the progress range for it.
        job.progress = 5

        audio_directory.mkdir(parents=True, exist_ok=True)
        job.message = "Извлечение звука и преобразование в WAV 48 кГц…"
        process = await asyncio.create_subprocess_exec(
            str(ffmpeg), "-hide_banner", "-nostats", "-y", "-i", str(source),
            "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", "48000",
            "-c:a", "pcm_s16le", "-stats_period", "0.25", "-progress", "pipe:1", "-f", "wav", str(temporary),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        job.process = process
        stderr_task = asyncio.create_task(_read_process_stderr(job, process))
        if process.stdout is not None:
            while line := await process.stdout.readline():
                if job.cancel_requested:
                    break
                key, separator, value = line.decode("ascii", errors="ignore").strip().partition("=")
                if not separator:
                    continue
                if key == "out_time":
                    try:
                        hours, minutes, seconds = value.split(":")
                        elapsed_ms = round((int(hours) * 3600 + int(minutes) * 60 + float(seconds)) * 1000)
                        job.progress = max(5, min(99, 5 + elapsed_ms * 94 / job.duration_ms))
                    except (ValueError, TypeError):
                        pass
                elif key in {"out_time_us", "out_time_ms"}:
                    try:
                        elapsed_ms = int(value) // 1000
                        job.progress = max(5, min(99, 5 + elapsed_ms * 94 / job.duration_ms))
                    except ValueError:
                        pass
                elif key == "progress" and value == "continue":
                    job.message = "Извлечение и преобразование аудио…"
        if job.cancel_requested and process.returncode is None:
            process.terminate()
        return_code = await process.wait()
        if stderr_task:
            await stderr_task
            stderr_task = None
        if job.cancel_requested:
            job.state = "cancelled"
            job.progress = 0
            job.message = "Подготовка аудио отменена."
            return
        if return_code != 0:
            raise RuntimeError(job.errors[-1] if job.errors else f"FFmpeg завершился с кодом {return_code}.")
        if not temporary.is_file() or temporary.stat().st_size <= 44:
            raise RuntimeError("FFmpeg завершился без готового аудиофайла.")
        temporary.replace(output)
        project = read_project(project_uuid)
        project.prepared_audio_file = "audio/prepared.wav"
        project.updated_at = datetime.now(timezone.utc).isoformat()
        save_project(project)
        job.progress = 100
        job.state = "completed"
        job.message = "Аудио подготовлено: WAV, 48 кГц, стерео."
    except asyncio.CancelledError:
        job.cancel_requested = True
        if job.process and job.process.returncode is None:
            job.process.terminate()
            await job.process.wait()
        job.state = "cancelled"
        job.message = "Подготовка аудио отменена."
        raise
    except Exception as error:
        if job.cancel_requested:
            job.state = "cancelled"
            job.message = "Подготовка аудио отменена."
        else:
            job.state = "failed"
            job.message = str(error) or "Не удалось подготовить аудио."
    finally:
        if stderr_task and not stderr_task.done():
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        temporary.unlink(missing_ok=True)
        job.process = None


@router.get("/ffmpeg/status")
async def ffmpeg_status() -> dict[str, object]:
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        return {"available": False, "version": None, "message": "FFmpeg не найден. Запустите проект через run-dubparty.cmd, чтобы загрузить его автоматически."}
    ffprobe = _ffprobe_bin(ffmpeg)
    if not ffprobe:
        return {"available": False, "version": None, "message": "FFprobe не найден рядом с FFmpeg; переустановите runtime через run-dubparty.cmd."}
    try:
        process = await asyncio.create_subprocess_exec(str(ffmpeg), "-version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output, _ = await asyncio.wait_for(process.communicate(), timeout=8)
    except (OSError, asyncio.TimeoutError):
        return {"available": False, "version": None, "message": "Не удалось запустить FFmpeg."}
    if process.returncode != 0:
        return {"available": False, "version": None, "message": "FFmpeg завершился с ошибкой при проверке версии."}
    version = output.decode("utf-8", errors="replace").splitlines()[0]
    return {"available": True, "version": version, "message": "FFmpeg и FFprobe готовы к обработке."}


@router.post("/projects/{project_id}/audio/prepare", status_code=202)
async def prepare_audio(project_id: uuid.UUID) -> dict[str, object]:
    project = read_project(project_id)
    availability = await ffmpeg_status()
    if not availability["available"]:
        raise HTTPException(status_code=503, detail=availability["message"])
    ffmpeg = _ffmpeg_bin()
    ffprobe = _ffprobe_bin(ffmpeg) if ffmpeg else None
    if not ffmpeg or not ffprobe:
        raise HTTPException(status_code=503, detail="FFmpeg или FFprobe не найден.")
    project_key = str(project_id)
    async with jobs_lock:
        current = jobs.get(project_key)
        if current and current.state in {"queued", "running"}:
            return _format_job(current, project_key)
        for other in jobs.values():
            if other.state in {"queued", "running"}:
                raise HTTPException(status_code=409, detail="На компьютере уже выполняется подготовка аудио другого проекта.")
        job = AudioJob(project_id=project_key, message="Подготовка аудио запускается…")
        jobs[project_key] = job
        job.task = asyncio.create_task(_run_preparation(job, ffmpeg, ffprobe))
    return _format_job(job, str(project.id))


@router.get("/projects/{project_id}/audio/status")
async def audio_status(project_id: uuid.UUID) -> dict[str, object]:
    project = read_project(project_id)
    return _format_job(jobs.get(str(project_id)), str(project.id))


@router.delete("/projects/{project_id}/audio/prepare")
async def cancel_audio(project_id: uuid.UUID) -> dict[str, object]:
    project = read_project(project_id)
    job = jobs.get(str(project_id))
    if not job or job.state not in {"queued", "running"}:
        return _format_job(job, str(project.id))
    job.cancel_requested = True
    job.message = "Отменяем подготовку аудио…"
    if job.process and job.process.returncode is None:
        job.process.terminate()
    return _format_job(job, str(project.id))


@router.get("/projects/{project_id}/audio/prepared")
async def get_prepared_audio(project_id: uuid.UUID) -> FileResponse:
    project = read_project(project_id)
    if project.prepared_audio_file != "audio/prepared.wav":
        raise HTTPException(status_code=404, detail="Подготовленное аудио не найдено.")
    path = project_directory(project_id) / "audio" / "prepared.wav"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл подготовленного аудио отсутствует.")
    return FileResponse(path, filename=f"{project.title}-prepared.wav", media_type="audio/wav")
