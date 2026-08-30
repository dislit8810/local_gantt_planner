# Schedule App — decisions and backlog

## Confirmed MVP direction

- Web application using React, TypeScript, and Vite.
- Store data locally in the browser for the first version.
- Show a simple horizontal Gantt view.
- Allow each parent task to run its children sequentially or in parallel.
- Parent tasks may override the project's default sequential/parallel mode from the settings dialog.
- Calculate task dates from the saved task order, hierarchy, durations, start date, and sequential/parallel setting.
- Exclude weekends from the generated date axis and derive parent spans from their children.
- Every task with children displays its calculated child schedule span as an automatic duration; stale manual values are never shown for parent tasks.
- Render the Gantt rows from the actual task data instead of fixed sample bars.

## Later backlog — calendar view

- Add a familiar calendar-style schedule view in addition to the horizontal Gantt view.
- Display seven days across one row.
- Display the following week on the next row, like a conventional month calendar.
- Make this an alternative view of the same task and schedule data, rather than a separate planning system.
- Do not include this in the MVP; implement it after the core task entry, scheduling, and Gantt workflow works.

## Time-scale preference

- Make week boundaries visually prominent in the Gantt view.
- Planning is mainly in days, half-weeks, and whole weeks rather than hours.
- Keep day detail visible while making each week feel like the primary visual group.
- Duration editor supports days and weeks without requiring number typing.
- In day mode, `ArrowUp` / `ArrowDown` changes duration by one day.
- In week mode, `ArrowUp` / `ArrowDown` changes duration by half a week (2.5 working days).
- Each task remembers day and week values separately. Switching units restores the last value edited in that unit instead of converting or resetting it.
- `Enter` moves from the current duration field to the next task; `Shift + Enter` moves to the previous task.
- In a duration field, `ArrowLeft` returns to editing the task name and `ArrowRight` toggles between the remembered day and week values.
- At the end of a task name, `ArrowRight` moves directly into that task's duration field.

## Required keyboard-first task editing

- Task entry must be usable without repeatedly reaching for the mouse.
- `Enter` while editing: confirm the current task and start entering the next task at the same level.
- `Tab` while editing: move the task currently being entered one level deeper without ending editing.
- `Shift + Tab` while editing: move the task currently being entered one level higher without ending editing.
- `Shift + Tab`: move the selected task one level higher.
- `Alt + ArrowUp`: move the selected task one position upward.
- `Alt + ArrowDown`: move the selected task one position downward.
- Alt-based reordering works from both task-name and duration editing; tasks with descendants move as one intact subtree and only exchange with siblings at the same level.
- `ArrowUp` / `ArrowDown`: confirm the current task, move to the previous or next task, and immediately edit it with the text cursor at the end of its name.
- `Space`: toggle completion when not editing text.
- `Enter` when not editing: edit the selected task.
- Single-click a task name: edit that task.
- `Delete`: delete only the selected task and promote its children one level.
- `Shift + Delete`: delete the selected task and all of its descendants.
- `Escape`: finish continuous task entry.
- Automatically remove an empty task when its input loses focus or entry is ended.
- Persist tasks, hierarchy, ordering, durations, completion, project start date, and scheduling settings in browser local storage.
- Show the keyboard shortcut reference inside the project settings dialog.
- Support multiple level-zero title tasks in one workspace and collapse or expand all descendants with a disclosure button.
- Implement task creation and continuous `Enter` entry first, then hierarchy and reorder shortcuts.


## Required data compatibility policy

- Every new version must continue to read tasks and settings saved by previous versions.
- When adding saved fields, supply safe defaults when older data does not contain those fields.
- When renaming fields, changing types, changing hierarchy, or changing storage keys, implement an automatic migration from the old format before releasing the change.
- Never remove or rename an existing storage key without a migration path.
- If loading fails, do not overwrite and destroy the existing saved data. Preserve it and provide a safe fallback or recovery path.
- Before each release, test loading, updating, and saving data created by the immediately previous version.
