// A native change the running app does not have yet: the platforms still to
// rebuild, and whether `pod install` must run (before the iOS build) first.
export type Pending = { root: string; file: string; platforms: ('ios' | 'android')[]; pods: boolean; gen: number }

declare module 'claude-code' {
  interface PluginState {
    'redbox-relay': {
      // Per log source (`ios:<udid>`, `android:<serial>`): when it was last read in full, ms since epoch.
      cursors: Record<string, number>
      // Short hashes of events already attached, so a later prompt does not repeat them.
      delivered: string[]
      pending: Pending[]
      gen: number
    }
  }
}
