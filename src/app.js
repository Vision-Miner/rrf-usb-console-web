import { backend } from './serial.js';
import { flashFirmware, checkImage } from './samba.js';

const DUET3 = { vendorId: 0x1d50, productId: 0x60ee };
const SAMBA = { vendorId: 0x03eb, productId: 0x6124 };
const MAX_SHOWN = 5000;
const $ = (id) => document.getElementById(id);

let link = null;              // console connection
let reconnect = false;        // reopen the console when the board comes back
let flashing = false;
let partial = '';
const decoder = new TextDecoder();
const lines = [];             // the whole session, for export
const history = [];
let historyAt = 0;

function setStatus(text, bad = false) {
  $('status').textContent = text;
  $('status').classList.toggle('bad', bad);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(text) {
  const line = `${stamp()}  ${text}`;
  lines.push(line);
  const el = $('log');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.append(line + '\n');
  while (el.childNodes.length > MAX_SHOWN) el.firstChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
  $('count').textContent = `${lines.length} lines`;
}

function onBytes(bytes) {
  partial += decoder.decode(bytes, { stream: true });
  let i;
  while ((i = partial.indexOf('\n')) >= 0) {
    const line = partial.slice(0, i).replace(/\r$/, '');
    partial = partial.slice(i + 1);
    if (line !== '') log(line);
  }
}

async function openConsole(port) {
  const opened = await backend.open(port, 115200, onBytes);
  link = opened;
  reconnect = true;
  $('connect').textContent = 'Disconnect';
  setStatus('Connected');
  log('--- connected ---');
  opened.closed.then(() => {
    if (link !== opened) return;
    link = null;
    opened.close();
    log('--- disconnected ---');
    $('connect').textContent = 'Connect';
    setStatus(reconnect ? 'Board disconnected. Waiting for it to come back; press Connect if it does not reconnect by itself.' : 'Not connected', reconnect);
  });
}

// Reopen the console without a click when the browser still holds permission for the board.
async function tryReconnect() {
  if (!reconnect || link || flashing) return;
  const port = await backend.granted(DUET3);
  if (!port) return;
  try {
    await openConsole(port);
  } catch {
    // not ready yet; the next poll retries
  }
}

async function toggleConnection() {
  if (link) {
    reconnect = false;
    await link.close();
    return;
  }
  const port = await backend.request(DUET3, SAMBA);
  if (backend.is(port, SAMBA)) {
    throw new Error('This board is in its ROM bootloader and has no console. Choose the firmware below and press Flash.');
  }
  await openConsole(port);
}

async function sendLine(text) {
  if (!link) throw new Error('Not connected');
  log('> ' + text);
  await link.write(new TextEncoder().encode(text + '\n'));
}

function exportLog() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `rrf-console-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function chosenImage() {
  const file = $('image').files[0];
  if (!file) throw new Error('Choose the firmware .bin first');
  const image = new Uint8Array(await file.arrayBuffer());
  checkImage(image, 2 * 1024 * 1024);              // the size is checked against the real chip before erasing
  return { file, image };
}

async function rebootToBootloader() {
  if (!link) throw new Error('Connect to the board first');
  await chosenImage();                              // never open the one-way door without usable firmware in hand
  if (!confirm('Reboot the board into its ROM bootloader?\n\nIt will not start its firmware again until new firmware has been flashed in step 3.')) return;
  reconnect = false;
  await sendLine('M999 P"ERASE"');
  $('flash-status').textContent = 'Sent. When the board has re-enumerated as a bootloader, press Flash.';
}

async function flash() {
  const { file, image } = await chosenImage();
  const port = await backend.request(SAMBA);
  const boot = await backend.open(port, 921600);
  const bar = $('progress');
  const note = $('flash-status');
  flashing = true;
  bar.hidden = false;
  $('flash').disabled = true;
  log(`--- flashing ${file.name} (${image.length} bytes) ---`);
  try {
    const result = await flashFirmware(boot, image, (stage, done, total) => {
      bar.max = total;
      bar.value = done;
      note.textContent = `${stage}…`;
    }, log);
    note.textContent = `Flashed ${file.name} to ${result.chip} (${result.pages} pages, verified). The board is restarting; power-cycle it if the console does not come back.`;
    log(`--- flashed and verified, ${result.chip} ---`);
    reconnect = true;
  } catch (e) {
    note.textContent = `Failed: ${e.message}. The board is still in the bootloader; press Flash to try again.`;
    log(`--- flashing failed: ${e.message} ---`);
    throw e;
  } finally {
    flashing = false;
    bar.hidden = true;
    $('flash').disabled = false;
    await boot.close();
  }
}

// Run a UI action, showing any failure in the status line.
async function act(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.name === 'NotFoundError') return;        // the port picker was dismissed
    setStatus(e.message, true);
  }
}

if (!backend) {
  $('unsupported').textContent = window.isSecureContext
    ? 'This browser has neither Web Serial nor WebUSB. Use Chrome, Edge or Opera, or desktop Firefox 151 or newer.'
    : `USB access is blocked because this page was opened over plain HTTP at ${location.host}. Open it at http://localhost or over HTTPS.`;
  $('unsupported').hidden = false;
  for (const id of ['connect', 'bootloader', 'flash']) $(id).disabled = true;
} else {
  backend.events.addEventListener('connect', () => act(tryReconnect));
  setInterval(() => act(tryReconnect), 1000);
  $('connect').onclick = () => act(toggleConnection);
  $('bootloader').onclick = () => act(rebootToBootloader);
  $('flash').onclick = () => act(flash);
}

$('export').onclick = exportLog;
$('clear').onclick = () => {
  lines.length = 0;
  $('log').textContent = '';
  $('count').textContent = '';
};
$('send').onsubmit = (e) => {
  e.preventDefault();
  const text = $('gcode').value.trim();
  if (!text) return;
  history.push(text);
  historyAt = history.length;
  $('gcode').value = '';
  act(() => sendLine(text));
};
$('gcode').onkeydown = (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  historyAt = Math.max(0, Math.min(history.length, historyAt + (e.key === 'ArrowUp' ? -1 : 1)));
  $('gcode').value = history[historyAt] ?? '';
};
