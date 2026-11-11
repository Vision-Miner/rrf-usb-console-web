// Model of a SAM E70 in its SAM-BA ROM bootloader, for tests: command parser, RAM, flash with an
// EEFC page latch (programming can only clear bits), lock bits, GPNVM bits and the word copy applet.

const FLASH = 0x00400000;
const RAM = 0x20400000;
const PAGE = 512;
const EEFC = 0x400e0c00;

export class FakeSamba {
  constructor({ chipId = 0xa1020c00, pages = 2048, lockRegions = 64 } = {}) {
    this.chipId = chipId;
    this.pages = pages;
    this.lockRegions = lockRegions;
    this.ram = new Uint8Array(0x60000);
    this.flash = new Uint8Array(pages * PAGE).fill(0x5a);     // old contents, to prove the erase
    this.latch = new Uint8Array(PAGE).fill(0xff);
    this.locked = new Set();
    this.gpnvm = 0;
    this.frr = [];
    this.fsr = 1;
    this.resetRequested = false;
    this.corruptPage = -1;                                     // set to a page number to break its programming
    this.text = '';
    this.pending = null;                                       // { addr, left } while S data is expected
    this.onSend = () => {};
  }

  receive(bytes) {
    for (const b of bytes) {
      if (this.pending) {
        this.#write8(this.pending.addr++, b);
        if (--this.pending.left === 0) this.pending = null;
        continue;
      }
      const ch = String.fromCharCode(b);
      if (ch !== '#') { this.text += ch; continue; }
      // Like the ROM, take the last command letter and its arguments; anything before it is noise.
      const cmd = this.text.match(/[NVwoWSRG][0-9A-Fa-f,]*$/)?.[0];
      this.text = '';
      if (cmd) this.#run(cmd);
    }
  }

  #send(bytes) {
    this.onSend(Uint8Array.from(bytes));
  }

  #run(cmd) {
    const [a, b] = cmd.slice(1).split(',').map((x) => parseInt(x, 16));
    switch (cmd[0]) {
      case 'N': this.#send([0x0a, 0x0d]); break;
      case 'V': this.#send([...new TextEncoder().encode('v1.1 Dec 15 2010 19:25:04'), 0x0a, 0x0d]); break;
      case 'w': { const v = this.#read32(a); this.#send([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]); break; }
      case 'o': this.#send([this.#read8(a)]); break;
      case 'W': this.#write32(a, b); break;
      case 'S': this.pending = { addr: a, left: b }; break;
      case 'R':
        // The ROM bug BOSSA works around: such reads never complete.
        if (b > 32 && (b & (b - 1)) === 0) break;
        this.#send(Array.from({ length: b }, (_, i) => this.#read8(a + i)));
        break;
      case 'G': this.#go(a); break;
      default: throw new Error(`fake SAM-BA: unknown command ${cmd}`);
    }
  }

  // Vector-table start of the word copy applet.
  #go(addr) {
    const reset = this.#read32(addr + 4);
    const base = (reset & ~1) >>> 0;
    if (this.#read8(base) !== 0x09 || this.#read8(base + 1) !== 0x48) throw new Error('fake SAM-BA: jump to something that is not the applet');
    const dst = this.#read32(base + 0x28);
    const src = this.#read32(base + 0x2c);
    const words = this.#read32(base + 0x30);
    for (let i = 0; i < words * 4; i++) this.#write8(dst + i, this.#read8(src + i));
  }

  #read8(addr) {
    if (addr >= RAM && addr < RAM + this.ram.length) return this.ram[addr - RAM];
    if (addr >= FLASH && addr < FLASH + this.flash.length) return this.flash[addr - FLASH];
    return (this.#read32(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
  }

  #write8(addr, value) {
    if (addr >= RAM && addr < RAM + this.ram.length) this.ram[addr - RAM] = value;
    else if (addr >= FLASH && addr < FLASH + this.flash.length) this.latch[(addr - FLASH) % PAGE] = value;
    else throw new Error(`fake SAM-BA: byte write to 0x${addr.toString(16)}`);
  }

  #read32(addr) {
    if ((addr >= RAM && addr < RAM + this.ram.length) || (addr >= FLASH && addr < FLASH + this.flash.length)) {
      return (this.#read8(addr) | (this.#read8(addr + 1) << 8) | (this.#read8(addr + 2) << 16) | (this.#read8(addr + 3) << 24)) >>> 0;
    }
    switch (addr) {
      case 0x0: return 0x20401000;
      case 0xe000ed00: return 0x410fc271;
      case 0x400e0740: return 0;
      case 0x400e0940: return this.chipId;
      case 0x400e0944: return 0x2;
      case EEFC + 0x08: { const v = this.fsr; this.fsr = 1; return v; }
      case EEFC + 0x0c: return this.frr.shift() ?? 0;
      default: throw new Error(`fake SAM-BA: read of 0x${addr.toString(16)}`);
    }
  }

  #write32(addr, value) {
    if (addr >= RAM && addr < RAM + this.ram.length) {
      for (let i = 0; i < 4; i++) this.ram[addr - RAM + i] = (value >>> (i * 8)) & 0xff;
    } else if (addr === EEFC) {
      this.fmr = value;
    } else if (addr === EEFC + 0x04) {
      this.#eefc(value);
    } else if (addr === 0xe000ed0c && value === 0x05fa0004) {
      this.resetRequested = true;
    } else {
      throw new Error(`fake SAM-BA: write of 0x${addr.toString(16)}`);
    }
  }

  #eefc(value) {
    if (value >>> 24 !== 0x5a) { this.fsr |= 2; return; }
    const cmd = value & 0xff;
    const arg = (value >>> 8) & 0xffff;
    const region = (page) => Math.floor((page * this.lockRegions) / this.pages);
    switch (cmd) {
      case 0x1:                                                // WP
        if (this.locked.has(region(arg))) { this.fsr |= 4; break; }
        for (let i = 0; i < PAGE; i++) this.flash[arg * PAGE + i] &= this.latch[i];
        if (arg === this.corruptPage) this.flash[arg * PAGE + 7] ^= 0x10;
        this.latch.fill(0xff);
        break;
      case 0x5:                                                // EA
        if (this.locked.size) { this.fsr |= 4; break; }
        this.flash.fill(0xff);
        break;
      case 0x9: if (!this.ignoreUnlock) this.locked.delete(region(arg)); break;   // CLB
      case 0xa:                                                // GLB
        this.frr = [];
        for (let base = 0; base < this.lockRegions; base += 32) {
          let bits = 0;
          for (let i = 0; i < 32; i++) if (this.locked.has(base + i)) bits |= 1 << i;
          this.frr.push(bits >>> 0);
        }
        break;
      case 0xb: this.gpnvm |= 1 << arg; break;                 // SGPB
      case 0xc: this.gpnvm &= ~(1 << arg); break;              // CGPB
      case 0xd: this.frr = [this.gpnvm]; break;                // GGPB
      default: this.fsr |= 2;
    }
  }
}

// In-process port for flashFirmware(): the fake answers synchronously into a byte queue.
export function fakePort(fake) {
  let queue = [];
  fake.onSend = (bytes) => queue.push(...bytes);
  return {
    write: async (bytes) => fake.receive(bytes),
    settle: async () => {},
    read: async (n) => {
      if (queue.length < n) throw new Error(`fake port: ${n} bytes wanted, ${queue.length} available`);
      return Uint8Array.from(queue.splice(0, n));
    },
    drain: async () => Uint8Array.from(queue.splice(0)),
  };
}
