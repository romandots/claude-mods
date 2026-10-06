# claude-mods

Маркетплейс модов для Claude Code.

| Мод | Что делает |
| --- | --- |
| [`slonk-card`](plugins/slonk-card) | Показывает карточку slonk, с которой работает сессия, и колонку, в которой она сейчас лежит |

## Установка

Нужен Claude Code v2.1.287+ в терминале или приложение Claude Desktop v2.1.286+ (вкладка Code).

```bash
claude plugin marketplace add romandots/claude-mods
claude plugin install slonk-card@romandots-mods
```

То же можно сделать прямо в сессии Claude Code:

```
/plugin marketplace add romandots/claude-mods
/plugin install slonk-card@romandots-mods
```

Если сессия уже открыта, выполните в ней `/reload-plugins`. Проверить, что мод загрузился: `/plugin`. В терминале под вкладками будет строка `1 mod active · slonk-card`.

Обновление: `/plugin` → **Installed** → `slonk-card` → Update, или `claude plugin update slonk-card@romandots-mods`.

Мод выполняется с вашими правами. Посмотреть, какие события он слушает и что вызывает, можно до установки:

```bash
claude plugin validate plugins/slonk-card
```

## slonk-card

Следит за вызовами MCP-инструментов slonk, в том числе у субагентов, и показывает текущую карточку:

- **строка статуса** под полем ввода: `slonk TANSULTANT-2016 · Code Review` (терминал и Desktop);
- **полоса над полем ввода** с заголовком и кнопками «Обновить» и «Скрыть» (терминал; Desktop её сейчас не отображает);
- **уведомление** при смене колонки: `TANSULTANT-2016: Development → Code Review`.

Как мод определяет карточку:

- вызов, касающийся одной карточки (`get_issue`, `claim_issue`, `transition_issue`, `create_issue` и т.п.), делает её текущей;
- если в ответе нет колонки (`comment_issue`, `link_git_ref`), мод сам запрашивает `get_issue`;
- раз в минуту мод перечитывает карточку и замечает перенос, сделанный другим агентом или человеком в Plane.

slonk распознаётся по ответу: ключ вида `PROJ-123` и состояние с группой Plane. Поэтому подходит любое имя MCP-сервера (`slonk-developer`, коннектор с UUID-именем и т.п.).

### Команда `/slonk-card`

| Команда | Действие |
| --- | --- |
| `/slonk-card` | Перечитать текущую карточку |
| `/slonk-card PROJ-123` | Следить за другой карточкой |
| `/slonk-card off` | Перестать следить |
| `/slonk-card hide` / `show` | Скрыть или показать полосу |

### Ограничения

- В облачных сессиях, чат-панели VS Code и `claude -p` мод ничего не рисует.
- Показывается последняя карточка, которой касалась сессия.
- Изменения, сделанные не из этой сессии, видны с задержкой до минуты.

## Разработка

```bash
claude plugin validate plugins/slonk-card
claude plugin test plugins/slonk-card
```

Для проверки на лету: `claude --plugin-dir plugins/slonk-card`. Перед релизом поднимите `version` в `plugins/slonk-card/.claude-plugin/plugin.json`.
