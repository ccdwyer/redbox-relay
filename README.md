# Redbox Relay

![Redbox Relay demo](media/demo.gif)

*Claude edits `Info.plist` and the `Podfile`; Redbox Relay tells it a JS reload won't pick this up, and the status line tracks the pending native rebuild. ([MP4](https://github.com/ccdwyer/claude-mods/raw/main/media/redbox-relay.mp4))*

A Claude Code mod for React Native work: the model sees what the running app just threw, without you copy-pasting redboxes.

- **Fresh errors on every prompt.** When you send a message in a React Native or Expo project (monorepo workspaces included), Redbox Relay reads every booted iOS Simulator (`xcrun simctl … log show`) and every connected Android device or emulator (`adb logcat`). For each device it reads back to its last successful read, and never more than 3 minutes. It keeps JS errors, unhandled JS exceptions, `RCTFatal`, Java crashes and native tombstones, each message together with its stack, but only from your app's process. The process is matched by app name, by package id (via `pidof` on Android), or by Expo Go for managed Expo projects (no native folders of their own). Other apps' logs on the same device, React Native or not, are left out, and nothing is guessed. Copies within one read are deduped. An error already attached isn't sent again, but the same error thrown again later is. Each device gets a fair share of a 40-line budget, newest events first, each from its top. When events don't fit, a note says how many were left out, and `/redbox` shows more. Bearer tokens, JWTs, auth and cookie headers, URL passwords, common API keys and `token=`/`password=` values are masked. The result is attached to your prompt as context, and a toast says how many lines went in.
- **Native edit warnings.** When the agent edits native code or config, it is told Fast Refresh won't pick the change up and that it needs `pod install` and/or a native rebuild. That covers Swift/ObjC/C++/Kotlin/Java, Xcode and Gradle project files, `Podfile`/`*.podspec`, and the native keys of `app.json`/`app.config.*`. Changing a JS file under `ios/`, or the display name in `app.json`, does not warn. New dependencies get a softer "if it has native code" note.
- **Shell edits count too.** A git snapshot taken around each shell command catches native files changed by `git apply`, `sed -i`, codegen and similar.
- **Status line.** It shows `⚠ native rebuild needed: iOS (pod install first), Android` per platform. It clears only for a provable build of this app on that platform: `expo run:android`, `xcodebuild … build`, `gradlew assembleDebug`, `eas build --local`, or a package script whose body does one of those. Scripts are expanded, so `"ios": "expo start --ios"` doesn't count. A Podfile change needs `pod install` (or `expo run:ios`/`react-native run-ios`, which run it) before the iOS build that clears it. Mentions such as `echo xcodebuild`, info commands like `xcodebuild -list`, `gradlew clean`, scripts like `ios:open`, and `--help`, builds in another directory or workspace, and builds whose success the exit status doesn't prove (after `;`, `|`, `||`, `&`) don't count. Platforms the app doesn't have aren't tracked.
- `/redbox` previews what would be attached right now, and lists any device it couldn't read. `/redbox on|off` toggles auto-attach (remembered across sessions).

Only prompts you type trigger it, not background notifications. With no simulator, emulator, `xcrun` or `adb` around, it does nothing and stays fast.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install redbox-relay@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `command.run{command=redbox}`
- `prompt.submit`
- `tool.call`

Engine calls it makes: `$.clock.now (via collect)`, `$.command.register`, `$.fs.exists (via exists)`, `$.fs.list (via listDirs)`, `$.fs.read (via readText)`, `$.fs.stat (via real`, `snapshot)`, `$.process.run (via run)`, `$.session.cwd`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`, `$.ui.status`, `$.ui.toast`.

A `tool.call` hook sits in the middle of every tool call: it can see the call, refuse it, or add context to its result. This mod uses that only for the behaviour described above.

## License

MIT
