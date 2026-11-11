// A byte link to the board over Web Serial, or over WebUSB (CDC-ACM) on Android, where Chrome's
// Web Serial port picker does not list wired USB devices.
// Incoming bytes go to onBytes when it is set (console), otherwise into a queue served by read()
// and drain() (bootloader protocol).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Link {
  constructor(onBytes) {
    this.onBytes = onBytes;                  // set before the first read so no early byte is missed
    this.queue = [];
    this.wake = () => {};
    this.dead = false;
  }

  feed(bytes) {
    if (this.onBytes) this.onBytes(bytes);
    else {
      this.queue.push(...bytes);
      this.wake();
    }
  }

  end() {
    this.dead = true;
    this.wake();
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
}

class SerialLink extends Link {
  static async open(port, baudRate, onBytes) {
    await port.open({ baudRate });
    return new SerialLink(port, onBytes);
  }

  constructor(port, onBytes) {
    super(onBytes);
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.closed = this.#pump();              // resolves when the port goes away or is closed
  }

  async #pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.feed(value);
      }
    } catch {
      // device lost
    }
    this.end();
  }

  write(bytes) {
    return this.writer.write(bytes);
  }

  // Let the previous write leave as its own USB packet before the next one is queued.
  settle() {
    return sleep(1);
  }

  async close() {
    try { await this.reader.cancel(); } catch { /* already gone */ }
    await this.closed;
    try { this.reader.releaseLock(); } catch { /* already gone */ }
    try { this.writer.releaseLock(); } catch { /* already gone */ }
    try { await this.port.close(); } catch { /* already gone */ }
  }
}

class UsbLink extends Link {
  static async open(device, baudRate, onBytes) {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const interfaces = device.configuration.interfaces;
    const data = interfaces.find((i) => i.alternate.interfaceClass === 0x0a);
    const comm = interfaces.find((i) => i.alternate.interfaceClass === 0x02);
    if (!data) throw new Error('This USB device has no CDC data interface');
    const endpoint = (dir) => data.alternate.endpoints.find((e) => e.type === 'bulk' && e.direction === dir).endpointNumber;
    if (comm) await device.claimInterface(comm.interfaceNumber);
    await device.claimInterface(data.interfaceNumber);
    if (comm) {
      const request = (code, value, body) => device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: code, value, index: comm.interfaceNumber }, body);
      const coding = new DataView(new ArrayBuffer(7));
      coding.setUint32(0, baudRate, true);
      coding.setUint8(6, 8);                                   // 8 data bits, no parity, 1 stop bit
      await request(0x20, 0, coding.buffer);                   // SET_LINE_CODING
      await request(0x22, 0x03);                               // SET_CONTROL_LINE_STATE: DTR and RTS
    }
    return new UsbLink(device, endpoint('in'), endpoint('out'), onBytes);
  }

  constructor(device, epIn, epOut, onBytes) {
    super(onBytes);
    this.device = device;
    this.epIn = epIn;
    this.epOut = epOut;
    this.closed = this.#pump();
  }

  async #pump() {
    try {
      for (;;) {
        const result = await this.device.transferIn(this.epIn, 4096);
        if (result.data?.byteLength) this.feed(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
      }
    } catch {
      // device lost or closed
    }
    this.end();
  }

  async write(bytes) {
    await this.device.transferOut(this.epOut, bytes);
  }

  // Every transferOut is its own USB transfer already.
  async settle() {}

  async close() {
    try { await this.device.close(); } catch { /* already gone */ }
    await this.closed;
  }
}

const android = /Android/i.test(navigator.userAgent);

// The API this browser can reach the board with, or null.
export const backend = !android && 'serial' in navigator ? {
  name: 'Web Serial',
  events: navigator.serial,
  request: (...ids) => navigator.serial.requestPort({ filters: ids.map((id) => ({ usbVendorId: id.vendorId, usbProductId: id.productId })) }),
  is: (port, id) => port.getInfo().usbVendorId === id.vendorId && port.getInfo().usbProductId === id.productId,
  async granted(id) {
    return (await navigator.serial.getPorts()).find((p) => {
      const info = p.getInfo();
      return info.usbVendorId === id.vendorId && info.usbProductId === id.productId;
    }) ?? null;
  },
  open: (port, baudRate, onBytes = null) => SerialLink.open(port, baudRate, onBytes),
} : 'usb' in navigator ? {
  name: 'WebUSB',
  events: navigator.usb,
  request: (...ids) => navigator.usb.requestDevice({ filters: ids }),
  is: (device, id) => device.vendorId === id.vendorId && device.productId === id.productId,
  async granted(id) {
    return (await navigator.usb.getDevices()).find((d) => d.vendorId === id.vendorId && d.productId === id.productId) ?? null;
  },
  open: (device, baudRate, onBytes = null) => UsbLink.open(device, baudRate, onBytes),
} : null;
