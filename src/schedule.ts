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

function addBusinessDays(date: Date, count: number) {
  const result = new Date(date)
  let added = 0
  while (added < count) {
    if (result.getDay() !== 0 && result.getDay() !== 6) added += 1
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

export function calculateSchedule(tasks: Task[], parallelChildren: boolean, parallelProjects: boolean, startDateText: string) {
  const rows = new Map<number, ScheduleRow>()
  const roots = buildTree(tasks)

  const scheduleNode = (node: Node, start: number): number => {
    if (node.children.length === 0) {
      const days = Math.max(0.5, node.task.days || 1)
      rows.set(node.task.id, { id: node.task.id, name: node.task.name, start, days, parent: false, completed: node.task.completed ?? false })
      return start + days
    }

    let end = start
    const runInParallel = node.task.execution ? node.task.execution === 'parallel' : parallelChildren
    if (runInParallel) {
      end = Math.max(...node.children.map((child) => scheduleNode(child, start)))
    } else {
      for (const child of node.children) end = scheduleNode(child, end)
    }
    rows.set(node.task.id, { id: node.task.id, name: node.task.name, start, days: end - start, parent: true, completed: node.task.completed ?? false })
    return end
  }

  let projectEnd = 0
  if (parallelProjects) {
    projectEnd = Math.max(0, ...roots.map((root) => scheduleNode(root, 0)))
  } else {
    for (const root of roots) projectEnd = scheduleNode(root, projectEnd)
  }
  const columnCount = Math.max(14, Math.ceil(projectEnd))
  const startDate = new Date(`${startDateText}T00:00:00`)
  const dates = Array.from({ length: columnCount }, (_, index) => addBusinessDays(startDate, index + 1))
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
    workdays,
    weeks,
    rows: tasks.map((task) => rows.get(task.id)!).filter(Boolean),
  }
}
