// Mission queue: why a task is not running, from the scheduler's recorded wait reason.
export const d6En = {
  "d6.wait.dependency": "Waiting for a dependency",
  "d6.wait.slot": "Waiting for a free worker slot",
  "d6.wait.project-stopped": "Project is stopped",
  "d6.wait.owner": "Waiting for you",
  "d6.wait.recovery": "Recovery required — it was not started again",
} as const;
export const d6Ru = {
  "d6.wait.dependency": "Ждёт зависимость",
  "d6.wait.slot": "Ждёт свободный слот исполнителя",
  "d6.wait.project-stopped": "Проект остановлен",
  "d6.wait.owner": "Ждёт вас",
  "d6.wait.recovery": "Нужно восстановление — повторно не запускалась",
} as const;
