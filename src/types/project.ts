export interface Character {
  id: string;
  name: string;
  color: string;
}

export interface DialogueLine {
  id: string;
  character_id: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  lane?: number;
}

export interface SceneProject {
  id: string;
  title: string;
  video_name: string;
  video_file: string;
  duration_ms: number;
  characters: Character[];
  lines: DialogueLine[];
  prepared_audio_file: string | null;
  vocals_stem_file: string | null;
  accompaniment_stem_file: string | null;
  created_at: string;
  updated_at: string;
}
