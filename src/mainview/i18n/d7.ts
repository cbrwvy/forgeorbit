// Mission Control: what may advance a mission by itself (from the mission's binding and its activation).
export const d7En = {
  "d7.authority.supervised": "Supervised: every step waits for your approval.",
  "d7.authority.autonomous": "Autonomous under an active policy: bounded routine steps may advance by themselves. Completion stays with you unless the policy explicitly allows it.",
  "d7.authority.full-autonomy": "Full Autonomy under an active policy: it plans, launches, reviews and reworks inside the policy and stops at a QC PASS waiting for you. Completion is automatic only if the policy explicitly allows it.",
  "d7.authority.inactive": "This mission's policy is {why}. Nothing advances by itself; each step needs your decision.",
  "d7.authority.why.revoked": "revoked",
  "d7.authority.why.expired": "expired",
  "d7.authority.why.paused": "paused",
  "d7.authority.why.ended": "finished",
  "d7.authority.why.missing": "missing",
  "d7.authority.emergency": "The Emergency Stop is on. Nothing advances by itself.",
} as const;
export const d7Ru = {
  "d7.authority.supervised": "Под контролем: каждый шаг ждёт вашего одобрения.",
  "d7.authority.autonomous": "Автономно по действующей политике: ограниченные рутинные шаги могут идти сами. Завершение остаётся за вами, если политика явно не разрешает иное.",
  "d7.authority.full-autonomy": "Полная автономность по действующей политике: планирует, запускает, проверяет и переделывает в рамках политики и останавливается на QC PASS в ожидании вас. Завершение автоматическое только если политика явно это разрешает.",
  "d7.authority.inactive": "Политика этой миссии: {why}. Сами по себе шаги не идут; каждый требует вашего решения.",
  "d7.authority.why.revoked": "отозвана",
  "d7.authority.why.expired": "истекла",
  "d7.authority.why.paused": "приостановлена",
  "d7.authority.why.ended": "завершена",
  "d7.authority.why.missing": "не найдена",
  "d7.authority.emergency": "Включена экстренная остановка. Сами по себе шаги не идут.",
} as const;
