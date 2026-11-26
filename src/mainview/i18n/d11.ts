// Direction 11 display copy: what kind of quota fact a screen is showing. A reading you reported, a provider
// diagnostic, a past reading and a verified reading are different facts; none of them is a balance unless
// a trusted source says so, and an unknown quota is never worded as zero, free or unlimited.
export const d11En = {
  "d11.fact.title": "Reading type",
  "d11.fact.verified": "Verified reading",
  "d11.fact.owner-reported": "Reported by you — not verified",
  "d11.fact.observed": "Provider diagnostic — not verified",
  "d11.fact.historical": "Past reading — not current capacity",
  "d11.fact.conflict": "Readings disagree — capacity unknown",
  "d11.fact.unknown": "No reading — capacity unknown",
  "d11.fact.last": "Last reading {when} · source {source}",
  "d11.fact.never": "no reading on record",
  "d11.preflight.owner-reported": "A reading you reported is on record. It is not verified capacity and is not used to choose a resource.",
  "d11.preflight.observed": "Only a provider diagnostic reading is on record. It is not verified capacity.",
  "d11.preflight.historical": "Only a past reading is on record. It is not current capacity, and nothing was refreshed.",
  "d11.preflight.none": "No quota reading is on record for this resource.",
} as const;

export const d11Ru = {
  "d11.fact.title": "Тип значения",
  "d11.fact.verified": "Проверенное значение",
  "d11.fact.owner-reported": "Указано вами — не проверено",
  "d11.fact.observed": "Диагностика провайдера — не проверено",
  "d11.fact.historical": "Прошлое значение — не текущий лимит",
  "d11.fact.conflict": "Значения расходятся — лимит неизвестен",
  "d11.fact.unknown": "Значения нет — лимит неизвестен",
  "d11.fact.last": "Последнее значение {when} · источник {source}",
  "d11.fact.never": "значения нет",
  "d11.preflight.owner-reported": "Есть значение, которое указали вы. Это не проверенный лимит, и оно не влияет на выбор ресурса.",
  "d11.preflight.observed": "Есть только диагностическое значение от провайдера. Это не проверенный лимит.",
  "d11.preflight.historical": "Есть только прошлое значение. Это не текущий лимит; ничего не обновлялось.",
  "d11.preflight.none": "Для этого ресурса значения квоты нет.",
} as const;
