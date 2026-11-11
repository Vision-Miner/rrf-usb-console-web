import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { flashFirmware, checkImage } from '../src/samba.js';
import { FakeSamba, fakePort } from './fake-samba.js';

// A random image with a plausible SAM E70 vector table.
export function makeImage(size) {
  const image = new Uint8Array(randomBytes(size));
  const v = new DataView(image.buffer);
  v.setUint32(0, 0x20460000, true);
  v.setUint32(4, 0x00400401, true);
  return image;
}

test('flashes, verifies, selects boot from flash and resets', async () => {
  const fake = new FakeSamba();
  const image = makeImage(70123);
  const stages = new Set();
  const result = await flashFirmware(fakePort(fake), image, (stage) => stages.add(stage));
  assert.equal(result.chip, 'ATSAME70x20');
  assert.deepEqual(fake.flash.subarray(0, image.length), image);
  assert.ok(fake.flash.subarray(image.length).every((b) => b === 0xff), 'rest of the flash is erased');
  assert.equal(fake.gpnvm, 0b10);
  assert.equal(fake.resetRequested, true);
  assert.deepEqual([...stages], ['Testing link', 'Unlocking', 'Erasing', 'Writing', 'Verifying', 'Finishing']);
});

test('a page-aligned image is written whole', async () => {
  const fake = new FakeSamba();
  const image = makeImage(4096);
  await flashFirmware(fakePort(fake), image);
  assert.deepEqual(fake.flash.subarray(0, 4096), image);
});

test('locked regions are unlocked first', async () => {
  const fake = new FakeSamba();
  fake.locked = new Set([0, 3, 40]);
  await flashFirmware(fakePort(fake), makeImage(9000));
  assert.equal(fake.locked.size, 0);
  assert.equal(fake.gpnvm, 0b10);
});

test('a programming fault fails verification and leaves the board in the bootloader', async () => {
  const fake = new FakeSamba();
  fake.corruptPage = 5;
  await assert.rejects(flashFirmware(fakePort(fake), makeImage(9000)), /Verify failed in page 5 at 0x00400A00, byte 7: .* \(1 of 512 differ\)/);
  assert.equal(fake.gpnvm, 0);
  assert.equal(fake.resetRequested, false);
});

test('an unknown chip is refused before anything is erased', async () => {
  const fake = new FakeSamba({ chipId: 0xa3cc0ce0 });
  await assert.rejects(flashFirmware(fakePort(fake), makeImage(9000)), /Unsupported chip/);
  assert.ok(fake.flash.every((b) => b === 0x5a));
});

test('a file that is not SAM E70 firmware is refused before anything is erased', async () => {
  const fake = new FakeSamba();
  const image = makeImage(9000);
  new DataView(image.buffer).setUint32(0, 0x20030000, true);          // a SAME5x stack pointer
  await assert.rejects(flashFirmware(fakePort(fake), image), /stack pointer/);
  assert.ok(fake.flash.every((b) => b === 0x5a));
  assert.throws(() => checkImage(makeImage(2 * 1024 * 1024), 1024 * 1024), /larger than the flash/);
});

test('a host that truncates large writes gets smaller pieces and still flashes', async () => {
  const fake = new FakeSamba();
  const port = fakePort(fake);
  const write = port.write;
  port.write = (bytes) => write(bytes.length > 200 ? bytes.subarray(0, 200) : bytes);    // only 200 bytes of a write arrive
  const image = makeImage(9000);
  const notes = [];
  const result = await flashFirmware(port, image, () => {}, (line) => notes.push(line));
  assert.equal(result.writeChunk, 128);
  assert.deepEqual(fake.flash.subarray(0, image.length), image);
  assert.ok(notes.some((l) => /writing in 256 byte pieces fails/.test(l)));
});

test('a host that damages the end of large replies gets smaller reads and still flashes', async () => {
  const fake = new FakeSamba();
  const port = fakePort(fake);
  const read = port.read;
  port.read = async (n, t) => {
    const bytes = await read(n, t);
    if (n > 300) bytes[n - 1] ^= 0xff;
    return bytes;
  };
  const image = makeImage(9000);
  const result = await flashFirmware(port, image);
  assert.equal(result.readChunk, 256);
  assert.deepEqual(fake.flash.subarray(0, image.length), image);
});

test('a link that cannot carry data at all stops before anything is erased', async () => {
  const fake = new FakeSamba();
  const port = fakePort(fake);
  const write = port.write;
  port.write = (bytes) => write(bytes.length > 24 ? bytes.subarray(0, 24) : bytes);
  await assert.rejects(flashFirmware(port, makeImage(9000)), /Link test failed: writing .* Nothing was erased/);
  assert.ok(fake.flash.every((b) => b === 0x5a));
});

test('an error flag left in the flash controller by an earlier run is cleared, not reported', async () => {
  const fake = new FakeSamba();
  fake.fsr = 0x3;
  const image = makeImage(9000);
  const notes = [];
  await flashFirmware(fakePort(fake), image, () => {}, (line) => notes.push(line));
  assert.deepEqual(fake.flash.subarray(0, image.length), image);
  assert.ok(notes.some((l) => /old error flags set \(status 0x00000003\)/.test(l)));
});

test('a rejected flash command is reported with the command, the status and the stage', async () => {
  const fake = new FakeSamba();
  fake.locked = new Set([2]);
  fake.ignoreUnlock = true;
  await assert.rejects(flashFirmware(fakePort(fake), makeImage(9000)), /Flash lock error \(after EA 0, status 0x00000005\) \(while erasing\)/);
});
