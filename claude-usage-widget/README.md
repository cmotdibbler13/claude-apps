# Claude Usage Taskbar Widget

A tiny strip on the Windows 11 taskbar, just left of the system tray and clock, showing your
Claude **5-hour** and **7-day** usage as percentages with colour-coded bars
(green under 50 %, amber under 80 %, red from 80 %), next to a little orange Claude critter.
Hover for reset times.

Pure PowerShell + WinForms. Nothing to install beyond Claude Code itself.

## Where the numbers come from

The widget uses **no login and makes no network calls of its own**. It reads a small local
file, which is kept up to date by two documented Claude Code features:

1. **`/usage` check (covers everything).** Every 5 minutes, and whenever you left-click, the
   widget runs `claude -p "/usage"` in the background. Claude Code looks up your account-wide
   plan usage and prints a report; the widget saves the 5-hour ("session") and weekly
   ("all models") rows. Because the figures are account-wide, this includes usage from the
   **Claude desktop app** and **claude.ai**. Claude Code answers `/usage` locally: it uses
   **no model tokens** (zero turns, zero cost).
2. **Status line (instant, terminal only).** After each response in a Claude Code terminal
   session, Claude Code pipes its rate-limit figures to `Save-ClaudeUsage.ps1`, which updates
   the same file straight away.

```
every 5 min / on click:  claude -p "/usage"  ──┐
                                               ├─>  %LOCALAPPDATA%\ClaudeUsageWidget\usage.json  ─>  widget
terminal session:  status line -> Save-ClaudeUsage.ps1 ──┘
```

Notes:

- Desktop-app usage appears within the check interval (5 minutes by default), or at once on click.
- When a window's reset time passes, the widget shows it as 0 % on its own.
- Hover shows how old the last report is, and the reason if a check failed.
- The `/usage` check runs with no connectors, no saved transcript and without your user hooks
  or plugins, from a neutral folder, so it stays quick (about 2 seconds) and leaves nothing behind.

## Files

| File | Purpose |
|------|---------|
| `ClaudeUsageWidget.ps1` | The widget (UI, timers, placement, background `/usage` check) |
| `Save-ClaudeUsage.ps1` | Claude Code status line command. Saves usage to the local file, prints the status line |
| `ClaudeUsage.Core.psm1` | Helpers: run and parse `/usage`, snapshot parse/merge/read, formatting, colours, layout |
| `Install-Shortcuts.ps1` | Adds/removes the Startup and Desktop shortcuts, and builds `widget.ico` for them |
| `tests\Core.Tests.ps1` | Pester tests, including a guard that no script touches the login file or makes web requests |

## Setup

1. Have Claude Code installed and signed in with your subscription (`claude auth login`).
2. Create the shortcuts:
   ```
   powershell -ExecutionPolicy Bypass -File Install-Shortcuts.ps1
   ```
   This adds **Claude Usage Widget** to the Desktop (start or restart) and to the Startup
   folder (start at logon). Remove both with `Install-Shortcuts.ps1 -Remove`.
3. Double-click **Claude Usage Widget** on the Desktop.
4. Optional, instant updates from terminal sessions. In `~\.claude\settings.json`:
   ```json
   "statusLine": {
     "type": "command",
     "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/claude-usage-widget/Save-ClaudeUsage.ps1"
   }
   ```
   Put in the folder where you saved the widget, with forward slashes.

## No console window

The shortcuts start PowerShell under `conhost.exe --headless`, which gives it a console that
never has a window. Nothing appears on the taskbar except the strip, so there is no black
window to close by accident. (`powershell -WindowStyle Hidden` is not enough: the window
appears first, and under some terminal hosts it stays.) To start it by hand the same way:

```
conhost --headless powershell -NoProfile -ExecutionPolicy Bypass -File ClaudeUsageWidget.ps1
```

## Using it

- **Desktop shortcut**: starts the widget, or restarts it if it is already running.
- **Left-click**: ask Claude Code for fresh numbers now (a small dot shows while it checks).
- **Right-click**: Check now, open the claude.ai usage page in your browser, Quit.
- **Hover**: both windows with "resets in ...", and when Claude Code last reported.
- `--` means no data yet (hover to see why).

Claude Code's own status line also shows the figures in terminal sessions, e.g. `Opus | 5h 22% | 7d 43%`.

## Options

```
ClaudeUsageWidget.ps1 -CheckMinutes 5 -RefreshSeconds 5 -Width 184 -Height 40 -Gap 6 [-Restart]
```

`-CheckMinutes 0` turns the timer off, leaving click-to-check and the status line feed.
`-Restart` closes a copy that is already running before starting (the Desktop shortcut uses it).
To change an option for good, add it to the end of the Target of both "Claude Usage Widget"
shortcuts (Desktop and Startup folder). Running `Install-Shortcuts.ps1` again resets them.

## Tests

```
powershell -ExecutionPolicy Bypass -Command "Invoke-Pester -Path tests"
```

## Uninstall

Right-click the strip and Quit, run `Install-Shortcuts.ps1 -Remove`, remove the `statusLine`
block from `~\.claude\settings.json`, and delete `%LOCALAPPDATA%\ClaudeUsageWidget`.
