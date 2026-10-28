import { useState, type ChangeEvent } from "react";
import { Film, LoaderCircle, Upload, X } from "lucide-react";
import "./CreateProjectDialog.css";
import { projectsApi } from "../../services/projects";
import type { SceneProject } from "../../types/project";

interface CreateProjectDialogProps {
  onClose: () => void;
  onCreated: (project: SceneProject) => void;
}

export default function CreateProjectDialog({ onClose, onCreated }: CreateProjectDialogProps) {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;
    setFile(next);
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
  };

  const create = async () => {
    if (!title.trim()) { setError("Введите название проекта."); return; }
    if (!file) { setError("Выберите видеофайл."); return; }
    setBusy(true); setError("");
    try { onCreated(await projectsApi.upload(file, title.trim())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать проект."); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="create-project-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
      <header><div className="entry-kicker"><Film size={15} /> НОВАЯ ПРОЕКТ-КОМНАТА</div><button className="icon-button" title="Закрыть" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <h2 id="create-project-title">Создать проект фильма</h2>
      <label className="field-label" htmlFor="project-name">Название</label>
      <input id="project-name" className="text-input" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Вечерний дубляж" autoFocus />
      <label className="field-label" htmlFor="project-video">Видеофайл</label>
      <label className="project-file-picker" htmlFor="project-video"><Upload size={17} /><span>{file?.name ?? "Выбрать видеофайл"}</span><input id="project-video" type="file" accept="video/*,.mkv" onChange={chooseFile} /></label>
      {error && <div className="editor-error"><X size={14} />{error}</div>}
      <footer><button className="secondary-button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => void create()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Film size={15} />}Создать комнату</button></footer>
    </section>
  </div>;
}
