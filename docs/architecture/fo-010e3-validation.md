# FO-010E3 — Результаты локальной проверки

Дата: 2026-10-25 (UTC). Ветка `main`, исходный HEAD
`8dd6e659feed7113b32f89c326be5b7fbb295688`; перед работой дерево было чистым.

Архитектура и границы:
[Employee recovery and history](fo-010e3-employee-recovery-history.md).

## Unit / integration / regression: 263 PASS, 0 FAIL

Каждый файл запускался отдельным Bun-процессом, последовательно, через
`/tmp/fo010e3-tests.ts`. Обвязка использует `e2e/isolated-env.ts`: временный
HOME/data, sanitized environment, fake drivers, stub binaries, offline usage.
Файлы с собственным SQLite singleton открывают свою временную БД.
Полный suite не запускался.

| Файл | PASS |
| --- | ---: |
| `src/bun/employee-reconciliation.test.ts` | 28 |
| `src/bun/employee-run.test.ts` | 29 |
| `src/bun/employee-run-migration.test.ts` | 4 |
| `src/bun/employee-execution.test.ts` | 21 |
| `src/bun/employee-core.test.ts` | 26 |
| `src/bun/assignment-core.test.ts` | 18 |
| `src/bun/assignment-http.test.ts` | 3 |
| `src/bun/project-execution.test.ts` | 33 |
| `src/bun/project-manager.test.ts` | 32 |
| `src/bun/project-ownership-scopes.test.ts` | 10 |
| `src/shared/execution/run.test.ts` | 4 |
| `src/shared/project-execution.test.ts` | 19 |
| `src/mainview/lib/employee-execution.test.ts` | 9 |
| `src/mainview/lib/employee-execution-poll.test.ts` | 10 |
| `src/mainview/lib/employees.test.ts` | 17 |

Новые тесты — 28 backend + 10 polling. Проверены точный Run ID, отсутствие
временной эвристики, terminal и missing/orphaned evidence, concurrent/repeated
Reconcile, новый recovery-процесс, pending spawn, rollback записи Run/provenance,
запрет повторного Employee/обычного Task start, strict bearer/schema, ownership,
rename/archive, pagination, Unknown resources и границы follow-up attribution.
Усиленная FO-010E2 регрессия отдельно подтверждает `indeterminate` для thrown
exception, который мог произойти после spawn.

Логи: `/tmp/fo010e3-unit-acceptance.log`,
`/tmp/fo010e3-e2-regression-final.log`.

## Playwright: 27 PASS, 0 FAIL, 0 SKIP

| Spec | PASS |
| --- | ---: |
| `e2e/employee-reconciliation.spec.ts` | 5 |
| `e2e/employee-run.spec.ts` | 4 |
| `e2e/employee-execution.spec.ts` | 3 |
| `e2e/project-execution.spec.ts` | 3 |
| `e2e/company-directory.spec.ts` | 10 |
| `e2e/company-assignment-integration.spec.ts` | 2 |

Проверены fake Runtime → Employee History → существующий Task / Run Panel;
unknown process → Reconcile без нового запуска → подтверждённое завершение;
длинная история (23 attempts, страницы 20 + 3); rename/archive; Empty / Loading /
Error / Retry; keyboard; dark/light; ширины 390 / 768 / 1024 / 1440; остановка
опроса после terminal/unmount; bounded pending spawn → Starting → Completed.
Скриншоты истории проверены визуально.

Команда итогового прогона:

```sh
CI=1 FORGEORBIT_E2E_API_PORT_OFFSET=10000 bun --bun node_modules/@playwright/test/cli.js test --config=/tmp/fo010e3-playwright.config.ts e2e/employee-reconciliation.spec.ts e2e/employee-run.spec.ts e2e/employee-execution.spec.ts e2e/project-execution.spec.ts e2e/company-directory.spec.ts e2e/company-assignment-integration.spec.ts --workers=1
```

`--bun` нужен существующему `e2e/helpers.ts` с импортом `bun:sqlite`.
macOS sandbox не разрешал старт Chromium (MachPortRendezvous); успешный прогон
выполнен с разрешённым исключением sandbox.

Параллельные тесты из `forgeorbit-qa01` занимали IPv6 Vite :5173 и backend :4700.
Они не останавливались и не изменялись. Добавлен необязательный, проверяемый
`FORGEORBIT_E2E_API_PORT_OFFSET` для портов fixture; default остаётся прежним.
Временный конфиг итогового прогона поднимает наш Vite на IPv4 127.0.0.1:5173 и
направляет Chromium `localhost` на IPv4. Origin остаётся `localhost:5173`.
Production CORS allowlist и bearer authentication не менялись. Backend/stub
порты этого прогона — 14600–14900. Чужой Vite на IPv6 остаётся отдельным процессом.

Промежуточные неуспешные прогоны сохранены как диагностические: Node вместо Bun;
Chromium sandbox; конфликт портов; неподдерживаемый alternate frontend origin;
fixture без Refresh после внешнего rename/archive. Последняя ошибка исправлена
явным Company Refresh без задержек. Во время визуальной проверки также исправлено
сжатие строк длинной истории. Пропусков тестов и увеличения timeout для сокрытия
ошибок нет.

Итоговый лог: `/tmp/fo010e3-browser-final.log`.
Скриншоты: `test-results/employee-reconciliation-lo-d483b-four-viewports-and-keyboard-chromium/history-*.png`.

## Статические проверки

- `bun run typecheck` — PASS.
- `bunx vite build` — PASS; остаётся предупреждение о крупных chunks.
- `git diff --check` — PASS.
- Миграции 076–085 не изменялись; последняя — 085, 083 отсутствует; 086 не нужен.

Логи: `/tmp/fo010e3-typecheck-acceptance.log`, `/tmp/fo010e3-build-final.log`.

## Ограничения и readiness

- Legacy attempt без доказуемой связи с Run может оставаться заблокированным
  бессрочно. Нет скрытого force release или снятия защиты через acknowledge.
- `orphaned` — неизвестная судьба процесса, а не доказательство его остановки.
- Actual model/account остаются Unknown, если Runtime их не подтверждает.
- Follow-up внутри того же Run виден через его ID. Самостоятельные follow-up Runs
  не наследуют Employee автоматически; будущая атрибуция требует нового Owner
  Approval и повторной проверки назначения. `sendInput` lifecycle не переписан.
- История удалённой задачи сохраняется, но существующий Task Details открыть
  уже нельзя. Ссылка ведёт в существующую историю задачи, а не новый Run viewer.
- Native Electrobun, реальные AI CLI, провайдеры, платные запросы и production
  не проверялись. Реальные CLI не вызывались даже с `--version`.
- Независимая проблема `portfolio-dashboard` не исправлялась.
- Organization End-to-End и Final QA не запускались; готовность организации
  целиком этим этапом не подтверждается.

Git: разрешён один локальный commit
`feat: add employee execution reconciliation and history`. Push/merge/rebase,
изменения remotes, удаление worktrees и ручное изменение `.git` не выполняются.
