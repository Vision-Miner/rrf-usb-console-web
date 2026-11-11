# RepRapFirmware USB Console

Browser-based serial console and firmware flasher for Duet 3 mainboards. It talks to the board over USB
using the Web Serial API (WebUSB on Android). No installation, no server side.

## Features

- **G-code console** with timestamps and command history.
- **Reconnect after reset**: the port is reopened when the board comes back, so boot messages are captured.
- **Log export** of the whole session to a `.txt` file.
- **Firmware flashing** through the SAM-BA ROM bootloader of the SAM E70, the job `bossac` does:
  unlock, erase, write, verify, set boot-from-flash, reset.
- **Safety checks**: the firmware image is validated against the chip, the USB link is tested on bootloader
  RAM before the flash is erased, and the boot bit is set only after verification.

## Usage

### Console

1. Connect the board by USB and press **Connect**.
2. Select the board in the browser's device list.
3. Enter G-code, for example `M115`.

### Firmware flashing

1. Choose `Duet3Firmware_MB6HC.bin`.
2. Enter the bootloader: fit the ERASE jumper and power-cycle the board, or press **Reboot to bootloader**
   (sends `M999 P"ERASE"`). The board does not boot its firmware again until flashing has finished.
3. Press **Flash** and select the bootloader device.

If flashing fails, the board stays in the bootloader and the operation can be repeated.

## Compatibility

| Platform | Browser | Transport |
|---|---|---|
| Windows, macOS, Linux | Chrome, Edge, Opera | Web Serial |
| Windows, macOS, Linux | Firefox 151+ | Web Serial |
| Android | Chrome | WebUSB |
| Android | Firefox | not supported |
| iOS, iPadOS | any | not supported |

Supported hardware: Duet 3 boards based on the ATSAME70 (USB `1d50:60ee`, bootloader `03eb:6124`).

Notes:

- Browsers expose USB access only in a secure context: HTTPS or `localhost`.
- On Linux the user needs access to `/dev/ttyACM*` (group `dialout` or `uucp`).

## Running locally

```sh
git clone https://github.com/Vision-Miner/rrf-usb-console-web.git
cd rrf-usb-console-web
npm run serve   # http://localhost:8000
npm test
```

There are no dependencies and no build step; `npm` is only used to run the scripts.

## Project structure

| Path | Purpose |
|---|---|
| `index.html`, `src/style.css` | the page |
| `src/app.js` | UI logic |
| `src/serial.js` | Web Serial and WebUSB transports |
| `src/samba.js` | SAM-BA protocol and SAM E70 flash programming |
| `test/` | unit tests against a simulated bootloader |

## License

MIT, see `LICENSE`. `src/samba.js` is derived from [BOSSA](https://github.com/shumatech/BOSSA) and carries
its BSD 3-Clause notice; see `THIRD_PARTY_NOTICES.md`.
