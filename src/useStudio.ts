import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { ChangeScope, Cue, CueKind, FieldDiff, FrozenVersion, PendingChange, Scene, SnapshotChange, SnapshotCheck, StructuralOp, StudioDocument, StudioState, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 推算一条修改影响到的项目字段、场次与提示项，供退回时判断连带影响。 */
function deriveScope(before: StudioDocument, after: StudioDocument): ChangeScope {
  const scope: ChangeScope = {
    project:
      before.title !== after.title ||
      before.subtitle !== after.subtitle ||
      before.targetDuration !== after.targetDuration,
    sceneIds: [],
    cueIds: []
  }
  const beforeScenes = new Map(before.scenes.map((scene) => [scene.id, scene]))
  const afterScenes = new Map(after.scenes.map((scene) => [scene.id, scene]))
  for (const scene of after.scenes) {
    const previous = beforeScenes.get(scene.id)
    if (!previous) {
      scope.sceneIds.push(scene.id)
      scope.cueIds.push(...scene.cues.map((cue) => cue.id))
      continue
    }
    if (!sameJson(previous.cues, scene.cues)) {
      scope.sceneIds.push(scene.id)
      for (const cue of scene.cues) {
        if (!previous.cues.some((item) => item.id === cue.id) || !sameJson(previous.cues.find((item) => item.id === cue.id), cue)) {
          scope.cueIds.push(cue.id)
        }
      }
    }
    const sceneMetaKeys: (keyof Scene)[] = ['code', 'title', 'location', 'timeOfDay', 'transition', 'durationLimit']
    if (sceneMetaKeys.some((key) => previous[key] !== scene[key])) scope.sceneIds.push(scene.id)
  }
  for (const scene of before.scenes) {
    if (!afterScenes.has(scene.id)) {
      scope.sceneIds.push(scene.id)
      scope.cueIds.push(...scene.cues.map((cue) => cue.id))
    }
  }
  // 仅调整场次顺序时，顺序变化区间内的场次都算受影响。
  const beforeOrder = before.scenes.map((scene) => scene.id)
  const afterOrder = after.scenes.map((scene) => scene.id)
  if (scope.sceneIds.length === 0 && beforeOrder.length === afterOrder.length && beforeOrder.some((id, index) => afterOrder[index] !== id)) {
    const length = beforeOrder.length
    let start = 0
    while (start < length && beforeOrder[start] === afterOrder[start]) start += 1
    let end = length - 1
    while (end >= 0 && beforeOrder[end] === afterOrder[end]) end -= 1
    for (let i = start; i <= end; i += 1) scope.sceneIds.push(afterOrder[i])
  }
  scope.sceneIds = [...new Set(scope.sceneIds)]
  scope.cueIds = [...new Set(scope.cueIds)]
  return scope
}

function changeScope(change: PendingChange): ChangeScope {
  // 兼容旧版本 localStorage 中没有 scope/diffs 字段的草稿。
  return change.scope ?? { project: true, sceneIds: [], cueIds: [] }
}

const SCENE_META_KEYS = ['code', 'title', 'location', 'timeOfDay', 'transition', 'durationLimit'] as const
const CUE_MUTABLE_KEYS = ['kind', 'characterId', 'text', 'emotion', 'rate', 'soundEffectId', 'transition', 'manualDuration'] as const

/** 提取一次提交的逐字段差异（不含纯排序，排序单独记录）。 */
function deriveDiffs(before: StudioDocument, after: StudioDocument): FieldDiff[] {
  const diffs: FieldDiff[] = []
  if (before.title !== after.title) diffs.push({ kind: 'project', field: 'title', before: before.title, after: after.title })
  if (before.subtitle !== after.subtitle) diffs.push({ kind: 'project', field: 'subtitle', before: before.subtitle, after: after.subtitle })
  if (before.targetDuration !== after.targetDuration) diffs.push({ kind: 'project', field: 'targetDuration', before: before.targetDuration, after: after.targetDuration })

  for (const afterScene of after.scenes) {
    const beforeScene = before.scenes.find((scene) => scene.id === afterScene.id)
    if (!beforeScene) continue
    for (const key of SCENE_META_KEYS) {
      if (beforeScene[key] !== afterScene[key]) {
        diffs.push({ kind: 'scene', sceneId: afterScene.id, field: key, before: beforeScene[key], after: afterScene[key] })
      }
    }
    for (const afterCue of afterScene.cues) {
      const beforeCue = beforeScene.cues.find((cue) => cue.id === afterCue.id)
      if (!beforeCue) continue
      for (const key of CUE_MUTABLE_KEYS) {
        if (!sameJson(beforeCue[key], afterCue[key])) {
          diffs.push({ kind: 'cue', sceneId: afterScene.id, cueId: afterCue.id, field: key, before: clone(beforeCue[key]), after: clone(afterCue[key]) })
        }
      }
    }
  }
  return diffs
}

/** 提取新增/删除提示项与场次的结构操作（同一批 id 集合，无新增删除时才视为纯排序）。 */
function deriveOps(before: StudioDocument, after: StudioDocument): StructuralOp[] {
  const ops: StructuralOp[] = []
  const beforeSceneIds = new Set(before.scenes.map((scene) => scene.id))
  const afterSceneIds = new Set(after.scenes.map((scene) => scene.id))
  for (const scene of after.scenes) {
    if (!beforeSceneIds.has(scene.id)) {
      ops.push({ type: 'add-scene', sceneId: scene.id, index: after.scenes.findIndex((item) => item.id === scene.id), snapshot: clone(scene) })
    }
  }
  for (const scene of before.scenes) {
    if (!afterSceneIds.has(scene.id)) {
      ops.push({ type: 'delete-scene', sceneId: scene.id, index: before.scenes.findIndex((item) => item.id === scene.id), snapshot: clone(scene) })
    }
  }
  for (const afterScene of after.scenes) {
    const beforeScene = before.scenes.find((scene) => scene.id === afterScene.id)
    if (!beforeScene) continue
    const beforeCueIds = new Set(beforeScene.cues.map((cue) => cue.id))
    const afterCueIds = new Set(afterScene.cues.map((cue) => cue.id))
    for (const cue of afterScene.cues) {
      if (!beforeCueIds.has(cue.id)) {
        ops.push({ type: 'add-cue', sceneId: afterScene.id, cueId: cue.id, index: afterScene.cues.findIndex((item) => item.id === cue.id), snapshot: clone(cue) })
      }
    }
    for (const cue of beforeScene.cues) {
      if (!afterCueIds.has(cue.id)) {
        ops.push({ type: 'delete-cue', sceneId: afterScene.id, cueId: cue.id, index: beforeScene.cues.findIndex((item) => item.id === cue.id), snapshot: clone(cue) })
      }
    }
  }
  return ops
}

/** 纯排序（无增删）时记录目标顺序，供退回时按需恢复。 */
function deriveOrders(before: StudioDocument, after: StudioDocument): FieldDiff[] {
  const diffs: FieldDiff[] = []
  if (
    before.scenes.length === after.scenes.length &&
    before.scenes.every((scene) => after.scenes.some((item) => item.id === scene.id))
  ) {
    const beforeOrder = before.scenes.map((scene) => scene.id)
    const afterOrder = after.scenes.map((scene) => scene.id)
    if (!sameJson(beforeOrder, afterOrder)) {
      diffs.push({ kind: 'scene', field: '__order__', before: beforeOrder, after: afterOrder })
    }
  }
  for (const afterScene of after.scenes) {
    const beforeScene = before.scenes.find((scene) => scene.id === afterScene.id)
    if (!beforeScene) continue
    if (
      beforeScene.cues.length === afterScene.cues.length &&
      beforeScene.cues.every((cue) => afterScene.cues.some((item) => item.id === cue.id))
    ) {
      const beforeOrder = beforeScene.cues.map((cue) => cue.id)
      const afterOrder = afterScene.cues.map((cue) => cue.id)
      if (!sameJson(beforeOrder, afterOrder)) {
        diffs.push({ kind: 'cue-order', sceneId: afterScene.id, before: beforeOrder, after: afterOrder })
      }
    }
  }
  return diffs
}

function scopesOverlap(a: ChangeScope, b: ChangeScope): boolean {
  if (a.project && b.project) return true
  if (a.sceneIds.some((id) => b.sceneIds.includes(id))) return true
  if (a.cueIds.some((id) => b.cueIds.includes(id))) return true
  return false
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) return parsed
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

  function durationOfCue(cue: Cue, document: StudioDocument = state.value.document): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene, document: StudioDocument = state.value.document): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue, document), 0).toFixed(1))
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

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
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
      after: clone(document),
      scope: deriveScope(before, document),
      diffs: [...deriveDiffs(before, document), ...deriveOrders(before, document)],
      ops: deriveOps(before, document)
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
      after: clone(next),
      scope: deriveScope(before, next),
      diffs: [...deriveDiffs(before, next), ...deriveOrders(before, next)],
      ops: deriveOps(before, next)
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
    change.acceptedAt = new Date().toISOString()
    persist()
  }

  /**
   * 退回一条修改时的重建思路：
   * - 标量字段沿“同一字段的修改链”重算：取未退回改动里最新一条的改后值；
   *   若该字段上的改动全部已退回，则回到最早一条的改前值。
   * - 排序同理：没有更新的未退回排序改动时，才恢复这条的改前顺序。
   * - 新增/删除实体随这条退回而撤销；实体上的更晚改动会出现在确认列表里。
   * 整个过程只动当前这条，其他草稿的状态与内容都不受影响。
   */
  type DiffKey = string
  const diffKeyOf = (diff: FieldDiff): DiffKey => `${diff.kind}|${diff.sceneId ?? ''}|${diff.cueId ?? ''}|${diff.field ?? ''}`

  function chainValue(target: FieldDiff, ignoredChangeId?: string): unknown {
    const key = diffKeyOf(target)
    let newestIndex: number | null = null
    let newestValue: unknown
    let oldestIndex: number | null = null
    let oldestValue: unknown
    state.value.pending.forEach((change, index) => {
      const match = change.diffs?.find((diff) => diffKeyOf(diff) === key)
      if (!match) return
      const isRejected = change.status === 'rejected' || change.id === ignoredChangeId
      if (!isRejected && (newestIndex === null || index < newestIndex)) {
        newestIndex = index
        newestValue = clone(match.after)
      }
      if (oldestIndex === null || index > oldestIndex) {
        oldestIndex = index
        oldestValue = clone(match.before)
      }
    })
    return newestIndex === null ? oldestValue : newestValue
  }

  function applyOrder<T extends { id: string }>(items: T[], targetIds: string[]): T[] {
    const present = new Map(items.map((item) => [item.id, item]))
    const ordered = targetIds.map((id) => present.get(id)).filter((item): item is T => Boolean(item))
    const rest = items.filter((item) => !targetIds.includes(item.id))
    return [...ordered, ...rest]
  }

  function reinsertAt(items: Array<{ id: string }>, beforeIds: string[], index: number) {
    // 优先参照改前文档里相邻且仍然存在的实体定位，找不到就退回原始下标。
    for (let i = index - 1; i >= 0; i -= 1) {
      const neighbor = items.findIndex((item) => item.id === beforeIds[i])
      if (neighbor >= 0) return neighbor + 1
    }
    for (let i = index + 1; i < beforeIds.length; i += 1) {
      const neighbor = items.findIndex((item) => item.id === beforeIds[i])
      if (neighbor >= 0) return neighbor
    }
    return Math.min(index, items.length)
  }

  function selectiveRevert(change: PendingChange): StudioDocument {
    const document = clone(state.value.document)
    const diffs = change.diffs ?? []

    // 1. 标量字段按修改链重算（被退回的这条先视为已退出修改链）。
    for (const diff of diffs) {
      if (diff.field === '__order__') continue
      const value = chainValue(diff, change.id)
      if (diff.kind === 'project' && diff.field) {
        (document as unknown as Record<string, unknown>)[diff.field] = value
      } else if (diff.kind === 'scene' && diff.sceneId && diff.field) {
        const scene = document.scenes.find((item) => item.id === diff.sceneId)
        if (scene) (scene as unknown as Record<string, unknown>)[diff.field] = value
      } else if (diff.kind === 'cue' && diff.sceneId && diff.cueId && diff.field) {
        const cue = document.scenes.find((item) => item.id === diff.sceneId)?.cues.find((item) => item.id === diff.cueId)
        if (cue) (cue as unknown as Record<string, unknown>)[diff.field] = value
      }
    }

    // 2. 排序：沿修改链取最新未退回顺序，否则取这条的改前顺序。
    for (const diff of diffs) {
      if (diff.kind === 'cue-order' && diff.sceneId) {
        const scene = document.scenes.find((item) => item.id === diff.sceneId)
        if (!scene) continue
        const targetIds = (chainValue(diff, change.id) as string[] | undefined) ?? (diff.before as string[])
        scene.cues = applyOrder(scene.cues, targetIds)
      } else if (diff.kind === 'scene' && diff.field === '__order__') {
        const targetIds = (chainValue(diff, change.id) as string[] | undefined) ?? (diff.before as string[])
        document.scenes = applyOrder(document.scenes, targetIds)
      }
    }

    // 3. 结构操作随退回而撤销。
    for (const op of change.ops ?? []) {
      if (op.type === 'add-cue' && op.sceneId && op.cueId) {
        const scene = document.scenes.find((item) => item.id === op.sceneId)
        if (scene) scene.cues = scene.cues.filter((cue) => cue.id !== op.cueId)
      } else if (op.type === 'delete-cue' && op.sceneId && op.cueId) {
        const scene = document.scenes.find((item) => item.id === op.sceneId)
        if (scene && !scene.cues.some((cue) => cue.id === op.cueId)) {
          const beforeScene = change.before.scenes.find((item) => item.id === op.sceneId)
          const insertAt = reinsertAt(scene.cues, beforeScene?.cues.map((cue) => cue.id) ?? [], op.index)
          scene.cues.splice(insertAt, 0, clone(op.snapshot) as Cue)
        }
      } else if (op.type === 'add-scene' && op.sceneId) {
        document.scenes = document.scenes.filter((scene) => scene.id !== op.sceneId)
      } else if (op.type === 'delete-scene' && op.sceneId) {
        if (!document.scenes.some((scene) => scene.id === op.sceneId)) {
          const insertAt = reinsertAt(document.scenes, change.before.scenes.map((scene) => scene.id), op.index)
          document.scenes.splice(insertAt, 0, clone(op.snapshot) as Scene)
        }
      }
    }
    return document
  }

  /** 退回一条草稿后，仍然落在同一场次/同一项目上的、更晚的待确认草稿。 */
  function laterAffectedChanges(changeId: string): PendingChange[] {
    const index = state.value.pending.findIndex((item) => item.id === changeId)
    if (index < 0) return []
    const target = changeScope(state.value.pending[index])
    // pending 最新的在数组前面，更晚的草稿下标更小；按时间先后（旧→新）返回。
    const result: PendingChange[] = []
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = state.value.pending[i]
      if (candidate.status === 'pending' && scopesOverlap(target, changeScope(candidate))) result.push(candidate)
    }
    return result
  }

  /** UI 在退回前调用：同一场次还有更晚的待确认改动时，需要导演先过目这些记录。 */
  function previewReject(changeId: string): PendingChange[] {
    return laterAffectedChanges(changeId)
  }

  /** 只退回当前这条；已被后续修改覆盖的字段保留后续值，不连带撤掉别的草稿。 */
  function rejectChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId && item.status === 'pending')
    if (!change) return
    undoStack.value.push(clone(state.value.document))
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = selectiveRevert(change)
    change.status = 'rejected'
    change.rejectedAt = new Date().toISOString()
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

  function totalDurationOf(document: StudioDocument): number {
    return document.scenes.reduce((total, scene) => total + durationOfScene(scene, document), 0)
  }

  function checksForDocument(document: StudioDocument): SnapshotCheck[] {
    const result: SnapshotCheck[] = []
    for (const scene of document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneCode: scene.code,
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
            sceneCode: scene.code,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene, document)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneCode: scene.code,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  }

  /** 冻结前必须处理完的内容：待确认修改与错误级检查项。 */
  const freezeBlockers = computed(() => ({
    pending: pendingChanges.value,
    errors: warnings.value.filter((item) => item.level === 'error')
  }))

  function freeze(name: string): FrozenVersion {
    const document = clone(state.value.document)
    const checks = checksForDocument(document)
    // 只收录自上一版快照之后新接受的修改，避免同一修改在多版制作稿里重复出现。
    const acceptedChanges: SnapshotChange[] = state.value.pending
      .filter((item) => item.status === 'accepted' && !item.frozenInVersionId)
      .map((item) => ({
        id: item.id,
        label: item.label,
        note: item.note,
        createdAt: item.createdAt,
        acceptedAt: item.acceptedAt ?? item.createdAt
      }))
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document,
      script: makeScript(document),
      totalDuration: totalDurationOf(document),
      acceptedChanges,
      checks
    }
    state.value.frozen.unshift(version)
    for (const item of state.value.pending) {
      if (item.status === 'accepted' && !item.frozenInVersionId) item.frozenInVersionId = version.id
    }
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
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(scene, document)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(cue, document).toFixed(1)}s]`
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
    // 兼容旧版本 localStorage 里还没有内联制作稿的快照。
    const script = version.script ?? makeScript(version.document)
    const blob = new Blob([script], { type: 'text/plain;charset=utf-8' })
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

  watch(state, persist, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
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
    previewReject,
    acceptAll,
    undo,
    redo,
    freeze,
    freezeBlockers,
    downloadVersion,
    makeScript,
    resetSample,
    persist
  }
}
