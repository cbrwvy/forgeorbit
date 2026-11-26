# FO-009F — Codex Account & Quota Verification Connector

Дата проверки: 2026-10-25. Исходная чистая `main`: `aba4128fa1c2dcc78330781c38934c17d99f6640`.

**Результат: безопасная подготовка и auth inspection реализованы; production verified
quota acquisition — BLOCKED.** Документированный `account/read` не предоставляет
стабильного provider subject, необходимого для FO-009C attribution. Это не доказательство
отсутствия любых возможных API: вывод ограничен указанными официальными интерфейсами.

## A. Official Protocol Audit

Проверены [Codex app-server](https://learn.chatgpt.com/docs/app-server) и
[SIWC app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Первый документ описывает JSONL stdio, handshake `initialize` → `initialized`,
`account/read` с `refreshToken:false`, и `account/rateLimits/read`. В опубликованном
ChatGPT account response есть type/email/planType, но нет стабильного subject.
WebSocket и app-server отмечены экспериментальными; production readiness не установлена.
Локальные/open-source интеграции с прежней app-server auth могут продолжать её использовать;
рекомендуется миграция на SIWC, commercial/hosted применение этой auth не разрешено.

SIWC описывает отдельный OAuth lifecycle приложения и передачу собственного access token
дочернему процессу. ForgeOrbit этого lifecycle не имеет; чтение CLI tokens для его имитации
не реализуется. `model/list` может возвращать bundled catalog, который не доказывает
entitlement. Inference probe для проверки модели в этом этапе запрещён.

## B. Transport

`codex-stdio.ts` выделяет общий существующий Harness JSONL wire. Catalog discovery
переиспользует его; auth inspection вызывает только `initialize`, `initialized`,
`account/read`. Нет публичного listener, адреса/команды/пути из HTTP, shell или новых
зависимостей. stdout ограничен 4 MiB; stderr игнорируется, notifications не публикуются.

На каждый auth check нужны Owner checkbox consent и нажатие Verify Authentication.
Процесс использует текущий CLI environment, без изменения HOME/CODEX_HOME и без
подстановки Harness home. Binary resolution соответствует existing Codex discovery.
Одна проверка на server instance; deadline 10 секунд, AbortSignal, disconnect/cancel,
сброс памяти, закрытие stdin, принудительная остановка owned child и отмена stdout reader в finally.
Exit hook и daemon shutdown очищают соединение; успешная проверка тоже закрывает процесс.
Поздний ответ после отмены не вызывает следующий RPC и не возвращает evidence.

Обнаруженные старые обходные пути закрыты: scheduler не запускает Codex catalog при
boot/periodic/status/legacy refresh без отдельного code-level process consent. Bulk
Dashboard Harness status не запускает Codex даже с `--version`; наличие binary на диске
не означает готовность исполнения. Прямой Task Runtime preflight сохраняет прежнее
поведение. Legacy Usage Poller не изменён.

## C. Account Identity

Auth inspection различает ChatGPT, API key, no account и Bedrock. Неподдерживаемый или
невалидный ответ закрывает доступ. В памяти остаются только auth mode, requiresOpenaiAuth,
время наблюдения и expiry. Email, plan, raw subject-like extra fields, tokens и provider
errors отбрасываются. `account/updated` во время проверки инвалидирует результат.
Declared Account UUID, provider identity, CLI auth и actual execution account остаются
разными понятиями. Последний — Unknown: выполнения не было.

## D. Verified Binding

Stable documented subject отсутствует: нет операции, которая превращала бы Owner
подтверждение в техническую верификацию. Confirm Link disabled; linkedAccountId всегда
null; production `TrustedQuotaAdapter` не зарегистрирован. Один или несколько accounts,
совпадающие email/display name/plan и одна Harness binding этого не меняют.
Disconnect отменяет проверку и очищает ephemeral evidence; это не provider logout.
Binding/revoke не реализованы, поскольку создавать достоверную binding пока невозможно.

## E. Quota Acquisition

Live `account/rateLimits/read` не вызывается: Refresh без verified binding запрещён.
Ни одной live observation в AccountCore не записано, нет второго quota registry.
Честный статус квот — Unknown. Существующие TrustedQuotaRefresh, VerifiedQuotaBinding,
writer, resolver и bearer endpoints сохранены, их регрессии проверены.

Чистый `normalizeCodexQuotas` подготовлен и проверен на protocol fixtures. Приоритет у
rateLimitsByLimitId; legacy rateLimits — только fallback при отсутствии map. Каждый
limit ID и primary/secondary slot сохраняются отдельно. Сохраняются usedPercent,
duration, reset (seconds → milliseconds) и факт provider-reported limit, без raw status
text. Все абсолютные counts и sharedPool остаются null. Отсутствие именованного limit ID
не заменяется вымышленным ID; отсутствующие данные остаются Unknown. Invalid/mismatched
bucket keys, проценты, durations и unsafe timestamps отвергаются. Этот parser ничего
не получает от провайдера и не записывает: будущий adapter обязан отдельно доказать
attribution и сопоставить scope/window с существующими AccountCore definitions.

## F. Freshness

Auth TTL 60 секунд — локальная максимальная давность, не обещание провайдера. UI
инвалидирует label локальным таймером/focus/visibility без сети. Подготовленный quota
parser применяет local TTL максимум 5 минут, capped at reset. Уже прошедший reset даёт
исторический stale sample; будущий writer должен его отклонить/не записывать как current.
Reset не гарантирует восстановления ёмкости. Текущий resolver сохраняет Conflict;
проценты не конвертируются в точные remaining requests и не дают capacity entitlement.

## G. Account Dashboard

В Accounts & Resources → Quota Sources и в Account Details добавлен Codex Source:
status, auth mode, Unassigned / Unverified, actual execution Unknown, observation/expiry,
reset/quota/pool Unknown, видимое объяснение блокера, consent, Verify Authentication,
Disconnect / Cancel Check и disabled Confirm Link. Существующий quota Refresh disabled.
Auth check не изображается успешным связыванием ресурса. Snapshot read не acquires.

## H. Model Router Compatibility

Не создаётся model/effort/tool/concurrency/login evidence. AccountCore SQLite не
изменяется при inspection; FO-009D/E продолжают возвращать No Verified Candidate при
недостатке независимых доказательств. Catalog discovery не выдаётся за entitlement.
Ни выбора actual execution account, ни reservation/allocation не добавлено.

## I. Security

Exact bearer проверяется до parsing; connector responses no-store. Строгий body
`{consent:true}`, предел 16 KiB, отказ от extra fields/query params, фиксированные ошибки.
Нет credential reads, cookies, unofficial endpoints, arbitrary paths/URLs, OAuth/login/
logout, account switching, paid probes, prompts, real tasks, tokens в renderer,
account identity в SSE/SQLite metadata/logs. No-account/API-key auth не дают subscription
quota authorization. Existing legacy provider/poller поведение не сертифицируется этим
коннектором; ни его работа, ни Task Runtime не переписаны.

## J. Unit Tests

`bun scripts/test-codex-source.ts`: 13 последовательных suites в отдельных процессах,
с sanitized environment, временными HOME/SQLite, fake binaries и offline usage.
**334 PASS, 0 FAIL.** Новый набор содержит 29 тестов protocol/auth/redaction, missing
subject/multiple accounts, invalid replies, timeout/cancel/disconnect/late reply, HTTP
allowlist/no-store, read-only SQLite и quota normalization/freshness/conflict. Shared
transport прогоняется через fake executable; реальный Codex CLI не использован.
Дополнительно добавлены regressions запрета automatic catalog и `--version` probes.
Existing Trusted Quota tests покрывают verified/mismatched/revoked binding и atomic writes.

## K. Playwright

Команда: `CI=1 bun --bun node_modules/@playwright/test/cli.js test e2e/codex-source.spec.ts e2e/accounts-dashboard.spec.ts e2e/model-router-preview.spec.ts e2e/portfolio-dashboard.spec.ts --workers=4`.
Backend — fake drivers, stub binaries, временные HOME/SQLite, offline usage; connector
inspection UI — fake HTTP responses, без provider account. Actual backend проверен на
passive status, no-store, bearer denial и disabled binding/refresh. Есть consent,
local expiry, cancellation/late result, sanitized timeout и screenshots 390/1280.
Финальный результат — **24 PASS, 0 FAIL**; counters — в `fo-009f-validation.json`.

Первый Node runner не загрузил bun:sqlite; запуск через Bun исправил runtime.
В sandbox Chromium не стартовал из-за MachPortRendezvous; разрешённый запуск вне
sandbox выполняет тесты. Первый полноценный прогон: 23 PASS, 1 устаревшее текстовое
ожидание FO-009C исправлено на stable-subject blocker. Известный тест
`accounts-dashboard.spec.ts:320` прошёл при четырёх workers; искусственные задержки и
изменение его логики не добавлялись. Native Electrobun UI не проверялся.

## L. Typecheck / Build

`bun run typecheck`, Vite build и `git diff --check` проходят. Vite сохраняет существующие
предупреждения о native config `__dirname` и размере chunks. Native/distribution build
не запускался. Точные результаты и SHA-256 manifest — в validation JSON.

## M. Limitations

Это safe preparation с usable auth inspection, не завершённый trusted live quota
connector. Нет стабильной documented provider identity, binding, live quota acquisition,
AccountCore persistence от Codex, model entitlement или гарантии реального login.
Реальный Codex не запускался даже для version/schema generation. Поддержка конкретной
установленной версии CLI и live account/provider поведение остаются непроверенными.

## N. Production Readiness

**BLOCKED для production verified resource source.** Локальная fixture-based QA проверяет
границы, protocol и UI, но не доказывает разрешённость коммерческого использования,
готовность app-server для production или достоверное связывание аккаунта. До независимого
identity evidence Refresh должен оставаться недоступным.

## O. Commit SHA

Один локальный commit `feat: add codex trusted resource verification` поверх исходного
HEAD. Итоговый SHA — в отчёте выполнения; push/merge/rebase не выполнялись.

## P. Git Status

После commit проверяется чистая main. Нет remotes/worktree cleanup или ручных изменений
.git. Commit содержит только connector, shared transport extraction, запрет implicit
Codex probes, UI, targeted tests и этот отчёт/validation manifest.

## Q. Recommendations for Employee Execution Integration

Сначала установить разрешённый auth lifecycle (для нового продукта — отдельно проверить
SIWC) и источник stable subject с explicit Owner link, expiry/revocation и повторной
проверкой до/после acquisition. Затем подключить adapter к действующему AccountCore и
транзакционно сохранять только при совпадении identity. Model entitlement, effort,
permissions, execution login и concurrency проверять независимо. До исполнения заново
проверять Owner approvals/политику, freshness/conflicts, atomically reserve capacity и
сохранять фактическую identity на confirmed run. Следующий этап не начат.
