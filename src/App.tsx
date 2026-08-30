import { useEffect, useMemo, useRef, useState } from 'react'
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
}

type BackupPayload = {
  schemaVersion: 1
  exportedAt: string
  tasks: Task[]
  settings: { parallel: boolean; projectsParallel: boolean; startDate: string }
}

const rememberedDayValue = (task: Task) => task.dayValue ?? (task.unit === 'day' && task.days > 0 ? task.days : 1)
const rememberedWeekValue = (task: Task) => task.weekValue ?? (task.unit === 'week' && task.days > 0 ? task.days / 5 : 1)
const tasksStorageKey = 'schedule-app.tasks.v1'
const settingsStorageKey = 'schedule-app.settings.v1'

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
    return stored ? JSON.parse(stored) as { parallel?: boolean; projectsParallel?: boolean; startDate?: string } : {}
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
  const [startDate, setStartDate] = useState(storedSettings.startDate ?? '2026-09-01')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [taskItems, setTaskItems] = useState<Task[]>(loadStoredTasks)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<number | null>(null)
  const [durationEditingId, setDurationEditingId] = useState<number | null>(null)
  const [durationDraft, setDurationDraft] = useState('')
  const [viewMode, setViewMode] = useState<'gantt' | 'calendar'>('gantt')
  const inputRef = useRef<HTMLInputElement>(null)
  const durationRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const schedule = useMemo(() => calculateSchedule(taskItems, parallel, projectsParallel, startDate), [taskItems, parallel, projectsParallel, startDate])
  const weekStartIndexes = useMemo(() => {
    let total = 0
    return new Set(schedule.weeks.slice(0, -1).map((week) => {
      total += week.days
      return total
    }))
  }, [schedule.weeks])
  const timelineWidth = Math.max(720, schedule.workdays.length * 48)
  const parentTasks = taskItems.filter((task, index) => taskItems[index + 1]?.level > task.level)
  const parentTaskIds = new Set(parentTasks.map((task) => task.id))
  const scheduleById = new Map(schedule.rows.map((row) => [row.id, row]))
  const visibleTasks = taskItems.filter((task, index) => {
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

  const exportBackup = () => {
    const payload: BackupPayload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tasks: taskItems,
      settings: { parallel, projectsParallel, startDate },
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
      if (payload.schemaVersion !== 1 || !Array.isArray(payload.tasks)) throw new Error('対応していないバックアップ形式です。')
      if (!confirm('現在のタスクと設定を、選択したバックアップで置き換えますか？')) return
      const normalized = payload.tasks.map((task) => ({
        ...task,
        dayValue: rememberedDayValue(task),
        weekValue: rememberedWeekValue(task),
        completed: task.completed ?? false,
      }))
      setTaskItems(normalized)
      setParallel(payload.settings?.parallel ?? true)
      setProjectsParallel(payload.settings?.projectsParallel ?? false)
      setStartDate(payload.settings?.startDate ?? '2026-09-01')
      setEditingId(null)
      setDurationEditingId(null)
      setSelectedId(null)
      setSelectedTaskIds(new Set())
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
    localStorage.setItem(tasksStorageKey, JSON.stringify(taskItems))
  }, [taskItems])

  useEffect(() => {
    localStorage.setItem(settingsStorageKey, JSON.stringify({ parallel, projectsParallel, startDate }))
  }, [parallel, projectsParallel, startDate])

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
    setTaskItems((current) => [...current, { id, name: '', days: 1, level: 0, unit: 'day', dayValue: 1, weekValue: 1, completed: false }])
    setEditingId(id)
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
        return [...current.slice(0, previousStart), ...currentBlock, ...previousBlock, ...current.slice(end)]
      }

      if (end >= current.length || current[end].level !== task.level) return current
      let nextEnd = end + 1
      while (nextEnd < current.length && current[nextEnd].level > task.level) nextEnd += 1
      const nextBlock = current.slice(end, nextEnd)
      return [...current.slice(0, start), ...nextBlock, ...currentBlock, ...current.slice(nextEnd)]
    })
  }

  const updateDuration = (task: Task, displayedValue: number) => {
    const minimum = task.unit === 'day' ? 1 : 0.5
    const safeValue = Math.max(minimum, displayedValue || minimum)
    const days = task.unit === 'day' ? safeValue : safeValue * 5
    setTaskItems((current) => current.map((item) => item.id === task.id
      ? task.unit === 'day'
        ? { ...item, days, dayValue: safeValue }
        : { ...item, days, weekValue: safeValue }
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
          ? { ...item, unit: 'week', days: rememberedWeekValue(item) * 5 }
          : { ...item, unit: 'day', days: rememberedDayValue(item) }
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

  const setTaskCompletion = (taskId: number, completed: boolean) => {
    setTaskItems((current) => {
      const next = current.map((task) => ({ ...task }))
      const targetIndex = next.findIndex((task) => task.id === taskId)
      if (targetIndex < 0) return current

      const targetLevel = next[targetIndex].level
      let branchEnd = targetIndex + 1
      while (branchEnd < next.length && next[branchEnd].level > targetLevel) branchEnd += 1

      // A parent controls its entire branch; a leaf controls only itself.
      for (let index = targetIndex; index < branchEnd; index += 1) {
        next[index].completed = completed
      }

      // Recalculate every parent from the deepest one upward.
      for (let index = next.length - 2; index >= 0; index -= 1) {
        const level = next[index].level
        if (next[index + 1].level <= level) continue
        let end = index + 1
        while (end < next.length && next[end].level > level) end += 1
        next[index].completed = next.slice(index + 1, end).every((task) => task.completed)
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
          <label>
            開始日
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <button className="settings-button" type="button" aria-label="設定を開く" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <section className="workspace">
        <div className="task-panel">
          <div className="task-title"><strong>タスク一覧</strong></div>
          <div className="panel-heading"><span>タスク</span><span>日数</span></div>
          {visibleTasks.map((task) => (
            <div
              className={`task-row${editingId === task.id ? ' editing' : ''}${selectedTaskIds.has(task.id) ? ' range-selected' : ''}${selectedId === task.id ? ' selected' : ''}${task.completed ? ' completed' : ''}`}
              style={{ paddingLeft: 18 + task.level * 22 }}
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
          ))}
          <div className="add-actions"><button className="add-task" type="button" onClick={addTitleTask}>＋ プロジェクト追加</button><button className="add-task" type="button" onClick={addRootTask}>＋ タスク追加</button></div>
        </div>
        <div className="gantt-panel">
          <div className="gantt-title">
            <strong>{viewMode === 'gantt' ? 'ガントチャート' : 'カレンダー'}</strong>
            <div className="view-switch" aria-label="表示方法">
              <button className={viewMode === 'gantt' ? 'active' : ''} type="button" onClick={() => setViewMode('gantt')}>ガント</button>
              <button className={viewMode === 'calendar' ? 'active' : ''} type="button" onClick={() => setViewMode('calendar')}>カレンダー</button>
            </div>
          </div>
          {viewMode === 'gantt' ? (
            <>
              <div className="calendar-axis" style={{ width: timelineWidth }}>
                <div className="week-axis" style={{ gridTemplateColumns: schedule.weeks.map((week) => `${week.days}fr`).join(' ') }}>
                  {schedule.weeks.map((week) => <span key={week.label}>{week.label}</span>)}
                </div>
                <div className="date-axis" style={{ gridTemplateColumns: `repeat(${schedule.workdays.length}, 1fr)` }}>
                  {schedule.workdays.map((date, index) => <span className={weekStartIndexes.has(index) ? 'week-start' : ''} key={`${date}-${index}`}>{date}</span>)}
                </div>
              </div>
              {schedule.rows.filter((item) => visibleTaskIds.has(item.id)).map((item) => (
                <div className="gantt-row" key={item.id} style={{ '--columns': schedule.workdays.length, width: timelineWidth } as React.CSSProperties}>
                  {[...weekStartIndexes].map((index) => (
                    <span className="week-line" key={index} style={{ left: `${(index / schedule.workdays.length) * 100}%` }} />
                  ))}
                  <div
                    className={`gantt-bar${item.parent ? ' parent-bar' : ''}${item.completed ? ' completed' : ''}`}
                    style={{
                      left: `${(item.start / schedule.workdays.length) * 100}%`,
                      width: `${(item.days / schedule.workdays.length) * 100}%`,
                    }}
                    aria-label={`${item.name}、${item.days}営業日`}
                  >
                    {!item.parent && item.name}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div className="month-calendar">
              <div className="calendar-weekday-row">
                {['日', '月', '火', '水', '木', '金', '土'].map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
              </div>
              {calendarWeeks.map((week, weekIndex) => (
                <div className="calendar-week" key={weekIndex}>
                  <div className="calendar-date-row">
                    {week.days.map((date) => (
                      <div className={`calendar-day${date.getDay() === 0 || date.getDay() === 6 ? ' weekend' : ''}`} key={date.toISOString()}>
                        <div className="calendar-date">{date.getMonth() + 1}/{date.getDate()}</div>
                      </div>
                    ))}
                  </div>
                  <div className="calendar-bars">
                    {week.segments.map(({ task, start, span }) => (
                      <div className={`calendar-task${task.completed ? ' completed' : ''}`} key={task.id} style={{ gridColumn: `${start} / span ${span}` }} title={task.name}>{task.name}</div>
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
            {parentTasks.length > 0 && (
              <div className="parent-settings">
                <h3>親タスクごとの実行方法</h3>
                {parentTasks.map((task) => (
                  <label key={task.id}>
                    <span>{task.name}</span>
                    <select
                      value={task.execution ?? 'default'}
                      onChange={(event) => setTaskItems((current) => current.map((item) =>
                        item.id === task.id
                          ? { ...item, execution: event.target.value === 'default' ? undefined : event.target.value as 'sequence' | 'parallel' }
                          : item,
                      ))}
                    >
                      <option value="default">既定に従う</option>
                      <option value="sequence">順番</option>
                      <option value="parallel">並列</option>
                    </select>
                  </label>
                ))}
              </div>
            )}
            <div className="data-tools">
              <h3>バックアップ</h3>
              <p className="setting-note">タスクと設定をJSONファイルに保存・復元します。</p>
              <div>
                <button type="button" onClick={exportBackup}>JSONをエクスポート</button>
                <button type="button" onClick={() => importRef.current?.click()}>JSONをインポート</button>
                <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file) }} />
              </div>
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
