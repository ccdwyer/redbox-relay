// Turning raw simulator and device logs into this app's error events.
// Pure functions: register.ts runs the commands and feeds their output here.

// `hosts`: process names that run this app's JS without being named like it (Expo Go).
export type AppIdentity = { names: string[]; packages: string[]; hosts: string[] }

// One logged message: its header line and any lines that continue it (a stack).
export type LogEvent = { at: string; proc: string; tag: string; lines: string[] }

// The React Native log subsystem on iOS, plus the generic crash lines; ownership
// is decided afterwards, from the process that logged them.
export const IOS_PREDICATE = [
  '(subsystem == "com.facebook.react.log" AND (messageType == error OR messageType == fault))',
  'eventMessage CONTAINS "Unhandled JS Exception"',
  'eventMessage CONTAINS "Terminating app due to uncaught exception"',
  'eventMessage CONTAINS "RCTFatal"',
].join(' OR ')

// Tags read on Android; native tombstones are DEBUG/libc at fatal level.
export const ANDROID_FILTER = ['ReactNativeJS:E', 'ReactNative:E', 'AndroidRuntime:E', 'DEBUG:F', 'libc:F', '*:S']

// `log show --style compact`: date time  level  Process Name[pid:tid] message. Names may hold spaces.
const IOS_HEAD = /^(\d{4}-\d{2}-\d{2}[ T][\d:.]+)(?:[+-]\d{2,4})?\s+\w{1,2}\s+(.+?)\[(\d+):[0-9a-fx]+\]\s*/i
// `logcat -v time`: MM-DD time level/Tag( pid): message. Every line carries its own header.
const ANDROID_HEAD = /^(\d{2}-\d{2} [\d:.]+)\s+[VDIWEFA]\/([^(]+?)\(\s*(\d+)\):\s?/

const MAX_EVENT_LINES = 25

export function parseIos(out: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const raw of out.split('\n')) {
    const m = IOS_HEAD.exec(raw)
    if (m !== null) {
      const tag = raw.includes('[com.facebook.react.log') ? 'react' : 'other'
      events.push({ at: m[1] as string, proc: m[2] as string, tag, lines: [raw] })
      continue
    }
    // A line without a header continues the message above it (a stack, a redbox body).
    const last = events[events.length - 1]
    if (last !== undefined && raw.trim() !== '') last.lines.push(raw)
  }
  return events
}

export function parseAndroid(out: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const raw of out.split('\n')) {
    const m = ANDROID_HEAD.exec(raw)
    if (m === null) continue
    const at = m[1] as string
    const tag = (m[2] as string).trim()
    const proc = m[3] as string
    const last = events[events.length - 1]
    // logcat splits one multi-line message into lines with the same header.
    const continues = last !== undefined && last.proc === proc && last.tag === tag && (last.at === at || tag === 'DEBUG')
    // Continuation lines keep only their text, so a value split over lines stays next to its key.
    if (continues) last.lines.push(`    ${raw.slice(m[0].length)}`)
    else events.push({ at, proc, tag, lines: [raw] })
  }
  return events
}

/**
 * This app's events on an iOS simulator: processes named like the app, else a
 * known host of its JS (Expo Go). Other React Native apps' errors stay out.
 */
export function iosEvents(out: string, app: AppIdentity): LogEvent[] {
  const events = parseIos(out)
  const names = new Set(app.names.map(n => n.toLowerCase()))
  const hosts = new Set(app.hosts.map(n => n.toLowerCase()))
  const named = events.filter(e => names.has(e.proc.toLowerCase()))
  return named.length > 0 ? named : events.filter(e => hosts.has(e.proc.toLowerCase()))
}

/**
 * This app's events on an Android device: lines from its live processes (`pids`,
 * from `pidof`), plus crash reports and tombstones that name its package, plus
 * the JS lines of a process that crashed that way. Nothing is guessed.
 */
export function androidEvents(out: string, app: AppIdentity, pids: string[]): LogEvent[] {
  const events = parseAndroid(out)
  // An exact application id, or one of its `:subprocess` processes.
  const ours = (pkg: string) => app.packages.some(p => pkg === p || pkg.startsWith(`${p}:`))
  const owners = new Set(pids)
  for (const e of events) {
    const crashed = /Process: ([\w.:]+), PID: (\d+)/.exec(e.lines.join('\n'))
    if (crashed !== null && (ours(crashed[1] as string) || owners.has(crashed[2] as string))) {
      owners.add(e.proc)
      owners.add(crashed[2] as string)
    }
  }
  // A tombstone is written by crash_dump under its own pid; keep it when it names our process.
  const tombs = new Set<string>()
  for (const e of events) {
    if (e.tag !== 'DEBUG') continue
    const m = /pid: (\d+), tid: \d+, name: .*?>>> ([\w.:]+) <<</.exec(e.lines.join('\n'))
    if (m !== null && (owners.has(m[1] as string) || ours(m[2] as string))) {
      tombs.add(e.proc)
      owners.add(m[1] as string)
    }
  }
  return events.filter(e => (e.tag === 'DEBUG' ? tombs.has(e.proc) : owners.has(e.proc)))
}

/** The message without its timestamp, level and pid/tid: what two copies of one error share. */
export function bare(event: LogEvent): string {
  return event.lines.map(l => l.replace(IOS_HEAD, '$2: ').replace(ANDROID_HEAD, '$2: ').trim()).join('\n')
}

/** One copy of each error in a read, the newest kept, in log order. */
export function dedupe(events: LogEvent[]): LogEvent[] {
  const last = new Map<string, number>()
  events.forEach((e, i) => last.set(bare(e), i))
  return events.filter((e, i) => last.get(bare(e)) === i)
}

/**
 * The newest events that fit in `budget` lines, each from its head (the message
 * and the top of its stack matter most), oldest first. At least one event.
 */
export function fit(events: LogEvent[], budget: number): LogEvent[] {
  const kept: LogEvent[] = []
  let room = budget
  for (let i = events.length - 1; i >= 0 && room > 0; i -= 1) {
    const e = events[i] as LogEvent
    const take = Math.min(e.lines.length, MAX_EVENT_LINES, kept.length === 0 ? Math.max(room, 1) : room)
    if (take < Math.min(e.lines.length, 3) && kept.length > 0) break
    kept.unshift({ ...e, lines: e.lines.slice(0, take) })
    room -= take
  }
  return kept
}

const KEYS = [
  'access_?token', 'refresh_?token', 'id_?token', 'auth_?token', 'session_?token', 'bearer_?token', 'token',
  'password', 'passwd', 'pwd', 'pass_?phrase', 'secret', 'client_?secret', '\\w*secret_?access_?key',
  'api_?key', 'private_?key', 'secret_?key', 'session(?:_?id)?', 'sid', 'csrf_?token', 'xsrf_?token', 'otp', 'pin_?code',
].join('|')

const SECRETS: [RegExp, string][] = [
  // Whole header values: everything after the header name is the credential.
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(["']?\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]'],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted-slack-token]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, '[redacted-api-key]'],
  // key: "quoted value, spaces and escapes allowed", on the same line or the next; or key=value.
  [
    new RegExp(`(?<![A-Za-z0-9])(${KEYS})(["']?[ \\t]*[=:][ \\t]*(?:\\r?\\n[ \\t]*)?)(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"'&,;]{3,})`, 'gi'),
    '$1$2[redacted]',
  ],
]

/** Masks credentials across an event's lines, and keeps them from closing the log block. */
export function scrubLines(lines: string[]): string[] {
  let text = lines.join('\n')
  for (const [pattern, mask] of SECRETS) text = text.replace(pattern, mask)
  text = text.replace(/<\/?device-logs/gi, '‹device-logs')
  return text.split('\n').map(l => (l.length > 600 ? `${l.slice(0, 599)}…` : l))
}

export const scrub = (line: string): string => scrubLines([line]).join('\n')

/** A device name made safe to sit in a quoted attribute. */
export function label(text: string): string {
  return text.replace(/["<>\n\r]/g, ' ').slice(0, 80)
}
