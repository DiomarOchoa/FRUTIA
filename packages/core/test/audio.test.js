/**
 * Pruebas del formato de audio.
 *
 * El modelo de TTS devuelve PCM crudo (`audio/l16`), sin cabecera. Si se guarda
 * con extension `.mp3`, ffmpeg no lo lee y el render revienta DESPUES de haber
 * gastado toda la cuota del guion y de las imagenes. Estas pruebas fijan el
 * comportamiento para que ese fallo no vuelva.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pcmToWav, normalizeAudio, GEMINI_VOICES, TtsProvider } from '../dist/providers/tts.js';

/** Genera medio segundo de silencio PCM s16le mono a 24kHz. */
function fakePcm() {
  const samples = 24_000 / 2;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(0, i * 2);
  return buf.toString('base64');
}

test('pcmToWav escribe una cabecera RIFF valida', () => {
  const wav = Buffer.from(pcmToWav(fakePcm(), 24000, 1), 'base64');

  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString(), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString(), 'data');
  assert.equal(wav.length, 44 + 24_000, '44 bytes de cabecera + muestras');
});

test('la cabecera declara los parametros de audio correctos', () => {
  const wav = Buffer.from(pcmToWav(fakePcm(), 24000, 1), 'base64');

  assert.equal(wav.readUInt16LE(20), 1, 'PCM sin comprimir');
  assert.equal(wav.readUInt16LE(22), 1, 'un canal');
  assert.equal(wav.readUInt32LE(24), 24000, 'frecuencia de muestreo');
  assert.equal(wav.readUInt16LE(34), 16, '16 bits por muestra');
  assert.equal(wav.readUInt32LE(40), 24_000, 'tamaño del bloque de datos');
  assert.equal(wav.readUInt32LE(4), 36 + 24_000, 'tamaño RIFF = archivo - 8');
});

test('normalizeAudio convierte el PCM que devuelve Gemini en WAV', () => {
  const result = normalizeAudio('audio/L16; codec=pcm; rate=24000; channels=1', fakePcm());

  assert.equal(result.extension, 'wav');
  assert.equal(result.mimeType, 'audio/wav');
  const wav = Buffer.from(result.base64, 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
});

test('normalizeAudio reconoce el mimeType exacto que devuelve Gemini', () => {
  // Este es el string real de la API: L16 en mayusculas y sin la palabra
  // "pcm". Una comparacion sensible a mayusculas lo pasaba por MP3 y el
  // render fallaba al final, con toda la cuota ya gastada.
  const result = normalizeAudio('audio/L16; codec=pcm; rate=24000; channels=1', fakePcm());
  assert.equal(result.extension, 'wav');
  assert.equal(result.mimeType, 'audio/wav');
});

test('normalizeAudio detecta PCM aunque no venga la palabra pcm', () => {
  const result = normalizeAudio('audio/L16; rate=24000; channels=1', fakePcm());
  assert.equal(result.extension, 'wav', 'sin "codec=pcm" tambien es PCM');
});

test('normalizeAudio respeta la frecuencia que anuncia el mimeType', () => {
  const result = normalizeAudio('audio/L16; rate=16000; channels=1', fakePcm());
  const wav = Buffer.from(result.base64, 'base64');
  assert.equal(wav.readUInt32LE(24), 16000);
});

test('normalizeAudio respeta audio de varios canales', () => {
  const result = normalizeAudio('audio/L16; rate=24000; channels=2', fakePcm());
  const wav = Buffer.from(result.base64, 'base64');
  assert.equal(wav.readUInt16LE(22), 2, 'dos canales');
});

test('normalizeAudio no vuelve a envolver un WAV que ya trae cabecera', () => {
  const original = pcmToWav(fakePcm());
  const result = normalizeAudio('audio/wav', original);

  // Envolverlo otra vez anadiria una segunda cabecera RIFF.
  assert.equal(result.base64, original);
  assert.equal(result.extension, 'wav');
});

test('normalizeAudio respeta MP3 cuando la API si lo devuelve', () => {
  const result = normalizeAudio('audio/mpeg', 'SU1Q');
  assert.equal(result.extension, 'mp3');
  assert.equal(result.base64, 'SU1Q', 'los bytes no se tocan');
});

test('normalizeAudio asume MP3 ante un mimeType desconocido', () => {
  assert.equal(normalizeAudio(undefined, 'SU1Q').extension, 'mp3');
  assert.equal(normalizeAudio('audio/desconocido', 'SU1Q').extension, 'mp3');
});

test('las voces por defecto son validas para Gemini', () => {
  // Regresion: se uso `es-ES-Neural2-A`, que es de Azure y no existe en
  // Gemini. El fallo aparecia tarde, al sintetizar, tras gastar la cuota.
  assert.ok(GEMINI_VOICES.includes('Puck'));
  assert.ok(GEMINI_VOICES.includes('Kore'));
  assert.equal(GEMINI_VOICES.some((v) => v.includes('es-ES')), false);
});

test('el proveedor rechaza una voz de Azure en vez de fallar tarde', () => {
  assert.throws(
    () => new TtsProvider({ apiKey: 'x', defaultVoice: 'es-ES-Neural2-A' }),
    /no existe en Gemini/,
  );
});

test('stripSpeakerLabels quita las marcas sin perder el texto', () => {
  const cleaned = TtsProvider.stripSpeakerLabels(
    'MANGO: te menti\nPERA: lo se todo',
    ['MANGO', 'PERA'],
  );
  assert.equal(cleaned.includes('MANGO:'), false);
  assert.equal(cleaned.includes('PERA:'), false);
  assert.ok(cleaned.includes('te menti'));
  assert.ok(cleaned.includes('lo se todo'));
});

test('stripSpeakerLabels no toca texto sin marcas', () => {
  const text = 'La fresa no podia creerlo.';
  assert.equal(TtsProvider.stripSpeakerLabels(text, ['Fresa']), text);
});