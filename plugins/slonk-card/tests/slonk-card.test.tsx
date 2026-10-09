import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const issue = (column: string, group: string) =>
  JSON.stringify({
    key: 'SLONK-37',
    name: 'Фильтры list_issues',
    state: { id: 'x', name: column, group },
  })

const BAND = {
  plugin: 'slonk-card',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** The stepper's cells as drawn: what fills each one, by its key. */
const stepper = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts
    .filter(t => t.text === '     ' || t.text === '[   ]')
    .map(t => String(t.props.backgroundColor ?? t.props.color))
}

const bandText = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text).join('')
}

// What the engine stands for beneath the plugin: a clock and its own (empty) band.
const world = (on: On) => {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return mock.clock(on, { now: 1_000_000 })
}

describe('slonk-card', () => {
  test('shows the column of the card a slonk call returned', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__slonk-developer__get_issue' }, () => ({
      result: {},
      text: issue('Development', 'started'),
    }))

    await $.tool.call({ tool: 'mcp__slonk-developer__get_issue', issue_id: 'SLONK-37' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = await bandText($, surface)
      expect(text).toContain('SLONK-37')
      expect(text).toContain('Development')
    }
  })

  test('re-reads the card after a call whose answer has no state', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__slonk-qa__get_issue' }, () => ({
      result: {},
      text: issue('Testing', 'started'),
    }))
    on('tool.call', { tool: 'mcp__slonk-qa__comment_issue' }, () => ({
      result: {},
      text: JSON.stringify({ ok: true, comment_id: 'c1' }),
    }))
    on('mcp.call', () => ({
      value: { content: [{ type: 'text', text: issue('Documenting', 'started') }], isError: false },
    }))

    await $.tool.call({ tool: 'mcp__slonk-qa__get_issue', issue_id: 'SLONK-37' })
    await $.tool.call({ tool: 'mcp__slonk-qa__comment_issue', issue_id: 'SLONK-37', body: 'ok' })

    expect(await bandText($, 'terminal')).toContain('Documenting')
  })

  test('follows slonk connected under a UUID name', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__c9007cc4-028b-4894__claim_issue' }, () => ({
      result: {},
      text: issue('Analysis', 'started'),
    }))

    await $.tool.call({ tool: 'mcp__c9007cc4-028b-4894__claim_issue', issue_id: 'SLONK-37' })

    expect(await bandText($, 'terminal')).toContain('Analysis')
  })

  test('ignores issues of other trackers', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__linear__get_issue' }, () => ({
      result: {},
      text: JSON.stringify({ key: 'SLONK-37', name: 'x', state: { name: 'In Progress', type: 'started' } }),
    }))

    await $.tool.call({ tool: 'mcp__linear__get_issue', issue_id: 'SLONK-37' })

    expect(await bandText($, 'terminal')).not.toContain('SLONK-37')
  })

  test('/slonk-card off stops showing the card', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__slonk-developer__get_issue' }, () => ({
      result: {},
      text: issue('Code Review', 'started'),
    }))
    await $.tool.call({ tool: 'mcp__slonk-developer__get_issue', issue_id: 'SLONK-37' })

    const res = await $.command.run({
      command: 'slonk-card',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

    expect(res.text).toContain('выключено')
    expect(await bandText($, 'terminal')).not.toContain('SLONK-37')
  })

  test('polls slonk and shows a move made by another agent', async ($, on) => {
    const clock = world(on)
    let column = 'Code Review'
    on('tool.call', { tool: 'mcp__slonk-developer__transition_issue' }, () => ({
      result: {},
      text: issue(column, 'started'),
    }))
    on('mcp.call', () => ({
      value: { content: [{ type: 'text', text: issue(column, 'started') }], isError: false },
    }))

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__slonk-developer__transition_issue', issue_id: 'SLONK-37', state: 'Code Review' })
    expect(await bandText($, 'terminal')).toContain('Code Review')

    column = 'Testing'
    await clock.advance(60_000)

    expect(await bandText($, 'terminal')).toContain('Testing')
  })

  test('stops polling once the host refuses its own MCP calls', async ($, on) => {
    const clock = world(on)
    let calls = 0
    on('tool.call', { tool: 'mcp__slonk-developer__get_issue' }, () => ({
      result: {},
      text: issue('Testing', 'started'),
    }))
    on('mcp.call', () => {
      calls += 1
      return { deny: 'auto mode classifier gave no verdict' }
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__slonk-developer__get_issue', issue_id: 'SLONK-37' })
    await clock.advance(60_000)
    await clock.advance(60_000)

    expect(calls).toBe(1)
    expect(await bandText($, 'terminal')).toContain('Testing')
  })

  test('draws the flow as a stepper in the band', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__slonk-developer__transition_issue' }, () => ({
      result: {},
      text: issue('Code Review', 'started'),
    }))
    await $.tool.call({ tool: 'mcp__slonk-developer__transition_issue', issue_id: 'SLONK-37', state: 'Code Review' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const cells = await stepper($, surface)
      expect(cells.slice(0, 4)).toEqual(['success', 'success', 'success', 'success'])
      expect(['warning', 'claude']).toContain(cells[4])
      expect(cells.slice(5)).toEqual(['inactive', 'inactive', 'inactive', 'inactive'])
    }
  })

  test('the current step flickers', async ($, on) => {
    const clock = world(on)
    on('tool.call', { tool: 'mcp__slonk-developer__transition_issue' }, () => ({
      result: {},
      text: issue('Testing', 'started'),
    }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__slonk-developer__transition_issue', issue_id: 'SLONK-37', state: 'Testing' })

    const before = (await stepper($, 'terminal'))[5]
    await clock.advance(700)
    const after = (await stepper($, 'terminal'))[5]

    expect(before).not.toBe(after)
  })

  test('a blocked card keeps its place and turns the step red', async ($, on) => {
    world(on)
    let column = 'Development'
    let group = 'started'
    on('tool.call', { tool: 'mcp__slonk-developer__transition_issue' }, () => ({
      result: {},
      text: issue(column, group),
    }))
    await $.tool.call({ tool: 'mcp__slonk-developer__transition_issue', issue_id: 'SLONK-37', state: column })
    column = 'Blocked'
    group = 'unstarted'
    await $.tool.call({ tool: 'mcp__slonk-developer__transition_issue', issue_id: 'SLONK-37', state: column })

    const cells = await stepper($, 'terminal')
    expect(cells.slice(0, 2)).toEqual(['success', 'success'])
    expect(cells[2]).toBe('error')
  })

  test('a done card fills every step', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'mcp__slonk-merger__transition_issue' }, () => ({
      result: {},
      text: issue('Done', 'completed'),
    }))
    await $.tool.call({ tool: 'mcp__slonk-merger__transition_issue', issue_id: 'SLONK-37', state: 'Done' })

    expect(new Set(await stepper($, 'desktop'))).toEqual(new Set(['success']))
  })
})
