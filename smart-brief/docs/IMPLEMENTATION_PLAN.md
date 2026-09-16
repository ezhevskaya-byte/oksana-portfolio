# Smart Brief — Technical Implementation Plan v1.1

> Техническая архитектура реального Smart Brief **до начала программирования**.  
> Документ отвечает на вопрос: как превратить продуктовую логику в безопасный и экономичный сервис.  
> **v1.1:** добавлен рабочий контур **Smart Brief Lead Workspace** — лиды не должны жить только в email.  
> **v1.1.1:** зафиксирован single-admin MVP (только Оксана) и server-side password authentication.  
> На этом этапе система **не реализуется**.

### Для кого

| Аудитория | Как использовать |
|-----------|------------------|
| **Разработчик / Cursor** | Контракт слоёв, этапов и ограничений перед кодом |
| **AI-агент (будущий runtime)** | Границы: что делает код, что делает модель, что нельзя слать в промпт |
| **Владелец продукта** | MVP, стоимость, безопасность, Lead Workspace, что решать до реализации |

### Что уже есть

| Слой | Состояние |
|------|-----------|
| Статический сайт | HTML/CSS/JS на GitHub Pages, prefix `/oksana-portfolio/` |
| UI-прототип | `smart-brief/index.html`, `css/smart-brief.css`, `js/smart-brief.js` |
| Продуктовая архитектура | System Prompt, Question Engine, Niche Modules, Decision Tree, Response Template |

Эти markdown-документы — **design documentation**.  
Они не должны целиком уходить в AI на каждом сообщении.

### Product principle

```
UNDERSTAND → STRUCTURE → RECOMMEND → SAVE → NOTIFY → CONTINUE WORK
```

Smart Brief — не только AI-чат на портфолио.  
Он помогает потенциальному клиенту **и** Оксане после разговора.

---

## 1. Исходный контекст

Smart Brief уже спроектирован как продукт:

```
SMART_BRIEF_SYSTEM_PROMPT
        ↓
QUESTION_ENGINE
        ↓
NICHE_MODULES
        ↓
DECISION_TREE
        ↓
RESPONSE_TEMPLATE
```

Технический runtime: frontend ↔ защищённый backend ↔ AI ↔ structured response ↔ **persistent qualified lead** ↔ **Lead Workspace** ↔ notification.

---

## 2. Ключевое ограничение

GitHub Pages — **статический** хостинг.

### Обязательное правило

Секретный AI API key **нельзя** размещать:

- в JavaScript браузера;
- в HTML;
- в GitHub repository;
- в публичных config-файлах.

Реальный AI-вызов проходит **только** через защищённый backend / serverless layer.

Это правило нельзя ослаблять «для прототипа на Pages».

---

## 3. High-level architecture

### Основной поток диалога

```
Browser / Smart Brief UI (public)
        ↓
Frontend Controller
        ↓
Public API endpoint (HTTPS)
        ↓
Backend / Serverless
        ↓
Smart Brief Runtime
  (state + compact instructions + niche slice)
        ↓
AI Provider
        ↓
Structured Response
        ↓
Frontend (сообщение + UI-переходы)
```

### Поток квалифицированного лида (обновлено)

```
Conversation (temporary session)
        ↓
Meaningfulness / qualification check
        ↓
Final Concept (client-visible)
        ↓
Internal Oksana Report (hidden)
        ↓
Persistent Qualified Lead
  (+ full conversation transcript)
        ↓
Smart Brief Lead Workspace (private)
        ↓
Notification to Oksana (email / Telegram)
```

**Email / Telegram — notification layer, не основное хранилище лидов.**

### Два контура данных

| Контур | Назначение |
|--------|------------|
| **A. Temporary Conversation Session** | Runtime во время разговора: compact state, stage, лимиты |
| **B. Persistent Qualified Lead** | Долговременная рабочая карточка + история диалога |

Не каждое случайное открытие Smart Brief должно становиться постоянным лидом.

### Варианты размещения backend / serverless

| Вариант | Плюсы | Минусы | Когда смотреть |
|---------|-------|--------|----------------|
| **Cloudflare Workers** (+ KV + D1) | Низкая стоимость, secrets, temp+persistent в одной экосистеме | Нужно освоить Workers / D1 | Предпочтительный кандидат MVP |
| **Vercel / Netlify + DB** | Привычный Node DX | Отдельный деплой от Pages; нужна отдельная БД | Альтернатива |
| **Supabase (Edge + Postgres)** | Готовый auth/DB/admin-friendly | Чуть больше связки сервисов | Сильный кандидат, если важны auth+CRUD из коробки |
| **Railway / Fly / VPS** | Полный контроль | Больше ops | Позже |

### Критерии выбора

- простота;
- безопасность;
- стоимость и cost caps;
- совместимость с GitHub Pages;
- удобство CRUD лидов и transcript;
- возможность private Lead Workspace;
- масштабируемость.

**Тарифы не фиксировать** — проверить актуальные условия перед реализацией.

---

## 4. Разделение Frontend / Backend / AI

### Public Frontend (портфолио / Smart Brief UI)

- интерфейс Smart Brief;
- текст / голос UX;
- отображение сообщений и результата;
- локальное UI-состояние;
- loading / error;
- согласия;
- запросы в **public API**.

Не принимает AI-бизнес-решения самостоятельно.

### Private Frontend (Lead Workspace)

- защищённый кабинет **только для Оксаны** (single-admin MVP);
- без публичной регистрации и без аккаунтов для посетителей Smart Brief;
- login/email + password → admin session;
- список лидов, карточка, transcript, статусы, заметки;
- запросы только в **admin API** после успешной **server-side** authentication.

### Backend

- secrets;
- validation, limits, timeouts;
- AI runtime context;
- temporary session;
- qualification → persistent lead;
- public API ≠ admin API;
- notifications;
- разделение CLIENT-VISIBLE / INTERNAL / ADMIN-ONLY.

### AI

- понимание языка, факты, ниша, следующий вопрос;
- Decision Tree / концепция / preliminary audience / internal report.

### Обычный код (не AI)

- stage machine, stop conditions, rate limits;
- qualification threshold;
- persist lead + transcript;
- auth для workspace;
- notifications;
- фильтрация полей по аудитории ответа.

---

## 5. Conversation State (temporary)

Structured temporary state во время диалога.  
Описание полей, **не** реальный JSON.

### SESSION

- `session_id`, `created_at`, `last_activity`
- `conversation_stage`, `ui_mode`, `locale`
- `qualified_lead_id` (если уже создан / привязан)

### BUSINESS / GOAL / AUDIENCE / DIGITAL STATE / PROJECT / DIALOGUE CONTROL / SAFETY

Как в v1.0:

- бизнес, ниша, confidence;
- цель, проблема, desired result, why now;
- аудитория + evidence level;
- текущие цифровые инструменты;
- project constraints;
- engagement, missing critical facts, readiness;
- usage / abuse counters.

### Важно для аудитории в state

Каждый значимый audience-пункт желательно помечать уровнем:

- **FACT** — сказал клиент / подтверждено;
- **HYPOTHESIS** — предположение Smart Brief;
- **UNKNOWN** — данных нет.

Temporary state кормит AI compact context.  
После qualification ключевые данные копируются в persistent lead.

---

## 6. Stages of conversation

| Стадия | Смысл |
|--------|-------|
| **START** | Выбор режима / первое сообщение |
| **UNDERSTANDING** | Извлечение бизнеса, цели, проблемы |
| **CLARIFYING** | Точечные вопросы |
| **READY_TO_RECOMMEND** | Достаточность закрыта |
| **RESULT** | Клиентская концепция |
| **HANDOFF** | Мягкий контакт / сохранение контакта |
| **CLOSED** | Завершение |

Переходы — как в v1.0.  
На RESULT / HANDOFF (и при достижении порога раньше, если уместно) запускается **lead qualification**.

Не бесконечный свободный чат.

---

## 7. Runtime Smart Brief

Большие markdown-документы **не** отправлять модели целиком каждый ход.

| Слой | Назначение |
|------|------------|
| Design documentation | Полные `.md` для людей / Cursor |
| Runtime instructions | Короткий operational prompt |
| Session state | Compact facts текущего клиента |
| Active niche module | Только релевантный срез |
| Current task | extract / next question / recommend |

Progressive context loading без изменений по смыслу v1.0.

---

## 8. Token / cost architecture

Принципы экономии v1.0 сохраняются:

compact state, niche slice, deterministic limits, stop conditions, message size limits, rate/session limits, optional model routing.

### Cost guardrails

Огромные тексты, бесконечный чат, спам, flood новых сессий, off-topic «как ChatGPT» — ограничивать кодом; не создавать persistent lead на мусоре.

---

## 9. AI call strategy

- Обычный ход: A + B (facts + next action) одним вызовом, если экономично.  
- Финал: отдельный C (concept + internal report).  
- Persist lead / notification — **код**, не AI.  
- Voice → сначала текст, потом диалоговый вызов.

---

## 10. Structured AI response

Логические поля (не schema):

- `assistant_message`
- `extracted_facts`
- `niche` / confidence
- `engagement`
- `missing_critical_facts`
- `readiness_for_recommendation`
- `next_action`
- `recommendation_data`
- `internal_report` (server-only)
- `safety_signal`
- `qualification_hint` (опционально: достаточно ли смысла для persist)

Frontend получает только client-safe часть.

---

## 11. Voice input

Голос обязателен для продукта.

- **A:** Browser STT — быстрее для раннего voice.  
- **B:** Audio → transcription backend — выше контроль/стоимость/privacy.  
- Текст всегда fallback.  
- Исходный audio **не** хранить постоянно без отдельного privacy/consent решения.  
- В transcript сохраняется текст + `input_type: text | voice_transcription`.

Фазы: text MVP → voice MVP 1.1 (browser STT) → опционально server STT.

---

## 12. Smart Brief Lead Workspace — ключевое требование

Smart Brief **не** должен после разговора только отправить email и потерять рабочий контекст.

Оксане нужен собственный контур:

### SMART BRIEF LEAD WORKSPACE

Позволяет:

- видеть содержательные обращения;
- хранить структурированную карточку лида;
- открывать полную историю разговора;
- видеть резюме Smart Brief;
- видеть предварительное понимание ЦА;
- видеть предложенное решение;
- видеть вопросы, которые осталось уточнить;
- возвращаться к разговору позже;
- находить нужного клиента;
- использовать данные для дальнейшей работы;
- в будущем готовить на их основе полноценный разбор ЦА и коммерческое предложение.

Это **не** публичная часть портфолио.  
Скрытый URL на GitHub Pages **недостаточен** — нужна настоящая авторизация.

---

## 13. Когда создаётся постоянный лид

### Lead qualification / persistence threshold

Постоянный лид создаётся, когда выполнено **одно или несколько** условий полезности, например:

- клиент сообщил содержательную информацию о бизнесе;
- определена бизнес-задача;
- оставлен контакт;
- Smart Brief дошёл до RESULT;
- сформирована предварительная концепция;
- разговор содержит ценную информацию для дальнейшей работы Оксаны.

Это **не** оценка «хороший / плохой клиент».  
Это техническое решение: сохранять ли сессию как рабочий лид.

### Не создавать полноценную постоянную карточку автоматически для

- «Привет»;
- «Что ты умеешь?»;
- одного off-topic вопроса;
- явного спама / abuse.

Точные пороги — Open Decision до PHASE persistent storage.

---

## 14. Persistent Lead Data Model

Логическая структура постоянной карточки (**не** JSON schema).

### IDENTITY

- `lead_id`
- `created_at` / `updated_at`
- `source` (smart-brief)
- `session_id`
- `status` (см. статусы ниже)

### CONTACT

Только добровольно предоставленные данные:

- name, phone, email, messenger, preferred contact method.

Не требовать все поля.

### BUSINESS

- business description, niche, business model;
- geography when relevant;
- product / service.

### REQUEST

- original request, goal, problem, desired result, why now.

### AUDIENCE

- информация, явно данная клиентом;
- preliminary hypotheses Smart Brief;
- needs, pains, motivations, objections, trust factors;
- confidence / evidence level.

**Критично различать:**

| Метка | Смысл |
|-------|-------|
| **FACT** | Сообщено клиентом / подтверждено |
| **HYPOTHESIS** | Предположение Smart Brief |
| **UNKNOWN** | Информации нет |

### DIGITAL STATE

- website, socials, messengers, marketplaces, CRM, booking/order systems, other tools.

### PROJECT

- suggested solution, alternative solution;
- necessary functions, integrations;
- content/materials, design/brand state;
- constraints, deadlines, budget orientation if provided.

### SMART BRIEF RESULT

- short conversation summary;
- preliminary concept;
- preliminary audience understanding;
- recommendation + reasoning;
- unresolved questions;
- suggested next step.

### INTERNAL OKSANA REPORT

- scope summary, complexity, information completeness;
- what affects estimate;
- what Oksana should clarify;
- possible development opportunities.

### CONVERSATION TRANSCRIPT

Ссылка / вложенная последовательность сообщений (раздел 15).

### WORKSPACE NOTES (для Оксаны)

- заметки;
- будущие действия;
- флаги future actions (`prepare_audience_analysis`, `prepare_proposal`) — позже.

---

## 15. Full conversation history

Оксана должна открывать **исходный** разговор.

Логическая последовательность:

```
CLIENT → ASSISTANT → CLIENT → ASSISTANT → …
```

Для каждого сообщения концептуально:

- `role` (`client` / `assistant`)
- `timestamp`
- `content`
- `input_type` (`text` / `voice_transcription`)

Полная история — первоисточник: AI-summary может упустить деталь.  
Исходный audio постоянно не хранить без отдельного решения.

---

## 16. Lead Workspace UI (private)

### Доступ (обязательно)

- В MVP кабинет доступен **только одному** административному пользователю — **Оксане**.
- Публичной регистрации администраторов **нет**.
- Посетители Smart Brief **не получают аккаунты** и **не имеют доступа** к Lead Workspace.
- Вход: **login/email + password** с настоящей server-side authentication (детали — раздел 23).

Минимальная структура закрытого кабинета:

### LEADS LIST

- дата;
- имя (если известно);
- бизнес;
- ниша;
- краткая задача;
- наличие контакта;
- статус;
- последняя активность.

### SEARCH / FILTERS (можно упростить на старте, расширить позже)

- поиск;
- статус;
- ниша;
- дата;
- наличие контакта.

### LEAD DETAIL — разделы / вкладки

1. **ОБЗОР** — резюме, бизнес, задача, контакты, текущая ситуация, что хочет клиент.  
2. **ЦЕЛЕВАЯ АУДИТОРИЯ**  
   - A. Известно из разговора (FACT)  
   - B. Гипотезы Smart Brief (HYPOTHESIS)  
   - C. Требует исследования (UNKNOWN / gaps)  
3. **РЕШЕНИЕ** — рекомендуемый вариант, альтернативы, почему, развитие.  
4. **ДИАЛОГ** — полный transcript.  
5. **ДАЛЬНЕЙШАЯ РАБОТА** — что уточнить, заметки Оксаны, действия, статус.

---

## 17. Lead status

Простые рабочие статусы процесса (не оценка человека):

`NEW` → `REVIEWED` → `CONTACTED` → `DISCUSSION` → `PROPOSAL` → `WON` / `CLOSED`

Не усложнять MVP полноценной CRM, ролями сотрудников и сложными воронками.

---

## 18. Notifications

```
Qualified Lead
      ↓
Persistent Storage
      ↓
Lead Workspace
      ↓
Notification to Oksana
```

Уведомление — короткий сигнал, не архив.

Минимум в notification:

- новый лид;
- имя (если известно);
- тип бизнеса;
- краткая задача;
- наличие контакта;
- идентификатор / ссылка на карточку в Workspace.

### Сравнение для MVP

| Канал | Роль |
|-------|------|
| **Email** | Надёжный текстовый ping + ссылка на карточку |
| **Telegram** | Быстрее заметить; удобен как alert |

**Рекомендация MVP:** Telegram **или** email как notification (выбрать один для простоты);  
**источник истины** — Lead Workspace + persistent storage.  
Позже можно оба.

---

## 19. Два уровня анализа ЦА

Фундаментальное бизнес-требование. **Не смешивать.**

### LEVEL 1 — Smart Brief Preliminary Audience Understanding

Создаётся в первичном разговоре.

Источники:

- ответы клиента;
- информация, которую он дал;
- разумные гипотезы Smart Brief.

Это **не** полноценное исследование рынка.  
Гипотезы нельзя выдавать за подтверждённые факты.

### LEVEL 2 — Full Target Audience Analysis

Полноценный разбор ЦА, который Оксана может давать клиенту в рамках дальнейшей работы / бонуса при заказе сайта.

Может использовать:

- данные Smart Brief;
- полный разговор;
- сайт клиента;
- соцсети;
- отзывы;
- конкурентов;
- открытые источники;
- доп. исследование;
- материалы клиента.

Smart Brief обязан сохранить достаточно исходных данных (FACT/HYPOTHESIS/UNKNOWN + transcript), чтобы LEVEL 2 можно было сделать качественно позже.

---

## 20. Future action: «Подготовить разбор ЦА»

Заложить возможность в карточке лида (**не реализовывать сейчас**).

В будущем действие сможет:

1. взять структурированные данные Smart Brief;  
2. взять полный разговор;  
3. определить пробелы;  
4. при наличии разрешённых инструментов использовать доп. источники;  
5. сформировать исследовательский черновик для Оксаны;  
6. явно разделить: подтверждённые данные / внешние данные / выводы / гипотезы.

Оксана проверяет результат **до** передачи клиенту.

---

## 21. Future action: «Подготовить предложение»

Future capability (**не MVP**):

На основе разговора, решения, scope, уточнений Оксаны и будущих правил ценообразования.

**Не** генерировать цену автоматически без правил/данных.

---

## 22. Storage architecture (пересмотр)

Нужны **два** типа хранения.

### 1. Temporary session storage

- runtime conversation state;
- короткий TTL;
- cost/safety counters;
- не обязан переживать долго после CLOSED без qualification.

### 2. Persistent lead storage

- квалифицированные лиды;
- structured card;
- full transcript;
- статусы / заметки Оксаны.

### Варианты persistent storage

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| **Cloudflare D1** (+ KV для temp) | Одна экосистема с Workers; SQL для лидов/поиска | Нужно освоить D1; проверить лимиты |
| **Cloudflare KV only** | Просто для ключ-значение | Слабее для списка/поиска/связей transcript |
| **Supabase Postgres** | Сильный CRUD, auth, удобный admin | Отдельный сервис; проверить стоимость/политику |
| **Firebase** | Быстрый старт realtime | Модель данных/запросы и vendor lock оценить заранее |
| **Vercel/Netlify + внешняя DB** | Гибко | Больше склейки |

### Рекомендация направления (проверить условия)

Если остаёмся на Cloudflare stack:

- **KV (или durable object/session store)** — temporary sessions;  
- **D1** — persistent leads + messages/transcript + statuses.

Если важнее готовый auth/DB UX:

- **Supabase** как persistent + auth для Lead Workspace,  
- Worker/Function как public AI API.

Email **не** является persistent lead storage.

---

## 23. Authentication / private access

Lead Workspace содержит персональные и коммерческие данные.

### Single-admin MVP (обязательно)

1. В MVP существует **только один** административный пользователь: **Оксана**.
2. Публичная регистрация административных пользователей **отсутствует**.
3. Посетители Smart Brief **не получают аккаунты** и **не имеют доступа** к Lead Workspace.
4. Для входа Оксаны требуется настоящая аутентификация: **login/email + password**.
5. Пароль:
   - никогда не хранится в frontend-коде;
   - никогда не хранится в GitHub repository;
   - никогда не передаётся клиенту;
   - не хранится в открытом виде (только безопасный server-side secret storage / hash — по выбранному механизму).
6. После успешного входа создаётся **защищённая административная сессия**.
7. Авторизация проверяется **SERVER-SIDE** для **каждого** защищённого admin API request.
8. **Нельзя** считать защитой:
   - скрытый URL;
   - JavaScript password check;
   - наличие специального параметра в URL;
   - простой frontend redirect.
9. Без действующей admin session **запрещён** доступ к:
   - списку лидов;
   - карточкам лидов;
   - контактам;
   - conversation transcript;
   - preliminary audience analysis;
   - internal Oksana report;
   - заметкам;
   - статусам;
   - любым admin API endpoints.
10. Обязательные возможности:
    - login;
    - logout;
    - expiration административной сессии;
    - повторный вход после expiration.
11. Архитектура **может** позже добавить дополнительные аккаунты / роли — это **не входит в MVP**.
12. Конкретный technical mechanism authentication (библиотека / провайдер / cookie vs token и т.п.) пока остаётся **Open Decision** до выбора стека.  
    Продуктовое требование при этом уже зафиксировано: **один admin, email/login + password, server-side session checks**.

### Разделение API

- **public Smart Brief API** — для посетителей диалога (без доступа к лидам и internal data);
- **admin API** — только после успешной server-side admin authentication.

Скрытая страница на GitHub Pages без auth — **неприемлема**.

Не реализовывать auth на этом этапе документации.

---

## 24. Data lifecycle

```
Anonymous visit
      ↓
Temporary session
      ↓
Meaningful conversation?
      ↓
No → expiration / deletion
Yes → qualified lead
      ↓
Persistent storage
      ↓
Oksana Lead Workspace
      ↓
further work / closure
      ↓
retention / deletion policy
```

Конкретные сроки retention **не придумывать** здесь.  
Определить перед launch вместе с правовой проверкой.

---

## 25. Privacy by design

Дополнение к legal checkpoint:

- собирать только необходимое;
- контакт — добровольно;
- не требовать лишние ПДн;
- не хранить аудио без необходимости;
- не слать тексты разговоров в аналитику;
- ограничить доступ к Lead Workspace;
- предусмотреть удаление данных;
- определить retention;
- документировать внешних обработчиков (AI, mail, DB);
- отдельно проверить правовые требования перед запуском.

Юридические тексты здесь не пишутся.

---

## 26. Security (обновление)

Базовые требования v1.0 + :

- public API не отдаёт internal report и transcript admin-полей;
- admin API только с auth;
- prompt injection не раскрывает prompts / internal / leads других сессий;
- логи без лишних ПДн;
- CORS / size limits / timeouts / rate limits.

| CLIENT-VISIBLE | INTERNAL / ADMIN |
|----------------|------------------|
| Сообщения ассистента клиенту | Internal Oksana Report |
| Клиентская концепция | Complexity / commercial prep |
| Уточняющие вопросы | Полный admin transcript UI |
| Мягкий CTA | Secrets, prompts, abuse scores |

---

## 27. Error / fallback UX

Без изменений по смыслу v1.0: понятные действия, без technical dump; при сбоях AI/backend — повтор / текст / прямой контакт с Оксаной.

Если persist lead не удался после RESULT — retry серверно + alert Оксане; клиенту не показывать внутреннюю ошибку хранения.

---

## 28. Analytics

События Metrika как в v1.0 (+ опционально позже `smart_brief_lead_saved` без ПДн).

Запрет: тексты сообщений, контакты, transcript, internal report в аналитику.

---

## 29. MVP (пересмотр)

### Цель MVP

Оксана тестирует реальный текстовый сценарий **и не теряет полезные лиды**.

### MVP включает

- public Smart Brief UI + text dialogue;
- backend + AI + temporary session;
- adaptive questions + final concept;
- internal report;
- cost limits + error handling;
- **qualification → persistent lead**;
- **full transcript**;
- **private Lead Workspace (минимум)**;
- **notification** о новом квалифицированном лиде.

### MVP Lead Workspace минимум

- единственный admin-аккаунт Оксаны (без публичной регистрации);
- вход login/email + password;
- server-side проверка admin session на каждом admin API request;
- login / logout / session expiration;
- список сохранённых лидов;
- открытие карточки;
- краткое резюме;
- контакт;
- бизнес / задача;
- preliminary audience understanding (FACT vs HYPOTHESIS);
- recommendation;
- полный conversation transcript;
- статус;
- уведомление Оксане.

### Не включать в первый MVP без необходимости

- сложную CRM;
- команды / роли;
- тяжёлые воронки и отчёты;
- автоматический LEVEL 2 анализ ЦА;
- автоматическое КП;
- сложную аналитику.

### Voice

- **MVP 1.0** — text + persist + workspace;  
- **MVP 1.1** — browser STT;  
- **MVP 1.2** — server transcription при необходимости.

---

## 30. Phased implementation (обновлено)

### PHASE 1 — Runtime + data contracts

**Цель:** state, stages, lead model, transcript model, FACT/HYPOTHESIS/UNKNOWN.  
**Не делаем:** AI/API deploy.

### PHASE 2 — Backend / API skeleton

**Цель:** public API skeleton, secrets, validation, rate limit stub.  
**Не делаем:** полный диалог и workspace UI.

### PHASE 3 — Text AI dialogue + temporary session

**Цель:** multi-turn text, compact runtime, stop conditions.  
**Не делаем:** persistent leads ещё можно заглушить.

### PHASE 4 — Final recommendation + structured internal report

**Цель:** RESULT для клиента + internal report на сервере.  
**Не делаем:** voice / сложную CRM.

### PHASE 5 — Persistent qualified lead storage

**Цель:** threshold, save lead card + transcript.  
**Готово, если:** полезный диалог не теряется после закрытия браузера.  
**Не делаем:** красивый кабинет можно минимально через API/smoke UI.

### PHASE 6 — Private Lead Workspace

**Цель:** auth + list + detail tabs (обзор / ЦА / решение / диалог / дальнейшая работа).  
**Готово, если:** Оксана может работать с лидом без поиска в почте.

### PHASE 7 — Lead notification

**Цель:** email или Telegram ping со ссылкой/id на карточку.  
**Готово, если:** новый qualified lead заметно сигнализируется.

### PHASE 8 — Voice

**Цель:** «Рассказать» → transcript → тот же pipeline.  
**Не делаем:** постоянное хранение audio.

### PHASE 9 — Analytics + privacy / security / legal checkpoint

**Цель:** Metrika events, access review, retention decisions, launch checklist.

### PHASE 10 — Testing + launch

**Цель:** сценарии раздела 31 + мониторинг стоимости/ошибок.

**Почему такая последовательность:** сначала не терять смысл (persist), затем удобный доступ (workspace), затем сигнал (notify), затем voice.  
Email-first без DB отвергнут как конечный рабочий процесс.

---

## 31. Test strategy

Сценарии v1.0 (1–15) сохраняются.

### Дополнительные сценарии Lead Workspace

| # | Сценарий | Ожидание |
|---|----------|----------|
| 16 | Содержательный диалог до RESULT | Создаётся persistent lead + transcript |
| 17 | «Привет» / off-topic | Нет полноценной карточки лида |
| 18 | Контакт оставлен добровольно | Попадает в CONTACT; без контакта карточка всё ещё может существовать, если порог пройден |
| 19 | Оксана открывает Workspace | Видит обзор, ЦА с метками, решение, диалог |
| 20 | Неавторизованный доступ к admin API | Отказ |
| 21 | Persist failure после RESULT | Retry/alert; клиентский UX не ломается грубо |
| 22 | FACT vs HYPOTHESIS | В карточке ЦА видно различие |

---

## 32. Open decisions before implementation

| Решение | Варианты | Когда принять |
|---------|----------|---------------|
| Backend provider | Cloudflare Workers / Vercel / Netlify / другое | До PHASE 2 |
| AI provider / model | OpenAI / Anthropic / другие (тарифы проверить) | До PHASE 3 |
| Temporary session store | KV / memory / иное | До PHASE 3 |
| **Persistent database** | D1 / Supabase / иное | До PHASE 5 |
| **Admin authentication mechanism** | Конкретный стек для **login/email + password** одного admin (Workers+session / Supabase Auth / иное). Продуктово уже зафиксировано: single-admin Оксана, без публичной регистрации, server-side checks | До PHASE 6 |
| **Lead Workspace hosting** | Отдельный private frontend на Worker/Pages+auth / часть admin app | До PHASE 6 |
| **Lead qualification threshold** | Правила persist | До PHASE 5 |
| **Notification channel** | Email / Telegram / оба | До PHASE 7 |
| **Retention policy** | Сроки хранения лидов/transcript | До PHASE 9 / launch |
| **Backup / export** | Ручной export / automated | До PHASE 9 |
| **Future audience research workflow** | Инструменты LEVEL 2 | После MVP; дизайн флага — PHASE 1 |
| Transcription | Browser / server STT | До PHASE 8 / 1.2 |
| Exact cost limits | turns/tokens/sessions | До PHASE 3 + review |
| Legal / privacy texts | Consent, disclosures | До PHASE 9 |
| Model routing | Single / dual | После MVP 1.0 |
| Session lifetime (temp) | TTL | До PHASE 3 |

---

## 33. Предпочтительная MVP-архитектура (обновлено)

### Рекомендация

```
GitHub Pages
  └─ Public Smart Brief UI
        ↓
Cloudflare Worker
  ├─ Public API (dialogue / AI runtime)
  ├─ Admin API (auth required)
  ├─ Temporary sessions (KV / TTL)
  ├─ Persistent leads + transcripts (D1)
  └─ Secrets / limits / qualification
        ↓
AI provider (server-side only)
        ↓
Structured response → Public UI
        ↓
Qualified Lead → D1
        ↓
Private Lead Workspace
  (single admin: Оксана)
  (login/email + password)
  (server-side admin session)
        ↓
Notification (Telegram или Email) → Оксана
```

### Ответы на ключевые вопросы

| Вопрос | Ответ |
|--------|-------|
| Где frontend клиента? | GitHub Pages / Smart Brief UI |
| Где public API? | Cloudflare Worker public routes |
| Где AI runtime? | Worker server-side |
| Где temporary session? | KV (или эквивалент) с TTL |
| Где persistent leads? | D1 (или выбранная SQL/DB) |
| Где transcript? | Persistent storage, связанный с lead |
| Где private workspace? | Отдельный auth-protected UI + admin API |
| Кто имеет доступ к Workspace в MVP? | Только Оксана (один admin; без публичной регистрации; посетители без аккаунтов) |
| Как авторизуется Оксана? | Login/email + password → защищённая admin session; каждый admin API request проверяется **server-side**. Конкретный mechanism — Open Decision |
| Что не считается защитой? | Скрытый URL, JS password check, URL-параметр, простой frontend redirect |
| Как приходит notification? | Короткий ping; карточка в Workspace |
| Как расширить до LEVEL 2 ЦА? | Future action на карточке лида + сохранённые FACT/HYPOTHESIS/UNKNOWN + transcript |
| Можно ли добавить других admin позже? | Да, архитектурно; **не в MVP** |

### Оговорка

Перед реализацией проверить актуальные условия Cloudflare / AI / mail/Telegram / auth.  
Цены не выдумывать.

### Запасной стек той же формы

GitHub Pages + Serverless Function + Supabase (DB + Auth) + notification.  
Слои те же: temporary session ≠ persistent lead ≠ notification.

### Что отвергнуто как конечный процесс

«Только email lead без базы и кабинета» — недостаточно для работы Оксаны.

---

## 34. Definition of ready

План готов, если понятно:

- где frontend / backend / secrets;
- что делает AI vs код;
- temporary vs persistent storage;
- когда создаётся qualified lead;
- как устроена карточка и transcript;
- как устроен Lead Workspace и auth;
- что в MVP только один admin (Оксана), без публичной регистрации;
- что вход — login/email + password, а проверки — server-side на каждом admin API request;
- как разделены LEVEL 1 и LEVEL 2 ЦА;
- как приходит notification;
- как экономятся токены и режутся расходы;
- как защищены internal данные;
- какие phases реализовывать;
- какие Open Decisions ещё открыты;
- как система поддерживает цикл  
  **UNDERSTAND → STRUCTURE → RECOMMEND → SAVE → NOTIFY → CONTINUE WORK**.

### PRIVATE WORKSPACE SECURITY

Посторонний пользователь, знающий URL кабинета или URL API, **не может** получить данные без успешной **server-side** authentication.

Это включает запрет доступа без действующей admin session к списку и карточкам лидов, контактам, transcript, preliminary audience analysis, internal Oksana report, заметкам, статусам и любым admin API endpoints.

---

## Версия и статус

| Параметр | Значение |
|----------|----------|
| Версия | 1.1.1 |
| Изменение | Single-admin MVP + server-side password auth requirements for Lead Workspace |
| Статус | Техническое проектирование (без реализации) |
| Тип документа | Implementation Plan |
| Следующий шаг | Утвердить Open Decisions → PHASE 1–2 |

---

*Документ дополнен под бизнес-требование Lead Workspace и single-admin security. HTML/CSS/JS и другие файлы на этом этапе не изменяются.*
