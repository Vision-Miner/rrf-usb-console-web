// One open Web Serial port. Incoming bytes go to onBytes when it is set (console),
// otherwise into a queue served by read() and drain() (bootloader protocol).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SerialLink {
  static async open(port, baudRate, onBytes = null) {
    await port.open({ baudRate });
    return new SerialLink(port, onBytes);
  }

  constructor(port, onBytes) {
    this.port = port;
    this.onBytes = onBytes;                  // set before the first read so no early byte is missed
    this.queue = [];
    this.wake = () => {};
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.closed = this.#pump();              // resolves when the port goes away or is closed
  }

  async #pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (this.onBytes) this.onBytes(value);
        else {
          this.queue.push(...value);
          this.wake();
        }
      }
    } catch {
      // device lost
    }
    this.dead = true;
    this.wake();
  }

  write(bytes) {
    return this.writer.write(bytes);
  }

  // Let the previous write leave as its own USB packet before the next one is queued.
  settle() {
    return sleep(1);
  }

  #arrival(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(timer); resolve(); };
    });
  }

  async read(n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length < n) {
      if (this.dead) throw new Error('The port closed while waiting for a reply');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`No reply from the bootloader (${this.queue.length} of ${n} bytes)`);
      await this.#arrival(left);
    }
    return Uint8Array.from(this.queue.splice(0, n));
  }

  async drain(quietMs) {
    let seen = -1;
    while (seen !== this.queue.length && !this.dead) {
      seen = this.queue.length;
      await this.#arrival(quietMs);
    }
    return Uint8Array.from(this.queue.splice(0));
  }

  async close() {
    try { await this.reader.cancel(); } catch { /* already gone */ }
    await this.closed;
    try { this.reader.releaseLock(); } catch { /* already gone */ }
    try { this.writer.releaseLock(); } catch { /* already gone */ }
    try { await this.port.close(); } catch { /* already gone */ }
  }
}
