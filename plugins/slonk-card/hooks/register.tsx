import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Card } from '../types'

const card = atom({ plugin: 'slonk-card', key: 'card' } as const, null)
const lastServer = atom({ plugin: 'slonk-card', key: 'lastServer' } as const, null)
const isHidden = atom({ plugin: 'slonk-card', key: 'isHidden' } as const, false)
const pulse = atom({ plugin: 'slonk-card', key: 'pulse' } as const, false)

const POLL_MS = 60_000
const PULSE_MS = 700
// slonk's main flow, left to right: one stepper cell per column.
export const FLOW = [
  'Backlog',
  'To Do',
  'Analysis',
  'Development',
  'Security Review',
  'Code Review',
  'Testing',
  'Documenting',
  'Merging',
  'Done',
] as const
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
let flicker: { cancel: () => void } | null = null
// False once the host refused a call the mod made on its own (e.g. under the auto
// permission mode, whose classifier only judges actions the model asked for).
let canPoll = true

const store = async ($: EngineInterface, issue: Issue, server: string) => {
  const now = await $.clock.now()
  const before = await read($, card)
  if (before && before.key === issue.key && before.column !== issue.column) {
    $.ui.toast(`${issue.key}: ${before.column} → ${issue.column}`)
  }
  const at = FLOW.indexOf(issue.column as (typeof FLOW)[number])
  const flowIndex = at >= 0 ? at : before?.key === issue.key ? before.flowIndex : undefined
  await update($, card, () => ({ ...issue, server, checkedAt: now, flowIndex }))
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
    const res = await $.mcp.call(server, 'get_issue', { issue_id: target }).catch((err: unknown) => {
      // The host refused the call itself (not the server answering an error).
      canPoll = false
      throw err
    })
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

/** A card still travelling the flow: its current step flickers. */
const isMoving = (c: Card) => c.column !== 'Done' && FLOW.includes(c.column as (typeof FLOW)[number])

type StepState = 'done' | 'current' | 'blocked' | 'todo'

/** How a step is painted: filled when passed or current, outlined when ahead. */
export const stepLook = (step: StepState, isLit: boolean) => {
  // Every step carries the same square border so all of them have one shape;
  // a filled step's border is the colour of its fill.
  const fill = (color: string) => ({ backgroundColor: color, borderStyle: 'single', borderColor: color })
  if (step === 'done') return fill('success')
  if (step === 'blocked') return fill('error')
  if (step === 'current') return fill(isLit ? 'claude' : 'warning')
  return { backgroundColor: undefined, borderStyle: 'single', borderColor: 'inactive' }
}

const STEP_PX = 7
// Plane's own state colours, so the stepper reads like the board.
const SVG_COLOR = { done: '#46A758', blocked: '#EF4444', current: '#F59E0B', currentLit: '#D97706', todo: '#9AA4BC' }

/**
 * The desktop stepper: one rectangle per FLOW column across the band's width,
 * passed and current ones filled, the ones ahead outlined; the current one
 * flickers through an SVG animation, so no redraw is needed for it.
 */
export const stepperSvg = (states: StepState[]) => {
  const span = 1000
  const gap = 8
  const w = (span - gap * (states.length - 1)) / states.length
  const rects = states.map((step, i) => {
    const x = (i * (w + gap)).toFixed(2)
    const size = `x="${x}" y="0.5" width="${w.toFixed(2)}" height="${STEP_PX - 1}"`
    if (step === 'todo') {
      return `<rect ${size} fill="none" stroke="${SVG_COLOR.todo}" stroke-width="1" vector-effect="non-scaling-stroke"/>`
    }
    if (step === 'current') {
      return (
        `<rect ${size} fill="${SVG_COLOR.current}">` +
        `<animate attributeName="fill" values="${SVG_COLOR.current};${SVG_COLOR.currentLit};${SVG_COLOR.current}" dur="1.4s" repeatCount="indefinite"/>` +
        `</rect>`
      )
    }
    return `<rect ${size} fill="${step === 'done' ? SVG_COLOR.done : SVG_COLOR.blocked}"/>`
  })

  return (
    // Wider than any band: the desktop draws an SVG at its own width capped by
    // the slot, so this makes it span the band; the height is pinned by the prop.
    `<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="${STEP_PX}" ` +
    `viewBox="0 0 ${span} ${STEP_PX}" preserveAspectRatio="none">${rects.join('')}</svg>`
  )
}

/** Terminal cell width so the nine steps and their gaps span the band. */
const cellWidth = (columns: number) => Math.max(3, Math.floor((columns - (FLOW.length - 1)) / FLOW.length))

/** What each FLOW cell shows for a card. */
export const steps = (c: Pick<Card, 'column' | 'group' | 'flowIndex'>): StepState[] => {
  const at = FLOW.indexOf(c.column as (typeof FLOW)[number])
  const current = at >= 0 ? at : (c.flowIndex ?? -1)
  const isDone = c.column === 'Done' || c.group === 'completed'
  const isStuck = at < 0 && c.group !== 'completed'

  return FLOW.map((_, i) => {
    if (isDone || i < current) return 'done'
    if (i === current) return isStuck ? 'blocked' : 'current'
    return 'todo'
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'slonk-card',
      description: 'Текущая карточка slonk: /slonk-card [KEY | off | hide | show]',
    })
    poll?.cancel()
    flicker?.cancel()
    flicker = $.clock.every(PULSE_MS, () => {
      void read($, card).then(c => (c && isMoving(c) ? update($, pulse, p => !p) : undefined))
    })
    poll = $.clock.every(POLL_MS, () => {
      if (canPoll) void read($, card).then(c => (c ? refresh($) : undefined))
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poll?.cancel()
    poll = null
    flicker?.cancel()
    flicker = null

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

    // Only the terminal flickers by redraw; the desktop SVG animates itself.
    const isLit = e.surface === 'desktop' ? false : await read($, pulse)

    let desktopStepper: RenderElement | null = null
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const states = steps(c)
      const at = Math.min(states.filter(st => st === 'done').length + 1, FLOW.length)
      desktopStepper = (
        <Box width="100%" marginTop={1}>
          <Svg
            source={stepperSvg(states)}
            alt={`${c.key}: ${c.column}, шаг ${at} из ${FLOW.length}`}
            height={STEP_PX}
            isInteractive
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" width="100%">
          <Box flexShrink={0}>
            <Text dimColor wrap="truncate">slonk </Text>
            <Text bold wrap="truncate">{c.key}</Text>
            <Text wrap="truncate"> · </Text>
            <Text bold wrap="truncate" color={GROUP_COLOR[c.group] ?? 'white'}>
              {c.column}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {c.title !== '' && (
              <Text dimColor wrap="truncate-end">
                {' '}
                {c.title}
              </Text>
            )}
          </Box>
          <Box flexShrink={0}>
            {minutes !== null && minutes > 0 && <Text dimColor wrap="truncate"> · {minutes} мин назад</Text>}
            <Text> </Text>
            <Button key="refresh" label="Обновить" onPress={() => void refresh($)} />
            <Button key="hide" label="Скрыть" onPress={() => update($, isHidden, () => true)} />
          </Box>
        </Box>
        {desktopStepper ?? (
          <Box flexDirection="row">
            {steps(c).map((step, i) => {
              const look = stepLook(step, isLit)
              const width = cellWidth(e.props.bodyColumns)
              return (
                <Text key={`step-${i}`} backgroundColor={look.backgroundColor} color={look.borderColor}>
                  {i === 0 ? '' : ' '}
                  {look.backgroundColor ? ' '.repeat(width) : `▕${' '.repeat(Math.max(0, width - 2))}▏`}
                </Text>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })
}
