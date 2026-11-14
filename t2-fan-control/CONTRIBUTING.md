# Contributing

Thanks for looking. The project is small and has been tested on one machine, so
reports from other hardware are especially valuable.

## Reporting a problem

Please include:

- Mac model identifier (`(Get-CimInstance Win32_ComputerSystem).Model`, e.g. `MacBookPro16,1`)
- Windows version
- What the status line at the bottom of the window says
- Output of the read-only probe (`.\build.ps1 -Probe`, then `.\build\Probe.exe temps`)
- Whether Macs Fan Control or another fan/monitoring tool is installed or running

## Reporting that it works

Equally useful. Open an issue titled with your model identifier and say which
modes you tried.

## Sensor names

If a sensor is shown by its raw key (for example `TH0a`) and you know what it
measures, or a name is wrong, say so in an issue or send a change to the `Names`
table in `src/Engine.cs`.

## Code changes

- Keep it buildable with the in-box compiler: C# 5 syntax, .NET Framework 4.x,
  no NuGet packages. `.\build.ps1` must succeed.
- Keep SMC writes limited to `F?Md` and `F?Tg`. Changes that write other keys
  will not be accepted without a very good reason.
- Anything that changes fan behaviour should fail safe: when in doubt, hand the
  fan back to automatic.
- Say what hardware you tested on in the pull request.
