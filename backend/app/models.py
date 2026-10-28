from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


def clean_nickname(value: str) -> str:
    nickname = value.strip()
    if not nickname or len(nickname) > 24:
        raise ValueError("Никнейм должен содержать от 1 до 24 символов.")
    if any(ord(char) < 32 or ord(char) == 127 for char in nickname):
        raise ValueError("Никнейм содержит недопустимые символы.")
    return nickname


class StartLobbyRequest(BaseModel):
    ip: str = Field(min_length=7, max_length=15)
    port: int = Field(ge=1, le=65535)
    nickname: str

    @field_validator("nickname")
    @classmethod
    def validate_nickname(cls, value: str) -> str:
        return clean_nickname(value)


class StopLobbyResponse(BaseModel):
    running: bool


class InterfaceInfo(BaseModel):
    ip: str
    name: str


class Participant(BaseModel):
    id: str
    nickname: str
    host: bool
    connected: Literal[True] = True


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    nickname: str
    text: str
    sent_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    system: bool = False
    room_id: str | None = None

