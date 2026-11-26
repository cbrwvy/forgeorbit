/**
 * Display text for fixed English sentences the server (or a shared module) writes into screens the
 * Owner reads (FO-UX-SIMPLIFY02-M8, found in the packaged app in Russian).
 *
 * The English sentence stays canonical: it also goes into stored records and model prompts. This
 * only changes what the page shows, only for sentences listed here, and only outside English.
 * Anything not listed — including any text a model or a project file wrote — is shown verbatim.
 */
import { getLocale, type Locale } from "@/i18n/core";

const EXACT: ReadonlyArray<readonly [string, string]> = [
  // Supervised live workflow: what the Owner does next.
  ["Admit this task to the project inbox or approve a PM proposal into Backlog first.", "Допустите задачу во входящие проекта или одобрите предложение PM в Бэклог."],
  ["Triage with the project manager, then move the task to Ready when it should run.", "Проведите триаж с менеджером проекта, затем переведите задачу в «Готово к запуску», когда её нужно выполнить."],
  ["Assign an implementer (AI employee) before authorized execution.", "Назначьте исполнителя (ИИ-сотрудника) перед авторизованным запуском."],
  ["Choose harness and model, run preflight, then confirm to start implementation.", "Выберите среду и модель, выполните предпроверку и подтвердите запуск реализации."],
  ["Confirm the prepared employee run to start implementation.", "Подтвердите подготовленный запуск сотрудника, чтобы начать реализацию."],
  ["Address review feedback, then authorize a new implementation run.", "Учтите замечания проверки, затем авторизуйте новый запуск реализации."],
  ["Request an independent AI quality review when implementation succeeded.", "Запросите независимую ИИ-проверку качества после успешной реализации."],
  ["Inspect the QC verdict and mark the task done when you accept the result.", "Изучите вердикт QC и отметьте задачу выполненной, если принимаете результат."],
  ["Open the run and answer or unblock the agent.", "Откройте запуск и ответьте агенту или снимите блокировку."],
  // Why a column cannot be run from.
  ["This task is still in Backlog. Admit it to the project inbox, then move it to Ready to run.", "Задача всё ещё в Бэклоге. Допустите её во входящие проекта, затем переведите в «Готово к запуску»."],
  ["This task is in the project inbox for PM triage. Move it to Ready when you want to run it.", "Задача во входящих проекта на триаже PM. Переведите её в «Готово к запуску», когда хотите её выполнить."],
  ["This task is already running. Open its run to follow it.", "Задача уже выполняется. Откройте её запуск, чтобы следить за ходом."],
  ["This task is blocked waiting for you. Open its run to answer or retry it.", "Задача заблокирована и ждёт вас. Откройте запуск, чтобы ответить или повторить."],
  ["This task is waiting for review. Open its run, request a fix, or accept the result.", "Задача ждёт проверки. Откройте запуск, запросите исправление или примите результат."],
  ["This task is done. Move it back to the backlog to run it again.", "Задача выполнена. Верните её в Бэклог, чтобы запустить снова."],
  // Provider refusal in the employee-run preflight.
  ["The provider refused an earlier request for this account and model (usage limit). Sign-in is valid, but readiness to run is unconfirmed.", "Провайдер отклонил более ранний запрос для этого аккаунта и модели (лимит использования). Вход действителен, но готовность к запуску не подтверждена."],
  // Add-project wizard.
  ["Use a folder that is already on this Mac. Nothing in it will be changed.", "Используйте папку, которая уже есть на этом Mac. Ничего в ней не изменится."],
  ["Start from an empty folder, or create a new folder in a place you choose.", "Начните с пустой папки или создайте новую папку в выбранном месте."],
  ["Register the folder as a ForgeOrbit project.", "Зарегистрировать папку как проект ForgeOrbit."],
  ["Leave every file already in the folder untouched.", "Не трогать файлы, которые уже лежат в папке."],
  ["Do not create or overwrite IDEA.md or PRD.md.", "Не создавать и не перезаписывать IDEA.md и PRD.md."],
  ["Do not overwrite any existing document.", "Не перезаписывать существующие документы."],
  ["Do not run install, test, git, Docker, or Makefile commands.", "Не запускать команды установки, тестов, git, Docker и Makefile."],
  ["Do not save a launch profile.", "Не сохранять профиль запуска."],
  ["The launch profile is not valid yet. Fix it or skip the environment step before adding the project.", "Профиль запуска пока недействителен. Исправьте его или пропустите шаг среды перед добавлением проекта."],
  ["Do not start the project.", "Не запускать проект."],
  ["Save the description and document choices in ForgeOrbit, outside the project folder.", "Сохранить описание и выбор документов в ForgeOrbit, вне папки проекта."],
  ["This folder is not a git repository.", "Эта папка не является git-репозиторием."],
  ["No stack detected", "Стек не определён"],
  ["Not a git repository", "Не git-репозиторий"],
  ["Not found", "Не найдено"],
  ["Folder", "Папка"],
  ["Stack", "Стек"],
  // What approving a Head of PM board proposal does.
  ["None (draft only)", "Нет (только черновик)"],
  ["Supervised board policy", "Политика контролируемой доски"],
  ["Updates project board.", "Обновляет доску проекта."],
  ["None (draft creation in Backlog)", "Нет (создание черновика в Бэклоге)"],
  ["Supervised backlog policy", "Политика контролируемого Бэклога"],
  ["Creates a draft task in Backlog. No specialist runs.", "Создаёт черновик задачи в Бэклоге. Специалисты не запускаются."],
  ["None (task metadata modification)", "Нет (изменение данных задачи)"],
  ["Supervised edit policy", "Политика контролируемого редактирования"],
  ["Updates task title and prompt.", "Обновляет название и текст задачи."],
  ["Updates task title only. Description stays unchanged.", "Обновляет только название задачи. Описание остаётся без изменений."],
  ["Updates task description only. Title stays unchanged.", "Обновляет только описание задачи. Название остаётся без изменений."],
  ["Updates task title and description.", "Обновляет название и описание задачи."],
  ["Blocked: stored edit proposal contains a blank description that would erase the task prompt.", "Заблокировано: сохранённое предложение содержит пустое описание и стёрло бы текст задачи."],
  ["None (board scheduling priority)", "Нет (приоритет в очереди на доске)"],
  ["Supervised scheduling policy", "Политика контролируемого планирования"],
  ["Owner Backlog admission gate", "Допуск из Бэклога владельцем"],
  ["Supervised intake policy", "Политика контролируемого приёма"],
  ["Moves task from Backlog to Inbox for specialist triage.", "Переносит задачу из Бэклога во входящие для триажа специалистом."],
  ["Project lifecycle admission check", "Проверка допуска жизненного цикла проекта"],
  ["Supervised ready stage policy", "Политика контролируемой стадии «Готово к запуску»"],
  ["Moves task to Ready for execution review.", "Переносит задачу в «Готово к запуску» для проверки запуска."],
  ["None (specialist assignment)", "Нет (назначение специалиста)"],
  ["Supervised assignment policy", "Политика контролируемого назначения"],
  ["Rework lifecycle gate", "Этап доработки"],
  ["Supervised rework policy", "Политика контролируемой доработки"],
  ["Returns task to Ready for another implementation attempt.", "Возвращает задачу в «Готово к запуску» для новой попытки реализации."],
  ["Owner final acceptance & QC sign-off", "Итоговая приёмка владельца и подтверждение QC"],
  ["Evidence-gated Owner acceptance policy", "Политика приёмки владельцем по свидетельствам"],
  ["Marks task Done and acknowledges QC verdict.", "Отмечает задачу выполненной и принимает вердикт QC."],
];

const PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
  [/^Create the folder (.+)\.$/s, (m) => `Создать папку ${m[1]}.`],
  [/^Create (.+) from the draft you reviewed\. Stop if that file already exists\.$/s, (m) => `Создать ${m[1]} из проверенного черновика. Остановиться, если такой файл уже есть.`],
  [/^Save the launch profile: (.+)\.$/s, (m) => `Сохранить профиль запуска: ${m[1]}.`],
  [/^(IDEA and PRD are|IDEA is|PRD is) skipped\. You can create (them|it) later from the project workspace\.$/, (m) => {
    const what = m[1] === "IDEA and PRD are" ? "IDEA и PRD пропущены" : m[1] === "IDEA is" ? "IDEA пропущен" : "PRD пропущен";
    return `${what}. Создать можно позже в рабочем пространстве проекта.`;
  }],
  [/^Updates task priority to (.+)\.$/s, (m) => `Меняет приоритет задачи на ${m[1]}.`],
  [/^Assigns specialist (.+) to task\.$/s, (m) => `Назначает специалиста ${m[1]} на задачу.`],
];

const BY_EN = new Map(EXACT);

/** The sentence in the current language when it is a known one, otherwise exactly as given. */
export function knownText(text: string, locale: Locale = getLocale()): string {
  if (locale === "en") return text;
  const exact = BY_EN.get(text);
  if (exact !== undefined) return exact;
  for (const [pattern, render] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}
