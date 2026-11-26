// FO-UX-SIMPLIFY02-M2 display copy: the global technical-details setting, Owner authorization
// "why" line, the single provider-launch notice and plain names for mission history events.
// Canonical codes and event names are never edited here; this file only maps them for display.
export const m2En = {
  "settings.tech_details": "Show technical details",
  "settings.tech_details_hint": "Opens identifiers, raw codes and diagnostics on every screen. When off, each block still opens with one click. This changes only what is shown, not what is allowed.",

  "ownerPlain.why": "Why it's blocked",
  "ownerPlain.howItWorks": "How confirmation works",

  "runtime.notice.more": "Why AI can't be started from here",

  "mcEvent.created": "Mission created",
  "mcEvent.authorized": "Plan approved by the Owner",
  "mcEvent.started": "Mission started",
  "mcEvent.owner_started": "Mission started by the Owner",
  "mcEvent.paused": "Mission paused",
  "mcEvent.resumed": "Mission resumed",
  "mcEvent.cancelled": "Mission cancelled",
  "mcEvent.completed_all_tasks": "All tasks finished",
  "mcEvent.paused_authorization_mismatch": "Paused: the plan changed after it was approved",
  "mcEvent.resource_reauthorized": "New AI resources approved by the Owner",
  "mcEvent.recovery_tick": "Continued after a restart",
  "mcEvent.recovery_held": "Kept on pause after a restart",
  "mcEvent.reason": "Reason: {reason}",
  "mcEvent.tech": "Event record",
  "mcEvent.name": "Event name",
  "mcEvent.details": "Details",
  "mc.historyEmpty": "Nothing has happened in this mission yet.",

  "mcDep.qc_pass": "after it passes quality control",
  "mcDep.done": "after it is done",
  "mcDep.awaiting_owner": "after it reaches your review",
  "mcDep.tech": "Task identifiers",
  "mcDep.task": "Task",
  "mcDep.dependsOnTask": "Depends on task",
  "mcDep.condition": "Condition",
  "mc.projectFolder": "Project folder",
  "mc.missionId": "Mission identifier",
  "mc.revisionLabel": "Plan revision",
  "mc.missionTech": "Mission identifiers",
  "mc.statusRaw": "Status code",

  "runtimeTech.summary": "Adapter and versions",
} as const;

export const m2Ru: Record<keyof typeof m2En, string> = {
  "settings.tech_details": "Показывать технические сведения",
  "settings.tech_details_hint": "Раскрывает идентификаторы, исходные коды и диагностику на всех экранах. Когда выключено, каждый блок по-прежнему открывается одним нажатием. Меняет только то, что показано, а не то, что разрешено.",

  "ownerPlain.why": "Почему заблокировано",
  "ownerPlain.howItWorks": "Как работает подтверждение",

  "runtime.notice.more": "Почему ИИ нельзя запустить отсюда",

  "mcEvent.created": "Миссия создана",
  "mcEvent.authorized": "Владелец утвердил план",
  "mcEvent.started": "Миссия запущена",
  "mcEvent.owner_started": "Владелец запустил миссию",
  "mcEvent.paused": "Миссия поставлена на паузу",
  "mcEvent.resumed": "Миссия продолжена",
  "mcEvent.cancelled": "Миссия отменена",
  "mcEvent.completed_all_tasks": "Все задачи завершены",
  "mcEvent.paused_authorization_mismatch": "Пауза: план изменился после утверждения",
  "mcEvent.resource_reauthorized": "Владелец утвердил новые ИИ-ресурсы",
  "mcEvent.recovery_tick": "Продолжена после перезапуска",
  "mcEvent.recovery_held": "Оставлена на паузе после перезапуска",
  "mcEvent.reason": "Причина: {reason}",
  "mcEvent.tech": "Запись события",
  "mcEvent.name": "Имя события",
  "mcEvent.details": "Подробности",
  "mc.historyEmpty": "В этой миссии пока ничего не произошло.",

  "mcDep.qc_pass": "после прохождения контроля качества",
  "mcDep.done": "после завершения",
  "mcDep.awaiting_owner": "после передачи вам на проверку",
  "mcDep.tech": "Идентификаторы задач",
  "mcDep.task": "Задача",
  "mcDep.dependsOnTask": "Зависит от задачи",
  "mcDep.condition": "Условие",
  "mc.projectFolder": "Папка проекта",
  "mc.missionId": "Идентификатор миссии",
  "mc.revisionLabel": "Версия плана",
  "mc.missionTech": "Идентификаторы миссии",
  "mc.statusRaw": "Код состояния",

  "runtimeTech.summary": "Адаптер и версии",
};
