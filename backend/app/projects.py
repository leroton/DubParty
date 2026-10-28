import json
import mimetypes
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

MAX_VIDEO_SIZE = 20 * 1024 * 1024 * 1024
VIDEO_TYPES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


def storage_root() -> Path:
    override = os.environ.get("DUBPARTY_DATA_DIR")
    base = Path(override) if override else Path(os.environ.get("APPDATA", Path.home())) / "DubParty" / "projects"
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail=f"Нет доступа к папке проектов: {base}. Задайте DUBPARTY_DATA_DIR или проверьте права пользователя.",
        ) from error
    return base


def project_directory(project_id: UUID) -> Path:
    return storage_root() / str(project_id)


def metadata_path(project_id: UUID) -> Path:
    return project_directory(project_id) / "project.json"


class Character(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("Имя персонажа не может быть пустым.")
        return name


class DialogueLine(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    character_id: str | None = None
    text: str = Field(default="", max_length=1000)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    lane: int = Field(default=0, ge=0, le=5000)

    @model_validator(mode="after")
    def valid_range(self):
        if self.end_ms <= self.start_ms:
            raise ValueError("Конец реплики должен быть позже её начала.")
        return self


class SceneProject(BaseModel):
    id: UUID
    title: str = Field(min_length=1, max_length=120)
    video_name: str = Field(min_length=1, max_length=255)
    video_file: str = Field(pattern=r"^video\.[a-z0-9]{1,8}$")
    duration_ms: int = Field(default=0, ge=0)
    characters: list[Character] = Field(default_factory=list, max_length=100)
    lines: list[DialogueLine] = Field(default_factory=list, max_length=5000)
    prepared_audio_file: str | None = Field(default=None, pattern=r"^audio/prepared\.wav$")
    created_at: str
    updated_at: str

    @field_validator("title", "video_name")
    @classmethod
    def trim_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Значение не может быть пустым.")
        return text

    @model_validator(mode="after")
    def validate_lines(self):
        ids = {character.id for character in self.characters}
        character_ids = [character.id for character in self.characters]
        if len(character_ids) != len(set(character_ids)):
            raise ValueError("ID персонажей должны быть уникальными.")
        line_ids = [line.id for line in self.lines]
        if len(line_ids) != len(set(line_ids)):
            raise ValueError("ID реплик должны быть уникальными.")
        for line in self.lines:
            if line.character_id and line.character_id not in ids:
                raise ValueError("Реплика ссылается на неизвестного персонажа.")
            if self.duration_ms and line.end_ms > self.duration_ms:
                raise ValueError("Реплика выходит за пределы длительности видео.")
        return self


router = APIRouter(prefix="/api/projects", tags=["projects"])


def read_project(project_id: UUID) -> SceneProject:
    path = metadata_path(project_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Проект не найден.")
    try:
        return SceneProject.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail="Не удалось прочитать файл проекта.") from error


def save_project(project: SceneProject) -> None:
    directory = project_directory(project.id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "project.json"
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as file:
            temporary = file.name
            file.write(project.model_dump_json(indent=2))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


@router.get("")
async def list_projects() -> dict[str, list[dict[str, object]]]:
    projects: list[SceneProject] = []
    for path in storage_root().glob("*/project.json"):
        try:
            projects.append(SceneProject.model_validate_json(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    projects.sort(key=lambda item: item.updated_at, reverse=True)
    return {"projects": [item.model_dump(mode="json") for item in projects]}


@router.post("")
async def create_project(file: UploadFile, title: str | None = Form(default=None, max_length=120)) -> dict[str, object]:
    original_filename = file.filename or ""
    if "/" in original_filename or "\\" in original_filename:
        raise HTTPException(status_code=400, detail="Некорректное имя видеофайла.")
    filename = Path(file.filename or "").name
    extension = Path(filename).suffix.lower()
    if extension not in VIDEO_TYPES:
        raise HTTPException(status_code=415, detail="Поддерживаются видео MP4, MOV, MKV, WebM, AVI и M4V.")
    if not re.fullmatch(r"[^/\\]+", filename):
        raise HTTPException(status_code=400, detail="Некорректное имя видеофайла.")

    project_id = uuid4()
    directory: Path | None = None
    project_title = (title or Path(filename).stem or "Новый фильм").strip()
    if not project_title:
        raise HTTPException(status_code=422, detail="Название проекта не может быть пустым.")
    try:
        directory = project_directory(project_id)
        directory.mkdir(parents=True, exist_ok=False)
        video_file = directory / f"video{extension}"
        size = 0
        with video_file.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_VIDEO_SIZE:
                    raise HTTPException(status_code=413, detail="Размер видео превышает 20 ГБ.")
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Видео пустое.")
        timestamp = datetime.now(timezone.utc).isoformat()
        project = SceneProject(
            id=project_id,
            title=project_title,
            video_name=filename,
            video_file=video_file.name,
            created_at=timestamp,
            updated_at=timestamp,
        )
        save_project(project)
        return project.model_dump(mode="json")
    except HTTPException:
        if directory and directory.exists():
            for item in directory.iterdir():
                item.unlink(missing_ok=True)
            directory.rmdir()
        raise
    except OSError as error:
        if directory and directory.exists():
            for item in directory.iterdir():
                item.unlink(missing_ok=True)
            directory.rmdir()
        data_root = directory.parent if directory else os.environ.get("DUBPARTY_DATA_DIR", "%APPDATA%\\DubParty\\projects")
        raise HTTPException(
            status_code=500,
            detail=f"Не удалось сохранить видео в {data_root}: проверьте свободное место и права на запись.",
        ) from error
    finally:
        await file.close()


@router.get("/{project_id}")
async def get_project(project_id: UUID) -> dict[str, object]:
    return read_project(project_id).model_dump(mode="json")


@router.put("/{project_id}")
async def update_project(project_id: UUID, project: SceneProject) -> dict[str, object]:
    if project.id != project_id:
        raise HTTPException(status_code=400, detail="ID проекта не совпадает.")
    current = read_project(project_id)
    if current.video_file != project.video_file or current.video_name != project.video_name:
        raise HTTPException(status_code=400, detail="Исходное видео нельзя заменить через сохранение метаданных.")
    from datetime import datetime, timezone

    project.updated_at = datetime.now(timezone.utc).isoformat()
    save_project(project)
    return project.model_dump(mode="json")


@router.get("/{project_id}/video")
async def get_video(project_id: UUID) -> FileResponse:
    project = read_project(project_id)
    path = project_directory(project_id) / project.video_file
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Исходное видео проекта не найдено.")
    media_type = mimetypes.guess_type(project.video_name)[0] or "application/octet-stream"
    return FileResponse(path, filename=project.video_name, media_type=media_type)

