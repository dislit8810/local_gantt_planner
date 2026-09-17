import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { calculateSchedule } from './schedule'

export type Task = {
  id: number
  name: string
  days: number
  level: number
  unit: 'day' | 'week'
  dayValue?: number
  weekValue?: number
  completed?: boolean
  execution?: 'sequence' | 'parallel'
  collapsed?: boolean
  projectStartDate?: string
  manualStartDate?: string
  manualEndDate?: string
  actualStartDate?: string
  actualEndDate?: string
  plannedStartAtCompletion?: string
  plannedEndAtCompletion?: string
  projectColor?: string
  scheduleExcluded?: boolean
}

type PresetTask = Pick<Task, 'name' | 'days' | 'level' | 'unit' | 'dayValue' | 'weekValue' | 'execution'>
type ProjectPreset = { id: string; name: string; tasks: PresetTask[] }

type BackupPayload = {
  schemaVersion: 1
  exportedAt: string
  tasks: Task[]
  settings: { parallel: boolean; projectsParallel: boolean; startDate: string; holidays?: string[]; presets?: ProjectPreset[] }
}

type SharedJsonHandle = {
  name: string
  getFile: () => Promise<File>
  queryPermission?: (options: { mode: 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<'granted' | 'denied'>
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>
    close: () => Promise<void>
  }>
}

const sharedHandleDatabase = 'schedule-app.handles.v1'
const sharedHandleStore = 'handles'
const sharedHandleKey = 'active-json'
const openHandleDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(sharedHandleDatabase, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(sharedHandleStore)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
const storeSharedHandle = async (handle: SharedJsonHandle) => {
  const database = await openHandleDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(sharedHandleStore, 'readwrite')
    transaction.objectStore(sharedHandleStore).put(handle, sharedHandleKey)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
const restoreSharedHandle = async () => {
  const database = await openHandleDatabase()
  const handle = await new Promise<SharedJsonHandle | undefined>((resolve, reject) => {
    const request = database.transaction(sharedHandleStore).objectStore(sharedHandleStore).get(sharedHandleKey)
    request.onsuccess = () => resolve(request.result as SharedJsonHandle | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return handle
}

const rememberedDayValue = (task: Task) => task.dayValue ?? (task.unit === 'day' && task.days > 0 ? task.days : 1)
const rememberedWeekValue = (task: Task) => task.weekValue ?? (task.unit === 'week' && task.days > 0 ? task.days / 5 : 1)
const localToday = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const icsDateKey = (value?: string) => {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}
const holidaysFromIcs = (text: string) => {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const dates = new Set<string>()
  for (const event of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = event.split('END:VEVENT')[0] ?? ''
    if (/^STATUS:CANCELLED$/mi.test(body)) continue
    const startLine = body.match(/^DTSTART(?:;[^:]*)?:(.+)$/mi)?.[1]?.trim()
    const endLine = body.match(/^DTEND(?:;[^:]*)?:(.+)$/mi)?.[1]?.trim()
    const startKey = icsDateKey(startLine)
    if (!startKey) continue
    const start = new Date(`${startKey}T00:00:00`)
    const endKey = icsDateKey(endLine)
    let exclusiveEnd = endKey ? new Date(`${endKey}T00:00:00`) : new Date(start.getTime() + 86400000)
    if (exclusiveEnd <= start) exclusiveEnd = new Date(start.getTime() + 86400000)
    for (const date = new Date(start); date < exclusiveEnd; date.setDate(date.getDate() + 1)) dates.add(localDateKey(date))
  }
  return [...dates].sort()
}
const shortDate = (value?: string) => value ? `${value.slice(5, 7)}/${value.slice(8, 10)}` : '—'
const actualStartForCompletion = (task: Task, scheduledStart: string | undefined, completedOn: string) => {
  const candidate = task.actualStartDate ?? task.manualStartDate ?? scheduledStart ?? completedOn
  return candidate > completedOn ? completedOn : candidate
}
const businessDaysInclusive = (startText: string, endText: string, holidays: Set<string>) => {
  const start = new Date(`${startText}T00:00:00`)
  const end = new Date(`${endText}T00:00:00`)
  if (end < start) return 1
  let days = 0
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    if (date.getDay() !== 0 && date.getDay() !== 6 && !holidays.has(key)) days += 1
  }
  return Math.max(1, days)
}
const tasksStorageKey = 'schedule-app.tasks.v1'
const settingsStorageKey = 'schedule-app.settings.v1'
const taskPanelWidthStorageKey = 'schedule-app.task-panel-width.v1'

const loadStoredTasks = (): Task[] => {
  try {
    const stored = localStorage.getItem(tasksStorageKey)
    if (!stored) return initialTasks
    const parsed = JSON.parse(stored) as Task[]
    const normalized = parsed.map((task) => ({
      ...task,
      dayValue: rememberedDayValue(task),
      weekValue: rememberedWeekValue(task),
      completed: task.completed ?? false,
    }))
    if (normalized.some((task) => task.level === 0)) return normalized
    return [{ id: Math.max(0, ...normalized.map((task) => task.id)) + 1, name: 'Schedule App v0.1', days: 0, level: 0, unit: 'day', dayValue: 1, weekValue: 1, completed: false }, ...normalized]
  } catch {
    return initialTasks
  }
}

const loadStoredSettings = () => {
  try {
    const stored = localStorage.getItem(settingsStorageKey)
    return stored ? JSON.parse(stored) as { parallel?: boolean; projectsParallel?: boolean; startDate?: string; holidays?: string[]; presets?: ProjectPreset[] } : {}
  } catch {
    return {}
  }
}

const initialTasks: Task[] = [
  { id: 8, name: 'Schedule App v0.1', days: 0, level: 0, unit: 'day', dayValue: 1, weekValue: 1 },
  { id: 1, name: '要件整理', days: 2, level: 1, unit: 'day', dayValue: 2, weekValue: 1 },
  { id: 2, name: '設計', days: 0, level: 1, unit: 'day', dayValue: 1, weekValue: 1 },
  { id: 3, name: 'UI作成', days: 2, level: 2, unit: 'day', dayValue: 2, weekValue: 1 },
  { id: 4, name: 'DB設計', days: 1, level: 2, unit: 'day', dayValue: 1, weekValue: 1 },
  { id: 5, name: 'タスク機能実装', days: 3, level: 1, unit: 'day', dayValue: 3, weekValue: 1 },
  { id: 6, name: 'ガント実装', days: 4, level: 1, unit: 'day', dayValue: 4, weekValue: 1 },
  { id: 7, name: 'テスト', days: 2, level: 1, unit: 'day', dayValue: 2, weekValue: 1 },
]

export default function App() {
  const storedSettings = loadStoredSettings()
  const [parallel, setParallel] = useState(storedSettings.parallel ?? true)
  const [projectsParallel, setProjectsParallel] = useState(storedSettings.projectsParallel ?? false)
  const [startDate, setStartDate] = useState(localToday)
  const [holidays, setHolidays] = useState<string[]>(storedSettings.holidays ?? [])
  const [presets, setPresets] = useState<ProjectPreset[]>(storedSettings.presets ?? [])
  const [newProjectPresetId, setNewProjectPresetId] = useState('')
  const [presetSourceId, setPresetSourceId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [editingPresetId, setEditingPresetId] = useState('')
  const [hideCompletedProjects, setHideCompletedProjects] = useState(false)
  const [hideFutureProjects, setHideFutureProjects] = useState(false)
  const [holidayDraft, setHolidayDraft] = useState('')
  const [holidayEndDraft, setHolidayEndDraft] = useState('')
  const [holidayEditMode, setHolidayEditMode] = useState(false)
  const [holidayAnchor, setHolidayAnchor] = useState('')
  const [holidayRangeAction, setHolidayRangeAction] = useState<'add' | 'remove' | null>(null)
  const [lastIcsImport, setLastIcsImport] = useState<{ name: string; addedDates: string[] } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [taskItems, setTaskItems] = useState<Task[]>(loadStoredTasks)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)
  const [durationEditingId, setDurationEditingId] = useState<number | null>(null)
  const [durationDraft, setDurationDraft] = useState('')
  const [viewMode, setViewMode] = useState<'gantt' | 'calendar'>('gantt')
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error'>('saved')
  const [sharedDataReady, setSharedDataReady] = useState(false)
  const [sharedJsonHandle, setSharedJsonHandle] = useState<SharedJsonHandle | null>(null)
  const [rememberedJsonHandle, setRememberedJsonHandle] = useState<SharedJsonHandle | null>(null)
  const [sharedJsonName, setSharedJsonName] = useState('')
  const [taskPanelWidth, setTaskPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem(taskPanelWidthStorageKey))
    return Number.isFinite(stored) && stored >= 560 ? stored : 780
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const durationRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const icsImportRef = useRef<HTMLInputElement>(null)
  const saveTimerRef = useRef<number | null>(null)
  const schedule = useMemo(() => calculateSchedule(taskItems, parallel, projectsParallel, startDate, holidays), [taskItems, parallel, projectsParallel, startDate, holidays])
  const holidaySet = useMemo(() => new Set(holidays), [holidays])
  const weekStartIndexes = useMemo(() => {
    let total = 0
    return new Set(schedule.weeks.slice(0, -1).map((week) => {
      total += week.days
      return total
    }))
  }, [schedule.weeks])
  const timelineWidth = Math.max(720, schedule.workdays.length * 48)
  const today = localToday()
  const todayIndex = schedule.isoDates.indexOf(today)
  const parentTasks = taskItems.filter((task, index) => taskItems[index + 1]?.level > task.level)
  const projectTasks = taskItems.filter((task) => task.level === 0)
  const parentTaskIds = new Set(parentTasks.map((task) => task.id))
  const scheduleById = new Map(schedule.rows.map((row) => [row.id, row]))
  const projectPalette = ['#2563eb', '#7c3aed', '#059669', '#ea580c', '#db2777', '#0891b2', '#65a30d', '#9333ea']
  const projectIdByTaskId = new Map<number, number>()
  const projectColorByTaskId = new Map<number, string>()
  let currentProjectId = 0
  let currentProjectColor = projectPalette[0]
  let projectIndex = -1
  for (const task of taskItems) {
    if (task.level === 0) {
      projectIndex += 1
      currentProjectId = task.id
      currentProjectColor = task.projectColor ?? projectPalette[projectIndex % projectPalette.length]
    }
    projectIdByTaskId.set(task.id, currentProjectId)
    projectColorByTaskId.set(task.id, currentProjectColor)
  }
  const hiddenProjectIds = new Set(projectTasks.filter((project) => {
    const row = scheduleById.get(project.id)
    return hideCompletedProjects && project.completed || hideFutureProjects && Boolean(row?.startDate && row.startDate > today)
  }).map((project) => project.id))
  const visibleTasks = taskItems.filter((task, index) => {
    if (hiddenProjectIds.has(projectIdByTaskId.get(task.id) ?? 0)) return false
    let ancestorLevel = task.level
    for (let previous = index - 1; previous >= 0 && ancestorLevel > 0; previous -= 1) {
      const candidate = taskItems[previous]
      if (candidate.level < ancestorLevel) {
        if (candidate.collapsed) return false
        ancestorLevel = candidate.level
      }
    }
    return true
  })
  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id))
  const calendarDays = useMemo(() => {
    const first = new Date(`${schedule.isoDates[0]}T00:00:00`)
    const last = new Date(`${schedule.isoDates.at(-1)}T00:00:00`)
    first.setDate(first.getDate() - first.getDay())
    last.setDate(last.getDate() + 6 - last.getDay())
    const days: Date[] = []
    for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) days.push(new Date(date))
    return days
  }, [schedule.isoDates])
  const calendarWeeks = useMemo(() => Array.from({ length: Math.ceil(calendarDays.length / 7) }, (_, index) => {
    const days = calendarDays.slice(index * 7, index * 7 + 7)
    const keys = days.map((date) => {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    })
    const segments = schedule.rows.filter((row) => {
      if (!visibleTaskIds.has(row.id)) return false
      if (!row.parent) return true
      return taskItems.find((task) => task.id === row.id)?.collapsed === true
    }).flatMap((row) => {
      const activeKeys = new Set(schedule.isoDates.slice(Math.floor(row.start), Math.min(schedule.isoDates.length, Math.ceil(row.start + row.days))))
      const activeColumns = keys.map((key, column) => activeKeys.has(key) ? column : -1).filter((column) => column >= 0)
      if (activeColumns.length === 0) return []
      const first = activeColumns[0]
      const last = activeColumns.at(-1)!
      return [{ task: row, start: first + 1, span: last - first + 1 }]
    })
    return { days, segments }
  }), [calendarDays, schedule, taskItems, visibleTasks])

  const applyBackupPayload = (payload: BackupPayload) => {
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.tasks)) throw new Error('対応していないバックアップ形式です。')
    setTaskItems(payload.tasks.map((task) => ({
      ...task,
      dayValue: rememberedDayValue(task),
      weekValue: rememberedWeekValue(task),
      completed: task.completed ?? false,
    })))
    setParallel(payload.settings?.parallel ?? true)
    setProjectsParallel(payload.settings?.projectsParallel ?? false)
    setStartDate(localToday())
    setHolidays(payload.settings?.holidays ?? [])
    setPresets(payload.settings?.presets ?? [])
    setEditingId(null)
    setDurationEditingId(null)
    setSelectedId(null)
    setSelectedTaskIds(new Set())
  }

  const loadSharedJson = async (handle: SharedJsonHandle, confirmReplacement: boolean) => {
    const payload = JSON.parse(await (await handle.getFile()).text()) as BackupPayload
    if (confirmReplacement && !confirm('現在の表示を、選択した共有JSONの内容で置き換えますか？')) return false
    applyBackupPayload(payload)
    setSharedJsonHandle(handle)
    setRememberedJsonHandle(handle)
    setSharedJsonName(handle.name)
    await storeSharedHandle(handle)
    return true
  }

  const selectSharedJson = async () => {
    const picker = (window as Window & {
      showOpenFilePicker?: (options: object) => Promise<SharedJsonHandle[]>
    }).showOpenFilePicker
    if (!picker) {
      alert('このブラウザは共有JSONの直接編集に対応していません。ChromeまたはEdgeで開いてください。')
      return
    }
    try {
      const [handle] = await picker.call(window, {
        multiple: false,
        types: [{ description: 'Schedule App JSON', accept: { 'application/json': ['.json'] } }],
      })
      if (handle && await loadSharedJson(handle, true)) alert(`${handle.name}を共有データとして開きました。以後の変更はこのファイルにも自動保存されます。`)
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError') alert('共有JSONを開けませんでした。')
    }
  }

  const reconnectSharedJson = async () => {
    if (!rememberedJsonHandle) return
    try {
      const permission = rememberedJsonHandle.requestPermission
        ? await rememberedJsonHandle.requestPermission({ mode: 'readwrite' })
        : 'granted'
      if (permission !== 'granted') throw new Error('共有JSONへのアクセスが許可されませんでした。')
      await loadSharedJson(rememberedJsonHandle, true)
    } catch (error) {
      alert(error instanceof Error ? error.message : '共有JSONへ再接続できませんでした。')
    }
  }

  const exportBackup = () => {
    const payload: BackupPayload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tasks: taskItems,
      settings: { parallel, projectsParallel, startDate, holidays, presets },
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `schedule-app-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const importBackup = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as BackupPayload
      if (!confirm('現在のタスクと設定を、選択したバックアップで置き換えますか？')) return
      applyBackupPayload(payload)
      alert('バックアップを読み込みました。')
    } catch (error) {
      alert(error instanceof Error ? error.message : 'バックアップを読み込めませんでした。')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  useEffect(() => {
    setTaskItems((current) => current.map((task) => ({
      ...task,
      dayValue: rememberedDayValue(task),
      weekValue: rememberedWeekValue(task),
    })))
  }, [])

  useEffect(() => {
    let active = true
    const loadSharedData = async () => {
      try {
        const rememberedHandle = await restoreSharedHandle().catch(() => undefined)
        if (rememberedHandle) {
          setRememberedJsonHandle(rememberedHandle)
          setSharedJsonName(rememberedHandle.name)
          const permission = rememberedHandle.queryPermission ? await rememberedHandle.queryPermission({ mode: 'readwrite' }) : 'granted'
          if (permission === 'granted') {
            const payload = JSON.parse(await (await rememberedHandle.getFile()).text()) as BackupPayload
            if (payload.schemaVersion !== 1 || !Array.isArray(payload.tasks)) throw new Error('共有JSONの形式が正しくありません。')
            applyBackupPayload(payload)
            setSharedJsonHandle(rememberedHandle)
            if (active) {
              setSharedDataReady(true)
              setSaveStatus('saved')
            }
            return
          }
          // Browsers may require a fresh user gesture after an application
          // update. Keep the remembered shared file selected instead of
          // silently falling back to the installation folder's local data.
          if (active) {
            setSharedDataReady(false)
            setSaveStatus('error')
          }
          return
        }
        const response = await fetch('/api/state', { cache: 'no-store' })
        if (!active) return
        if (response.status === 204) {
          const seed: BackupPayload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            tasks: taskItems,
            settings: { parallel, projectsParallel, startDate, holidays, presets },
          }
          const saved = await fetch('/api/state', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(seed),
          })
          if (!saved.ok) throw new Error('初期データを保存できませんでした。')
        } else if (response.ok) {
          const payload = await response.json() as BackupPayload
          if (payload.schemaVersion !== 1 || !Array.isArray(payload.tasks)) throw new Error('保存形式が正しくありません。')
          setTaskItems(payload.tasks.map((task) => ({
            ...task,
            dayValue: rememberedDayValue(task),
            weekValue: rememberedWeekValue(task),
            completed: task.completed ?? false,
          })))
          setParallel(payload.settings?.parallel ?? true)
          setProjectsParallel(payload.settings?.projectsParallel ?? false)
          setStartDate(localToday())
          setHolidays(payload.settings?.holidays ?? [])
          setPresets(payload.settings?.presets ?? [])
        } else {
          throw new Error('共通データを読み込めませんでした。')
        }
        if (active) {
          setSharedDataReady(true)
          setSaveStatus('saved')
        }
      } catch {
        if (active) {
          setSharedDataReady(true)
          setSaveStatus('error')
        }
      }
    }
    void loadSharedData()
    return () => { active = false }
  }, [])

  useEffect(() => {
    localStorage.setItem(taskPanelWidthStorageKey, String(taskPanelWidth))
  }, [taskPanelWidth])

  useEffect(() => {
    if (!sharedDataReady) return
    setSaveStatus('saving')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        const payload: BackupPayload = {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          tasks: taskItems,
          settings: { parallel, projectsParallel, startDate, holidays, presets },
        }
        const response = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) throw new Error('保存に失敗しました。')
        if (sharedJsonHandle) {
          const writable = await sharedJsonHandle.createWritable()
          await writable.write(`${JSON.stringify(payload, null, 2)}\n`)
          await writable.close()
        }
        localStorage.setItem(tasksStorageKey, JSON.stringify(taskItems))
        localStorage.setItem(settingsStorageKey, JSON.stringify({ parallel, projectsParallel, startDate, holidays, presets }))
        setSaveStatus('saved')
      } catch {
        setSaveStatus('error')
      }
    }, 350)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
  }, [taskItems, parallel, projectsParallel, startDate, holidays, presets, sharedDataReady, sharedJsonHandle])

  useEffect(() => {
    if (editingId !== null) {
      inputRef.current?.focus()
      const end = inputRef.current?.value.length ?? 0
      inputRef.current?.setSelectionRange(end, end)
    }
  }, [editingId])

  useEffect(() => {
    if (selectedId !== null && editingId === null) {
      document.querySelector<HTMLButtonElement>(`[data-task-id="${selectedId}"]`)?.focus()
    }
  }, [selectedId, editingId])

  useEffect(() => {
    if (durationEditingId !== null) {
      const task = taskItems.find((item) => item.id === durationEditingId)
      if (task) setDurationDraft(String(task.unit === 'day' ? rememberedDayValue(task) : rememberedWeekValue(task)))
      durationRef.current?.focus()
      durationRef.current?.select()
    }
  }, [durationEditingId, taskItems])

  const updateTaskName = (id: number, name: string) => {
    setTaskItems((current) => current.map((task) => task.id === id ? { ...task, name } : task))
  }

  const nextId = () => Math.max(0, ...taskItems.map((task) => task.id)) + 1

  const addTaskAfter = (task: Task, child: boolean) => {
    if (!task.name.trim()) return

    const id = nextId()
    const newTask: Task = { id, name: '', days: 1, level: child ? task.level + 1 : task.level, unit: 'day', dayValue: 1, weekValue: 1, completed: false }
    setTaskItems((current) => {
      const currentIndex = current.findIndex((item) => item.id === task.id)
      let insertIndex = currentIndex + 1

      if (!child) {
        while (insertIndex < current.length && current[insertIndex].level > task.level) insertIndex += 1
      }

      const next = [...current]
      next.splice(insertIndex, 0, newTask)
      return next
    })
    setEditingId(id)
  }

  const finishEditing = (task: Task) => {
    if (!task.name.trim()) {
      setTaskItems((current) => current.filter((item) => item.id !== task.id))
    } else {
      updateTaskName(task.id, task.name.trim())
    }
    setEditingId((current) => current === task.id ? null : current)
  }

  const addRootTask = () => {
    const id = nextId()
    setTaskItems((current) => [...current, { id, name: '', days: 1, level: 1, unit: 'day', dayValue: 1, weekValue: 1, completed: false }])
    setEditingId(id)
  }

  const addTitleTask = () => {
    const id = nextId()
    const preset = presets.find((item) => item.id === newProjectPresetId)
    const root: Task = { id, name: '', days: preset ? 0 : 1, level: 0, unit: 'day', dayValue: 1, weekValue: 1, completed: false }
    const presetTasks: Task[] = (preset?.tasks ?? []).map((item, index) => ({
      ...item,
      id: id + index + 1,
      completed: false,
      collapsed: false,
    }))
    setTaskItems((current) => [...current, root, ...presetTasks])
    setEditingId(id)
  }

  const saveProjectPreset = () => {
    const sourceId = Number(presetSourceId)
    const sourceIndex = taskItems.findIndex((item) => item.id === sourceId && item.level === 0)
    if (sourceIndex < 0) return
    let end = sourceIndex + 1
    while (end < taskItems.length && taskItems[end].level > 0) end += 1
    const tasks = taskItems.slice(sourceIndex + 1, end).map(({ name, days, level, unit, dayValue, weekValue, execution }) => ({ name, days, level, unit, dayValue, weekValue, execution }))
    if (tasks.length === 0) {
      alert('配下にタスクがあるプロジェクトを選んでください。')
      return
    }
    const name = presetName.trim() || taskItems[sourceIndex].name.trim()
    if (!name) return
    setPresets((current) => [...current, { id: crypto.randomUUID?.() ?? `${Date.now()}`, name, tasks }])
    setPresetName('')
  }

  const updatePreset = (presetId: string, updater: (preset: ProjectPreset) => ProjectPreset) => {
    setPresets((current) => current.map((preset) => preset.id === presetId ? updater(preset) : preset))
  }

  const changeTaskLevel = (task: Task, direction: 1 | -1) => {
    setTaskItems((current) => {
      const index = current.findIndex((item) => item.id === task.id)
      if (index < 0) return current

      if (direction === 1) {
        if (index === 0) return current
        const previous = current[index - 1]
        if (current[index].level >= previous.level + 1) return current
      } else if (current[index].level <= 1) {
        return current
      }

      const originalLevel = current[index].level
      let end = index + 1
      while (end < current.length && current[end].level > originalLevel) end += 1

      return current.map((item, itemIndex) =>
        itemIndex >= index && itemIndex < end ? { ...item, level: item.level + direction } : item,
      )
    })
  }

  const changeSelectedTaskLevels = (task: Task, direction: 1 | -1) => {
    if (selectedTaskIds.size <= 1 || !selectedTaskIds.has(task.id)) {
      changeTaskLevel(task, direction)
      return
    }

    setTaskItems((current) => {
      const selectedIndexes = current
        .map((item, index) => selectedTaskIds.has(item.id) ? index : -1)
        .filter((index) => index >= 0)
      if (selectedIndexes.length === 0) return current

      const first = Math.min(...selectedIndexes)
      if (direction === 1) {
        if (first === 0 || current[first].level >= current[first - 1].level + 1) return current
      } else if (selectedIndexes.some((index) => current[index].level <= 1)) {
        return current
      }

      const affected = new Set(selectedIndexes)
      for (const index of selectedIndexes) {
        const level = current[index].level
        let descendant = index + 1
        while (descendant < current.length && current[descendant].level > level) {
          affected.add(descendant)
          descendant += 1
        }
      }

      return current.map((item, index) => affected.has(index) ? { ...item, level: item.level + direction } : item)
    })
  }

  const selectTaskRange = (task: Task, extend: boolean) => {
    if (!extend || selectionAnchorId === null) {
      setSelectedId(task.id)
      setSelectionAnchorId(task.id)
      setSelectedTaskIds(new Set([task.id]))
      return
    }

    const anchorIndex = visibleTasks.findIndex((item) => item.id === selectionAnchorId)
    const targetIndex = visibleTasks.findIndex((item) => item.id === task.id)
    if (anchorIndex < 0 || targetIndex < 0) return
    const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    setSelectedId(task.id)
    setSelectedTaskIds(new Set(visibleTasks.slice(start, end + 1).map((item) => item.id)))
  }

  const deleteTaskBranch = (task: Task) => {
    setTaskItems((current) => {
      const index = current.findIndex((item) => item.id === task.id)
      if (index < 0) return current
      let end = index + 1
      while (end < current.length && current[end].level > task.level) end += 1
      return [...current.slice(0, index), ...current.slice(end)]
    })
    if (editingId === task.id) setEditingId(null)
    if (selectedId === task.id) setSelectedId(null)
  }

  const deleteTaskOnly = (task: Task) => {
    setTaskItems((current) => {
      const index = current.findIndex((item) => item.id === task.id)
      if (index < 0) return current
      let end = index + 1
      while (end < current.length && current[end].level > task.level) end += 1

      return current
        .filter((item) => item.id !== task.id)
        .map((item, itemIndex) =>
          itemIndex >= index && itemIndex < end - 1 ? { ...item, level: item.level - 1 } : item,
        )
    })
    if (editingId === task.id) setEditingId(null)
    if (selectedId === task.id) setSelectedId(null)
  }

  const moveTaskSelection = (task: Task, direction: -1 | 1) => {
    const index = taskItems.findIndex((item) => item.id === task.id)
    if (index < 0) return
    const nextIndex = Math.max(0, Math.min(taskItems.length - 1, index + direction))
    const nextTask = taskItems[nextIndex]
    if (editingId === task.id) finishEditing(task)
    setSelectedId(nextTask.id)
    setSelectionAnchorId(nextTask.id)
    setSelectedTaskIds(new Set([nextTask.id]))
    setEditingId(nextTask.id)
  }

  const reorderTask = (task: Task, direction: -1 | 1) => {
    setTaskItems((current) => {
      const start = current.findIndex((item) => item.id === task.id)
      if (start < 0) return current

      let end = start + 1
      while (end < current.length && current[end].level > task.level) end += 1
      const currentBlock = current.slice(start, end)

      if (direction === -1) {
        let previousStart = start - 1
        while (previousStart >= 0 && current[previousStart].level > task.level) previousStart -= 1
        if (previousStart < 0 || current[previousStart].level !== task.level) return current
        const previousBlock = current.slice(previousStart, start)
        const reordered = [...current.slice(0, previousStart), ...currentBlock, ...previousBlock, ...current.slice(end)]
        let projectStart = start
        while (projectStart > 0 && current[projectStart].level !== 0) projectStart -= 1
        const projectId = current[projectStart]?.id
        return reordered.map((item) => !item.completed && (task.level === 0 || projectIdByTaskId.get(item.id) === projectId)
          ? { ...item, manualStartDate: undefined, manualEndDate: undefined }
          : item)
      }

      if (end >= current.length || current[end].level !== task.level) return current
      let nextEnd = end + 1
      while (nextEnd < current.length && current[nextEnd].level > task.level) nextEnd += 1
      const nextBlock = current.slice(end, nextEnd)
      const reordered = [...current.slice(0, start), ...nextBlock, ...currentBlock, ...current.slice(nextEnd)]
      let projectStart = start
      while (projectStart > 0 && current[projectStart].level !== 0) projectStart -= 1
      const projectId = current[projectStart]?.id
      return reordered.map((item) => !item.completed && (task.level === 0 || projectIdByTaskId.get(item.id) === projectId)
        ? { ...item, manualStartDate: undefined, manualEndDate: undefined }
        : item)
    })
  }

  const updateDuration = (task: Task, displayedValue: number) => {
    const minimum = task.unit === 'day' ? 1 : 0.5
    const safeValue = Math.max(minimum, displayedValue || minimum)
    const days = task.unit === 'day' ? safeValue : safeValue * 5
    setTaskItems((current) => current.map((item) => item.id === task.id
      ? task.unit === 'day'
        ? { ...item, days, dayValue: safeValue, manualEndDate: undefined }
        : { ...item, days, weekValue: safeValue, manualEndDate: undefined }
      : item,
    ))
  }

  const adjustDuration = (task: Task, direction: 1 | -1) => {
    const step = task.unit === 'day' ? 1 : 0.5
    const minimum = task.unit === 'day' ? 1 : 0.5
    const currentValue = Number(durationDraft) || (task.unit === 'day' ? rememberedDayValue(task) : rememberedWeekValue(task))
    const nextValue = Math.max(minimum, currentValue + direction * step)
    setDurationDraft(String(nextValue))
    updateDuration(task, nextValue)
  }

  const setDurationUnit = (task: Task, unit: 'day' | 'week') => {
    if (task.unit === unit) return
    setTaskItems((current) => current.map((item) =>
      item.id === task.id
        ? unit === 'week'
          ? { ...item, unit: 'week', days: rememberedWeekValue(item) * 5, manualEndDate: undefined }
          : { ...item, unit: 'day', days: rememberedDayValue(item), manualEndDate: undefined }
        : item,
    ))
    setDurationDraft(String(unit === 'week' ? rememberedWeekValue(task) : rememberedDayValue(task)))
    requestAnimationFrame(() => durationRef.current?.focus())
  }

  const toggleDurationUnit = (task: Task) => {
    setDurationUnit(task, task.unit === 'day' ? 'week' : 'day')
  }

  const commitDuration = (task: Task) => {
    updateDuration(task, Number(durationDraft))
  }

  const moveDurationEditing = (task: Task, direction: -1 | 1) => {
    let index = taskItems.findIndex((item) => item.id === task.id) + direction
    while (index >= 0 && index < taskItems.length && parentTaskIds.has(taskItems[index].id)) index += direction
    if (index < 0 || index >= taskItems.length) {
      setDurationEditingId(null)
      return
    }
    setSelectedId(taskItems[index].id)
    setDurationEditingId(taskItems[index].id)
  }

  const durationLabel = (task: Task) => {
    if (task.days === 0) return '自動'
    return task.unit === 'day' ? `${rememberedDayValue(task)}日` : `${rememberedWeekValue(task)}週`
  }

  const updatePlannedDate = (task: Task, field: 'start' | 'end', value: string) => {
    if (value) {
      const date = new Date(`${value}T00:00:00`)
      if (date.getDay() === 0 || date.getDay() === 6 || holidaySet.has(value)) {
        alert('土日または休日は、タスクの開始日・終了日には設定できません。営業日を選んでください。')
        return
      }
    }
    const taskIndex = taskItems.findIndex((item) => item.id === task.id)
    let targetIds = [task.id]
    let leafDescendants: Task[] = []
    let runInParallel = false
    if (parentTaskIds.has(task.id)) {
      let branchEnd = taskIndex + 1
      while (branchEnd < taskItems.length && taskItems[branchEnd].level > task.level) branchEnd += 1
      leafDescendants = taskItems.slice(taskIndex + 1, branchEnd).filter((item) => !parentTaskIds.has(item.id))
      runInParallel = task.execution ? task.execution === 'parallel' : parallel
      targetIds = runInParallel
        ? leafDescendants.map((item) => item.id)
        : [field === 'start' ? leafDescendants[0]?.id ?? task.id : leafDescendants.at(-1)?.id ?? task.id]
    }
    const targetIdSet = new Set(targetIds)
    const leafIdSet = new Set(leafDescendants.map((item) => item.id))
    const firstLeafId = leafDescendants[0]?.id
    const lastLeafId = leafDescendants.at(-1)?.id
    const parentSchedule = scheduleById.get(task.id)

    setTaskItems((current) => current.map((item) => {
      if (item.id === task.id && parentTaskIds.has(task.id)) {
        return { ...item, manualStartDate: undefined, manualEndDate: undefined }
      }
      if (parentTaskIds.has(task.id) && !runInParallel && leafIdSet.has(item.id)) {
        const manualStartDate = item.id === firstLeafId ? (field === 'start' ? value || undefined : parentSchedule?.startDate) : undefined
        const manualEndDate = item.id === lastLeafId ? (field === 'end' ? value || undefined : parentSchedule?.endDate) : undefined
        if (item.id === firstLeafId && item.id === lastLeafId && manualStartDate && manualEndDate) {
          const days = businessDaysInclusive(manualStartDate, manualEndDate, holidaySet)
          return { ...item, manualStartDate, manualEndDate, days, dayValue: days, unit: 'day' }
        }
        return { ...item, manualStartDate, manualEndDate }
      }
      if (!targetIdSet.has(item.id)) return item
      const scheduled = scheduleById.get(item.id)
      let start = field === 'start' ? value : item.manualStartDate ?? scheduled?.startDate ?? ''
      let end = field === 'end' ? value : item.manualEndDate ?? scheduled?.endDate ?? ''
      if (start && end && end < start) {
        if (field === 'start') end = start
        else start = end
      }
      const next = {
        ...item,
        manualStartDate: field === 'start' ? value || undefined : start && start !== scheduled?.startDate ? start : item.manualStartDate,
        manualEndDate: field === 'end' ? value || undefined : end && end !== scheduled?.endDate ? end : item.manualEndDate,
      }
      if (start && end && value) {
        const days = businessDaysInclusive(start, end, holidaySet)
        next.days = days
        next.dayValue = days
        next.unit = 'day'
      }
      return next
    }))
  }

  const updateTaskExecution = (task: Task, value: 'default' | 'sequence' | 'parallel') => {
    const execution = value === 'default' ? undefined : value
    const taskIndex = taskItems.findIndex((item) => item.id === task.id)
    let branchEnd = taskIndex + 1
    while (branchEnd < taskItems.length && taskItems[branchEnd].level > task.level) branchEnd += 1
    const leafTasks = taskItems.slice(taskIndex + 1, branchEnd).filter((item) => !parentTaskIds.has(item.id))
    const leafIds = new Set(leafTasks.map((item) => item.id))
    setTaskItems((current) => current.map((item) => {
      if (item.id === task.id) return { ...item, execution }
      if (!leafIds.has(item.id)) return item
      return {
        ...item,
        // Execution mode changes placement only. The scheduler already passes
        // a common start to parallel children and a rolling start to sequence
        // children, so copied dates would only block later recalculation.
        manualStartDate: undefined,
        manualEndDate: undefined,
      }
    }))
  }

  const toggleScheduleExcluded = (task: Task) => {
    const taskIndex = taskItems.findIndex((item) => item.id === task.id)
    let branchEnd = taskIndex + 1
    while (branchEnd < taskItems.length && taskItems[branchEnd].level > task.level) branchEnd += 1
    const branchIds = new Set(taskItems.slice(taskIndex, branchEnd).map((item) => item.id))
    const excluded = !task.scheduleExcluded
    setTaskItems((current) => current.map((item) => branchIds.has(item.id)
      ? {
          ...item,
          scheduleExcluded: excluded || undefined,
          manualStartDate: excluded ? undefined : item.manualStartDate,
          manualEndDate: excluded ? undefined : item.manualEndDate,
        }
      : item))
  }

  const addHolidayRange = () => {
    if (!holidayDraft) return
    const start = new Date(`${holidayDraft}T00:00:00`)
    const end = new Date(`${holidayEndDraft || holidayDraft}T00:00:00`)
    const first = start <= end ? start : end
    const last = start <= end ? end : start
    const additions: string[] = []
    for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) additions.push(localDateKey(date))
    setHolidays((current) => [...new Set([...current, ...additions])].sort())
    setHolidayDraft('')
    setHolidayEndDraft('')
  }

  const importHolidayIcs = async (file: File) => {
    try {
      const imported = holidaysFromIcs(await file.text())
      if (imported.length === 0) throw new Error('休日として読み込める予定がありませんでした。')
      if (!confirm(`${file.name}から${imported.length}日分を休日として取り込みますか？`)) return
      const addedDates = imported.filter((date) => !holidays.includes(date))
      setHolidays((current) => [...new Set([...current, ...imported])].sort())
      setLastIcsImport({ name: file.name, addedDates })
      alert(`${addedDates.length}日分を新しく休日として取り込みました。`)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'ICSファイルを読み込めませんでした。')
    } finally {
      if (icsImportRef.current) icsImportRef.current.value = ''
    }
  }

  const undoLastIcsImport = () => {
    if (!lastIcsImport) return
    setHolidays((current) => current.filter((date) => !lastIcsImport.addedDates.includes(date)))
    setLastIcsImport(null)
  }

  const selectHolidayOnSchedule = (date: string, extendRange: boolean) => {
    if (extendRange && holidayAnchor) {
      const start = new Date(`${holidayAnchor}T00:00:00`)
      const end = new Date(`${date}T00:00:00`)
      const first = start <= end ? start : end
      const last = start <= end ? end : start
      const additions: string[] = []
      for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) additions.push(localDateKey(cursor))
      setHolidays((current) => holidayRangeAction === 'remove'
        ? current.filter((item) => !additions.includes(item))
        : [...new Set([...current, ...additions])].sort())
    } else {
      const removing = holidays.includes(date)
      setHolidayRangeAction(removing ? 'remove' : 'add')
      setHolidays((current) => removing ? current.filter((item) => item !== date) : [...current, date].sort())
    }
    setHolidayAnchor(date)
  }

  const setTaskCompletion = (taskId: number, completed: boolean) => {
    const completedOn = localToday()
    setTaskItems((current) => {
      const next = current.map((task) => ({ ...task }))
      const targetIndex = next.findIndex((task) => task.id === taskId)
      if (targetIndex < 0) return current

      const targetLevel = next[targetIndex].level
      let branchEnd = targetIndex + 1
      while (branchEnd < next.length && next[branchEnd].level > targetLevel) branchEnd += 1

      // A parent controls its entire branch; a leaf controls only itself.
      for (let index = targetIndex; index < branchEnd; index += 1) {
        const wasCompleted = next[index].completed ?? false
        next[index].completed = completed
        if (completed) {
          if (!wasCompleted || !next[index].plannedStartAtCompletion) {
            next[index].plannedStartAtCompletion = next[index].manualStartDate ?? scheduleById.get(next[index].id)?.startDate
          }
          if (!wasCompleted || !next[index].plannedEndAtCompletion) {
            next[index].plannedEndAtCompletion = next[index].manualEndDate ?? scheduleById.get(next[index].id)?.endDate
          }
          if (!wasCompleted || !next[index].actualStartDate) {
            next[index].actualStartDate = actualStartForCompletion(next[index], scheduleById.get(next[index].id)?.startDate, completedOn)
          }
          if (!wasCompleted || !next[index].actualEndDate) next[index].actualEndDate = completedOn
        } else {
          next[index].actualStartDate = undefined
          next[index].actualEndDate = undefined
          next[index].plannedStartAtCompletion = undefined
          next[index].plannedEndAtCompletion = undefined
        }
      }

      if (completed) {
        // Release placement dates on later unfinished tasks in this project so
        // an early actual finish can pull the remaining sequence forward.
        let projectEnd = targetIndex + 1
        while (projectEnd < next.length && next[projectEnd].level !== 0) projectEnd += 1
        for (let index = branchEnd; index < projectEnd; index += 1) {
          if (next[index].completed) continue
          next[index].manualStartDate = undefined
          next[index].manualEndDate = undefined
        }
      }

      // Recalculate every parent from the deepest one upward.
      for (let index = next.length - 2; index >= 0; index -= 1) {
        const level = next[index].level
        if (next[index + 1].level <= level) continue
        let end = index + 1
        while (end < next.length && next[end].level > level) end += 1
        const wasCompleted = next[index].completed ?? false
        const isCompleted = next.slice(index + 1, end).every((task) => task.completed)
        next[index].completed = isCompleted
        if (isCompleted) {
          if (!wasCompleted || !next[index].plannedStartAtCompletion) {
            next[index].plannedStartAtCompletion = next[index].manualStartDate ?? scheduleById.get(next[index].id)?.startDate
          }
          if (!wasCompleted || !next[index].plannedEndAtCompletion) {
            next[index].plannedEndAtCompletion = next[index].manualEndDate ?? scheduleById.get(next[index].id)?.endDate
          }
          if (!wasCompleted || !next[index].actualStartDate) {
            next[index].actualStartDate = actualStartForCompletion(next[index], scheduleById.get(next[index].id)?.startDate, completedOn)
          }
          if (!wasCompleted || !next[index].actualEndDate) next[index].actualEndDate = completedOn
        } else {
          next[index].actualStartDate = undefined
          next[index].actualEndDate = undefined
          next[index].plannedStartAtCompletion = undefined
          next[index].plannedEndAtCompletion = undefined
        }
      }

      return next
    })
  }

  const handleSelectedTaskKey = (event: React.KeyboardEvent, task: Task) => {
    if (editingId === task.id) return

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      reorderTask(task, event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      changeSelectedTaskLevels(task, event.shiftKey ? -1 : 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      setEditingId(task.id)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      if (event.shiftKey) deleteTaskBranch(task)
      else deleteTaskOnly(task)
    } else if (event.key === ' ') {
      event.preventDefault()
      setTaskCompletion(task.id, !(task.completed ?? false))
    } else if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const index = visibleTasks.findIndex((item) => item.id === task.id)
      const next = visibleTasks[Math.max(0, Math.min(visibleTasks.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))]
      if (next) selectTaskRange(next, true)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveTaskSelection(task, event.key === 'ArrowUp' ? -1 : 1)
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Schedule App v0.1</h1>
        <div className="header-actions">
          <span className={`save-status ${saveStatus}`} title={sharedJsonName ? `${sharedJsonName}にも自動保存します` : 'このPCの共通ローカルデータを使用します'}>
            {rememberedJsonHandle && !sharedJsonHandle
              ? `${sharedJsonName}へ再接続が必要`
              : saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? sharedJsonName ? `${sharedJsonName}に保存済み` : '共通データに保存済み' : '共通データに保存できません'}
          </span>
          <label>
            今日
          <input type="date" value={startDate} readOnly aria-label="今日の日付" title="全体の基準日は今日です。開始日はプロジェクトごとに設定します" />
          </label>
          <button className="settings-button" type="button" aria-label="設定を開く" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <section className={`workspace${viewMode === 'calendar' ? ' calendar-view' : ''}`} style={{ '--task-panel-width': `${taskPanelWidth}px` } as CSSProperties}>
        <div className="task-panel">
          <div className="task-title"><strong>タスク一覧</strong></div>
          <div className="panel-heading"><span>タスク</span><span>実行</span><span className="date-heading">開始<small>予定 / 実績</small></span><span className="date-heading">終了<small>予定 / 実績</small></span><span>日数</span></div>
          {visibleTasks.map((task, visibleIndex) => {
            const isProject = task.level === 0
            const isParent = parentTaskIds.has(task.id)
            const nextTask = visibleTasks[visibleIndex + 1]
            const isProjectEnd = !nextTask || nextTask.level === 0
            return (
            <div
              className={`task-row in-project${isProject ? ' project-row project-start' : ''}${isProjectEnd ? ' project-end' : ''}${isParent && !isProject ? ' parent-task' : ''}${!isParent ? ' leaf-task' : ''}${editingId === task.id ? ' editing' : ''}${selectedTaskIds.has(task.id) ? ' range-selected' : ''}${selectedId === task.id ? ' selected' : ''}${task.completed ? ' completed' : ''}${task.scheduleExcluded ? ' schedule-excluded' : ''}`}
              style={{ '--task-level': task.level, '--project-color': projectColorByTaskId.get(task.id) } as CSSProperties}
              key={task.id}
              onClick={(event) => selectTaskRange(task, event.shiftKey)}
              onKeyDown={(event) => handleSelectedTaskKey(event, task)}
            >
              <div className="row-leading">
                {parentTaskIds.has(task.id) ? (
                  <button type="button" aria-label={task.collapsed ? `${task.name}を展開` : `${task.name}を折りたたむ`} onClick={(event) => { event.stopPropagation(); setTaskItems((current) => current.map((item) => item.id === task.id ? { ...item, collapsed: !item.collapsed } : item)) }}>{task.collapsed ? '▸' : '▾'}</button>
                ) : <span />}
                <input
                  type="checkbox"
                  aria-label={`${task.name}を完了`}
                  checked={task.completed ?? false}
                  onChange={(event) => setTaskCompletion(task.id, event.target.checked)}
                />
              </div>
              <div className="task-name-cell">
                {editingId === task.id ? (
                  <input
                    ref={inputRef}
                    className="task-name-input"
                    value={task.name}
                    placeholder="タスク名を入力"
                    onChange={(event) => updateTaskName(task.id, event.target.value)}
                    onBlur={() => finishEditing(task)}
                    onKeyDown={(event) => {
                      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                        event.preventDefault()
                        reorderTask(task, event.key === 'ArrowUp' ? -1 : 1)
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        addTaskAfter(task, false)
                      } else if (event.key === 'Tab') {
                        event.preventDefault()
                        changeTaskLevel(task, event.shiftKey ? -1 : 1)
                      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault()
                        moveTaskSelection(task, event.key === 'ArrowUp' ? -1 : 1)
                      } else if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === event.currentTarget.value.length && !parentTaskIds.has(task.id)) {
                        event.preventDefault()
                        finishEditing(task)
                        setDurationEditingId(task.id)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        finishEditing(task)
                      }
                    }}
                  />
                ) : (
                  <button
                    className="task-name-button"
                    type="button"
                    data-task-id={task.id}
                    onClick={(event) => { event.stopPropagation(); selectTaskRange(task, event.shiftKey); if (!event.shiftKey) setEditingId(task.id) }}
                  >
                    {task.name}
                  </button>
                )}
                <button
                  className={`schedule-toggle${task.scheduleExcluded ? ' excluded' : ''}`}
                  type="button"
                  title={task.scheduleExcluded ? 'スケジュール計算へ戻す' : '日付を空にしてスケジュール計算から一時除外'}
                  onClick={(event) => { event.stopPropagation(); toggleScheduleExcluded(task) }}
                >{task.scheduleExcluded ? '日程に戻す' : '日程から除外'}</button>
              </div>
              {parentTaskIds.has(task.id) ? <select
                className="task-execution-select"
                aria-label={`${task.name}の子タスク実行方法`}
                title="このタスクの直下にある子タスクの実行方法"
                value={task.execution ?? 'default'}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation()
                  updateTaskExecution(task, event.target.value as 'default' | 'sequence' | 'parallel')
                }}
              >
                <option value="default">既定</option>
                <option value="sequence">順番</option>
                <option value="parallel">並列</option>
              </select> : <span className="task-execution-empty" aria-label="最下層タスクのため実行方法なし">—</span>}
              <div className="task-date-cell">
                <input
                  className="task-date-input"
                  type="date"
                  aria-label={`${task.name}の予定開始日`}
                  title="予定開始日。空欄に戻すと自動計算になります"
                  value={task.scheduleExcluded ? '' : parentTaskIds.has(task.id) ? scheduleById.get(task.id)?.startDate ?? '' : task.manualStartDate ?? task.plannedStartAtCompletion ?? scheduleById.get(task.id)?.startDate ?? ''}
                  disabled={task.scheduleExcluded}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => updatePlannedDate(task, 'start', event.target.value)}
                />
                <small className="actual-date" title={task.actualStartDate}>{task.completed ? shortDate(task.actualStartDate) : '—'}</small>
              </div>
              <div className="task-date-cell">
                <input
                  className="task-date-input"
                  type="date"
                  aria-label={`${task.name}の予定終了日`}
                  title="予定終了日。空欄に戻すと自動計算になります"
                  value={task.scheduleExcluded ? '' : parentTaskIds.has(task.id) ? scheduleById.get(task.id)?.endDate ?? '' : task.manualEndDate ?? task.plannedEndAtCompletion ?? scheduleById.get(task.id)?.endDate ?? ''}
                  disabled={task.scheduleExcluded}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => updatePlannedDate(task, 'end', event.target.value)}
                />
                <small className="actual-date" title={task.actualEndDate}>{task.completed ? shortDate(task.actualEndDate) : '—'}</small>
              </div>
              {parentTaskIds.has(task.id) ? (
                <span className="auto-duration">{scheduleById.get(task.id)?.days ?? 0}日 <small>自動</small></span>
              ) : durationEditingId === task.id ? (
                <div
                  className="duration-editor"
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      commitDuration(task)
                      setDurationEditingId((current) => current === task.id ? null : current)
                    }
                  }}
                >
                  <input
                    ref={durationRef}
                    type="number"
                    min={task.unit === 'day' ? 1 : 0.5}
                    step={task.unit === 'day' ? 1 : 0.5}
                    value={durationDraft}
                    aria-label={`${task.name}の所要期間`}
                    onChange={(event) => setDurationDraft(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                        event.preventDefault()
                        reorderTask(task, event.key === 'ArrowUp' ? -1 : 1)
                      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault()
                        adjustDuration(task, event.key === 'ArrowUp' ? 1 : -1)
                      } else if (event.key === 'ArrowLeft') {
                        event.preventDefault()
                        commitDuration(task)
                        setDurationEditingId(null)
                        setEditingId(task.id)
                      } else if (event.key === 'ArrowRight') {
                        event.preventDefault()
                        toggleDurationUnit(task)
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        commitDuration(task)
                        moveDurationEditing(task, event.shiftKey ? -1 : 1)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        commitDuration(task)
                        setDurationEditingId(null)
                      }
                    }}
                  />
                  <button type="button" onClick={() => toggleDurationUnit(task)}>{task.unit === 'day' ? '日' : '週'}</button>
                </div>
              ) : (
                <button className="duration-button" type="button" onClick={(event) => { event.stopPropagation(); setSelectedId(task.id); setDurationEditingId(task.id) }}>{durationLabel(task)}</button>
              )}
              <button className="delete-task" type="button" aria-label={`${task.name}だけを削除`} onClick={(event) => { event.stopPropagation(); deleteTaskOnly(task) }}>×</button>
            </div>
            )
          })}
          <div className="add-actions">
            <select aria-label="新しいプロジェクトのプリセット" value={newProjectPresetId} onChange={(event) => setNewProjectPresetId(event.target.value)}>
              <option value="">空のプロジェクト</option>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
            <button className="add-task" type="button" onClick={addTitleTask}>＋ プロジェクト追加</button>
            <button className="add-task" type="button" onClick={addRootTask}>＋ タスク追加</button>
          </div>
        </div>
        <div
          className="panel-resizer"
          role="separator"
          aria-label="タスク一覧とスケジュールの幅を変更"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const left = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0
            setTaskPanelWidth(Math.max(560, Math.min(1200, event.clientX - left)))
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onDoubleClick={() => setTaskPanelWidth(780)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setTaskPanelWidth((current) => Math.max(560, Math.min(1200, current + (event.key === 'ArrowLeft' ? -20 : 20))))
          }}
        />
        <div className={`gantt-panel${viewMode === 'calendar' ? ' calendar-mode' : ''}`}>
          <div className="gantt-title">
            <strong>{viewMode === 'gantt' ? 'ガントチャート' : 'カレンダー'}</strong>
            <div className="view-switch" aria-label="表示方法">
              <button className={viewMode === 'gantt' ? 'active' : ''} type="button" onClick={() => setViewMode('gantt')}>ガント</button>
              <button className={viewMode === 'calendar' ? 'active' : ''} type="button" onClick={() => setViewMode('calendar')}>カレンダー</button>
              <button className={holidayEditMode ? 'active holiday-mode' : ''} type="button" aria-pressed={holidayEditMode} onClick={() => {
                setHolidayEditMode((current) => !current)
                setHolidayAnchor('')
                setHolidayRangeAction(null)
              }}>休日編集</button>
              <button className={hideCompletedProjects ? 'active filter-active' : ''} type="button" aria-pressed={hideCompletedProjects} onClick={() => setHideCompletedProjects((current) => !current)}>完了を隠す</button>
              <button className={hideFutureProjects ? 'active filter-active' : ''} type="button" aria-pressed={hideFutureProjects} onClick={() => setHideFutureProjects((current) => !current)}>開始前を隠す</button>
            </div>
          </div>
          {viewMode === 'gantt' ? (
            <>
              <div className="calendar-axis" style={{ width: timelineWidth }}>
                <div className="week-axis" style={{ gridTemplateColumns: schedule.weeks.map((week) => `${week.days}fr`).join(' ') }}>
                  {schedule.weeks.map((week) => <span key={week.label}>{week.label}</span>)}
                </div>
                <div className="date-axis" style={{ gridTemplateColumns: `repeat(${schedule.workdays.length}, 1fr)` }}>
                  {schedule.workdays.map((date, index) => <span
                    className={`${weekStartIndexes.has(index) ? 'week-start ' : ''}${schedule.isoDates[index] === today ? 'today ' : ''}${holidayEditMode ? 'holiday-editable' : ''}`}
                    key={`${date}-${index}`}
                    title={holidayEditMode ? 'クリックで休日。Shift＋クリックで範囲指定' : undefined}
                    onClick={(event) => { if (holidayEditMode) selectHolidayOnSchedule(schedule.isoDates[index], event.shiftKey) }}
                  >{date}</span>)}
                </div>
              </div>
              {visibleTasks.map((task, visibleIndex) => {
                const item = scheduleById.get(task.id)
                const nextTask = visibleTasks[visibleIndex + 1]
                const isProjectStart = task.level === 0
                const isProjectEnd = !nextTask || nextTask.level === 0
                return (
                <div className={`gantt-row${isProjectStart ? ' project-start' : ''}${isProjectEnd ? ' project-end' : ''}${selectedId === task.id ? ' selected' : ''}`} key={task.id} style={{ '--columns': schedule.workdays.length, '--project-color': projectColorByTaskId.get(task.id), width: timelineWidth } as React.CSSProperties}>
                  {[...weekStartIndexes].map((index) => (
                    <span className="week-line" key={index} style={{ left: `${(index / schedule.workdays.length) * 100}%` }} />
                  ))}
                  {todayIndex >= 0 && <span className="today-line" style={{ left: `${((todayIndex + 0.5) / schedule.workdays.length) * 100}%` }} />}
                  {item && item.days > 0 && <div
                    className={`gantt-bar${item.parent ? ' parent-bar' : ''}${item.completed ? ' completed' : ''}`}
                    style={{
                      left: `${(item.start / schedule.workdays.length) * 100}%`,
                      width: `${(item.days / schedule.workdays.length) * 100}%`,
                      backgroundColor: item.completed ? undefined : projectColorByTaskId.get(task.id),
                    }}
                    aria-label={`${item.name}、${item.days}営業日`}
                    onClick={() => {
                      setSelectedId(task.id)
                      setSelectionAnchorId(task.id)
                      setSelectedTaskIds(new Set([task.id]))
                    }}
                  >
                    {!item.parent && item.name}
                  </div>}
                </div>
                )
              })}
            </>
          ) : (
            <div className="month-calendar">
              <div className="calendar-weekday-row">
                {['日', '月', '火', '水', '木', '金', '土'].map((day, index) => <div className={`calendar-weekday${index === 0 ? ' sunday' : index === 6 ? ' saturday' : ''}`} key={day}>{day}</div>)}
              </div>
              {calendarWeeks.map((week, weekIndex) => (
                <div className="calendar-week" key={weekIndex}>
                  <div className="calendar-date-row">
                    {week.days.map((date) => (
                      <div
                        className={`calendar-day${date.getDay() === 0 ? ' weekend sunday' : date.getDay() === 6 ? ' weekend saturday' : ''}${holidaySet.has(localDateKey(date)) ? ' holiday' : ''}${localDateKey(date) === today ? ' today' : ''}${holidayEditMode ? ' holiday-editable' : ''}`}
                        key={date.toISOString()}
                        title={holidayEditMode ? 'クリックで休日を切替。Shift＋クリックで範囲指定' : undefined}
                        onClick={(event) => { if (holidayEditMode) selectHolidayOnSchedule(localDateKey(date), event.shiftKey) }}
                      >
                        <div className="calendar-date">{date.getMonth() + 1}/{date.getDate()}</div>
                      </div>
                    ))}
                  </div>
                  <div className="calendar-bars">
                    {week.segments.map(({ task, start, span }) => (
                      <div className={`calendar-task${task.completed ? ' completed' : ''}${selectedId === task.id ? ' selected' : ''}`} key={task.id} style={{ gridColumn: `${start} / span ${span}`, backgroundColor: task.completed ? undefined : projectColorByTaskId.get(task.id), borderColor: projectColorByTaskId.get(task.id) }} title={task.name} onClick={() => {
                        setSelectedId(task.id)
                        setSelectionAnchorId(task.id)
                        setSelectedTaskIds(new Set([task.id]))
                      }}>{task.name}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      {settingsOpen && (
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-heading">
              <h2 id="settings-title">スケジュール設定</h2>
              <button type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <label className="setting-field">
              プロジェクト全体の実行方法
              <select value={projectsParallel ? 'parallel' : 'sequence'} onChange={(event) => setProjectsParallel(event.target.value === 'parallel')}>
                <option value="sequence">上から順番に実行</option>
                <option value="parallel">同時に並列実行</option>
              </select>
            </label>
            <p className="setting-note">最上位の各プロジェクトを、順番または並列で配置します。</p>
            <label className="setting-field">
              子タスクの既定の実行方法
              <select value={parallel ? 'parallel' : 'sequence'} onChange={(event) => setParallel(event.target.value === 'parallel')}>
                <option value="sequence">上から順番に実行</option>
                <option value="parallel">同時に並列実行</option>
              </select>
            </label>
            <p className="setting-note">個別指定がない親タスクに適用されます。</p>
            <div className="holiday-settings">
              <h3>休日設定</h3>
              <p className="setting-note">土日に加えて、祝日や任意の休業日を営業日計算から除外します。</p>
              <div className="holiday-add-row">
                <label><span>開始</span><input type="date" value={holidayDraft} onChange={(event) => {
                  setHolidayDraft(event.target.value)
                  if (holidayEndDraft && event.target.value > holidayEndDraft) setHolidayEndDraft(event.target.value)
                }} /></label>
                <label><span>終了（省略可）</span><input type="date" min={holidayDraft || undefined} value={holidayEndDraft} onChange={(event) => setHolidayEndDraft(event.target.value)} /></label>
                <button type="button" disabled={!holidayDraft} onClick={addHolidayRange}>{holidayEndDraft && holidayEndDraft !== holidayDraft ? '範囲を休日に追加' : '1日を休日に追加'}</button>
              </div>
              <div className="holiday-list">
                {holidays.length === 0 ? <span className="setting-note">追加の休日はありません。</span> : holidays.map((date) => (
                  <span className="holiday-chip" key={date}>{date}<button type="button" aria-label={`${date}を休日から削除`} onClick={() => setHolidays((current) => current.filter((item) => item !== date))}>×</button></span>
                ))}
              </div>
              <div className="holiday-ics-tools">
                <button type="button" onClick={() => icsImportRef.current?.click()}>休日ICSを取り込む</button>
                {lastIcsImport && <button type="button" onClick={undoLastIcsImport}>「{lastIcsImport.name}」の取り込みを元に戻す</button>}
                <input ref={icsImportRef} type="file" accept="text/calendar,.ics" hidden onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importHolidayIcs(file)
                }} />
                <span className="setting-note">ICS内の予定日を休日として追加します。</span>
              </div>
            </div>
            {projectTasks.length > 0 && (
              <div className="project-start-settings">
                <h3>プロジェクトごとの開始日</h3>
                <p className="setting-note">未指定の場合は全体の開始日を使います。</p>
                {projectTasks.map((task) => (
                  <label key={task.id}>
                    <span>{task.name}</span>
                    <input type="color" aria-label={`${task.name}の色`} value={task.projectColor ?? projectColorByTaskId.get(task.id) ?? '#2563eb'} onChange={(event) => setTaskItems((current) => current.map((item) => item.id === task.id ? { ...item, projectColor: event.target.value } : item))} />
                    <input
                      type="date"
                      value={scheduleById.get(task.id)?.startDate ?? task.projectStartDate ?? ''}
                      onChange={(event) => setTaskItems((current) => current.map((item) => item.id === task.id ? { ...item, projectStartDate: event.target.value || undefined } : item))}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="preset-settings">
              <h3>プロジェクトプリセット</h3>
              <p className="setting-note">既存プロジェクトのタスク構成を、日付・完了状態を除いて再利用します。</p>
              <div className="preset-create-row">
                <select value={presetSourceId} onChange={(event) => {
                  setPresetSourceId(event.target.value)
                  const project = projectTasks.find((item) => item.id === Number(event.target.value))
                  if (project) setPresetName(project.name)
                }}>
                  <option value="">元にするプロジェクトを選択</option>
                  {projectTasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
                </select>
                <input type="text" placeholder="プリセット名" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                <button type="button" disabled={!presetSourceId} onClick={saveProjectPreset}>プリセットとして保存</button>
              </div>
              <div className="preset-list">
                {presets.length === 0 ? <span className="setting-note">保存済みプリセットはありません。</span> : presets.map((preset) => (
                  <span className="preset-chip" key={preset.id}>{preset.name}<small>{preset.tasks.length}件</small><button type="button" onClick={() => setEditingPresetId((current) => current === preset.id ? '' : preset.id)}>編集</button><button type="button" aria-label={`${preset.name}を削除`} onClick={() => {
                    setPresets((current) => current.filter((item) => item.id !== preset.id))
                    setNewProjectPresetId((current) => current === preset.id ? '' : current)
                    setEditingPresetId((current) => current === preset.id ? '' : current)
                  }}>×</button></span>
                ))}
              </div>
              {presets.filter((preset) => preset.id === editingPresetId).map((preset) => (
                <div className="preset-editor" key={preset.id}>
                  <label>プリセット名<input value={preset.name} onChange={(event) => updatePreset(preset.id, (current) => ({ ...current, name: event.target.value }))} /></label>
                  <div className="preset-editor-heading"><span>タスク名</span><span>階層</span><span>日数</span><span>単位</span><span>実行</span><span /></div>
                  {preset.tasks.map((task, index) => {
                    const isParent = preset.tasks[index + 1]?.level > task.level
                    return <div className="preset-task-row" key={index}>
                      <input value={task.name} style={{ paddingLeft: `${8 + Math.max(0, task.level - 1) * 14}px` }} onChange={(event) => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} />
                      <div className="preset-level-buttons"><button type="button" disabled={task.level <= 1} onClick={() => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, level: item.level - 1 } : item) }))}>−</button><span>{task.level}</span><button type="button" disabled={index === 0 || task.level >= preset.tasks[index - 1].level + 1} onClick={() => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, level: item.level + 1 } : item) }))}>＋</button></div>
                      <input type="number" min="0.5" step={task.unit === 'week' ? '0.5' : '1'} value={task.unit === 'week' ? task.weekValue ?? task.days / 5 : task.dayValue ?? task.days} onChange={(event) => {
                        const value = Math.max(task.unit === 'week' ? 0.5 : 1, Number(event.target.value) || 1)
                        updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, days: task.unit === 'week' ? value * 5 : value, ...(task.unit === 'week' ? { weekValue: value } : { dayValue: value }) } : item) }))
                      }} />
                      <select value={task.unit} onChange={(event) => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value as 'day' | 'week', days: event.target.value === 'week' ? (item.weekValue ?? 1) * 5 : item.dayValue ?? 1 } : item) }))}><option value="day">日</option><option value="week">週</option></select>
                      {isParent ? <select value={task.execution ?? 'default'} onChange={(event) => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.map((item, itemIndex) => itemIndex === index ? { ...item, execution: event.target.value === 'default' ? undefined : event.target.value as 'sequence' | 'parallel' } : item) }))}><option value="default">既定</option><option value="sequence">順番</option><option value="parallel">並列</option></select> : <span>—</span>}
                      <button type="button" aria-label={`${task.name}を削除`} onClick={() => updatePreset(preset.id, (current) => ({ ...current, tasks: current.tasks.filter((_, itemIndex) => itemIndex !== index) }))}>×</button>
                    </div>
                  })}
                  <div className="preset-editor-actions"><button type="button" onClick={() => updatePreset(preset.id, (current) => ({ ...current, tasks: [...current.tasks, { name: '新しいタスク', days: 1, level: 1, unit: 'day', dayValue: 1, weekValue: 1 }] }))}>＋ タスク追加</button><button type="button" onClick={() => setEditingPresetId('')}>編集を閉じる</button></div>
                </div>
              ))}
            </div>
            <div className="data-tools">
              <h3>バックアップ</h3>
              <p className="setting-note">タスクと設定をJSONファイルに保存・復元します。</p>
              <p className="setting-note">共有JSONを選ぶと選択先を記憶し、再表示後もアクセス権が残っていれば自動で読み込みます。権限が切れた場合は同じファイルをもう一度選択してください。</p>
              <p className="setting-note">複数PCからの同時編集には対応していません。最後に保存した内容が優先されます。</p>
              <div>
                <button type="button" onClick={() => void selectSharedJson()}>共有JSONを選択</button>
                {rememberedJsonHandle && !sharedJsonHandle && <button type="button" onClick={() => void reconnectSharedJson()}>前回の共有JSONへ再接続</button>}
                {sharedJsonHandle && <button type="button" onClick={() => void loadSharedJson(sharedJsonHandle, true)}>共有JSONを再読込</button>}
                <button type="button" onClick={exportBackup}>JSONをエクスポート</button>
                <button type="button" onClick={() => importRef.current?.click()}>JSONをインポート</button>
                <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file) }} />
              </div>
              {sharedJsonName && <p className="shared-json-name">選択中: {sharedJsonName}</p>}
            </div>
            <details className="shortcut-help">
              <summary>キーボードショートカット</summary>
              <dl>
                <div><dt>Enter</dt><dd>次のタスク／次の日数欄</dd></div>
                <div><dt>Tab・Shift＋Tab</dt><dd>階層を下げる／上げる</dd></div>
                <div><dt>↑・↓</dt><dd>タスク移動／日数の増減</dd></div>
                <div><dt>←・→</dt><dd>タスク名と日数を移動／日・週切替</dd></div>
                <div><dt>Alt＋↑・↓</dt><dd>タスクを並べ替える</dd></div>
                <div><dt>Delete</dt><dd>タスクだけ削除</dd></div>
                <div><dt>Shift＋Delete</dt><dd>子タスクごと削除</dd></div>
                <div><dt>Esc</dt><dd>編集を終了</dd></div>
              </dl>
            </details>
            <button className="close-settings" type="button" onClick={() => setSettingsOpen(false)}>完了</button>
          </section>
        </div>
      )}
    </main>
  )
}
