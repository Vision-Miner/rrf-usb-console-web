// SAM-BA ROM bootloader client and EEFC flash programmer for the SAM E70, independent of the transport.
//
// This file is a derived work: a JavaScript port of the USB path of BOSSA 1.9.1
// (https://github.com/shumatech/BOSSA; Samba.cpp, EefcFlash.cpp, Flash.cpp, Applet.cpp, Device.cpp,
// Flasher.cpp), with the word copy applet of WordCopyArm.cpp embedded unchanged. The command order and
// the workarounds are kept as they are there. BOSSA is distributed under this license, which continues
// to apply to the parts taken from it:
//
// Copyright (c) 2011-2018, ShumaTech
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//     * Neither the name of the <organization> nor the
//       names of its contributors may be used to endorse or promote products
//       derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// The port and the additions to it (link test, piece sizes, image check) are
// Copyright (c) 2026 Remenod and released under the MIT License, see LICENSE.
//
// The port object supplies:
//   write(Uint8Array)       send bytes
//   settle()                resolve once everything written has left for the device (BOSSA's flush)
//   read(n, timeoutMs)      resolve with exactly n bytes or reject
//   drain(quietMs)          resolve with whatever arrives until the line stays quiet for quietMs

export class SambaError extends Error {}

// CHIPID_CIDR & 0x7fffffe0 -> [name, flash pages, lock regions]
const CHIPS = {
  0x210d0a00: ['ATSAME70x19', 1024, 32],
  0x21020c00: ['ATSAME70x20', 2048, 64],
  0x21020e00: ['ATSAME70x21', 4096, 128],
};

const FLASH_ADDR = 0x00400000;
const PAGE = 512;
const RAM_ADDR = 0x20400000;
const RAM_SIZE = 0x60000;
const APPLET_ADDR = 0x20401000;
const APPLET_STACK = 0x20404000;
const EEFC_FMR = 0x400e0c00;
const EEFC_FCR = 0x400e0c04;
const EEFC_FSR = 0x400e0c08;
const EEFC_FRR = 0x400e0c0c;
const AIRCR = 0xe000ed0c;

const FCMD = { WP: 0x1, EA: 0x5, CLB: 0x9, GLB: 0xa, SGPB: 0xb, GGPB: 0xd };
const GPNVM_BOOT = 1;

// BOSSA's word copy applet (WordCopyArm.cpp): copies `words` 32-bit words from src to dst.
const APPLET = {
  start: 0x00, stack: 0x20, reset: 0x24, dst: 0x28, src: 0x2c, words: 0x30,
  code: new Uint8Array([
    0x09, 0x48, 0x0a, 0x49, 0x0a, 0x4a, 0x02, 0xe0, 0x08, 0xc9, 0x08, 0xc0, 0x01, 0x3a, 0x00, 0x2a,
    0xfa, 0xd1, 0x04, 0x48, 0x00, 0x28, 0x01, 0xd1, 0x01, 0x48, 0x85, 0x46, 0x70, 0x47, 0xc0, 0x46,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]),
};
const BUFFER_A = (APPLET_ADDR + APPLET.code.length + 3) & ~3;
const BUFFER_B = BUFFER_A + PAGE;

// "byte 511: expected 3A, got 57 (1 of 512 differ)" or null when equal.
function describeDiff(want, got) {
  let first = -1;
  let count = 0;
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== got[i]) {
      if (first < 0) first = i;
      count++;
    }
  }
  if (first < 0) return null;
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
  return `byte ${first}: expected ${hex2(want[first])}, got ${hex2(got[first])} (${count} of ${want.length} differ)`;
}

const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
const ascii = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Samba {
  constructor(port) {
    this.port = port;
    this.writeChunk = 256;                            // data bytes per S command
    this.readChunk = 512;                             // data bytes per R command
  }

  async init() {
    await this.port.drain(100);                       // flush garbage
    await this.port.write(ascii('N#'));               // binary mode
    await this.port.drain(100);                       // "\n\r"; like BOSSA, not required
    await this.port.write(ascii('V#'));
    const reply = await this.port.drain(200);
    let end = 0;
    while (end < reply.length && reply[end] >= 0x20 && reply[end] < 0x7f) end++;
    if (end === 0) throw new SambaError('The bootloader did not report a version');
    this.version = new TextDecoder().decode(reply.subarray(0, end));
  }

  async writeWord(addr, value) {
    await this.port.write(ascii(`W${hex8(addr)},${hex8(value)}#`));
    await this.port.settle();
  }

  async readWord(addr) {
    await this.port.write(ascii(`w${hex8(addr)},4#`));
    const b = await this.port.read(4, 1000);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  async readByte(addr) {
    await this.port.write(ascii(`o${hex8(addr)},4#`));
    return (await this.port.read(1, 1000))[0];
  }

  // The ROM misreads a command and its data in one packet, and macOS has been seen to deliver at most
  // 384 bytes of a larger write (BOSSA issue 106), so the data goes in small separately flushed pieces.
  async write(addr, data) {
    for (let pos = 0; pos < data.length; pos += this.writeChunk) {
      const part = data.subarray(pos, pos + this.writeChunk);
      await this.port.write(ascii(`S${hex8(addr + pos)},${hex8(part.length)}#`));
      await this.port.settle();
      await this.port.write(part);
      await this.port.settle();
    }
  }

  async read(addr, size) {
    const out = new Uint8Array(size);
    for (let pos = 0; pos < size;) {
      let n = Math.min(this.readChunk, size - pos);
      // The ROM fails USB reads whose size is a power of two above 32: take the first byte separately.
      if (n > 32 && (n & (n - 1)) === 0) {
        out[pos++] = await this.readByte(addr + pos - 1);
        n--;
      }
      await this.port.write(ascii(`R${hex8(addr + pos)},${hex8(n)}#`));
      out.set(await this.port.read(n, 2000), pos);
      pos += n;
    }
    return out;
  }

  // After a failed transfer the bootloader may still be waiting for data bytes. Feed it bytes that are
  // harmless both as data and as command text, then check that it answers again.
  async #resync() {
    for (let i = 0; i < 20; i++) {
      await this.port.write(new Uint8Array(32));
      await this.port.settle();
    }
    for (let i = 0; i < 3; i++) {
      await this.port.drain(200);
      try {
        if (((await this.readWord(0xe000ed00)) & 0xfff0) === 0xc270) return;
      } catch {
        // no answer yet
      }
    }
    throw new SambaError('Link test failed and the bootloader stopped answering. Nothing was erased; power-cycle the board and try again.');
  }

  // Find piece sizes that this host's USB stack carries intact, touching bootloader RAM only.
  // Word reads are the reference: chip detection already depends on them.
  async calibrate(addr, log) {
    const size = 512;
    const tries = 3;
    let pattern;
    const attempt = async (check) => {
      try {
        for (let i = 0; i < tries; i++) {
          const bad = await check();
          if (bad) return bad;
        }
        return null;
      } catch (e) {
        await this.port.drain(300);                   // let a confused bootloader run out of input
        return e.message;
      }
    };
    const pick = async (what, sizes, set, check) => {
      for (const chunk of sizes) {
        set(chunk);
        const bad = await attempt(check);
        if (!bad) return;
        log(`link test: ${what} in ${chunk} byte pieces fails: ${bad}`);
        await this.#resync();
      }
      throw new SambaError(`Link test failed: ${what} the bootloader's memory does not work on this computer. Nothing was erased.`);
    };

    await pick('writing', [256, 128, 64, 32], (n) => (this.writeChunk = n), async () => {
      // No '#': if the bootloader loses track, stray pattern bytes can never complete a command.
      pattern = Uint8Array.from({ length: size }, () => (Math.floor(Math.random() * 255) + 0x24) & 0xff);
      await this.write(addr, pattern);
      const got = new Uint8Array(size);
      for (let i = 0; i < size; i += 4) new DataView(got.buffer).setUint32(i, await this.readWord(addr + i), true);
      return describeDiff(pattern, got);
    });
    await pick('reading', [512, 256, 128, 64, 32], (n) => (this.readChunk = n), async () =>
      describeDiff(pattern, await this.read(addr, size)));
    log(`link test passed: write pieces ${this.writeChunk}, read pieces ${this.readChunk}`);
  }

  async go(addr) {
    await this.port.write(ascii(`G${hex8(addr)}#`));
    await this.port.settle();
  }
}

export class Same70Flash {
  constructor(samba, log = () => {}) {
    this.samba = samba;
    this.log = log;
    this.onBufferA = true;
    this.last = 'no command';                         // the latest flash controller command, for error reports
  }

  // Identify the chip the way BOSSA's Device::create does.
  async identify() {
    const s = this.samba;
    if (((await s.readWord(0x0)) & 0xff000000) === 0xea000000) throw new SambaError('This is an ARM7 device, not a SAM E70');
    const cpu = (await s.readWord(0xe000ed00)) & 0xfff0;
    if (cpu !== 0xc270) throw new SambaError(`This is not a Cortex-M7 device (CPUID part 0x${cpu.toString(16)})`);
    let id = await s.readWord(0x400e0740);
    if (id === 0) id = await s.readWord(0x400e0940);
    const chip = CHIPS[id & 0x7fffffe0];
    if (!chip) throw new SambaError(`Unsupported chip, CHIPID 0x${hex8(id)}`);
    [this.name, this.pages, this.lockRegions] = chip;
    this.size = this.pages * PAGE;
  }

  async loadApplet() {
    const s = this.samba;
    await s.write(APPLET_ADDR, APPLET.code);
    await s.writeWord(APPLET_ADDR + APPLET.words, PAGE / 4);
    await s.writeWord(APPLET_ADDR + APPLET.stack, APPLET_STACK);
    await s.writeWord(EEFC_FMR, 0x6 << 8);
    // Error flags stay set until the status is read; one left by an earlier failed run is not ours.
    const stale = await s.readWord(EEFC_FSR);
    if (stale & 0xe) this.log(`flash controller had old error flags set (status 0x${hex8(stale)}), cleared`);
  }

  async #waitReady(seconds = 1) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const fsr = await this.samba.readWord(EEFC_FSR);
      const where = `after ${this.last}, status 0x${hex8(fsr)}`;
      if (fsr & 0x6) {
        // Only the ready, error and ECC bits exist; with others set this was not a status word at all.
        if (fsr & ~0x000f000f) throw new SambaError(`Lost sync with the bootloader (${where})`);
        throw new SambaError(`Flash ${fsr & 0x2 ? 'command' : 'lock'} error (${where})`);
      }
      if (fsr & 0x1) return;
      if (Date.now() > deadline) throw new SambaError('Flash controller timeout');
      await sleep(1);
    }
  }

  #command(cmd, arg) {
    this.last = `${Object.keys(FCMD).find((k) => FCMD[k] === cmd)} ${arg}`;
    return this.samba.writeWord(EEFC_FCR, ((0x5a << 24) | (arg << 8) | cmd) >>> 0);
  }

  // Run the applet through its vector table (BOSSA's Applet::runv).
  async #copy(dst, src) {
    const s = this.samba;
    await s.writeWord(APPLET_ADDR + APPLET.dst, dst);
    await s.writeWord(APPLET_ADDR + APPLET.src, src);
    await this.#waitReady();
    await s.writeWord(APPLET_ADDR + APPLET.reset, APPLET_ADDR + APPLET.start + 1);
    await s.go(APPLET_ADDR + APPLET.stack);
  }

  async unlockAll() {
    await this.#waitReady();
    await this.#command(FCMD.GLB, 0);
    await this.#waitReady();
    const locked = [];
    for (let base = 0; base < this.lockRegions; base += 32) {
      const bits = await this.samba.readWord(EEFC_FRR);
      for (let i = 0; i < 32 && base + i < this.lockRegions; i++) {
        if (bits & (1 << i)) locked.push(base + i);
      }
    }
    for (const region of locked) {
      await this.#waitReady();
      await this.#command(FCMD.CLB, (region * this.pages) / this.lockRegions);
    }
    return locked.length;
  }

  async eraseAll() {
    await this.#waitReady();
    await this.#command(FCMD.EA, 0);
    await this.#waitReady(60);
  }

  // Program one erased page with exactly PAGE bytes.
  async writePage(page, data) {
    const buffer = this.onBufferA ? BUFFER_A : BUFFER_B;
    this.onBufferA = !this.onBufferA;
    await this.samba.write(buffer, data);
    await this.#copy(FLASH_ADDR + page * PAGE, buffer);
    await this.#command(FCMD.WP, page);
  }

  // The ROM returns zeros for direct flash reads, so copy the page to RAM and read it there.
  async readPage(page) {
    const buffer = this.onBufferA ? BUFFER_A : BUFFER_B;
    await this.#copy(buffer, FLASH_ADDR + page * PAGE);
    return this.samba.read(buffer, PAGE);
  }

  async getBootFlash() {
    await this.#waitReady();
    await this.#command(FCMD.GGPB, 0);
    await this.#waitReady();
    return ((await this.samba.readWord(EEFC_FRR)) & (1 << GPNVM_BOOT)) !== 0;
  }

  async setBootFlash() {
    await this.#waitReady();
    await this.#command(FCMD.SGPB, GPNVM_BOOT);
    if (!(await this.getBootFlash())) throw new SambaError('The boot-from-flash bit did not set');
  }

  reset() {
    return this.samba.writeWord(AIRCR, 0x05fa0004);
  }
}

// Reject anything that is not a Cortex-M image linked for SAM E70 flash and RAM.
export function checkImage(image, flashSize) {
  if (image.length < 8) throw new SambaError('The file is too small to be firmware');
  if (image.length > flashSize) throw new SambaError(`The file (${image.length} bytes) is larger than the flash (${flashSize} bytes)`);
  const v = new DataView(image.buffer, image.byteOffset, 8);
  const sp = v.getUint32(0, true);
  const pc = v.getUint32(4, true);
  if (sp <= RAM_ADDR || sp > RAM_ADDR + RAM_SIZE || sp % 4) {
    throw new SambaError(`Not firmware for this board: initial stack pointer 0x${hex8(sp)} is outside its RAM`);
  }
  if (!(pc & 1) || pc < FLASH_ADDR || pc >= FLASH_ADDR + flashSize) {
    throw new SambaError(`Not firmware for this board: reset vector 0x${hex8(pc)} is outside its flash`);
  }
}

// Unlock, erase, write, verify, select boot from flash, reset (bossac -u -e -w -v -b -R).
// The boot bit is set only after the whole image has verified, so a failure leaves the board in the bootloader.
export async function flashFirmware(port, image, onProgress = () => {}, log = () => {}) {
  let stage = 'Connecting';
  const progress = (name, done, total) => {
    if (name !== stage) log(`flash: ${name.toLowerCase()}`);
    stage = name;
    onProgress(name, done, total);
  };
  try {
    const samba = new Samba(port);
    await samba.init();
    const flash = new Same70Flash(samba, log);
    await flash.identify();
    log(`flash: ${flash.name}, bootloader ${samba.version}, ${image.length} bytes`);
    checkImage(image, flash.size);
    progress('Testing link', 0, 1);
    await samba.calibrate(BUFFER_A, log);
    await flash.loadApplet();

    const pages = Math.ceil(image.length / PAGE);
    const pageData = (n) => {
      const data = new Uint8Array(PAGE).fill(0xff);
      data.set(image.subarray(n * PAGE, (n + 1) * PAGE));
      return data;
    };

    progress('Unlocking', 0, 1);
    await flash.unlockAll();
    progress('Erasing', 0, 1);
    await flash.eraseAll();
    for (let n = 0; n < pages; n++) {
      progress('Writing', n, pages);
      await flash.writePage(n, pageData(n));
    }
    for (let n = 0; n < pages; n++) {
      progress('Verifying', n, pages);
      const want = pageData(n);
      let bad = describeDiff(want, await flash.readPage(n));
      if (bad) {
        log(`verify: page ${n} (0x${hex8(FLASH_ADDR + n * PAGE)}) ${bad}; reading it again`);
        bad = describeDiff(want, await flash.readPage(n));
        if (bad) throw new SambaError(`Verify failed in page ${n} at 0x${hex8(FLASH_ADDR + n * PAGE)}, ${bad}; the board stays in the bootloader, flash again`);
        log(`verify: page ${n} matched on the second read`);
      }
    }
    progress('Finishing', 1, 1);
    await flash.setBootFlash();
    await flash.reset();
    return { chip: flash.name, version: samba.version, pages, writeChunk: samba.writeChunk, readChunk: samba.readChunk };
  } catch (e) {
    e.message = `${e.message} (while ${stage.toLowerCase()})`;
    throw e;
  }
}
