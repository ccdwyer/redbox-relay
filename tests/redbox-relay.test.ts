import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { effectOf, impactOf } from '../hooks/native'
import { scrub, scrubLines } from '../hooks/logs'

const RN_PKG = JSON.stringify({
  name: 'myapp',
  scripts: { ios: 'react-native run-ios', android: 'react-native run-android', start: 'react-native start' },
  dependencies: { 'react-native': '0.80.0' },
})
const EXPO_PKG = JSON.stringify({ name: 'myapp', scripts: { ios: 'expo start --ios' }, dependencies: { expo: '54.0.0', 'react-native': '0.80.0' } })
const APP_JSON = JSON.stringify({ name: 'MyApp', displayName: 'My App' })
const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const result = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const SIMS = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'SIM-1', name: 'iPhone 17', state: 'Booted' }] },
})
const ios = (...lines: string[]) => ['Timestamp               Ty Process[PID:TID]', ...lines].join('\n')
const RN = (msg: string, t = '01.100', proc = 'MyApp') =>
  `2026-10-02 09:00:${t} E  ${proc}[123:4a5] [com.facebook.react.log:javascript] ${msg}`

type World = {
  pkg?: string
  files?: Record<string, string>
  dirs?: string[]
  ios?: string
  adb?: string
  iosFails?: boolean
  pidof?: string
  gitStatus?: () => string
  gitHead?: () => string
  gitDiff?: string
  mtime?: () => number
  drop?: boolean
}

function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: 1_759_395_600_000 })
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/app' }))
  const files: Record<string, string> = {
    ...(w.pkg === undefined ? {} : { '/work/app/package.json': w.pkg }),
    '/work/app/app.json': APP_JSON,
    ...w.files,
  }
  const dirs = new Set(w.dirs ?? ['/work/app/ios', '/work/app/android'])
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] as string } : { deny: 'ENOENT' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files || dirs.has(e.path) }))
  on('fs.stat', (_$, e) => (e.resolve ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: 1, mtimeMs: w.mtime === undefined ? 5 : w.mtime(), isLink: false } }))
  on('fs.list', (_$, e) => {
    const kids = [...dirs].filter(d => d.startsWith(`${e.path}/`) && !d.slice(e.path.length + 1).includes('/'))
    return kids.length === 0 ? { deny: 'ENOENT' } : { value: kids.map(d => ({ name: d.split('/').pop() as string, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const [cmd, ...rest] = e.argv
    if (cmd === 'xcrun' && rest[1] === 'list') return result(w.ios === undefined ? '{"devices":{}}' : SIMS)
    if (cmd === 'xcrun') return w.iosFails === true ? result('', 1) : result(w.ios ?? '')
    if (cmd === 'adb' && rest[0] === 'devices') return result(w.adb === undefined ? 'List of devices attached\n' : 'List of devices attached\nemulator-5554\tdevice\n')
    if (cmd === 'adb' && rest.includes('pidof')) return w.pidof === undefined ? result('', 1) : result(w.pidof)
    if (cmd === 'adb') return result(w.adb ?? '')
    if (cmd === 'git' && rest[0] === 'rev-parse' && rest.includes('HEAD')) return w.gitHead === undefined ? result('', 1) : result(`${w.gitHead()}\n`)
    if (cmd === 'git' && rest[0] === 'diff') return result(w.gitDiff ?? '')
    if (cmd === 'git' && w.gitStatus !== undefined) return result(rest[0] === 'rev-parse' ? '' : w.gitStatus())
    return result('', 1)
  })
  on('prompt.submit', (_$, e) => (w.drop === true ? { drop: 'refused' } : { text: e.text, context: e.context }))
  return { calls, clock, w }
}

async function ctx($: Engine, text = 'why') {
  const res = await $.prompt.submit(person(text))
  if (res.drop !== undefined) throw new Error('dropped')
  return (res.context ?? []).join('\n')
}

test('attaches this app’s simulator errors with their stack, deduped, newest copy kept', async ($, on) => {
  world(on, { pkg: RN_PKG, ios: ios(RN('TypeError: x is undefined', '01.1'), '    at Home (Home.tsx:42:15)', RN('TypeError: x is undefined', '02.2'), '    at Home (Home.tsx:42:15)') })
  const text = await ctx($)
  expect(text).toMatch(/iPhone 17/)
  expect(text.match(/TypeError/g)?.length).toBe(1)
  expect(text).toMatch(/09:00:02\.2[\s\S]*Home\.tsx:42:15/)
})

test('keeps errors that differ only in numbers, and process names with spaces', async ($, on) => {
  world(on, { pkg: RN_PKG, ios: ios(RN('at (Home.tsx:42:15)', '01.1', 'My App'), RN('at (Home.tsx:88:10)', '01.2', 'My App')) })
  const text = await ctx($)
  expect(text).toMatch(/42:15/)
  expect(text).toMatch(/88:10/)
})

test('prefers the app’s own process over another React Native app and other crashes', async ($, on) => {
  world(on, {
    pkg: RN_PKG,
    ios: ios(
      RN('Error: ours'),
      RN('Error: theirs', '01.5', 'OtherRNApp'),
      '2026-10-02 09:00:03.000 E  Safari[999:111] Terminating app due to uncaught exception NSRangeException',
    ),
  })
  const text = await ctx($)
  expect(text).toMatch(/ours/)
  expect(text).not.toMatch(/theirs|Safari/)
})

test('an Expo app with native folders does not claim Expo Go', async ($, on) => {
  world(on, { pkg: EXPO_PKG, ios: ios(RN('Error: someone elses snack', '01.1', 'Expo Go')) })
  expect(await ctx($)).toBe('')
})

test('a managed Expo app\u2019s errors inside Expo Go are kept; an unrelated React Native app\u2019s are not', async ($, on) => {
  world(on, { pkg: EXPO_PKG, dirs: [], ios: ios(RN('Error: in expo go', '01.1', 'Expo Go'), RN('Error: some other app', '01.2', 'OtherRNApp')) })
  const text = await ctx($)
  expect(text).toMatch(/in expo go/)
  expect(text).not.toMatch(/some other app/)
})

test('a bare app that logged nothing gets nothing, even when another React Native app errors', async ($, on) => {
  world(on, { pkg: RN_PKG, ios: ios(RN('Error: not ours', '01.2', 'OtherRNApp')) })
  expect(await ctx($)).toBe('')
})

test('attaches Android errors for the app’s pids and its tombstone from the head', async ($, on) => {
  const tombstone = Array.from({ length: 60 }, (_, i) => `10-02 09:00:05.000 F/DEBUG   ( 5000):     #${String(i).padStart(2, '0')} pc 0000 libhermes.so`)
  const { calls, clock } = world(on, {
    pkg: RN_PKG,
    files: { '/work/app/android/app/build.gradle': 'applicationId "com.myapp"' },
    pidof: '4242',
    adb: [
      '10-02 09:00:01.100 E/ReactNativeJS( 4242): Invariant Violation: boom',
      '10-02 09:00:02.000 E/ReactNativeJS( 7000): from another rn app',
      '10-02 09:00:05.000 F/DEBUG   ( 5000): pid: 4242, tid: 4250, name: mqt_js  >>> com.myapp <<<',
      '10-02 09:00:05.000 F/DEBUG   ( 5000): signal 11 (SIGSEGV), code 1',
      ...tombstone,
    ].join('\n'),
  })
  const text = await ctx($)
  expect(text).toMatch(/Invariant Violation/)
  expect(text).toMatch(/SIGSEGV/)
  expect(text).not.toMatch(/another rn app/)
  const logcat = calls.find(c => c.includes('logcat')) as string[]
  expect(Number(logcat[logcat.indexOf('-T') + 1])).toBe((clock.now() - 180_000) / 1000)
  expect(logcat).toContain('time')
})

test('the same read is not attached twice, but the same error at a new time is', async ($, on) => {
  const { w, clock } = world(on, { pkg: RN_PKG, ios: ios(RN('Error: again', '01.1')) })
  expect(await ctx($, 'one')).toMatch(/again/)
  expect(await ctx($, 'two')).toBe('')
  clock.advance(30_000)
  w.ios = ios(RN('Error: again', '01.1'), RN('Error: again', '31.1'))
  expect(await ctx($, 'three')).toMatch(/09:00:31\.1/)
})

test('a failed read does not move the cursor', async ($, on) => {
  const { calls, clock, w } = world(on, { pkg: RN_PKG, ios: ios(RN('Error: missed')), iosFails: true })
  expect(await ctx($, 'one')).toBe('')
  clock.advance(60_000)
  w.iosFails = false
  expect(await ctx($, 'two')).toMatch(/missed/)
  const shows = calls.filter(c => c.includes('show'))
  const last = shows[shows.length - 1] as string[]
  expect(last[last.indexOf('--last') + 1]).toBe('180s')
})

test('masks credentials in log lines', async () => {
  const lines = [
    'Authorization: bearer abcdefghijklmnop',
    '{"password":"correct horse battery staple"}',
    'Cookie: sid=abcdefgh; csrftoken=ijklmnop',
    'GET https://user:hunter22@api.example.com/x',
    'token=supersecret1 next',
    '{"accessToken":"opaque-credential-value","clientSecret":"another-credential-value"}',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
  ].map(scrub).join('\n') + '\n' + scrubLines(['"password":', '  "multi line value"']).join('\n')
  for (const leak of ['abcdefghijklmnop', 'correct horse', 'battery', 'abcdefgh', 'ijklmnop', 'hunter22', 'supersecret1', 'opaque-credential', 'another-credential', 'wJalrXUtnFEMI', 'multi line value']) {
    expect(lines.includes(leak)).toBe(false)
  }
  expect(lines).toMatch(/next/)
})

test('does nothing outside a React Native project', async ($, on) => {
  const { calls } = world(on, { pkg: JSON.stringify({ dependencies: { react: '19' } }), ios: ios(RN('Error: x')) })
  expect(await ctx($)).toBe('')
  expect(calls.length).toBe(0)
})

test('at a monorepo root, picks the app over a native library', async ($, on) => {
  world(on, {
    pkg: JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }),
    files: {
      '/work/app/packages/native-lib/package.json': RN_PKG,
      '/work/app/apps/mobile/package.json': RN_PKG,
      '/work/app/apps/mobile/app.json': APP_JSON,
    },
    dirs: ['/work/app/packages/native-lib', '/work/app/apps/mobile'],
    ios: ios(RN('Error: from the app')),
  })
  on('tool.call', () => ({ result: { staged: false } }))
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/app/apps/mobile/ios/MyApp/AppDelegate.swift', old_string: 'a', new_string: 'b' })
  expect((edit.context ?? []).join('\n')).toMatch(/AppDelegate/)
})

test('/redbox off stops auto-attach', async ($, on) => {
  world(on, { pkg: RN_PKG, ios: ios(RN('Error: x')) })
  await $.command.run({ command: 'redbox', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(await ctx($)).toBe('')
})

function rebuildWorld(on: On, w: World = {}) {
  world(on, { pkg: RN_PKG, ...w })
  on('tool.call', () => ({ result: { staged: false } }))
  const status = { text: undefined as string | undefined }
  on('ui.status', (_$, e) => {
    status.text = e.text
    return { value: undefined }
  })
  return status
}

const edit = (file_path: string, old_string = 'a', new_string = 'b') => ({ tool: 'Edit' as const, file_path, old_string, new_string })

test('native edits warn and are tracked per platform until that platform builds', async ($, on) => {
  const status = rebuildWorld(on)
  const pod = await $.tool.call(edit('/work/app/ios/Podfile'))
  expect((pod.context ?? []).join('\n')).toMatch(/pod install/)
  await $.tool.call(edit('/work/app/android/app/src/main/java/com/myapp/MainActivity.kt'))
  expect(status.text).toMatch(/iOS \(pod install first\), Android · 2 files/)
  await $.tool.call({ tool: 'Bash', command: 'cd ios && pod install && cd .. && npm run ios' })
  expect(status.text).toMatch(/Android · 1 file/)
  await $.tool.call({ tool: 'Bash', command: 'cd android && ./gradlew app:assembleDebug' })
  expect(status.text).toBeUndefined()
})

const CTX = {
  cwd: '/work/app',
  root: '/work/app',
  name: 'myapp',
  scripts: { ios: 'react-native run-ios', start: 'expo start --ios', 'ios:open': 'open ios/MyApp.xcworkspace' },
}
const builds = (command: string, ctx = CTX) => effectOf(command, ctx).steps.filter(s => s.kind === 'build').map(s => (s.kind === 'build' ? s.platform : ''))
const pods = (command: string) => effectOf(command, CTX).steps.some(s => s.kind === 'pods')

test('commands that do not prove a build of this app leave the warning up', () => {
  for (const command of [
    'echo "xcodebuild"', 'xcodebuild -version', 'xcodebuild -list', './gradlew clean', './gradlew buildEnvironment',
    'git diff ios/', 'npm run ios:open', 'npm run start', 'npm run ios | tee build.log', 'npm run ios; echo done',
    'true || npx expo run:ios', 'npx expo run:ios --help', './gradlew assembleDebug --help', 'echo skipped # && npx expo run:ios',
    'cd ../other-app && npx expo run:ios', 'pnpm --filter other-app ios', 'npm --prefix ../other run ios', 'npx expo run:ios &',
    'echo $(npx expo run:ios)', 'true || npx expo run:ios && echo done', 'cd ../other && false && cd ../app; npx expo run:ios',
    'cd ~ && ./gradlew assembleDebug', 'pushd /other/android && ./gradlew assembleDebug', './gradlew --project-dir=/other/android assembleDebug',
    '/other/android/gradlew assembleDebug', './gradlew :app:bundleDebugJsAndAssets', 'pnpm --filter @other/app ios',
  ]) {
    expect([command, builds(command)]).toEqual([command, []])
  }
})

test('builds of this app are credited, however they are spelled', () => {
  expect(builds('npm run ios')).toEqual(['ios'])
  expect(builds('eas build --local --platform=ios')).toEqual(['ios'])
  expect(builds('pnpm --filter myapp ios')).toEqual(['ios'])
  expect(builds('yarn expo run:android')).toEqual(['android'])
  expect(builds('npx expo run:ios 2>&1')).toEqual(['ios'])
  expect(builds('cd android\n./gradlew app:assembleDebug')).toEqual(['android'])
  expect(builds('bash -lc "npx expo run:ios"')).toEqual(['ios'])
  expect(builds('npx react-native run-ios', { ...CTX, cwd: '/work' })).toEqual([])
  expect(pods('npx expo prebuild --platform android')).toBe(false)
  expect(pods('cd ios && bundle exec pod install')).toBe(true)
  expect(pods('npx pod-install')).toBe(true)
  expect(pods('bundle exec pod install')).toBe(false)
  expect(pods('pod install --project-directory=../other/ios')).toBe(false)
  expect(pods('npx expo run:ios')).toBe(true)
  expect(builds('ENVFILE=.env react-native run-ios')).toEqual(['ios'])
  expect(builds('env CI=1 npx expo run:ios')).toEqual(['ios'])
  expect(effectOf('cd ../other && npm install expo-camera', CTX).installs).toEqual([])
})

test('an iOS build does not cover a Podfile change until pods are installed first', async ($, on) => {
  const status = rebuildWorld(on, { dirs: ['/work/app/ios'] })
  await $.tool.call(edit('/work/app/ios/Podfile'))
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp build' })
  expect(status.text).toMatch(/pod install first/)
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp build && cd ios && pod install' })
  expect(status.text).toMatch(/iOS · 1 file/)
  await $.tool.call({ tool: 'Bash', command: 'npm run ios' })
  expect(status.text).toBeUndefined()
})

test('script files under ios/ and non-native Expo config edits do not warn; a bundle id value change does', async ($, on) => {
  const status = rebuildWorld(on, {
    files: { '/work/app/app.json': JSON.stringify({ expo: { name: 'Old', ios: { bundleIdentifier: 'com.example.old' } } }, null, 2) },
  })
  const doc = await $.tool.call(edit('/work/app/docs/android/setup.md'))
  const js = await $.tool.call(edit('/work/app/ios/scripts/build.js'))
  const name = await $.tool.call(edit('/work/app/app.json', '"name": "Old"', '"name": "New"'))
  expect([...(doc.context ?? []), ...(js.context ?? []), ...(name.context ?? [])]).toEqual([])
  const id = await $.tool.call(edit('/work/app/app.json', 'com.example.old', 'com.example.new'))
  expect((id.context ?? []).join('\n')).toMatch(/Expo config/)
  expect(status.text).toMatch(/1 file/)
})

test('an iOS-only app does not track Android', async ($, on) => {
  const status = rebuildWorld(on, { dirs: ['/work/app/ios'] })
  await $.tool.call(edit('/work/app/src/native/Thing.cpp'))
  expect(status.text).toMatch(/iOS · 1 file/)
  expect(status.text).not.toMatch(/Android/)
})

test('dependency changes get a soft note but are not tracked', async ($, on) => {
  const status = rebuildWorld(on, {
    files: { '/work/app/package.json': JSON.stringify({ dependencies: { 'react-native': '0.80.0', 'react-native-reanimated': '3.0.0' } }, null, 2) },
  })
  const bump = await $.tool.call(edit('/work/app/package.json', '"react-native-reanimated": "3.0.0"', '"react-native-reanimated": "4.0.0"'))
  expect((bump.context ?? []).join('\n')).toMatch(/react-native-reanimated.*if any has native code/)
  const add = await $.tool.call({ tool: 'Bash', command: 'npx expo install expo-camera' })
  expect((add.context ?? []).join('\n')).toMatch(/expo-camera/)
  expect(status.text).toBeUndefined()
})

test('native files changed through the shell are caught by a git snapshot', async ($, on) => {
  let changed = false
  world(on, { pkg: RN_PKG, gitStatus: () => (changed ? ' M ios/MyApp/AppDelegate.swift\0' : '') })
  on('tool.call', () => {
    changed = true
    return { result: { stdout: '', stderr: '' } }
  })
  let status: string | undefined
  on('ui.status', (_$, e) => {
    status = e.text
    return { value: undefined }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git apply native.patch' })
  expect((ran.context ?? []).join('\n')).toMatch(/AppDelegate\.swift/)
  expect(status).toMatch(/iOS · 1 file/)
})

test('events over the budget are left out with a note, and the source is reread next time', async ($, on) => {
  const many = Array.from({ length: 12 }, (_, i) => [RN(`Error: number ${i}`, `${String(10 + i)}.000`), '  at a', '  at b', '  at c'].flat()).flat()
  world(on, { pkg: RN_PKG, ios: ios(...many) })
  const first = await ctx($, 'one')
  expect(first).toMatch(/number 11/)
  expect(first).toMatch(/older events? left out/)
  const second = await ctx($, 'two')
  expect(second).toMatch(/number 0/)
  expect(second).not.toMatch(/number 11/)
})

test('a dropped prompt consumes nothing', async ($, on) => {
  // Something beneath refuses the prompt after Redbox Relay attached its logs.
  const { w } = world(on, { pkg: RN_PKG, ios: ios(RN('Error: kept for later')), drop: true })
  const res = await $.prompt.submit(person('one'))
  expect(res.drop).toBeDefined()
  w.drop = false
  expect(await ctx($, 'two')).toMatch(/kept for later/)
})

test('a credential split across Android lines is masked before any budget cut', async ($, on) => {
  world(on, {
    pkg: RN_PKG,
    files: { '/work/app/android/app/build.gradle': 'applicationId "com.myapp"' },
    pidof: '4242',
    adb: ['10-02 09:00:01.100 E/ReactNativeJS( 4242): "password":', '10-02 09:00:01.100 E/ReactNativeJS( 4242):   "supersecret value"'].join('\n'),
  })
  const text = await ctx($)
  expect(text).toMatch(/password/)
  expect(text).not.toMatch(/supersecret/)
})

test('react-native run-ios only installs pods when forced; expo run:ios still does', () => {
  expect(pods('npx react-native run-ios')).toBe(false)
  expect(builds('npx react-native run-ios')).toEqual(['ios'])
  expect(pods('npx react-native run-ios --force-pods')).toBe(true)
  expect(pods('npx react-native run-ios --only-pods')).toBe(true)
  expect(builds('npx react-native run-ios --only-pods')).toEqual([])
  expect(pods('npm run ios')).toBe(false)
  expect(pods('npx expo run:ios')).toBe(true)
  expect(pods('npx expo run:ios --no-install')).toBe(false)
})

test('a Podfile edit stays flagged after react-native run-ios', async ($, on) => {
  const status = rebuildWorld(on, { dirs: ['/work/app/ios'] })
  await $.tool.call(edit('/work/app/ios/Podfile'))
  await $.tool.call({ tool: 'Bash', command: 'npx react-native run-ios' })
  expect(status.text).toMatch(/pod install first/)
})

test('a build only covers native files the same command changed before it', async ($, on) => {
  let changed = ''
  let stamp = 1
  world(on, { pkg: RN_PKG, gitStatus: () => changed, mtime: () => stamp })
  on('tool.call', (_$, e) => {
    const command = String((e as { command?: string }).command ?? '')
    changed = command.includes('Podfile') ? ' M ios/Podfile\0' : ' M ios/MyApp/AppDelegate.swift\0'
    stamp += 1
    return { result: { stdout: '', stderr: '' } }
  })
  const text = async (command: string) => ((await $.tool.call({ tool: 'Bash', command })).context ?? []).join('\n')
  const XB = 'xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp build'
  expect(await text(`${XB} && git apply native.patch`)).toMatch(/AppDelegate\.swift/)
  expect(await text(`git apply other.patch && ${XB}`)).toBe('')
  expect(await text(`git apply Podfile.patch && ${XB}`)).toMatch(/Podfile/)
  expect(await text(`git apply Podfile.patch && cd ios && pod install && cd .. && ${XB}`)).toBe('')
  expect(await text(`${XB} && cd ios && pod install`)).toMatch(/Podfile/)
  expect(await text(`bash -lc '${XB} && git apply native.patch'`)).toMatch(/AppDelegate\.swift/)
})

test('native changes committed inside the same command are still caught', async ($, on) => {
  let head = 'aaa'
  world(on, { pkg: RN_PKG, gitStatus: () => '', gitHead: () => head, gitDiff: 'ios/MyApp/AppDelegate.swift\0' })
  on('tool.call', () => {
    head = 'bbb'
    return { result: { stdout: '', stderr: '' } }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'python3 gen.py && git add ios && git commit -m gen' })
  expect((ran.context ?? []).join('\n')).toMatch(/AppDelegate\.swift/)
})

test('only real native trees count: a scripts/android folder does not, a module ios folder does', () => {
  expect(impactOf('scripts/android/release.sh')).toBeNull()
  expect(impactOf('docs/ios/notes.pdf')).toBeNull()
  expect(impactOf('modules/camera/ios/Camera.swift')?.platforms).toEqual(['ios'])
  expect(impactOf('modules/camera/android/src/main/AndroidManifest.xml')?.platforms).toEqual(['android'])
  expect(impactOf('modules/camera/android/CMakeLists.txt')?.platforms).toEqual(['android'])
  expect(impactOf('ios/MyApp/Images.xcassets/Logo.png')?.platforms).toEqual(['ios'])
})

test('masks PEM private keys and Google API keys', () => {
  const head = '-----BEGIN ' + 'PRIVATE KEY-----'
  const lines = scrubLines([`loaded ${head}`, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'ERROR: next line survives'])
  expect(lines.join('\n')).not.toMatch(/MIIEvQ/)
  expect(lines.join('\n')).toMatch(/next line survives/)
  expect(scrub('maps key=AIza' + 'SyA1234567890abcdefghijklmnopqrstuv')).not.toMatch(/AIza/)
})

test('builds count only for this app: not an example app, not a library task', () => {
  expect(builds('cd examples/Bare && npx expo run:ios')).toEqual([])
  expect(builds('xcodebuild -workspace examples/Bare/ios/Bare.xcworkspace -scheme Bare build')).toEqual([])
  expect(builds('cd android && ./gradlew :some-lib:assembleRelease')).toEqual([])
  expect(builds('cd android && ./gradlew :app:assembleDebug')).toEqual(['android'])
  expect(builds('npx react-native build-ios')).toEqual(['ios'])
  expect(builds('npx react-native build-android')).toEqual(['android'])
  expect(pods('cd ios && pod update')).toBe(true)
  expect(pods('eas build --local --platform ios')).toBe(true)
})

test('with automaticPodsInstallation, run-ios installs pods for a Podfile change only', () => {
  const auto = { ...CTX, autoPods: true }
  const step = effectOf('npx react-native run-ios', auto).steps[0]
  expect(step).toEqual({ kind: 'pods', podfileOnly: true })
  expect(pods('npx react-native run-ios')).toBe(false)
})

test('a workspace selector run from the monorepo root counts for the selected app', () => {
  expect(builds('pnpm --filter myapp ios', { ...CTX, cwd: '/work', root: '/work/app' })).toEqual(['ios'])
})

test('masks encrypted PEM keys with short last lines, and Google keys ending in -', () => {
  const B = '-----BEGIN ', E = '-----END '
  const enc = [`${B}RSA PRIVATE KEY-----`, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,ABCDEF', '', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'QUJDRA==', `${E}RSA PRIVATE KEY-----`, 'after']
  const out = scrubLines(enc).join('\n')
  expect(out).not.toMatch(/MIIEvQ|QUJDRA|ENCRYPTED/)
  expect(out).toMatch(/after/)
  expect(scrub('k="AIza' + 'SyA1234567890abcdefghijklmnopqrstu-"')).not.toMatch(/AIza/)
})
