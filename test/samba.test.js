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
  assert.deepEqual([...stages], ['Unlocking', 'Erasing', 'Writing', 'Verifying', 'Finishing']);
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
  await assert.rejects(flashFirmware(fakePort(fake), makeImage(9000)), /Verify failed at 0x00400A07/);
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
