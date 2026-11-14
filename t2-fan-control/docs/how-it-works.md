# How it works

## Source layout

| File | Purpose |
|---|---|
| `src/Smc.cs` | Talks to the Apple SMC: maps its memory window, reads and writes keys, decodes values. |
| `src/Engine.cs` | Background control loop, sensor discovery and names, program entry point. |
| `src/Ui.cs` | The window, tray icon, history graph and settings. Entirely custom drawn. |
| `tools/Probe.cs` | Read-only console diagnostic that prints fan keys and (with `temps`) every `T*` key. |

Everything targets .NET Framework 4.x and C# 5 so it compiles with the `csc.exe`
that ships with Windows.

## Reaching the SMC on a T2 Mac

On pre-T2 Intel Macs the SMC is reached through I/O ports `0x300`/`0x304`. On
T2 Macs that port interface does not answer; the SMC is exposed instead as a
memory-mapped window, described by the ACPI device `APP0001`. Apple's own Boot
Camp `MacHALDriver` still uses the port protocol and returns an error for SMC
key reads on a T2 machine, so it cannot be used.

`Smc.cs` opens `\\.\inpoutx64` and uses its "map physical memory" IOCTL
(`0x9C40201C`, `IOCTL_WINIO_MAPPHYSTOLIN`) to map 64 KB at physical address
`0xFE0B0000` into the process. All register access is then plain memory reads
and writes.

### Registers (offsets from the window base)

| Offset | Name | Use |
|---|---|---|
| `0x0000` | data | Up to 32 bytes of key data |
| `0x0078` | key | Four-character key, first character in the lowest byte |
| `0x007D` | length | Data length |
| `0x007E` | SMC id | Always 0 |
| `0x007F` | command / result | Write the command; read back 0 for success |
| `0x4005` | status | Bit `0x20` = transaction complete |

### Commands

| Code | Meaning |
|---|---|
| `0x10` | Read key |
| `0x11` | Write key |
| `0x12` | Get key name by index (index sent big-endian in the key register) |
| `0x13` | Get key info: bytes 0–3 type (e.g. `flt `, `sp78`, `ui8 `), byte 5 length |

### A read

1. If the status byte is non-zero, write 0 to it.
2. Write the key, then SMC id 0, then the command.
3. Poll the status byte until bit `0x20` is set (timeout 250 ms).
4. Read the result byte; non-zero is an SMC error.
5. For a key read, check the length register matches, then copy the data bytes.

A write is the same except the data bytes and length are written before the
command.

Before trusting the window, the constructor checks the status byte is not
`0xFF` and that key `LDKN` reads a value of at least 2, the same sanity checks
the Linux driver makes.

### Sharing the SMC

Each transaction is wrapped in the named mutex `Global\AppleSmcAccess`, a
convention shared with RPMAC, so cooperating tools do not interleave
transactions. Tools that ignore the mutex (Macs Fan Control, Apple's drivers)
can still collide, which shows up as an occasional failed or garbled read. Every
value is therefore range-checked and retried, and control decisions tolerate a
couple of bad readings.

## Keys used

| Key | Type | Meaning |
|---|---|---|
| `FNum` | `ui8` | Number of fans |
| `F0Ac`, `F1Ac`… | `flt` | Actual speed, RPM |
| `F0Mn` / `F0Mx` | `flt` | Minimum / maximum speed |
| `F0Tg` | `flt` | Target speed (written in manual mode) |
| `F0Md` | `ui8` | 0 = automatic, 1 = manual (written) |
| `#KEY` | `ui32` | Number of keys, used to enumerate sensors |
| `T???` | `sp78` or `flt` | Temperatures, °C |

`flt` values are little-endian IEEE-754 floats. `sp78` is a big-endian signed
16-bit value divided by 256. Other integer types are big-endian.

`Smc.WriteFanKey` refuses to write any key that is not `F<digit>Md` or
`F<digit>Tg`.

## Sensor discovery

At start the engine walks every key index, keeps keys that start with `T`, have
type `sp78` or `flt`, and currently read between 5 and 120 °C. Friendly names
come from the table in `Engine.cs` (`Names`); anything not in the table is shown
by its raw key. "CPU hottest core" is a virtual sensor: the maximum of
`TC1C`…`TC16C`, falling back to `TC0P`.

## Control loop

One background thread runs every two seconds (sooner when a setting changes):

1. If `MacsFanControl.exe` is running, read only and write nothing.
2. Read all sensors, then each fan's actual speed, target and mode.
3. For each fan work out a target:
   - **Automatic:** no target. If the fan is in manual mode, write `F?Md = 0`.
   - **Constant:** the configured RPM.
   - **Sensor:** `min + (max − min) × clamp((t − from) / (to − from))`, rounded
     to 50 RPM. If the sensor cannot be read, the last target is held for two
     cycles, then the fan is returned to automatic.
4. Clamp the target to the fan's own min–max. Write `F?Md = 1` if needed, and
   `F?Tg` when the target moved by at least 50 RPM, the SMC's stored target no
   longer matches, or a re-apply was forced (settings change, resume from
   sleep, Macs Fan Control closing).
5. Publish a snapshot to the window.

On exit the thread writes `F?Md = 0` for every fan (unless Macs Fan Control is
running) and unmaps the window. Exit paths that trigger this: the tray menu,
`--exit`, Windows session end, and unhandled exceptions. A forced kill skips it.

## Window

`Ui.cs` paints the whole window itself in a 1080×780 logical coordinate space,
scaled to the display DPI (and shrunk to fit small screens). Clickable areas are
recorded as hit rectangles during painting. History samples are kept in memory
for 31 minutes and are not written to disk.
