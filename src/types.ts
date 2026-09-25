export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
}

export type FieldDiffKind = 'project' | 'scene' | 'cue' | 'cue-order'

export interface FieldDiff {
  kind: FieldDiffKind
  sceneId?: string
  cueId?: string
  field?: string
  before: unknown
  after: unknown
}

export interface StructuralOp {
  type: 'add-cue' | 'delete-cue' | 'add-scene' | 'delete-scene'
  sceneId?: string
  cueId?: string
  index: number
  snapshot?: unknown
}

export interface ChangeScope {
  project: boolean
  sceneIds: string[]
  cueIds: string[]
}

export interface PendingChange {
  id: string
  label: string
  note: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  scope: ChangeScope
  diffs: FieldDiff[]
  ops: StructuralOp[]
  acceptedAt?: string
  rejectedAt?: string
  frozenInVersionId?: string
}

export interface SnapshotCheck {
  id: string
  type: WarningItem['type']
  level: WarningItem['level']
  sceneCode: string
  title: string
  detail: string
}

export interface SnapshotChange {
  id: string
  label: string
  note: string
  createdAt: string
  acceptedAt: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  script: string
  totalDuration: number
  acceptedChanges: SnapshotChange[]
  checks: SnapshotCheck[]
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}
