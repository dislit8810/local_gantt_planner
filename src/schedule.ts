import type { Task } from './App'

type Node = { task: Task; children: Node[] }
export type ScheduleRow = { id: number; name: string; start: number; days: number; parent: boolean; completed: boolean }

function buildTree(tasks: Task[]) {
  const roots: Node[] = []
  const stack: Node[] = []
  for (const task of tasks) {
    const node: Node = { task, children: [] }
    // The stack length is the level where the next node would be inserted.
    // Pop only when it is deeper than the incoming task. Using >= here makes
    // a level-0 title loop forever because an empty stack still has length 0.
    while (stack.length > task.level) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

function isBusinessDay(date: Date, holidays: Set<string>) {
  return date.getDay() !== 0 && date.getDay() !== 6 && !holidays.has(localDateKey(date))
}

function addBusinessDays(date: Date, count: number, holidays: Set<string>) {
  const result = new Date(date)
  let added = 0
  while (added < count) {
    if (isBusinessDay(result, holidays)) added += 1
    if (added < count) result.setDate(result.getDate() + 1)
  }
  return result
}

function mondayOf(date: Date) {
  const result = new Date(date)
  const day = result.getDay() || 7
  result.setDate(result.getDate() - day + 1)
  return result
}

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function nextBusinessDay(date: Date, holidays: Set<string>) {
  const result = new Date(date)
  while (!isBusinessDay(result, holidays)) result.setDate(result.getDate() + 1)
  return result
}

function businessDayOffset(origin: Date, target: Date, holidays: Set<string>) {
  const normalizedTarget = nextBusinessDay(target, holidays)
  const cursor = new Date(origin)
  let offset = 0
  while (localDateKey(cursor) < localDateKey(normalizedTarget)) {
    cursor.setDate(cursor.getDate() + 1)
    if (isBusinessDay(cursor, holidays)) offset += 1
  }
  return offset
}

function businessDayEndOffset(origin: Date, target: Date, holidays: Set<string>) {
  const offset = businessDayOffset(origin, target, holidays)
  return isBusinessDay(target, holidays) ? offset + 1 : offset
}

export function calculateSchedule(tasks: Task[], parallelChildren: boolean, parallelProjects: boolean, startDateText: string, holidayDates: string[] = []) {
  const holidays = new Set(holidayDates)
  const rows = new Map<number, ScheduleRow>()
  const roots = buildTree(tasks)
  const requestedStartDates = [
    startDateText,
    ...roots.map((root) => root.task.projectStartDate).filter(Boolean) as string[],
    ...tasks.filter((task, index) => !tasks[index + 1] || tasks[index + 1].level <= task.level).map((task) => task.manualStartDate).filter(Boolean) as string[],
    ...tasks.map((task) => task.actualStartDate).filter(Boolean) as string[],
  ]
  const originText = requestedStartDates.sort()[0] ?? startDateText
  const startDate = nextBusinessDay(new Date(`${originText}T00:00:00`), holidays)

  const scheduleNode = (node: Node, start: number): number => {
    const scheduledStart = node.children.length === 0 && node.task.manualStartDate
      ? businessDayOffset(startDate, new Date(`${node.task.manualStartDate}T00:00:00`), holidays)
      : start

    if (node.children.length === 0) {
      if (node.task.completed) {
        if (!node.task.actualEndDate) {
          rows.set(node.task.id, { id: node.task.id, name: node.task.name, start: scheduledStart, days: 0, parent: false, completed: true })
          return start
        }
        const actualStart = node.task.actualStartDate
          ? businessDayOffset(startDate, new Date(`${node.task.actualStartDate}T00:00:00`), holidays)
          : scheduledStart
        const actualEnd = businessDayEndOffset(startDate, new Date(`${node.task.actualEndDate}T00:00:00`), holidays)
        const end = Math.max(actualStart + 0.5, actualEnd)
        rows.set(node.task.id, { id: node.task.id, name: node.task.name, start: actualStart, days: end - actualStart, parent: false, completed: true })
        return Math.max(start, end)
      }
      const automaticDays = Math.max(0.5, node.task.days || 1)
      const requestedEnd = node.task.manualEndDate
        ? businessDayEndOffset(startDate, new Date(`${node.task.manualEndDate}T00:00:00`), holidays)
        : scheduledStart + automaticDays
      const end = Math.max(scheduledStart + automaticDays, requestedEnd)
      rows.set(node.task.id, { id: node.task.id, name: node.task.name, start: scheduledStart, days: end - scheduledStart, parent: false, completed: node.task.completed ?? false })
      return Math.max(start, end)
    }

    let end = scheduledStart
    const runInParallel = node.task.execution ? node.task.execution === 'parallel' : parallelChildren
    if (runInParallel) {
      end = Math.max(...node.children.map((child) => scheduleNode(child, scheduledStart)))
    } else {
      for (const child of node.children) end = scheduleNode(child, end)
    }
    if (node.task.completed && node.task.actualEndDate) {
      const actualStart = node.task.actualStartDate
        ? businessDayOffset(startDate, new Date(`${node.task.actualStartDate}T00:00:00`), holidays)
        : scheduledStart
      const actualEnd = businessDayEndOffset(startDate, new Date(`${node.task.actualEndDate}T00:00:00`), holidays)
      const completedEnd = Math.max(actualStart + 0.5, actualEnd)
      rows.set(node.task.id, { id: node.task.id, name: node.task.name, start: actualStart, days: completedEnd - actualStart, parent: true, completed: true })
      return Math.max(start, completedEnd)
    }
    const childRows = node.children.map((child) => rows.get(child.task.id)).filter(Boolean) as ScheduleRow[]
    const aggregateStart = childRows.length ? Math.min(...childRows.map((row) => row.start)) : scheduledStart
    const aggregateEnd = childRows.length ? Math.max(...childRows.map((row) => row.start + row.days)) : end
    rows.set(node.task.id, { id: node.task.id, name: node.task.name, start: aggregateStart, days: Math.max(0, aggregateEnd - aggregateStart), parent: true, completed: node.task.completed ?? false })
    return Math.max(start, end)
  }

  let projectEnd = 0
  if (parallelProjects) {
    projectEnd = Math.max(0, ...roots.map((root) => {
      const requested = root.task.completed ? 0 : businessDayOffset(startDate, new Date(`${root.task.projectStartDate ?? startDateText}T00:00:00`), holidays)
      return scheduleNode(root, requested)
    }))
  } else {
    for (const root of roots) {
      const requested = root.task.completed ? projectEnd : businessDayOffset(startDate, new Date(`${root.task.projectStartDate ?? startDateText}T00:00:00`), holidays)
      projectEnd = scheduleNode(root, Math.max(projectEnd, requested))
    }
  }
  const columnCount = Math.max(14, Math.ceil(projectEnd))
  const dates = Array.from({ length: columnCount }, (_, index) => addBusinessDays(startDate, index + 1, holidays))
  const workdays = dates.map((date) => `${date.getMonth() + 1}/${date.getDate()}`)
  const weeks: { label: string; days: number }[] = []
  for (const date of dates) {
    const monday = mondayOf(date)
    const label = `${monday.getMonth() + 1}/${monday.getDate()} の週`
    const last = weeks.at(-1)
    if (last?.label === label) last.days += 1
    else weeks.push({ label, days: 1 })
  }

  return {
    originDate: localDateKey(startDate),
    isoDates: dates.map(localDateKey),
    workdays,
    weeks,
    rows: tasks.map((task) => rows.get(task.id)!).filter(Boolean).map((row) => ({
      ...row,
      startDate: row.days > 0 ? localDateKey(dates[Math.floor(row.start)]) : undefined,
      endDate: row.days > 0 ? localDateKey(dates[Math.min(dates.length - 1, Math.ceil(row.start + row.days) - 1)]) : undefined,
    })),
  }
}
