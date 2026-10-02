// What a change to a file means for the native app, and which shell commands
// provably rebuild it. Pure functions: register.ts feeds them paths and commands.

export type Platform = 'ios' | 'android'
// `soft`: may need a rebuild (a dependency might be native); worth saying, not worth tracking.
export type Impact = { platforms: Platform[]; pods: boolean; note: string; soft?: boolean }

const IOS_SOURCE = /\.(swift|m|mm|xib|storyboard|xcconfig|entitlements|plist|pbxproj|xcscheme)$/
const ANDROID_SOURCE = /\.(kt|kts|java|gradle)$/
const SHARED_SOURCE = /\.(h|hpp|c|cc|cpp)$/
const SCRIPT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|md|mdx|txt|json)$/
const EXPO_JSON = /^app\.json$/
const EXPO_SCRIPT = /^app\.config\.(js|ts|mjs|cjs)$/
// Keys of an Expo config that only reach the app through a native rebuild.
const NATIVE_KEYS = [
  'plugins', 'ios', 'android', 'scheme', 'splash', 'icon', 'orientation', 'userInterfaceStyle',
  'newArchEnabled', 'jsEngine', 'runtimeVersion', 'backgroundColor', 'primaryColor', 'notification', 'locales',
]
const NATIVE_KEY_SET = new Set([...NATIVE_KEYS, 'bundleIdentifier', 'package', 'entitlements', 'infoPlist', 'permissions', 'googleServicesFile', 'associatedDomains', 'intentFilters', 'buildNumber', 'versionCode'])

/**
 * What a change to `rel` (a path relative to the app root) needs before it runs,
 * or null when Fast Refresh picks it up. `before` and `after` are the whole file
 * before and after the change where known.
 */
export function impactOf(rel: string, before?: string, after?: string): Impact | null {
  const parts = rel.split('/')
  const base = parts[parts.length - 1] ?? ''
  const dirs = parts.slice(0, -1)

  if (base === 'Podfile' || base.endsWith('.podspec')) return { platforms: ['ios'], pods: true, note: 'a CocoaPods file changed' }
  if (base === 'Podfile.lock') return null

  const inIos = dirs.includes('ios')
  const inAndroid = dirs.includes('android')
  if (inIos || inAndroid) {
    // Native project folders, the app's or a local/patched module's; scripts and JSON assets in them are not compiled.
    if (SCRIPT.test(base) && !/^google-services\.json$|^Contents\.json$/.test(base)) return null
    const platforms: Platform[] = [...(inIos ? ['ios' as const] : []), ...(inAndroid ? ['android' as const] : [])]
    const where = dirs[0] === 'ios' || dirs[0] === 'android' ? `the ${inIos ? 'Xcode' : 'Android'} project` : 'a native module'
    return { platforms, pods: false, note: `${where} changed` }
  }
  if (IOS_SOURCE.test(base)) return { platforms: ['ios'], pods: false, note: 'native iOS source changed' }
  if (ANDROID_SOURCE.test(base)) return { platforms: ['android'], pods: false, note: 'native Android source changed' }
  if (SHARED_SOURCE.test(base)) return { platforms: ['ios', 'android'], pods: false, note: 'native C/C++ source changed' }
  if (parts.includes('node_modules')) return null
  if (EXPO_JSON.test(rel)) return expoJsonImpact(before, after)
  if (EXPO_SCRIPT.test(rel)) return expoScriptImpact(before, after)
  if (rel === 'react-native.config.js') return { platforms: ['ios', 'android'], pods: true, note: 'native module linking changed' }
  if (rel === 'package.json' && before !== undefined && after !== undefined) {
    const expo = (t: string) => {
      try {
        return JSON.stringify((JSON.parse(t) as { expo?: unknown }).expo ?? null)
      } catch {
        return null
      }
    }
    const was = expo(before)
    const now = expo(after)
    if (was !== null && now !== null && was !== now) {
      const a = expoJsonImpact(JSON.stringify({ expo: JSON.parse(was) ?? {} }), JSON.stringify({ expo: JSON.parse(now) ?? {} }))
      if (a !== null) return a
    }
    const changed = changedDependencies(before, after)
    if (changed.length === 0) return null
    return {
      platforms: ['ios', 'android'],
      pods: true,
      soft: true,
      note: `dependencies changed (${changed.slice(0, 5).join(', ')}); if any has native code it needs pod install and a rebuild`,
    }
  }
  return null
}

const EXPO_NOTE = 'native settings in the Expo config changed (run `npx expo prebuild` if the native folders are generated)'

// app.json: compare the values only a native build reads, whole-file.
function expoJsonImpact(before?: string, after?: string): Impact | null {
  if (before === undefined || after === undefined || before === after) return null
  const pick = (text: string): string | null => {
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const expo = (json.expo ?? json) as Record<string, unknown>
      return JSON.stringify(NATIVE_KEYS.map(k => [k, expo[k]]))
    } catch {
      return null
    }
  }
  const a = pick(before)
  const b = pick(after)
  if (a !== null && b !== null && a === b) return null
  return { platforms: ['ios', 'android'], pods: true, soft: a === null || b === null, note: EXPO_NOTE }
}

// app.config.*: a changed line counts when it, or a key it is nested under, is native.
function expoScriptImpact(before?: string, after?: string): Impact | null {
  if (before === undefined || after === undefined || before === after) return null
  const touched = nativeLineChanged(after, before) || nativeLineChanged(before, after)
  return touched
    ? { platforms: ['ios', 'android'], pods: true, note: EXPO_NOTE }
    : {
        platforms: ['ios', 'android'],
        pods: true,
        soft: true,
        note: 'the Expo config changed; if it affects native settings (plugins, ids, permissions, icons), a prebuild and rebuild are needed',
      }
}

const KEY_LINE = /^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:/
const indent = (line: string) => line.length - line.trimStart().length

// Lines of `text` absent from `other`, checked with the keys enclosing them (by indentation).
function nativeLineChanged(text: string, other: string): boolean {
  const lines = text.split('\n')
  const present = new Set(other.split('\n'))
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (present.has(line) || line.trim() === '') continue
    const own = KEY_LINE.exec(line)
    if (own !== null && NATIVE_KEY_SET.has(own[1] as string)) return true
    let depth = indent(line)
    for (let j = i - 1; j >= 0 && depth > 0; j -= 1) {
      const up = lines[j] as string
      if (up.trim() === '' || indent(up) >= depth) continue
      depth = indent(up)
      const key = KEY_LINE.exec(up)
      if (key !== null && NATIVE_KEY_SET.has(key[1] as string)) return true
    }
  }
  return false
}

function dependencies(text: string): Map<string, string> | null {
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>
    return new Map([...Object.entries(pkg.dependencies ?? {}), ...Object.entries(pkg.devDependencies ?? {})])
  } catch {
    return null
  }
}

// Added, removed and re-versioned dependencies.
function changedDependencies(before: string, after: string): string[] {
  const old = dependencies(before)
  const now = dependencies(after)
  if (old === null || now === null) return []
  const names = new Set([...old.keys(), ...now.keys()])
  return [...names].filter(n => old.get(n) !== now.get(n))
}

// ---- Commands ----

export type Step = { kind: 'pods' } | { kind: 'build'; platform: Platform }
export type CommandEffect = { steps: Step[]; installs: string[] }
export type CommandContext = {
  // The directory the command starts in, and the app it must build to count.
  cwd: string
  root: string
  // The app's package.json scripts and package name, to expand `npm run ios` and match workspace selectors.
  scripts: Record<string, string>
  name?: string
}

type Simple = { words: string[]; op: string }
type Parsed = { commands: Simple[]; isOpaque: boolean }

const NOT_A_RUN = new Set(['echo', 'printf', 'git', 'grep', 'rg', 'cat', 'less', 'head', 'tail', 'which', 'type', 'command', 'man', 'ls', 'find', 'sed', 'awk', 'true', 'false', 'test', ':'])
// assemble/install/bundle a variant, or exactly `build`, optionally under a project path.
const GRADLE_BUILD = /^(?:[\w-]*:)*(?:(?:assemble|install|bundle)(?:[A-Z]\w*)?|build)$/
const GRADLE_PARTIAL = /JsAndAssets|Resources|UnitTest|AndroidTest|Assets$|Manifest|Sources$/
const XCODE_INFO = new Set(['-list', '-version', '-showBuildSettings', '-showsdks', '-help', '-usage', '-showdestinations', '-dry-run', '-n'])
const XCODE_ACTIONS = new Set(['build', 'test', 'archive', 'install', 'build-for-testing'])
const HELP = new Set(['--help', '-h', '--version', '-v', '--dry-run', '-m'])

/**
 * Splits a shell line into simple commands, each with the operator that ends it
 * (`&&`, `||`, `;`, `|`, `&`, or '' at the end). Quotes group words, `#` starts a
 * comment, `N>&M` and `&>` are redirects. Command substitution makes the line
 * opaque: nothing in it is credited.
 */
export function commandsOf(line: string): Parsed {
  const commands: Simple[] = []
  let words: string[] = []
  let word = ''
  let quote: string | null = null
  let started = false
  let isOpaque = false
  const push = () => {
    // A redirect target or operator is not an argument.
    if (started && !/^\d*[<>]/.test(word) && !/^&>/.test(word)) words.push(word)
    word = ''
    started = false
  }
  const end = (op: string) => {
    push()
    commands.push({ words, op })
    words = []
  }
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else {
        if (quote === '"' && (ch === '`' || (ch === '$' && line[i + 1] === '('))) isOpaque = true
        word += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      if (line[i + 1] !== '\n') word += line[i + 1]
      started = started || line[i + 1] !== '\n'
      i += 1
      continue
    }
    if (ch === '`' || (ch === '$' && line[i + 1] === '(')) isOpaque = true
    if (ch === '#' && !started) {
      while (i < line.length && line[i] !== '\n') i += 1
      i -= 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      push()
      continue
    }
    // `2>&1`, `>&2`, `&>file`: redirects, not operators.
    if (ch === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) {
      word += ch
      started = true
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      const pair = line[i + 1] === ch && ch !== ';' && ch !== '\n'
      end(pair ? ch + ch : ch === '\n' ? ';' : ch)
      if (pair) i += 1
      continue
    }
    word += ch
    started = true
  }
  end('')
  return { commands: commands.filter(c => c.words.length > 0 || c.op !== ''), isOpaque }
}

// The trailing commands a zero exit status proves ran and succeeded: the last
// simple command and the `&&` chain leading into it.
function proven(commands: Simple[]): Simple[] {
  const list = commands.filter(c => c.words.length > 0)
  const last = list[list.length - 1]
  // Backgrounded, or reached only when something before it failed: nothing is proven.
  // Backgrounded, or any `||` in the line (a later part may run only because an earlier one failed).
  if (last === undefined || last.op === '&' || list.some(c => c.op === '||')) return []
  const out: Simple[] = []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i] as Simple
    if (i < list.length - 1 && c.op !== '&&') break
    out.unshift(c)
  }
  return out
}

const resolve = (cwd: string, path: string) => {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return `/${out.join('/')}`
}
const inside = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`)

// `--flag value` or `--flag=value`.
function optValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === flag) return args[i + 1]
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return undefined
}

// A wrapper run by path (`/other/android/gradlew`) builds the project it lives in.
const wrapperDir = (cmd: string) => (cmd.includes('/') ? cmd.replace(/\/[^/]*$/, '') || '/' : undefined)

const platformOf = (args: string[]): string => {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === '--platform' || a === '-p') return args[i + 1] ?? 'all'
    if (a.startsWith('--platform=')) return a.slice('--platform='.length)
  }
  return 'all'
}

/**
 * What a successful run of `line` provably did for the app at `ctx.root`: pod
 * installs and platform builds, in order. Also the packages it installed (any
 * part of the line), for a soft note.
 */
export function effectOf(line: string, ctx: CommandContext, depth = 0): CommandEffect {
  const parsed = commandsOf(line)
  const installs: string[] = []
  const steps: Step[] = []
  const trusted = new Set(parsed.isOpaque ? [] : proven(parsed.commands))
  // null: the directory is no longer known, so nothing after it is credited.
  let cwd: string | null = ctx.cwd
  const list = parsed.commands.filter(c => c.words.length > 0)
  for (const [i, c] of list.entries()) {
    const sub: Interpreted = cwd === null ? { steps: [], installs: [] } : interpret(c.words, { ...ctx, cwd }, depth)
    if (sub.cd !== undefined) {
      // A `cd` is certain when it is in the proven tail, or is the line's first command ending in `;`.
      const certain = trusted.has(c) || (i === 0 && c.op === ';')
      cwd = certain ? sub.cd : null
    }
    const counts = trusted.has(c) && cwd !== null && inside(cwd, ctx.root)
    if (counts) {
      steps.push(...sub.steps)
      installs.push(...sub.installs)
    }
  }
  return { steps, installs }
}

type Interpreted = { steps: Step[]; installs: string[]; cd?: string | null }

function interpret(words: string[], ctx: CommandContext, depth: number): Interpreted {
  const none: Interpreted = { steps: [], installs: [] }
  let w = words
  if (w[0] === 'cd') {
    const to = w[1]
    // `cd`, `cd ~`, `cd -`, `cd $VAR`: not a path we can follow.
    return { ...none, cd: to === undefined || to === '-' || to.startsWith('~') || to.includes('$') ? null : resolve(ctx.cwd, to) }
  }
  if (w[0] === 'pushd' || w[0] === 'popd') return { ...none, cd: null }
  // Leading `env`/`cross-env` and NAME=value assignments.
  while (w[0] === 'env' || w[0] === 'cross-env') w = w.slice(1).filter((x, i) => i > 0 || !/^-/.test(x))
  while (w[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1)
  if (w[0] === 'bundle' && w[1] === 'exec') w = w.slice(2)
  if (w[0] === 'npx' || w[0] === 'bunx') w = w.slice(1).filter(x => x !== '--yes' && x !== '-y')
  if ((w[0] === 'pnpm' || w[0] === 'npm') && w[1] === 'exec') w = w.slice(2)
  const head = (w[0] ?? '').split('/').pop() ?? ''
  const args = w.slice(1)
  if (NOT_A_RUN.has(head)) return none
  if (args.some(a => HELP.has(a))) return none

  // `bash -lc "..."` runs its string as a script.
  if ((head === 'bash' || head === 'sh' || head === 'zsh') && depth < 3) {
    const i = args.findIndex(a => /^-\w*c\w*$/.test(a))
    if (i >= 0 && args[i + 1] !== undefined) {
      const inner = effectOf(args[i + 1] as string, ctx, depth + 1)
      return { steps: inner.steps, installs: inner.installs }
    }
    return none
  }

  if (head === 'xcodebuild') {
    if (args.some(a => XCODE_INFO.has(a))) return none
    for (const flag of ['-workspace', '-project']) {
      const i = args.indexOf(flag)
      if (i >= 0 && !inside(resolve(ctx.cwd, args[i + 1] ?? ''), ctx.root)) return none
    }
    const hasTarget = args.some(a => ['-scheme', '-workspace', '-project', '-target'].includes(a))
    return args.some(a => XCODE_ACTIONS.has(a)) || (hasTarget && !args.includes('clean'))
      ? { ...none, steps: [{ kind: 'build', platform: 'ios' }] }
      : none
  }
  if (head === 'gradlew' || head === 'gradle') {
    for (const dir of [optValue(args, '-p'), optValue(args, '--project-dir'), wrapperDir(w[0] ?? '')]) {
      if (dir !== undefined && !inside(resolve(ctx.cwd, dir), ctx.root)) return none
    }
    return args.some(a => GRADLE_BUILD.test(a) && !GRADLE_PARTIAL.test(a)) ? { ...none, steps: [{ kind: 'build', platform: 'android' }] } : none
  }
  if ((head === 'pod' && args[0] === 'install') || head === 'pod-install') {
    const dir = optValue(args, '--project-directory') ?? (head === 'pod-install' ? args.find(a => !a.startsWith('-')) : undefined)
    if (dir !== undefined && !inside(resolve(ctx.cwd, dir), ctx.root)) return none
    return { ...none, steps: [{ kind: 'pods' }] }
  }
  if (head === 'expo' || head === 'react-native') return expoLike(head, args)
  if (head === 'eas' && args[0] === 'build' && args.includes('--local')) {
    const p = platformOf(args)
    const steps: Step[] = []
    if (p === 'ios' || p === 'all') steps.push({ kind: 'build', platform: 'ios' })
    if (p === 'android' || p === 'all') steps.push({ kind: 'build', platform: 'android' })
    return { ...none, steps }
  }
  if (/^(npm|yarn|pnpm|bun)$/.test(head)) return runner(head, args, ctx, depth)
  return none
}

function expoLike(head: string, args: string[]): Interpreted {
  const sub = args[0] ?? ''
  const steps: Step[] = []
  const installs: string[] = []
  if (sub === 'run:ios' || sub === 'run-ios') {
    // Both CLIs install pods before building, unless told not to.
    if (!args.includes('--no-install') && !args.includes('--no-pods')) steps.push({ kind: 'pods' })
    steps.push({ kind: 'build', platform: 'ios' })
  }
  if (sub === 'run:android' || sub === 'run-android') steps.push({ kind: 'build', platform: 'android' })
  if (head === 'expo' && sub === 'prebuild' && !args.includes('--no-install')) {
    const p = platformOf(args)
    if (p === 'ios' || p === 'all') steps.push({ kind: 'pods' })
  }
  if (head === 'expo' && sub === 'install') installs.push(...args.slice(1).filter(a => !a.startsWith('-')))
  return { steps, installs }
}

// npm/yarn/pnpm/bun: workspace selectors must name this app; scripts are expanded.
function runner(head: string, args: string[], ctx: CommandContext, depth: number): Interpreted {
  const none: Interpreted = { steps: [], installs: [] }
  let rest = [...args]
  let cwd = ctx.cwd
  let selected: string | undefined
  for (;;) {
    const a = rest[0]
    if (a === undefined) break
    const value = (flag: string) => (a === flag ? rest[1] : a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : undefined)
    const sel = head === 'yarn' && a === 'workspace' ? rest[1] : value('--filter') ?? value('-F') ?? value('--workspace') ?? value('-w')
    const dir = value('--cwd') ?? value('--prefix') ?? value('-C') ?? value('--dir')
    if (sel !== undefined) {
      selected = sel
      rest = rest.slice(a.includes('=') ? 1 : 2)
    } else if (dir !== undefined) {
      cwd = resolve(cwd, dir)
      rest = rest.slice(a.includes('=') ? 1 : 2)
    } else if (a === '-s' || a === '--silent') rest = rest.slice(1)
    else break
  }
  // Without a selector the runner uses the package in its directory: it must be this app.
  if (selected === undefined && !inside(cwd, ctx.root)) return none
  if (selected !== undefined) {
    const sel = selected.replace(/\.\.\.$/, '')
    // A path selector resolves to a directory; any other is a package name.
    const isPath = sel.startsWith('./') || sel.startsWith('../') || sel.startsWith('/')
    if (isPath ? resolve(ctx.cwd, sel) !== ctx.root : sel !== ctx.name) return none
  }
  const cmd = rest[0] ?? ''
  if (['add', 'install', 'i'].includes(cmd)) return { ...none, installs: rest.slice(1).filter(a => !a.startsWith('-')) }
  // `yarn expo run:ios`, `pnpm react-native run-android`.
  if (cmd === 'expo' || cmd === 'react-native') return expoLike(cmd, rest.slice(1))
  const name = cmd === 'run' || cmd === 'run-script' ? rest[1] : cmd
  if (name === undefined || depth >= 3) return none
  const body = ctx.scripts[name]
  if (body === undefined) return none
  // Expand the script with its pre/post hooks; its body decides what it does.
  const chain = [ctx.scripts[`pre${name}`], body, ctx.scripts[`post${name}`]].filter((s): s is string => s !== undefined).join(' && ')
  const inner = effectOf(chain, { ...ctx, cwd: ctx.root }, depth + 1)
  return { steps: inner.steps, installs: inner.installs }
}
