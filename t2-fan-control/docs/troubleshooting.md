# Troubleshooting

The status line at the bottom of the window says what is wrong. Common cases:

## "Cannot open the inpoutx64 driver"

The driver is not installed or not running.

```powershell
Get-CimInstance Win32_SystemDriver -Filter "Name='inpoutx64'" | Format-List Name,State,StartMode,PathName
```

- Nothing returned: install it (see the README).
- `State: Stopped`: start it from an Administrator prompt with `sc start inpoutx64`.
  If it refuses to start, Windows Memory Integrity (Settings → Privacy &
  security → Windows Security → Device security → Core isolation) may be
  blocking it.

## "Could not map the SMC memory window" / "SMC window not responding" / "SMC did not answer correctly"

The SMC was not found at the expected address, or this is not a T2 Mac. Check
what address your machine uses:

```powershell
$d = Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -match 'APP0001' }
Get-CimAssociatedInstance -InputObject $d -ResultClassName Win32_DeviceMemoryAddress | Select-Object Name
```

The app expects a range starting at `0xFE0B0000`. If yours is different, or
there is no memory range at all (pre-T2 Mac), please open an issue with that
output and your model identifier.

## "Macs Fan Control is running — monitoring only"

Quit Macs Fan Control completely. Closing its window only hides it; use its
tray icon's menu to exit.

## Fans stuck at a speed after a crash or forced kill

Start the app again and choose **All fans automatic**, or exit it normally from
the tray menu. A reboot also clears it.

## Readings show "–" now and then

Another program is using the SMC at the same time and a read collided. An
occasional dash is harmless. Constant dashes mean something else is polling the
SMC heavily.

## Getting diagnostics for a bug report

Build and run the read-only probe:

```powershell
.\build.ps1 -Probe
.\build\Probe.exe temps > probe.txt
```

It prints the fan keys with their types and raw bytes, and every `T*` key. It
never writes to the SMC. Attach `probe.txt` to your issue.
