// Task quality control: which output a review round covers, and when no verdict covers the latest output.
export const d4En = {
  "d4.qc.attempt_latest": "Reviewed attempt {n}: the latest output.",
  "d4.qc.attempt_earlier": "Reviewed attempt {n}: earlier output, not the latest.",
  "d4.qc.no_verdict_latest": "No review verdict covers the latest output. Request a review before you accept it.",
  "d8.qc.limit_reached": "All {max} review rounds are used and the last verdict is not a PASS. No further review will start. This task needs your decision.",
  "d8.qc.limit_no_verdict": "All {max} review rounds are used and the last review produced no verdict: no verdict was obtained, and none is assumed. The task stays blocked and cannot be marked done without a fresh PASS.",
  "d8.qc.extension_title": "Authorize one more review round?",
  "d8.qc.extension_body": "This permits ONE more review round, after a new implementation attempt. It starts nothing: no implementation, no test, no review. It does not approve the result, it is recorded in the journal as your decision, it cannot be repeated for this task, and all earlier rounds stay as they are.",
  "d8.qc.extension_confirm": "Authorize one more round",
  "d8.qc.extension_button": "Authorize one more review round",
  "d8.qc.extension_explain": "You can permit one more review round for new output. It starts nothing and does not approve the result.",
  "d8.qc.extension_authorized": "One more review round is authorized. Nothing has started. Run a new implementation, then request the review. The result is not approved.",
  "d8.qc.extension_spent": "The one additional review round was used and the last verdict is still not a PASS. No further extension is available.",
} as const;
export const d4Ru = {
  "d4.qc.attempt_latest": "Проверена попытка {n}: последний результат.",
  "d4.qc.attempt_earlier": "Проверена попытка {n}: более ранний результат, не последний.",
  "d4.qc.no_verdict_latest": "Ни один вердикт проверки не относится к последнему результату. Запросите проверку, прежде чем принимать его.",
  "d8.qc.limit_reached": "Все {max} раундов проверки использованы, а последний вердикт не PASS. Новая проверка не запустится. Этой задаче нужно ваше решение.",
  "d8.qc.limit_no_verdict": "Все {max} раундов проверки использованы, а последняя проверка не дала вердикта: вердикт не получен и не предполагается. Задача остаётся заблокированной и не может быть принята без нового PASS.",
  "d8.qc.extension_title": "Разрешить ещё один раунд проверки?",
  "d8.qc.extension_body": "Это разрешает ОДИН дополнительный раунд проверки после новой попытки реализации. Ничего не запускается: ни реализация, ни тест, ни проверка. Результат не принимается, ваше решение записывается в журнал, повторить это для задачи нельзя, а все прежние раунды остаются как есть.",
  "d8.qc.extension_confirm": "Разрешить ещё один раунд",
  "d8.qc.extension_button": "Разрешить ещё один раунд проверки",
  "d8.qc.extension_explain": "Вы можете разрешить ещё один раунд проверки для нового результата. Ничего не запускается, результат не принимается.",
  "d8.qc.extension_authorized": "Ещё один раунд проверки разрешён. Ничего не запущено. Выполните новую реализацию, затем запросите проверку. Результат не принят.",
  "d8.qc.extension_spent": "Единственный дополнительный раунд проверки использован, а последний вердикт всё ещё не PASS. Других продлений нет.",
} as const;
