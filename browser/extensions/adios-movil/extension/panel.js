/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';
// Panel "Móvil" de AdiOS: muestra y maneja un Android con scrcpy-server 5.x a través del
// puente local (distribution/movil-puente.exe), que AdiOS arranca con un secreto de un solo
// uso (api/parent.js) y que reenvía el protocolo de scrcpy tal cual.

/* global browser */
const SESION = 1n << 63n, CONFIG = 1n << 62n, CLAVE = 1n << 61n, MASCARA_PTS = CLAVE - 1n;
const DEDO = -2n; // POINTER_ID_GENERIC_FINGER
const MSG = { TECLA: 0, TEXTO: 1, TOQUE: 2, RUEDA: 3, ATRAS: 4 };
const TECLAS = { Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 4,
                 ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22 };

const $ = id => document.getElementById(id);
const canvas = $('pantalla');
const ctx = canvas.getContext('2d');

let ws = null, reintento = null, avisoFijo = false;
let decoder = null, codec = null, config = null, conClave = false;
let ancho = 0, alto = 0, pulsado = false;
let pendiente = new Uint8Array(0), fase = 'dispositivo', cabecera = null;

function unir(a, b) {
  if (!a.length) return b;
  const r = new Uint8Array(a.length + b.length);
  r.set(a, 0); r.set(b, a.length);
  return r;
}

// ---- Avisos ----
function aviso(titulo, html, conBoton) {
  document.body.classList.remove('conectado');
  $('aviso-titulo').textContent = titulo;
  $('aviso-texto').innerHTML = html || '';
  $('reintentar').hidden = !conBoton;
  $('aviso').hidden = false;
  canvas.hidden = true;
  $('botones').hidden = true;
}

function mostrarPantalla() {
  $('aviso').hidden = true;
  canvas.hidden = false;
  $('botones').hidden = false;
  document.body.classList.add('conectado');
  ajustar();
}

const AVISOS = {
  'error:sin-movil': ['No encuentro tu Android',
    '<ol><li>En el móvil: Ajustes → Información del teléfono → toca 7 veces <b>Número de compilación</b>.</li>' +
    '<li>Ajustes → Sistema → Opciones de desarrollador → activa <b>Depuración USB</b>.</li>' +
    '<li>Conecta el cable USB y acepta el aviso del móvil.</li></ol><p>Se conectará solo en cuanto lo detecte.</p>'],
  'error:sin-permiso': ['Falta tu permiso en el móvil',
    '<p>Desbloquea el móvil y acepta <b>«¿Permitir depuración USB?»</b>, marcando «Permitir siempre desde este ordenador».</p><p>Se conectará solo en cuanto aceptes.</p>'],
  'error:servidor': ['No se ha podido arrancar la conexión',
    '<p>Desconecta y vuelve a conectar el cable. Si sigue fallando, reinicia el móvil.</p>'],
};

function estado(t) {
  if (AVISOS[t]) {
    avisoFijo = true;
    aviso(AVISOS[t][0], AVISOS[t][1], false);
  } else if (t === 'estado:conectando') {
    aviso('Conectando con tu móvil…', '', false);
  }
}

function sinPuente(motivo) {
  avisoFijo = true;
  const p = document.createElement('p');
  p.textContent = motivo || 'No se ha podido arrancar la conexión con el móvil.';
  aviso('No se puede abrir Móvil', '', true);
  $('aviso-texto').append(p);
}

// ---- Conexión con el puente ----
function reiniciarEstado() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null; codec = null; config = null; conClave = false;
  ancho = 0; alto = 0; pulsado = false;
  pendiente = new Uint8Array(0); fase = 'dispositivo'; cabecera = null;
}

async function conectar() {
  clearTimeout(reintento);
  reiniciarEstado();
  avisoFijo = false;
  let destino;
  try {
    destino = await browser.adiosMovil.start();
  } catch (e) {
    sinPuente(e && e.message);
    programarReintento();
    return;
  }
  let abierto = false;
  try {
    ws = new WebSocket('ws://127.0.0.1:' + destino.port + '/?t=' + destino.token);
  } catch (e) {
    sinPuente(); programarReintento(); return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { abierto = true; };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') estado(ev.data);
    else datos(new Uint8Array(ev.data));
  };
  ws.onclose = () => {
    ws = null;
    reiniciarEstado();
    if (!abierto) aviso('Conectando con tu móvil…', '', false);
    else if (!avisoFijo) aviso('Se ha perdido la conexión', '<p>Volviendo a conectar…</p>', false);
    programarReintento();
  };
}

function programarReintento() {
  clearTimeout(reintento);
  reintento = setTimeout(conectar, 3000);
}

$('reintentar').addEventListener('click', conectar);

// ---- Flujo de scrcpy: nombre (64) · códec (4) · [sesión (12) | cabecera (12) + paquete] ... ----
function datos(trozo) {
  pendiente = unir(pendiente, trozo);
  for (;;) {
    if (fase === 'dispositivo') {
      if (pendiente.length < 64) return;
      const nombre = new TextDecoder().decode(pendiente.subarray(0, 64)).replace(/\0[\s\S]*$/, '');
      $('nombre').textContent = nombre || 'Móvil';
      pendiente = pendiente.subarray(64);
      fase = 'codec';
    } else if (fase === 'codec') {
      if (pendiente.length < 4) return;
      pendiente = pendiente.subarray(4); // 'h264'
      fase = 'cabecera';
    } else if (fase === 'cabecera') {
      if (pendiente.length < 12) return;
      const v = new DataView(pendiente.buffer, pendiente.byteOffset, 12);
      const flags = v.getBigUint64(0);
      if (flags & SESION) {
        ancho = v.getUint32(4);
        alto = v.getUint32(8);
        ajustar();
      } else {
        cabecera = { flags, tam: v.getUint32(8) };
        fase = 'paquete';
      }
      pendiente = pendiente.subarray(12);
    } else {
      if (pendiente.length < cabecera.tam) return;
      const p = pendiente.slice(0, cabecera.tam);
      pendiente = pendiente.subarray(cabecera.tam);
      fase = 'cabecera';
      paquete(cabecera.flags, p);
    }
  }
}

function codecDe(p) {
  const h = x => x.toString(16).padStart(2, '0');
  for (let i = 0; i + 6 < p.length; i++) {
    if (p[i] === 0 && p[i + 1] === 0 && p[i + 2] === 1 && (p[i + 3] & 0x1f) === 7) {
      return 'avc1.' + h(p[i + 4]) + h(p[i + 5]) + h(p[i + 6]);
    }
  }
  return null;
}

function prepararDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  conClave = false;
  decoder = new VideoDecoder({
    output: dibujar,
    error: e => {
      aviso('No se puede mostrar el vídeo', '', true);
      const p = document.createElement('p');
      p.textContent = e.message;
      $('aviso-texto').append(p);
    },
  });
  decoder.configure({ codec, optimizeForLatency: true });
}

function paquete(flags, p) {
  if (flags & CONFIG) {
    config = p;
    const c = codecDe(p);
    if (c && (c !== codec || !decoder || decoder.state === 'closed')) {
      codec = c;
      prepararDecoder();
    }
    return;
  }
  if (!decoder || decoder.state !== 'configured') return;
  const clave = (flags & CLAVE) !== 0n;
  if (!conClave && !clave) return;
  let datosPaquete = p;
  if (config) { datosPaquete = unir(config, p); config = null; }
  if (clave) conClave = true;
  decoder.decode(new EncodedVideoChunk({
    type: clave ? 'key' : 'delta',
    timestamp: Number(flags & MASCARA_PTS),
    data: datosPaquete,
  }));
}

function dibujar(frame) {
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
  if (canvas.hidden) mostrarPantalla();
}

function ajustar() {
  if (!ancho || !alto) return;
  const vista = $('vista');
  const w = vista.clientWidth - 16, h = vista.clientHeight - 16;
  const e = Math.max(0.05, Math.min(w / ancho, h / alto));
  canvas.style.width = Math.floor(ancho * e) + 'px';
  canvas.style.height = Math.floor(alto * e) + 'px';
}
window.addEventListener('resize', ajustar);

// ---- Control: toques, rueda, teclas ----
function enviar(buf) {
  if (ws && ws.readyState === WebSocket.OPEN && ancho) ws.send(buf);
}

function posicion(ev) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round((ev.clientX - r.left) * ancho / r.width);
  const y = Math.round((ev.clientY - r.top) * alto / r.height);
  return [Math.max(0, Math.min(ancho - 1, x)), Math.max(0, Math.min(alto - 1, y))];
}

function toque(accion, ev) {
  const [x, y] = posicion(ev);
  const b = new ArrayBuffer(32), v = new DataView(b);
  v.setUint8(0, MSG.TOQUE);
  v.setUint8(1, accion); // 0 abajo, 1 arriba, 2 mover
  v.setBigInt64(2, DEDO);
  v.setInt32(10, x); v.setInt32(14, y);
  v.setUint16(18, ancho); v.setUint16(20, alto);
  v.setUint16(22, accion === 1 ? 0 : 0xffff);
  v.setInt32(24, 0); v.setInt32(28, 0);
  enviar(b);
}

canvas.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  canvas.focus();
  canvas.setPointerCapture(ev.pointerId);
  pulsado = true;
  toque(0, ev);
  ev.preventDefault();
});
canvas.addEventListener('pointermove', ev => { if (pulsado) toque(2, ev); });
canvas.addEventListener('pointerup', ev => { if (pulsado) { pulsado = false; toque(1, ev); } });
canvas.addEventListener('pointercancel', ev => { if (pulsado) { pulsado = false; toque(1, ev); } });
canvas.addEventListener('contextmenu', ev => { ev.preventDefault(); atras(); });

canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  const [x, y] = posicion(ev);
  const fp = n => Math.max(-32768, Math.min(32767, Math.round(n / 16 * 32768)));
  const b = new ArrayBuffer(21), v = new DataView(b);
  v.setUint8(0, MSG.RUEDA);
  v.setInt32(1, x); v.setInt32(5, y);
  v.setUint16(9, ancho); v.setUint16(11, alto);
  v.setInt16(13, fp(Math.sign(ev.deltaX)));
  v.setInt16(15, fp(-Math.sign(ev.deltaY)));
  v.setInt32(17, 0);
  enviar(b);
}, { passive: false });

function tecla(codigo) {
  for (const accion of [0, 1]) {
    const b = new ArrayBuffer(14), v = new DataView(b);
    v.setUint8(0, MSG.TECLA); v.setUint8(1, accion);
    v.setInt32(2, codigo); v.setInt32(6, 0); v.setInt32(10, 0);
    enviar(b);
  }
}

function texto(t) {
  const d = new TextEncoder().encode(t);
  const b = new Uint8Array(5 + d.length);
  b[0] = MSG.TEXTO;
  new DataView(b.buffer).setUint32(1, d.length);
  b.set(d, 5);
  enviar(b.buffer);
}

function atras() {
  for (const accion of [0, 1]) enviar(new Uint8Array([MSG.ATRAS, accion]).buffer);
}

canvas.addEventListener('keydown', ev => {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  if (TECLAS[ev.key] !== undefined) { ev.preventDefault(); tecla(TECLAS[ev.key]); return; }
  if (ev.key.length === 1) { ev.preventDefault(); texto(ev.key); }
});
canvas.addEventListener('paste', ev => {
  const t = ev.clipboardData && ev.clipboardData.getData('text');
  if (t) { ev.preventDefault(); texto(t); }
});

$('atras').addEventListener('click', atras);
$('inicio').addEventListener('click', () => tecla(3));
$('recientes').addEventListener('click', () => tecla(187));

conectar();
