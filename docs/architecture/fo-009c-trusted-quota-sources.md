# FO-009C — Trusted Quota Sources & Refresh

Дата проверки: **2026-10-24 (UTC)**. Исходная ветка `main`, HEAD
`5c72792e53c503d374af2a8539dd1993a0480125`; рабочее дерево было чистым.

Результат: каталог возможностей, расширяемый approved-adapter contract,
защищённый явный refresh, сохранение evidence в FO-009A и UX доступности источников.
**В production не зарегистрировано ни одного live quota adapter.** Документированный
интерфейс провайдера сам по себе не означает реализованный и авторизованный коннектор.

## A. Provider Capability Matrix

Все production Refresh отключены. Ручные наблюдения доступны для любого provider.
Канонические provider IDs для каталога: `openai`, `anthropic`, `cursor`, `google`, `fx`.
Неизвестный или пользовательский provider получает только manual source; привязка
к Harness не меняет provider и не доказывает аккаунт.

| Harness / source | Официальный механизм и показатели | Авторизация / identity | Units, windows, resets | Shared pool / возможность подключения |
| --- | --- | --- | --- | --- |
| Codex / `codex-app-server` | Документированы `account/rateLimits/read`, account read и отдельная token activity. Процент использования по buckets, duration и reset; точный остаток requests/tokens неизвестен. | Аутентифицированное ChatGPT app-server соединение; API key не означает подписочную авторизацию. Account read даёт account information, но не устанавливает соответствие локальному UUID. | `usedPercent`; каждый limit ID и primary/secondary window отдельно; reset в epoch seconds требует явной нормализации. | limit ID не является доказательством общего пула разных аккаунтов. Нет разрешённого транспорта и verified binding; CLI не запускался. |
| Claude Code / `anthropic-admin` | Usage/Cost Admin API: исторические API tokens/cost. Отдельные Rate Limits API: настроенные API limits; Code Analytics: агрегаты по actor. Личный остаток Pro/Max не доказан. | Organization Admin credential; workspace key недостаточен. Org/workspace/API-key/actor dimensions требуют отдельного mapping; не удостоверяют текущий CLI login. | Usage buckets 1m/1h/1d; cost daily; analytics daily с задержкой. Configured rate windows не являются remaining balance. | Organization/workspace scope не доказывает общий личный подписочный pool. Коннектор и безопасный credential provisioning отсутствуют. |
| Cursor / `cursor-admin` | Team Admin API: usage events, member metrics, spending/spend limits. | Администратор выдаёт team API key, Basic auth. Team/member identity требует проверенной связи; одного email недостаточно. | Counts и денежные spend metrics в собственных date/billing windows. Не конвертируются в остаток личных tokens. | Team membership не равен pool identity; коннектор отсутствует. |
| Cursor / `cursor-org-pool` | Organization pooled-usage: `limitCents`, `usedCents`, `remainingCents`, per-team usage. | Organization API key и соответствующий `organizationId`; требуется доказанная связь организации/команды/Account UUID. | Денежные значения в cents; contract start/end могут быть null. TTL и reset не выводятся из даты договора. | Документирован organization pool. В evidence нужен стабильный pool ID с contract/scope/window и provider/source namespace. Нет коннектора или verified bindings. |
| Gemini | Официальные quota/pricing guidance и интерактивный `/stats model`. Approved machine-readable account quota API в изученных документах не найден. | Product-dependent login/API key/Vertex; credentials не читались. Identity остаётся Unknown. | Product-dependent requests/day и другие windows; опубликованный максимум не означает текущий баланс. | Guidance о sharing не даёт точного pool ID. Для FO-009C Unsupported / user-provided only. |
| Antigravity | Plan/rate-limit guidance; account-specific acquisition API в изученной документации не установлен. | Approved authorization отсутствует, identity Unknown. | Plan-dependent windows; не hardcode-им числа, reset или remaining. | Pool identity Unknown; Unsupported / user-provided only. |
| fx | Документированы `/usage` и `fx usage --json`; данные зависят от upstream provider. Это CLI interface, а не прямой quota API ForgeOrbit. | CLI-managed login/key, selected provider/team. Реальная авторизация не проверялась. | Gateway today/7d/month по UTC; subscription windows зависят от upstream. | Sharing upstream account возможно; точный pool не доказан. `documented` + `excluded-cli`: запрещено регистрировать этот source как adapter в FO-009C. |
| Manual / неизвестные Harnesses | Только пользовательские observations в существующей модели. | Owner bearer; declared identity, unverified provenance. | Явные units/window/expiry; unknown остаётся null. | Не доказывает pool или CLI authentication. Provider Refresh недоступен. |

Ручное получение через ForgeOrbit возможно только после внедрения безопасного
коннектора и независимой проверенной атрибуции. Учитывая текущую конфигурацию,
**безопасное автоматическое обновление не реализовано ни для одного источника**.
Документированные admin read APIs — кандидаты для будущего отдельного подключения,
а не разрешение читать произвольные credentials или выполнять платные probes.

## B. Official Sources

Публичные страницы открыты и изучены 2026-10-24. Авторизованных provider calls,
CLI probes, cookies/session reads не было. Отсутствие подходящего API означает
«не установлен в изученной документации», а не доказательство отсутствия любых API.

- [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server) — account/read, rateLimits/read, bucket/window semantics. Адрес developers.openai.com/codex/app-server перенаправил сюда.
- [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) — organization API reporting и Admin credentials.
- [Anthropic Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api) — configured organization/workspace rate limits, без remaining counter.
- [Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api) — daily actor/token/cost aggregates; Console organization scope.
- [Cursor Team Admin API](https://cursor.com/docs/account/teams/admin-api) — documented team usage/spending, Basic API-key auth.
- [Cursor Organization Admin API](https://cursor.com/docs/account/organizations/organization-admin-api) — organizationId-bound pool and monetary balances.
- [Gemini CLI quotas/pricing](https://geminicli.com/docs/resources/quota-and-pricing/) — product-dependent quota and interactive stats.
- [Antigravity Plans](https://www.antigravity.google/docs/plans) — plan/rate-limit guidance.
- [fx Usage and costs](https://fx.sh/docs/using-fx/usage-and-costs) и [Authentication](https://fx.sh/docs/getting-started/authentication) — documented usage CLI, upstream credential/provider selection. Команды из документации не выполнялись.

## C. Adapter Architecture

`src/shared/accounts/quota-sources.ts` — один каталог capabilities: documentation,
acquisition policy, authorization, identity, metrics/windows, pool support,
limitations, official URL и дата аудита. Старый `/capabilities` расширен теми же
данными через `accountSourceCapabilities`; значения FO-009A совместимы.

`src/bun/trusted-quota.ts` содержит `TrustedQuotaAdapter`, `VerifiedQuotaBinding`,
`TrustedQuotaResult`, `TrustedQuotaSample` и coordinator `TrustedQuotaRefresh`.

- Adapter регистрируется только кодом сервера: documented + eligible interface.
  HTTP не принимает adapter, endpoint, command, credentials или token path.
- `binding(accountId)` — исключительно локальный, не выполняющий IO lookup
  уже проверенной авторизации. Declared harness bindings здесь не используются.
  Ошибки lookup закрывают доступ без раскрытия provider exception.
- `acquire({ account, definitions, signal })` возвращает provider/source,
  verified account attribution и отдельные samples с immutable quota ID,
  scope/unit/window, observedAt, nullable counts, typed percentage, expiry/reset,
  optional verified shared-pool identity. Нет объединения windows.
- Adapter обязан проверять документированное provider identity evidence и
  нормализовать данные без secrets. Этот контракт не sandbox для произвольного
  кода: будущий коннектор требует отдельного review и credential lifecycle.
- Coordinator проверяет account/provider/subject/method до и после acquisition,
  соответствие definitions, допустимые timestamps, pool policy и весь пакет.
  Raw provider payload/exception не сохраняется и не возвращается.
- `AccountCore.recordTrustedObservations` переиспользует действующую валидацию
  observations и транзакционно добавляет строки в `quota_observations`.
  Evidence хранится в существующем JSON: source, account UUID, subject, method,
  documentation reference, receivedAt, pool, limitations. Старые строки не меняются.

Новой таблицы, миграции или отдельного хранилища квот нет. Номер **078 не занят**.

## D. Refresh Behavior

В существующем bearer-authenticated backend добавлены:

| Method / path | Результат |
| --- | --- |
| GET `/account-core/quota-sources` | Каталог с implemented status; acquisition не запускается. |
| GET `/account-core/accounts/:id/quota-sources` | Доступность и причина отдельно для source и Account UUID. |
| POST `/account-core/accounts/:id/quota-refresh` | Только JSON `{ "sourceId": "..." }`; ручной вызов approved adapter. |

Permission проверяется до body parsing; используются действующий exact bearer
и constant-time comparison сервера, без query-token fallback. JSON ограничен
16 KiB; extra fields и query parameters refresh запрещены.
Unknown/provider-mismatched source: 400; unavailable/duplicate: 409;
invalid normalized evidence: 422; sanitized provider/persistence failure: 502;
timeout: 504. В production documented sources возвращают 409, acquisition не вызывается.

Один coordinator на server lifecycle. Account-wide in-flight guard охватывает
разные sources этого аккаунта. Timeout по умолчанию 10 секунд вызывает AbortSignal;
если adapter игнорирует abort, повторный запрос блокируется до settlement.
Поздний result не записывается. Нет автоматических retries или recurring polling.

## E. Account Attribution

Declared account metadata остаётся user-provided/unverified, даже после verified
observation. AccountCore identity resolution, planning association и current CLI
authentication не изменяются. Отдельный verified binding связывает provider subject
с внутренним Account UUID; email/display name/единственная harness binding этого
не доказывают. Revocation, смена subject или account metadata во время запроса
отменяет сохранение. Manual HTTP не может подделать source/provenance/acquisition.

## F. Freshness

Действует существующий FO-009A resolver: expiresAt обязателен для current evidence;
прошедший reset инвалидирует observation без предположения replenishment. Missing
TTL — historical/stale. Future timestamp недопустим. Данные одного source с более
старым или равным observedAt отвергаются транзакционно. Независимые current sources
могут дать Conflict. Unknown не становится 0/unlimited; explicit 0 сохраняется.
Проценты сохраняют направление и никогда не превращаются в точный остаток.

Verified pool identity хранится с provider/source/scope/window. Документированная
поддержка pool обязательна. Shared subscriptions не создают pool автоматически.
Старая Portfolio-проекция не выдаёт shared-pool balance/concurrency за независимую
ёмкость аккаунта или Harness; полные evidence доступны в accountResources.

## G. UI

Accounts & Resources получил вкладку Quota Sources и source panel в Account Details:
documentation/acquisition/connector status, auth/identity/window ограничения,
официальные ссылки и дата проверки, disabled Refresh с видимой причиной,
последнее verified observation и freshness. Quota cards показывают Known / Unknown /
Conflict, атрибуцию и явный shared pool либо Unknown. Исторические observations
и manual Add Observation сохранены. Local snapshot refresh явно подписан как
чтение локальных данных. Refresh errors используют только фиксированные сообщения.
Локальная expiry-переоценка не делает provider requests.

## H. Legacy Compatibility

Poller, `harness_usage`, `harness_usage_history`, transcript rollups, SSE и старый
refresh endpoint сохранены. Trusted код не импортирует legacy provider fetchers.
Новые bindings/refresh не приписывают старую историю аккаунту. Старые credential,
cookie и undocumented endpoint механизмы не сертифицированы и не расширены.
Существующий legacy background poller остаётся отдельным прежним поведением:
FO-009C не добавляет мониторинг и не обещает отключить существующий poller.

## I. Security

У нового acquisition path нет файлового/процессного API, URL-fetch input, shell
или credential-reader dependency. Registry фиксируется серверным кодом. SQL
параметризован. Нет account switching, provider login/logout, платных probes,
SSRF, token-path traversal, credential metadata или provider exception logging.
Body allowlist, safe identity fields и реконструкция output исключают raw payload.
Тесты блокируют real network/process calls; provider adapters — только fixtures.
Реальные авторизации/CLI/платные API не использованы.

## J. Tests

`bun scripts/test-trusted-quota.ts` запускает только 11 targeted suites, каждую в
отдельном процессе с временными HOME/SQLite, sanitized environment, fake CLI и
offline usage; poller-suite использует свои fake overrides по существующему recipe.
Проверки: capabilities, identity/verified evidence, two percentage directions,
windows, stale/reset/conflict, shared pools, manual refresh, duplicates, timeout/late
result, rollback, revocation, authentication, URL/path/secret rejection, zero
implicit acquisition, legacy, Accounts client и Portfolio compatibility.
**182 passed, 0 failed** в итоговом изолированном наборе. Полный suite не запускался. Точные counters и manifests: `fo-009c-validation.json`.

## K. Playwright

Accounts Dashboard + Portfolio Dashboard: **17 passed** (13 Accounts, 4 Portfolio).
После итоговых уточнений freshness/pool projection повторены 6 затронутых
сценариев: **6 passed**; результат записан в validation JSON. Успешный реальный backend с
неподдерживаемым refresh — 409. Доступный refresh, timeout и sanitized error UI
проверены через Playwright fake source/HTTP; реального провайдера это не доказывает.
Chromium сначала не стартовал внутри macOS sandbox (MachPortRendezvous permission
denied); разрешённый запуск вне sandbox прошёл. Screenshots новой source card
сохранены на 390/1280 px, регрессии темы/overflow/keyboard присутствуют в Accounts suite.

## L. Typecheck / Build

`bun run typecheck`, `bun node_modules/vite/bin/vite.js build`, `git diff --check` —
**PASS**. Vite сообщает предупреждения об existing `__dirname`
config compatibility и крупных chunks; unrelated build config не менялся.
Native/Electrobun release/distribution build не запускался.

## M. Limitations

Live quota acquisition ни с одним реальным аккаунтом не включён и не подтверждён.
Нет approved credential setup, source bindings, production adapter или live model
verification. Документация может измениться после даты аудита. Gemini/Antigravity
выводы ограничены просмотренными официальными страницами. fx CLI документирован,
но запрещён условиями задачи. Shared-pool aggregation/allocation, router,
switching, background monitoring и Knowledge Base не реализованы.

## N. Commit

Локальный commit: `feat: add trusted quota source capabilities and refresh`.
Итоговый SHA предоставлен в отчёте выполнения; parent — исходный ожидаемый HEAD.
Push, rebase, hard reset, clean, изменения remotes и ручные правки `.git` не выполняются.

## O. Git Status

До начала — чистая `main`. Финальный статус проверяется после локального commit.
Состав изменений ограничен FO-009C, targeted tests, validation runner и этим отчётом.
FO-011C/Markdown Knowledge Base и зарезервированная миграция 078 не затронуты.

## P. Recommendations for FO-009D

1. Отдельно согласовать read-only credential provisioning и verified provider/account
   mapping, с revocation/expiry вне AccountCore metadata.
2. Выбрать один documented источник: approved существующий Codex transport без
   запуска CLI либо Cursor Organization budget с отдельным organization binding.
3. Закрепить golden response fixtures, права и negative cases до включения коннектора;
   явно описать TTL policy, reset normalization и pool identity, не выводить их из плана.
4. Проверить legacy Portfolio projection и shared-pool dedup до любого allocation.
   Эти данные не дают разрешения переключать аккаунты или создавать Model Router.

FO-009D самостоятельно не начат.
