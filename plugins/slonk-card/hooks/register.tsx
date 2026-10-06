import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card } from '../types'

const card = atom({ plugin: 'slonk-card', key: 'card' } as const, null)
const lastServer = atom({ plugin: 'slonk-card', key: 'lastServer' } as const, null)
const isHidden = atom({ plugin: 'slonk-card', key: 'isHidden' } as const, false)

const POLL_MS = 60_000
// Any MCP tool, mcp__<server>__<tool>: slonk may be connected as slonk-developer,
// slonk-qa, ... or as a connector named by a UUID, so a server is told by its answers.
const MCP_TOOL = /^mcp__(.+)__([a-z_]+)$/i
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/
// Plane's state groups: an issue carrying one of them came from slonk.
const PLANE_GROUPS = new Set(['backlog', 'unstarted', 'started', 'completed', 'cancelled'])
// Servers that answered with a slonk issue in this module's life.
const slonkServers = new Set<string>()
const isSlonk = (server: string) => /slonk/i.test(server) || slonkServers.has(server)

const GROUP_COLOR: Record<string, string> = {
  backlog: 'gray',
  unstarted: 'blue',
  started: 'yellow',
  completed: 'green',
  cancelled: 'red',
}

type Issue = { key: string; title: string; column: string; group: string }

const asIssue = (value: unknown): Issue | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const state = v.state as Record<string, unknown> | undefined
  if (typeof v.key !== 'string' || !ISSUE_KEY.test(v.key)) return null
  if (typeof state?.name !== 'string' || typeof state.group !== 'string') return null
  if (!PLANE_GROUPS.has(state.group)) return null

  return {
    key: v.key,
    title: typeof v.name === 'string' ? v.name : '',
    column: state.name,
    group: state.group,
  }
}

/** Every slonk issue a tool answer carries: a single issue or a list of them. */
export const issuesIn = (text: string | undefined): Issue[] => {
  if (!text) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const one = asIssue(data)
  if (one) return [one]
  const d = data as Record<string, unknown> | null
  for (const field of ['issue', 'result']) {
    const nested = asIssue(d?.[field])
    if (nested) return [nested]
  }
  const list = d?.issues
  return Array.isArray(list) ? list.map(asIssue).filter((i): i is Issue => i !== null) : []
}

const describe = (c: Card) => `${c.key} · ${c.column}${c.title ? ` — ${c.title}` : ''}`

let poll: { cancel: () => void } | null = null

const store = async ($: EngineInterface, issue: Issue, server: string) => {
  const now = await $.clock.now()
  const before = await read($, card)
  if (before && before.key === issue.key && before.column !== issue.column) {
    $.ui.toast(`${issue.key}: ${before.column} → ${issue.column}`)
  }
  await update($, card, () => ({ ...issue, server, checkedAt: now }))
  $.ui.status(`slonk ${issue.key} · ${issue.column}`)
}

/** Re-reads the tracked card (or `key`) through slonk's get_issue. */
const refresh = async ($: EngineInterface, key?: string): Promise<string> => {
  const current = await read($, card)
  const target = key ?? current?.key
  const server = current?.server ?? (await read($, lastServer))
  if (!target) return 'Карточка ещё не выбрана: работайте со slonk или укажите /slonk-card <KEY>.'
  if (!server) return 'Не знаю, через какой slonk-сервер читать: сначала вызовите любой инструмент slonk.'

  try {
    const res = await $.mcp.call(server, 'get_issue', { issue_id: target })
    const text = res.content.map(block => block.text ?? '').join('')
    const issue = issuesIn(text)[0]
    if (res.isError || !issue) throw new Error(text.slice(0, 200) || 'пустой ответ')
    await store($, issue, server)
    return describe({ ...issue, server, checkedAt: 0 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (current && current.key === target) {
      await update($, card, c => (c ? { ...c, error: message } : c))
    }
    return `Не удалось прочитать ${target}: ${message}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'slonk-card',
      description: 'Текущая карточка slonk: /slonk-card [KEY | off | hide | show]',
    })
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => {
      void read($, card).then(c => (c ? refresh($) : undefined))
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poll?.cancel()
    poll = null

    return next(e)
  })

  on('tool.call', { tool: MCP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const [, server = '', name = ''] = MCP_TOOL.exec(e.tool) ?? []
    if (ran.deny !== undefined || ran.isError) return ran

    const args = e as unknown as Record<string, unknown>
    const issueId = typeof args.issue_id === 'string' ? args.issue_id : undefined
    const found = issuesIn(ran.text)
    if (found.length > 0) slonkServers.add(server)
    if (!isSlonk(server)) return ran
    await update($, lastServer, () => server)

    if (found.length === 1 && (issueId || name === 'create_issue' || name === 'get_issue')) {
      // A single-card call: this card becomes the tracked one.
      await store($, found[0]!, server)
    } else if (found.length > 0) {
      // A list: only refresh the tracked card if it is in there.
      const current = await read($, card)
      const same = current && found.find(i => i.key === current.key)
      if (same) await store($, same, server)
    } else if (issueId) {
      // comment_issue, link_git_ref, ...: no state in the answer, ask for it.
      const current = await read($, card)
      if (current?.key !== issueId) {
        await update($, card, () => ({ key: issueId, title: '', column: '…', group: '', server, checkedAt: 0 }))
      }
      await refresh($, issueId)
    }

    return ran
  })

  on('command.run', { command: 'slonk-card' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'off') {
      await update($, card, () => null)
      $.ui.status(undefined)
      return { text: 'Слежение за карточкой выключено.' }
    }
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: arg === 'hide' ? 'Полоса скрыта.' : 'Полоса показана.' }
    }
    if (arg && !ISSUE_KEY.test(arg.toUpperCase())) {
      return { text: 'Использование: /slonk-card [KEY | off | hide | show]' }
    }

    return { text: await refresh($, arg ? arg.toUpperCase() : undefined) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, card)
    if (!c || e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const minutes = c.checkedAt ? Math.floor(((await $.clock.now()) - c.checkedAt) / 60_000) : null

    return (
      <Box>
        <Text dimColor>slonk </Text>
        <Text bold>{c.key}</Text>
        <Text> · </Text>
        <Text bold color={GROUP_COLOR[c.group] ?? 'white'}>
          {c.column}
        </Text>
        {c.title !== '' && (
          <Text dimColor wrap="truncate-end">
            {' '}
            {c.title}
          </Text>
        )}
        {minutes !== null && minutes > 0 && <Text dimColor> · {minutes} мин назад</Text>}
        <Text> </Text>
        <Button key="refresh" label="Обновить" onPress={() => void refresh($)} />
        <Button key="hide" label="Скрыть" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
