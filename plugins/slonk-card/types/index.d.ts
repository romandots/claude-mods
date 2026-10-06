export type Card = {
  /** Issue key, e.g. SLONK-37 */
  key: string
  title: string
  /** Column (state name), e.g. "Code Review" */
  column: string
  /** Plane state group: backlog | unstarted | started | completed | cancelled */
  group: string
  /** MCP server the card was last seen through, e.g. slonk-developer */
  server: string
  /** Epoch ms of the last successful read */
  checkedAt: number
  /** Last refresh error, if the latest read failed */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'slonk-card': {
      card: Card | null
      lastServer: string | null
      isHidden: boolean
    }
  }
}
