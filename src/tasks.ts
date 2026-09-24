// 依任務類型與專案類型查步驟表（純函式）。
import { PROJECT_OVERRIDES, TASKS, TASK_IDS, type ProjectKind, type StageId, type TaskId } from './stages.ts'

export type StageDef = { id: StageId; label: string }

export const isTaskId = (v: unknown): v is TaskId => typeof v === 'string' && (TASK_IDS as readonly string[]).includes(v)

/** 某任務在某專案類型下的步驟（已套用 override：改標籤、省略步驟）。 */
export function stagesFor(task: TaskId, project: ProjectKind): StageDef[] {
  const o = PROJECT_OVERRIDES[project]
  const omit = o.omit?.[task] ?? []
  const labels = o.labels?.[task] ?? {}
  return TASKS[task].stages.filter(s => !omit.includes(s.id)).map(s => ({ id: s.id, label: labels[s.id] ?? s.label }))
}

export const hasStage = (task: TaskId, stage: string, project: ProjectKind): boolean =>
  stagesFor(task, project).some(s => s.id === stage)

/** 含有此 stage 的任務（考慮專案 override）。 */
export const tasksWithStage = (stage: string, project: ProjectKind): TaskId[] => TASK_IDS.filter(t => hasStage(t, stage, project))

export const stageIds = (task: TaskId, project: ProjectKind): string[] => stagesFor(task, project).map(s => s.id)
