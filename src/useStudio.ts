import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { Cue, CueKind, FrozenVersion, PendingChange, Scene, StudioDocument, StudioState, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const PROJECT_SCOPE = '__project__'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Scenes (or project-level data) touched by a change, derived from its before/after snapshots. */
function changeScope(change: PendingChange): Set<string> {
  const scope = new Set<string>()
  const beforeScenes = new Map(change.before.scenes.map((scene) => [scene.id, scene]))
  const afterScenes = new Map(change.after.scenes.map((scene) => [scene.id, scene]))
  for (const [id, scene] of beforeScenes) {
    const after = afterScenes.get(id)
    if (!after || !same(scene, after)) scope.add(id)
  }
  for (const id of afterScenes.keys()) {
    if (!beforeScenes.has(id)) scope.add(id)
  }
  const orderChanged = change.before.scenes.map((scene) => scene.id).join('\0') !== change.after.scenes.map((scene) => scene.id).join('\0')
  if (
    orderChanged ||
    change.before.title !== change.after.title ||
    change.before.subtitle !== change.after.subtitle ||
    change.before.targetDuration !== change.after.targetDuration ||
    !same(change.before.characters, change.after.characters) ||
    !same(change.before.soundEffects, change.after.soundEffects)
  ) {
    scope.add(PROJECT_SCOPE)
  }
  return scope
}

/** Human-readable labels for everything a change touches, used in confirmation dialogs. */
function sceneCodesOf(change: PendingChange): string[] {
  const labels: string[] = []
  for (const id of changeScope(change)) {
    if (id === PROJECT_SCOPE) {
      labels.push('项目设置')
      continue
    }
    const scene = change.after.scenes.find((item) => item.id === id) ?? change.before.scenes.find((item) => item.id === id)
    labels.push(scene ? `${scene.code} ${scene.title}` : '已删除场次')
  }
  return labels
}

/** Restore only the fields that differ between before and after, leaving later edits to other fields intact. */
function revertFields<T extends object>(current: T, before: T, after: T): T {
  const next = { ...current }
  for (const key of Object.keys(before) as Array<keyof T>) {
    if (!same(before[key], after[key])) next[key] = before[key]
  }
  return next
}

/** Rebuild `current` so items listed in `referenceOrder` keep that relative order; other items stay in place. */
function restoreRelativeOrder<T extends { id: string }>(current: T[], referenceOrder: string[]): T[] {
  const referenced = new Set(referenceOrder)
  const queue = referenceOrder.map((id) => current.find((item) => item.id === id)).filter((item): item is T => Boolean(item))
  const result: T[] = []
  let index = 0
  for (const item of current) {
    if (referenced.has(item.id) && index < queue.length) result.push(queue[index++])
    else result.push(item)
  }
  while (index < queue.length) result.push(queue[index++])
  return result
}

/**
 * Undo one change's effect on a list of entities (scenes, cues, characters, sound effects):
 * remove what it added, re-insert what it removed, revert the fields it touched and
 * restore the relative order it changed — without disturbing other records' edits.
 */
function revertEntityList<T extends { id: string }>(
  current: T[],
  before: T[],
  after: T[],
  revertItem: (current: T, before: T, after: T) => T
): T[] {
  const beforeMap = new Map(before.map((item) => [item.id, item]))
  const afterMap = new Map(after.map((item) => [item.id, item]))
  let list = current.filter((item) => beforeMap.has(item.id) || !afterMap.has(item.id))
  list = list.map((item) => {
    const beforeItem = beforeMap.get(item.id)
    const afterItem = afterMap.get(item.id)
    if (!beforeItem || !afterItem || same(beforeItem, afterItem)) return item
    return revertItem(item, beforeItem, afterItem)
  })
  before.forEach((beforeItem, index) => {
    if (!afterMap.has(beforeItem.id) && !list.some((item) => item.id === beforeItem.id)) {
      list.splice(Math.min(index, list.length), 0, clone(beforeItem))
    }
  })
  const sharedBefore = before.filter((item) => afterMap.has(item.id)).map((item) => item.id)
  const sharedAfter = after.filter((item) => beforeMap.has(item.id)).map((item) => item.id)
  if (sharedBefore.join('\0') !== sharedAfter.join('\0')) {
    list = restoreRelativeOrder(list, before.map((item) => item.id))
  }
  return list
}

function revertScene(current: Scene, before: Scene, after: Scene): Scene {
  const next: Scene = { ...current, cues: revertEntityList(current.cues, before.cues, after.cues, revertFields) }
  if (before.code !== after.code) next.code = before.code
  if (before.title !== after.title) next.title = before.title
  if (before.location !== after.location) next.location = before.location
  if (before.timeOfDay !== after.timeOfDay) next.timeOfDay = before.timeOfDay
  if (before.transition !== after.transition) next.transition = before.transition
  if (before.durationLimit !== after.durationLimit) next.durationLimit = before.durationLimit
  return next
}

/** Apply the inverse of a single change to the document, leaving every other change in place. */
function applyInverse(change: PendingChange, document: StudioDocument) {
  const { before, after } = change
  if (before.title !== after.title) document.title = before.title
  if (before.subtitle !== after.subtitle) document.subtitle = before.subtitle
  if (before.targetDuration !== after.targetDuration) document.targetDuration = before.targetDuration
  document.characters = revertEntityList(document.characters, before.characters, after.characters, revertFields)
  document.soundEffects = revertEntityList(document.soundEffects, before.soundEffects, after.soundEffects, revertFields)
  document.scenes = revertEntityList(document.scenes, before.scenes, after.scenes, revertScene)
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // Versions frozen before the snapshot manifest existed get empty defaults.
        parsed.frozen = (parsed.frozen ?? []).map((version) => ({
          ...version,
          acceptedChanges: version.acceptedChanges ?? [],
          checks: version.checks ?? [],
          script: version.script ?? ''
        }))
        parsed.pending = parsed.pending ?? []
        return parsed
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    updatedAt: new Date().toISOString()
  }
}

export function useStudio() {
  const state = ref<StudioState>(loadState())
  const selectedSceneId = ref(state.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  function durationOfCue(cue: Cue): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return state.value.document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => state.value.document.scenes.reduce((total, scene) => total + durationOfScene(scene), 0))
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of state.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !state.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  })

  const errorWarnings = computed(() => warnings.value.filter((warning) => warning.level === 'error'))
  const freezeBlockers = computed(() => ({
    pending: pendingChanges.value,
    errors: errorWarnings.value,
    blocked: pendingChanges.value.length > 0 || errorWarnings.value.length > 0
  }))

  // Debounced write-only save; safe to call from the deep watcher because it never mutates state.
  function scheduleSave() {
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
  }

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    scheduleSave()
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    })
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
  }

  function replaceDocument(next: StudioDocument, label: string) {
    const before = clone(state.value.document)
    state.value.document = clone(next)
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(next)
    })
    persist()
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  function addScene() {
    const nextNumber = state.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (state.value.document.scenes.length <= 1) return
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = state.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= state.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function acceptChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    change.status = 'accepted'
    persist()
  }

  /** Later records (newest-first list) that touch the same scenes or project data as this change. */
  function affectedByReject(changeId: string): PendingChange[] {
    const index = state.value.pending.findIndex((item) => item.id === changeId)
    if (index < 0) return []
    const scope = changeScope(state.value.pending[index])
    if (!scope.size) return []
    return state.value.pending.slice(0, index).filter((item) => {
      if (item.status === 'rejected') return false
      for (const id of changeScope(item)) {
        if (scope.has(id)) return true
      }
      return false
    })
  }

  function rejectChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId && item.status === 'pending')
    if (!change) return
    undoStack.value.push(clone(state.value.document))
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    const document = clone(state.value.document)
    applyInverse(change, document)
    state.value.document = document
    change.status = 'rejected'
    persist()
  }

  function acceptAll() {
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  }

  /** Production script prefixed with the snapshot manifest: accepted changes and check results at freeze time. */
  function buildVersionScript(version: FrozenVersion): string {
    const lines = [
      `${version.document.title}｜${version.name}`,
      `冻结时间：${formatTimestamp(version.createdAt)}`,
      `预计总时长：${version.totalDuration.toFixed(1)} 秒`,
      '',
      `本版包含的已接受修改（${version.acceptedChanges.length} 条）：`
    ]
    if (version.acceptedChanges.length) {
      version.acceptedChanges.forEach((change, index) => {
        lines.push(`${index + 1}. ${change.label}（${formatTimestamp(change.createdAt)}）${change.note ? `｜${change.note}` : ''}`)
      })
    } else {
      lines.push('（无）')
    }
    lines.push('', `冻结时检查结果（${version.checks.length} 条）：`)
    if (version.checks.length) {
      for (const check of version.checks) {
        lines.push(`- [${check.level === 'error' ? '错误' : '提醒'}] ${check.title}：${check.detail}`)
      }
    } else {
      lines.push('（全部通过）')
    }
    lines.push('', '='.repeat(48), '')
    lines.push(makeScript(version.document))
    return lines.join('\n')
  }

  function freeze(name: string): FrozenVersion | undefined {
    // Freezing is only allowed once every pending change is handled and no error-level check remains.
    if (freezeBlockers.value.blocked) return undefined
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value,
      acceptedChanges: state.value.pending
        .filter((item) => item.status === 'accepted')
        .reverse()
        .map((item) => ({ id: item.id, label: item.label, note: item.note, createdAt: item.createdAt })),
      checks: warnings.value.map((warning) => ({
        type: warning.type,
        level: warning.level,
        sceneCode: state.value.document.scenes.find((scene) => scene.id === warning.sceneId)?.code ?? '',
        title: warning.title,
        detail: warning.detail
      })),
      script: ''
    }
    version.script = buildVersionScript(version)
    state.value.frozen.unshift(version)
    // Handled records are archived into this snapshot so the next version only lists what changed since.
    state.value.pending = state.value.pending.filter((item) => item.status === 'pending')
    persist()
    return version
  }

  function makeScript(document: StudioDocument): string {
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒`,
      '='.repeat(48),
      ''
    ]
    document.scenes.forEach((scene, sceneIndex) => {
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(scene)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(cue).toFixed(1)}s]`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([version.script || makeScript(version.document)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  watch(state, scheduleSave, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    errorWarnings,
    freezeBlockers,
    saveState,
    durationOfCue,
    durationOfScene,
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    acceptChange,
    rejectChange,
    affectedByReject,
    sceneCodesOf,
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    persist
  }
}
