// Project Stop and recovery: a stopped run's process that is not yet observed to exit still holds the project in Draining.
export const d5En = {
  "d5.lifecycle.unconfirmed": "{count} earlier process(es) were not confirmed to exit. The project stays in Draining until each one is observed gone.",
  "d5.estop.chip": "still running",
  "d5.estop.leftRunning": "Not stopped: {count} running task(s) you started yourself. Stop them on the board.",
} as const;
export const d5Ru = {
  "d5.lifecycle.unconfirmed": "Не подтверждено завершение ранее остановленных процессов: {count}. Проект остаётся в состоянии «Завершение работы», пока каждый из них не будет замечен завершённым.",
  "d5.estop.chip": "ещё работают",
  "d5.estop.leftRunning": "Не остановлено: запущенные вами задачи, которые ещё работают: {count}. Остановите их на доске.",
} as const;
