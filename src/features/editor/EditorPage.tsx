import { ChangeEvent, PointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, FolderOpen, LoaderCircle, Maximize, Minimize, Pause, Play, Plus, Save, Trash2, Upload, UserRound, Volume2, VolumeX, X } from "lucide-react";
import "./EditorPage.css";
import { projectsApi, type AudioOperation, type DemucsStatus, type FfmpegStatus, type StemsOperation } from "../../services/projects";
import type { Character, DialogueLine, SceneProject } from "../../types/project";

const COLORS = ["#a88be0", "#62b7b1", "#d99a61", "#d6788b", "#76a9d8", "#b6c467"];

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatPreciseTime(ms: number) {
  const snapped = Math.max(0, Math.round(ms / 500) * 500);
  const totalSeconds = Math.floor(snapped / 1000);
  const halfSecond = snapped % 1000 >= 500 ? ".5" : "";
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}${halfSecond}`;
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface EditorPageProps {
  activeProjectId?: string;
  canPublish: boolean;
  mode?: "view" | "editor";
  onProjectChange: (project: SceneProject | null) => void;
  onNotice: (message: string) => void;
}

export default function EditorPage({ activeProjectId, canPublish, mode = "editor", onProjectChange, onNotice }: EditorPageProps) {
  const [projects, setProjects] = useState<SceneProject[]>([]);
  const [project, setProject] = useState<SceneProject | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newCharacter, setNewCharacter] = useState("");
  const [zoom, setZoom] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState("");
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<"original" | "redub">("original");
  const [timelinePanning, setTimelinePanning] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [audioOperation, setAudioOperation] = useState<AudioOperation | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [demucsStatus, setDemucsStatus] = useState<DemucsStatus | null>(null);
  const [stemsOperation, setStemsOperation] = useState<StemsOperation | null>(null);
  const [stemsBusy, setStemsBusy] = useState(false);
  const [stemDevice, setStemDevice] = useState<"auto" | "cpu" | "cuda">("auto");
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoStageRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineInnerRef = useRef<HTMLDivElement>(null);
  const timelineGestureRef = useRef<{ pointerId: number; startX: number; scrollLeft: number; mode: "pending" | "pan" | "scrub" } | null>(null);
  const dragRef = useRef<{ id: string; edge: "move" | "start" | "end"; originX: number; start: number; end: number } | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const projectRef = useRef<SceneProject | null>(null);
  const autoPrepareProjectRef = useRef<string | null>(null);
  const selectedLine = project?.lines.find((line) => line.id === selectedLineId) ?? null;
  const audioPreparing = audioOperation?.state === "queued" || audioOperation?.state === "running";
  const installingDemucs = demucsStatus?.install?.state === "queued" || demucsStatus?.install?.state === "running";
  const stemsMessage = !project?.prepared_audio_file
    ? audioOperation?.state === "failed" || audioOperation?.state === "cancelled"
      ? audioOperation.message
      : audioOperation?.message ?? "Ожидается автоматическая подготовка аудио…"
    : stemsOperation && stemsOperation.state !== "idle"
      ? stemsOperation.message
      : demucsStatus?.message ?? "Demucs готов к разделению.";
  const effectiveDuration = durationMs || project?.duration_ms || 60000;
  const rulerLabels = useMemo(() => {
    const lastSecond = Math.floor(effectiveDuration / 1000);
    const labels = Array.from({ length: Math.floor(lastSecond / 5) + 1 }, (_, index) => index * 5);
    if (!labels.length || labels[labels.length - 1] !== lastSecond) labels.push(lastSecond);
    return labels;
  }, [effectiveDuration]);
  const sortedLines = useMemo(() => [...(project?.lines ?? [])].sort((a, b) => a.start_ms - b.start_ms), [project?.lines]);
  const lineLanes = useMemo(() => {
    const laneEnds: Array<Array<[number, number]>> = [];
    const lanes = new Map<string, number>();
    for (const line of sortedLines) {
      let lane = Math.max(0, Math.min(5000, line.lane ?? 0));
      const conflicts = (index: number) => laneEnds[index]?.some(([start, end]) => line.start_ms < end && line.end_ms > start) ?? false;
      while (conflicts(lane) && lane < 5000) lane += 1;
      if (conflicts(lane)) {
        lane = 0;
        while (conflicts(lane) && lane < 5000) lane += 1;
      }
      if (!laneEnds[lane]) laneEnds[lane] = [];
      laneEnds[lane].push([line.start_ms, line.end_ms]);
      lanes.set(line.id, lane);
    }
    return { lanes, count: lanes.size ? Math.max(...lanes.values()) + 1 : 0 };
  }, [sortedLines]);

  const showProject = useCallback((next: SceneProject | null) => {
    setProject(next);
    projectRef.current = next;
    setSelectedLineId(next?.lines[0]?.id ?? null);
    setCurrentMs(0);
    setDurationMs(next?.duration_ms ?? 0);
    setVideoUrl(next ? projectsApi.videoUrl(next.id) : "");
    onProjectChange(next);
  }, [onProjectChange]);

  const loadProject = useCallback(async (id: string) => {
    setBusy(true); setError(""); showProject(null);
    try {
      const next = await projectsApi.get(id);
      showProject(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось открыть проект."); }
    finally { setBusy(false); }
  }, [showProject]);

  useEffect(() => {
    projectsApi.list().then(({ projects: found }) => {
      setProjects(found);
      const first = activeProjectId ? found.find((item) => item.id === activeProjectId) : found[0];
      if (first) void loadProject(first.id);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось загрузить проекты."));
  }, [activeProjectId, loadProject]);

  useEffect(() => {
    if (!canPublish || !project?.id) return;
    let active = true;
    let pollTimer: number | undefined;
    const refreshStatus = async () => {
      try {
        const status = await projectsApi.audioStatus(project.id);
        if (!active) return;
        setAudioOperation(status);
        if (status.state === "completed") {
          const latest = await projectsApi.get(project.id);
          if (!active) return;
          const current = projectRef.current;
          if (current?.id === latest.id && (current.prepared_audio_file !== latest.prepared_audio_file || current.vocals_stem_file !== latest.vocals_stem_file || current.accompaniment_stem_file !== latest.accompaniment_stem_file)) {
            const merged = { ...current, prepared_audio_file: latest.prepared_audio_file, vocals_stem_file: latest.vocals_stem_file, accompaniment_stem_file: latest.accompaniment_stem_file };
            projectRef.current = merged;
            setProject(merged);
          }
        }
        if (!(["queued", "running"] as const).includes(status.state as "queued" | "running")) {
          window.clearInterval(pollTimer);
          pollTimer = undefined;
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось получить состояние обработки аудио.");
      }
    };
    setAudioOperation(null);
    projectsApi.ffmpegStatus().then((status) => { if (active) setFfmpegStatus(status); })
      .catch((reason: unknown) => { if (active) setFfmpegStatus({ available: false, version: null, message: reason instanceof Error ? reason.message : "Не удалось проверить FFmpeg." }); });
    void refreshStatus();
    pollTimer = window.setInterval(() => void refreshStatus(), 1000);
    return () => { active = false; window.clearInterval(pollTimer); };
  }, [canPublish, project?.id]);

  useEffect(() => {
    if (!canPublish || !project?.id || project.prepared_audio_file || audioOperation && audioOperation.state !== "idle") return;
    if (autoPrepareProjectRef.current === project.id) return;
    autoPrepareProjectRef.current = project.id;
    let active = true;
    projectsApi.prepareAudio(project.id).then((operation) => {
      if (active) setAudioOperation(operation);
    }).catch((reason: unknown) => {
      if (active) setAudioOperation({
        state: "failed",
        progress: 0,
        output_file: null,
        message: reason instanceof Error ? `Автоподготовка не запустилась: ${reason.message}` : "Автоподготовка аудио не запустилась.",
      });
    });
    return () => { active = false; };
  }, [audioOperation?.state, canPublish, project?.id, project?.prepared_audio_file]);

  useEffect(() => {
    if (!canPublish || !project?.id) return;
    let active = true;
    let pollTimer: number | undefined;
    const refresh = async () => {
      try {
        const [status, operation] = await Promise.all([projectsApi.demucsStatus(), projectsApi.stemsStatus(project.id)]);
        if (!active) return;
        setDemucsStatus(status);
        const activeOperation = status.install && ["queued", "running"].includes(status.install.state) ? status.install : operation;
        setStemsOperation(activeOperation);
        if (operation.state === "completed") {
          const latest = await projectsApi.get(project.id);
          if (!active) return;
          const current = projectRef.current;
          if (current?.id === latest.id && (current.vocals_stem_file !== latest.vocals_stem_file || current.accompaniment_stem_file !== latest.accompaniment_stem_file)) {
            const merged = { ...current, vocals_stem_file: latest.vocals_stem_file, accompaniment_stem_file: latest.accompaniment_stem_file };
            projectRef.current = merged;
            setProject(merged);
          }
        }
        if (!( ["queued", "running"] as const).includes(activeOperation.state as "queued" | "running")) {
          window.clearInterval(pollTimer);
          pollTimer = undefined;
        }
      } catch (reason) {
        if (active) setDemucsStatus({ available: false, version: null, torch_version: null, cuda_available: false, model_cached: false, message: reason instanceof Error ? reason.message : "Не удалось проверить Demucs." });
      }
    };
    setStemsOperation(null);
    void refresh();
    pollTimer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(pollTimer); };
  }, [canPublish, project?.id]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [muted, videoUrl, volume]);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === videoStageRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    const timeline = timelineScrollRef.current;
    if (!timeline || mode !== "editor" || !playing) return;
    const playheadX = Math.min(1, currentMs / effectiveDuration) * timeline.scrollWidth;
    if (playheadX < timeline.scrollLeft || playheadX > timeline.scrollLeft + timeline.clientWidth) {
      timeline.scrollLeft = Math.max(0, playheadX - timeline.clientWidth * 0.15);
    }
  }, [currentMs, effectiveDuration, mode, playing, zoom]);

  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (projectRef.current) void projectsApi.save(projectRef.current).catch(() => undefined);
  }, []);

  const updateProject = (mutate: (draft: SceneProject) => SceneProject, autosave = true) => {
    if (!project) return;
    const next = mutate({ ...project, characters: [...project.characters], lines: [...project.lines] });
    setProject(next); projectRef.current = next; onProjectChange(next);
    if (!autosave) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void projectsApi.save(next).then((saved) => {
        setProject(saved); projectRef.current = saved;
        setProjects((items) => items.map((item) => item.id === saved.id ? saved : item));
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось сохранить проект."));
    }, 700);
  };

  const importVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true); setError("");
    try {
      const created = await projectsApi.upload(file);
      setProjects((items) => [created, ...items]);
      showProject(created); setVideoUrl(projectsApi.videoUrl(created.id));
      onNotice(`Проект «${created.title}» создан.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось импортировать видео."); }
    finally { setBusy(false); }
  };

  const saveNow = async () => {
    if (!project) return;
    window.clearTimeout(saveTimer.current);
    setBusy(true);
    try { const saved = await projectsApi.save(project); setProject(saved); setProjects((items) => items.map((item) => item.id === saved.id ? saved : item)); onNotice("Проект сохранён."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить проект."); }
    finally { setBusy(false); }
  };

  const prepareAudio = async () => {
    if (!project) return;
    setAudioBusy(true);
    try { setAudioOperation(await projectsApi.prepareAudio(project.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось запустить подготовку аудио."); }
    finally { setAudioBusy(false); }
  };

  const cancelAudio = async () => {
    if (!project) return;
    setAudioBusy(true);
    try { setAudioOperation(await projectsApi.cancelAudio(project.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отменить обработку аудио."); }
    finally { setAudioBusy(false); }
  };

  const installDemucs = async () => {
    setStemsBusy(true);
    try { setStemsOperation(await projectsApi.installDemucs()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось запустить установку Demucs."); }
    finally { setStemsBusy(false); }
  };

  const cancelDemucsInstall = async () => {
    setStemsBusy(true);
    try { setStemsOperation(await projectsApi.cancelDemucsInstall()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отменить установку Demucs."); }
    finally { setStemsBusy(false); }
  };

  const separateStems = async () => {
    if (!project) return;
    setStemsBusy(true);
    try { setStemsOperation(await projectsApi.separateStems(project.id, stemDevice)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось запустить разделение стемов."); }
    finally { setStemsBusy(false); }
  };

  const cancelStems = async () => {
    if (!project) return;
    setStemsBusy(true);
    try { setStemsOperation(await projectsApi.cancelStems(project.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отменить разделение стемов."); }
    finally { setStemsBusy(false); }
  };

  const onVideoMetadata = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const nextDuration = Math.round(video.duration * 1000);
    setDurationMs(nextDuration);
    if (project && project.duration_ms !== nextDuration) updateProject((draft) => ({ ...draft, duration_ms: nextDuration, lines: draft.lines.map((line) => {
      const end = Math.min(line.end_ms, nextDuration);
      const start = Math.min(line.start_ms, Math.max(0, end - 10));
      return { ...line, start_ms: start, end_ms: Math.max(start + 10, end) };
    }) }));
  };

  const seek = (ms: number) => {
    setCurrentMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setError("Не удалось запустить воспроизведение видео."));
    else video.pause();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || typing) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const position = (videoRef.current?.currentTime ?? currentMs / 1000) * 1000;
        seek(Math.max(0, Math.min(effectiveDuration, position + (event.key === "ArrowRight" ? 1000 : -1000))));
      } else if (event.key === "Delete" && selectedLineId) {
        event.preventDefault();
        deleteSelectedLine();
      } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && selectedLineId) {
        event.preventDefault();
        moveSelectedLineLane(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [effectiveDuration, selectedLineId, selectedLine, project, lineLanes]);

  const snappedTimelineTime = (clientX: number) => {
    const timeline = timelineInnerRef.current;
    if (!timeline) return currentMs;
    const bounds = timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return Math.max(0, Math.min(effectiveDuration, Math.round(ratio * effectiveDuration / 500) * 500));
  };

  const timelinePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".dialogue-block")) return;
    const scrub = Boolean((event.target as HTMLElement).closest(".timeline-playhead"));
    timelineGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: event.currentTarget.scrollLeft, mode: scrub ? "scrub" : "pending" };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (scrub) {
      seek(snappedTimelineTime(event.clientX));
    }
  };

  const timelinePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "scrub") {
      seek(snappedTimelineTime(event.clientX));
      return;
    }
    const delta = event.clientX - gesture.startX;
    if (gesture.mode === "pending" && Math.abs(delta) > 4) {
      gesture.mode = "pan";
      setTimelinePanning(true);
    }
    if (gesture.mode === "pan") event.currentTarget.scrollLeft = gesture.scrollLeft - delta;
  };

  const timelinePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "pending") seek(snappedTimelineTime(event.clientX));
    timelineGestureRef.current = null;
    setTimelinePanning(false);
  };

  const changeZoomAtPointer = (event: WheelEvent<HTMLDivElement>, nextZoom: number) => {
    const scroll = timelineScrollRef.current;
    const inner = timelineInnerRef.current;
    if (!scroll || !inner || nextZoom === zoom) return;
    const bounds = inner.getBoundingClientRect();
    const scrollBounds = scroll.getBoundingClientRect();
    const cursorViewportX = event.clientX - scrollBounds.left;
    const timeRatio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / inner.offsetWidth));
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const nextInner = timelineInnerRef.current;
      if (!nextInner) return;
      const nextCursorX = timeRatio * nextInner.offsetWidth;
      scroll.scrollLeft = Math.max(0, nextCursorX - cursorViewportX);
    });
  };

  const timelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.currentTarget.scrollLeft += event.deltaX;
      return;
    }
    if (Math.abs(event.deltaY) < 1) return;
    const nextZoom = Math.max(1, Math.min(8, zoom + (event.deltaY < 0 ? 1 : -1)));
    changeZoomAtPointer(event, nextZoom);
  };

  const addCharacter = () => {
    const name = newCharacter.trim();
    if (!name || !project) return;
    const character: Character = { id: makeId("character"), name, color: COLORS[project.characters.length % COLORS.length] };
    updateProject((draft) => ({ ...draft, characters: [...draft.characters, character] }));
    setNewCharacter("");
  };

  const addLine = () => {
    if (!project) return;
    const start = Math.min(currentMs, Math.max(0, effectiveDuration - 1000));
    const line: DialogueLine = { id: makeId("line"), character_id: project.characters[0]?.id ?? null, text: "Новая реплика", start_ms: start, end_ms: Math.min(effectiveDuration, start + 3000), lane: 0 };
    updateProject((draft) => ({ ...draft, lines: [...draft.lines, line] }));
    setSelectedLineId(line.id);
  };

  const editLine = (changes: Partial<DialogueLine>) => {
    if (!selectedLine) return;
    updateProject((draft) => ({ ...draft, lines: draft.lines.map((line) => line.id === selectedLine.id ? { ...line, ...changes } : line) }));
  };

  const deleteLine = () => {
    if (!selectedLine) return;
    updateProject((draft) => ({ ...draft, lines: draft.lines.filter((line) => line.id !== selectedLine.id) }));
    setSelectedLineId(null);
  };

  const deleteSelectedLine = () => {
    if (!selectedLineId) return;
    updateProject((draft) => ({ ...draft, lines: draft.lines.filter((line) => line.id !== selectedLineId) }));
    setSelectedLineId(null);
  };

  const moveSelectedLineLane = (delta: -1 | 1) => {
    if (!selectedLine || !project) return;
    const currentLane = lineLanes.lanes.get(selectedLine.id) ?? 0;
    let nextLane = Math.max(0, currentLane + delta);
    const overlapsOnLane = (lane: number) => project.lines.some((line) => line.id !== selectedLine.id
      && (lineLanes.lanes.get(line.id) ?? 0) === lane
      && selectedLine.start_ms < line.end_ms && selectedLine.end_ms > line.start_ms);
    while (nextLane <= 5000 && overlapsOnLane(nextLane)) nextLane += delta;
    if (nextLane < 0 || nextLane > 5000 || nextLane === currentLane) return;
    updateProject((draft) => ({ ...draft, lines: draft.lines.map((line) => line.id === selectedLine.id ? { ...line, lane: nextLane } : line) }));
  };

  const deleteCharacter = (id: string) => updateProject((draft) => ({ ...draft, characters: draft.characters.filter((character) => character.id !== id), lines: draft.lines.map((line) => line.character_id === id ? { ...line, character_id: null } : line) }));

  const startLineDrag = (event: PointerEvent<HTMLButtonElement>, line: DialogueLine) => {
    event.stopPropagation();
    const edge = (event.target as HTMLElement).dataset.edge;
    dragRef.current = { id: line.id, edge: edge === "start" || edge === "end" ? edge : "move", originX: event.clientX, start: line.start_ms, end: line.end_ms };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedLineId(line.id);
  };

  const moveLineDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const track = event.currentTarget.parentElement;
    if (!drag || !track || !project) return;
    const rect = track.getBoundingClientRect();
    const delta = Math.round((event.clientX - drag.originX) / rect.width * effectiveDuration / 10) * 10;
    const targetLine = project.lines.find((line) => line.id === drag.id);
    const currentLane = targetLine ? lineLanes.lanes.get(targetLine.id) ?? 0 : 0;
    const updateLane = (start_ms: number, end_ms: number) => {
      const occupied = project.lines.filter((line) => line.id !== drag.id).map((line) => ({ line, lane: lineLanes.lanes.get(line.id) ?? 0 }));
      let lane = currentLane;
      const conflicts = () => occupied.some(({ line, lane: otherLane }) => lane === otherLane && start_ms < line.end_ms && end_ms > line.start_ms);
      while (conflicts() && lane < 5000) lane += 1;
      if (conflicts()) { lane = 0; while (conflicts() && lane < 5000) lane += 1; }
      return lane;
    };
    updateProject((draft) => ({ ...draft, lines: draft.lines.map((line) => {
      if (line.id !== drag.id) return line;
      if (drag.edge === "move") {
        const length = drag.end - drag.start;
        const start = Math.max(0, Math.min(effectiveDuration - length, drag.start + delta));
        const end = start + length;
        return { ...line, start_ms: start, end_ms: end, lane: updateLane(start, end) };
      }
      if (drag.edge === "start") {
        const start = Math.max(0, Math.min(drag.end - 10, drag.start + delta));
        return { ...line, start_ms: start, lane: updateLane(start, line.end_ms) };
      }
      const end = Math.min(effectiveDuration, Math.max(drag.start + 10, drag.end + delta));
      return { ...line, end_ms: end, lane: updateLane(line.start_ms, end) };
    }) }));
  };

  if (!canPublish) return <section className="editor-page"><header className="editor-toolbar"><div><div className="editor-kicker"><Film size={14} /> ПРОЕКТ КОМНАТЫ</div><h2>{activeProjectId ? "Проект хоста" : "Проект фильма"}</h2><p>Редактирование доступно хосту на компьютере с исходным видео.</p></div></header><div className="project-empty shared-project"><Film size={34} /><h3>{activeProjectId ? "Проект выбран" : "Хост ещё не выбрал проект"}</h3><p>Подготовленный фильм и разметка появятся здесь после реализации передачи проекта участникам.</p></div></section>;

  return <section className="editor-page">
    <header className="editor-toolbar"><div className="editor-heading"><div className="editor-kicker"><Film size={14} /> {mode === "view" ? "ПРОСМОТР СЦЕНЫ" : "РЕДАКТОР СЦЕН"}</div>{project ? <>{mode === "editor" ? <input className="project-title-input" aria-label="Название проекта" maxLength={120} defaultValue={project.title} key={project.id} onBlur={(event) => { const title = event.target.value.trim(); if (title && title !== project.title) updateProject((draft) => ({ ...draft, title })); else event.target.value = project.title; }} /> : <h2>{project.title}</h2>}<p>{project.video_name}</p></> : <><h2>Проекты фильмов</h2><p>Импортируйте видео, чтобы начать разметку</p></>}</div><div className="editor-actions">{projects.length > 0 && <select className="project-picker" aria-label="Выбрать проект" value={project?.id ?? ""} onChange={(event) => { if (event.target.value) void loadProject(event.target.value); else showProject(null); }}><option value="">Выбрать проект</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}{mode === "editor" && <label className="secondary-button file-button"><Upload size={15} />Импортировать видео<input type="file" accept="video/*,.mkv" onChange={importVideo} hidden /></label>}{project && mode === "editor" && <button className="primary-button" disabled={busy} onClick={() => void saveNow()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Сохранить</button>}</div></header>
    {error && <div className="editor-error"><X size={15} />{error}</div>}
    {!project ? activeProjectId && !canPublish ? <div className="project-empty shared-project"><Film size={34} /><h3>Проект комнаты</h3><p>Редактор и исходное видео доступны на компьютере хоста. Передача проекта участникам появится на следующем этапе.</p></div> : <div className="project-empty"><FolderOpen size={34} /><h3>Создайте проект фильма</h3><p>Выберите локальный видеофайл. Метаданные и разметка сохраняются на компьютере хоста.</p><label className="primary-button file-button"><Upload size={16} />Выбрать видео<input type="file" accept="video/*,.mkv" onChange={importVideo} hidden /></label><div className="project-list">{projects.map((item) => <button className="project-card" key={item.id} onClick={() => void loadProject(item.id)}><Film size={17} /><span><strong>{item.title}</strong><small>{item.video_name} · {item.lines.length} реплик</small></span></button>)}</div></div> : <div className="editor-content">
      {mode === "view" && <div className="version-switch" role="tablist" aria-label="Версия сцены"><button role="tab" aria-selected={previewVersion === "original"} className={previewVersion === "original" ? "active" : ""} onClick={() => setPreviewVersion("original")}>Оригинал</button><button role="tab" aria-selected={previewVersion === "redub"} className={previewVersion === "redub" ? "active" : ""} onClick={() => setPreviewVersion("redub")}>Переозвученная версия</button></div>}
      <div className="video-stage" ref={videoStageRef}><video ref={videoRef} src={videoUrl} onLoadedMetadata={() => { setVideoError(""); onVideoMetadata(); }} onError={() => {
        const code = videoRef.current?.error?.code;
        setVideoError(code === MediaError.MEDIA_ERR_NETWORK
          ? "Не удалось загрузить видео с локального сервера. Проверьте, что backend работает: в окне run-dubparty.cmd введите status."
          : code === MediaError.MEDIA_ERR_DECODE
            ? "Браузер получил видео, но не смог его декодировать. Попробуйте MP4 с кодеком H.264."
            : "Этот формат или кодек не поддерживается браузером. Попробуйте MP4 с кодеком H.264.");
      }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={() => setCurrentMs(Math.round((videoRef.current?.currentTime ?? 0) * 1000))} />{videoError && <div className="video-error">{videoError}</div>}</div>
      <div className="transport"><button className="icon-button transport-button" title={playing ? "Пауза" : "Воспроизвести"} aria-label={playing ? "Пауза" : "Воспроизвести"} onClick={togglePlayback}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><span className="timecode">{formatPreciseTime(currentMs)} / {formatPreciseTime(effectiveDuration)}</span><input className="seek-slider" aria-label="Позиция видео" type="range" min={0} max={effectiveDuration} step={500} value={Math.min(currentMs, effectiveDuration)} onChange={(event) => seek(Number(event.target.value))} /><button className="icon-button transport-button volume-button" title={muted || volume === 0 ? "Включить звук" : "Выключить звук"} aria-label={muted || volume === 0 ? "Включить звук" : "Выключить звук"} onClick={() => setMuted((value) => !value)}>{muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><input className="volume-slider" aria-label="Громкость" title="Громкость" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(event) => { const next = Number(event.target.value); setVolume(next); setMuted(next === 0); }} /><button className="icon-button transport-button" title={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"} aria-label={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"} onClick={() => { const stage = videoStageRef.current; if (!stage) return; if (document.fullscreenElement) void document.exitFullscreen(); else void stage.requestFullscreen().catch(() => setError("Не удалось открыть видео на весь экран.")); }}>{fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</button></div>
      {project && <div className="audio-preparation"><div className="audio-preparation-main"><div><div className="audio-preparation-title">ПОДГОТОВКА АУДИО</div><p>{audioOperation?.message ?? ffmpegStatus?.message ?? "Проверка FFmpeg…"}</p>{ffmpegStatus?.available && <small>{ffmpegStatus.version}</small>}</div><div className="audio-preparation-actions">{audioOperation?.state === "queued" || audioOperation?.state === "running" ? <button className="secondary-button compact-button" disabled={audioBusy} onClick={() => void cancelAudio()}><X size={14} />Отменить</button> : <button className="secondary-button compact-button" disabled={audioBusy || !project || !ffmpegStatus?.available} onClick={() => void prepareAudio()}>{audioBusy ? <LoaderCircle className="spin" size={14} /> : <Film size={14} />}{audioOperation?.state === "completed" ? "Подготовить заново" : audioOperation?.state === "failed" ? "Повторить" : "Извлечь аудио"}</button>}</div></div>{audioOperation && ["queued", "running", "completed"].includes(audioOperation.state) && <div className="audio-progress-track" role="progressbar" aria-label="Подготовка аудио" aria-valuemin={0} aria-valuemax={100} aria-valuenow={audioOperation.progress}><span style={{ width: `${audioOperation.progress}%` }} /></div>}{audioOperation?.state === "completed" && audioOperation.output_file && <a className="audio-output-link" href={projectsApi.preparedAudioUrl(project.id)} download>Скачать подготовленный WAV</a>}</div>}
      {mode === "editor" && <div className="audio-preparation stems-preparation">
        <div className="audio-preparation-main">
          <div>
            <div className="audio-preparation-title">РАЗДЕЛЕНИЕ НА СТЕМЫ</div>
            <p>{stemsMessage}</p>
            {demucsStatus?.available && <small>Demucs {demucsStatus.version} · PyTorch {demucsStatus.torch_version} · {demucsStatus.cuda_available ? "CUDA доступна" : "только CPU"}</small>}
          </div>
          <div className="audio-preparation-actions">
            {stemsOperation?.state === "queued" || stemsOperation?.state === "running" ? <button className="secondary-button compact-button" disabled={stemsBusy} onClick={() => void (installingDemucs ? cancelDemucsInstall() : cancelStems())}><X size={14} />Отменить</button>
              : demucsStatus?.available ? <>
                {project?.prepared_audio_file && <select className="stem-device-select" aria-label="Устройство обработки" value={stemDevice} onChange={(event) => setStemDevice(event.target.value as "auto" | "cpu" | "cuda")}><option value="auto">Авто</option><option value="cpu">CPU</option><option value="cuda" disabled={!demucsStatus.cuda_available}>CUDA</option></select>}
                <button className="secondary-button compact-button" disabled={stemsBusy || audioBusy || !project || !project.prepared_audio_file && audioPreparing} title={!project?.prepared_audio_file && audioPreparing ? "Подготовка WAV ещё выполняется" : undefined} onClick={() => void (project?.prepared_audio_file ? separateStems() : prepareAudio())}>
                  {stemsBusy || audioBusy || !project?.prepared_audio_file && audioPreparing ? <LoaderCircle className="spin" size={14} /> : <Film size={14} />}
                  {!project?.prepared_audio_file ? audioPreparing ? "Готовим аудио…" : audioOperation?.state === "failed" ? "Повторить подготовку" : "Подготовить аудио" : stemsOperation?.state === "completed" ? "Повторить разделение" : "Разделить аудио"}
                </button>
              </> : <button className="secondary-button compact-button" disabled={stemsBusy} onClick={() => void installDemucs()}>{stemsBusy ? <LoaderCircle className="spin" size={14} /> : <Film size={14} />}Установить Demucs</button>}
          </div>
        </div>
        {stemsOperation && ["queued", "running", "completed"].includes(stemsOperation.state) && <div className="audio-progress-track" role="progressbar" aria-label="Разделение стемов" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stemsOperation.progress}><span style={{ width: `${stemsOperation.progress}%` }} /></div>}
        {stemsOperation?.state === "completed" && project && <div className="stem-previews"><label>Голосовой стем<audio controls preload="none" src={projectsApi.stemUrl(project.id, "vocals")} /><a className="audio-output-link" href={projectsApi.stemUrl(project.id, "vocals")} download>Скачать</a></label><label>Фоновый стем<audio controls preload="none" src={projectsApi.stemUrl(project.id, "accompaniment")} /><a className="audio-output-link" href={projectsApi.stemUrl(project.id, "accompaniment")} download>Скачать</a></label></div>}
        <small className="audio-note">Demucs разделяет вокал/голос и остальное аудио, но не выделяет отдельных персонажей.</small>
      </div>}
      {mode === "editor" && <><div className="timeline-panel"><div className="timeline-head"><span>ТАЙМЛАЙН РЕПЛИК</span><div className="timeline-tools"><label>Масштаб <input aria-label="Масштаб таймлайна" type="range" min={1} max={8} step={1} value={zoom} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setZoom(Number(event.target.value))} /><span>{zoom}×</span></label><button className="secondary-button compact-button" onClick={addLine}><Plus size={14} />Добавить реплику</button></div></div><div className={`timeline-scroll ${timelinePanning ? "panning" : ""}`} ref={timelineScrollRef} onWheel={timelineWheel} onPointerDown={timelinePointerDown} onPointerMove={timelinePointerMove} onPointerUp={timelinePointerUp} onPointerCancel={timelinePointerUp}><div className="timeline-inner" ref={timelineInnerRef} style={{ width: `${zoom * 100}%`, "--second-width": `${100000 / effectiveDuration}%`, "--five-second-width": `${500000 / effectiveDuration}%`, "--half-second-width": `${50000 / effectiveDuration}%` } as React.CSSProperties}><div className="timeline-ruler">{rulerLabels.map((second) => <span className="ruler-label" key={second} style={{ left: `${second * 1000 / effectiveDuration * 100}%` }}>{formatTime(second * 1000)}</span>)}</div><div className="timeline-track" style={{ height: `${Math.max(144, lineLanes.count * 34 + 16)}px` }}><div className="timeline-playhead" style={{ left: `${Math.min(100, currentMs / effectiveDuration * 100)}%` }} />{sortedLines.map((line) => { const character = project.characters.find((item) => item.id === line.character_id); return <button className={`dialogue-block ${selectedLineId === line.id ? "selected" : ""}`} key={line.id} style={{ top: `${8 + (lineLanes.lanes.get(line.id) ?? 0) * 34}px`, left: `${line.start_ms / effectiveDuration * 100}%`, width: `${Math.max(1.5, (line.end_ms - line.start_ms) / effectiveDuration * 100)}%`, borderColor: character?.color ?? "#888" }} onPointerDown={(event) => startLineDrag(event, line)} onPointerMove={moveLineDrag} onPointerUp={() => { dragRef.current = null; }} onClick={() => { setSelectedLineId(line.id); seek(line.start_ms); }}><span>{character?.name ?? "Без роли"}</span><small>{formatTime(line.start_ms)}</small><i className="line-handle line-handle-start" data-edge="start" /><i className="line-handle line-handle-end" data-edge="end" /></button>; })}</div></div></div></div>
      <div className="editor-lower"><aside className="characters-panel"><div className="panel-title"><span>ПЕРСОНАЖИ</span><UserRound size={14} /></div><div className="character-add"><input placeholder="Имя персонажа" value={newCharacter} onChange={(event) => setNewCharacter(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addCharacter(); }} /><button className="icon-button tiny" title="Добавить персонажа" onClick={addCharacter}><Plus size={15} /></button></div>{project.characters.map((character) => <div className="character-row" key={character.id}><input className="character-color" aria-label={`Цвет персонажа ${character.name}`} type="color" value={character.color} onChange={(event) => updateProject((draft) => ({ ...draft, characters: draft.characters.map((item) => item.id === character.id ? { ...item, color: event.target.value } : item) }))} /><input value={character.name} onChange={(event) => updateProject((draft) => ({ ...draft, characters: draft.characters.map((item) => item.id === character.id ? { ...item, name: event.target.value } : item) }))} /><button className="icon-button tiny" title="Удалить персонажа" onClick={() => deleteCharacter(character.id)}><Trash2 size={14} /></button></div>)}</aside><aside className="line-properties"><div className="panel-title"><span>СВОЙСТВА РЕПЛИКИ</span>{selectedLine && <button className="icon-button tiny" title="Удалить реплику" onClick={deleteLine}><Trash2 size={14} /></button>}</div>{selectedLine ? <div className="property-form"><label>Персонаж<select value={selectedLine.character_id ?? ""} onChange={(event) => editLine({ character_id: event.target.value || null })}><option value="">Без роли</option>{project.characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label><label>Текст реплики<textarea value={selectedLine.text} onChange={(event) => editLine({ text: event.target.value})} /></label><div className="property-grid"><label>Начало, мс<input type="number" min={0} max={Math.max(0, selectedLine.end_ms - 10)} value={selectedLine.start_ms} onChange={(event) => editLine({ start_ms: Math.min(Number(event.target.value), selectedLine.end_ms - 10) })} /></label><label>Конец, мс<input type="number" min={selectedLine.start_ms + 10} max={effectiveDuration} value={selectedLine.end_ms} onChange={(event) => editLine({ end_ms: Math.max(Number(event.target.value), selectedLine.start_ms + 10) })} /></label></div><div className="property-time">Длительность: {formatTime(selectedLine.end_ms - selectedLine.start_ms)}</div></div> : <div className="no-selection">Выберите блок на таймлайне</div>}</aside></div></>}
    </div>}
  </section>;
}
