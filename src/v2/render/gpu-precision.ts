/**
 * WHAT THIS DEVICE'S GPU CAN ACTUALLY HOLD — measured, not assumed.
 *
 * Night accumulates into RGBA8 today, which stores 256 values per channel.
 * In a room at a few percent light the signal sits at two or three of those
 * 255 steps, and the accumulator re-quantizes on EVERY blend — so the
 * sub-step differences between frames, which are the whole point of stacking,
 * are rounded away before they can add up. A higher-precision accumulator is
 * the obvious answer and this module exists to find out whether this phone
 * can actually give us one.
 *
 * Joshua, 2026-09-04: "Do not assume 'iOS normally supports half float'...
 * Do not just test whether an extension string exists." So for every
 * candidate format this allocates a texture, attaches it to a framebuffer,
 * checks completeness, RENDERS KNOWN FRACTIONAL VALUES, reads them back and
 * verifies they survived.
 *
 * TWO DESIGN DECISIONS WORTH KNOWING:
 *
 * 1. ITS OWN CONTEXT. The probe builds a throwaway canvas and WebGL context
 *    rather than borrowing the renderer's. The last test deliberately tries a
 *    full 12 MP allocation, and this project has already lost a context to
 *    memory pressure once — on a borrowed context that would take the live
 *    camera down with it. Here a loss costs only the probe.
 *
 * 2. THE READBACK IS AMPLIFIED, NOT DIRECT. readPixels from a float
 *    framebuffer is unreliable across WebGL1 implementations. So the values
 *    are read by a SECOND pass that multiplies them back up into 8-bit range
 *    and reads THAT as UNSIGNED_BYTE, which every implementation supports.
 *    The test values are all below half an 8-bit step (0.5/255 = 0.00196), so
 *    an RGBA8 target rounds every one of them to zero and reads back black.
 *    That is what makes this a real discriminator rather than a formality —
 *    and RGBA8 is probed as a CONTROL that is expected to fail, because a
 *    test which passes everything proves nothing.
 */

import { PROBE_CONSTANT_FRAGMENT, PROBE_AMPLIFY_FRAGMENT, PROBE_VERTEX } from '../filters/registry.js';

/** Below half an 8-bit step, so RGBA8 stores all three as zero. */
export const PROBE_VALUES: readonly [number, number, number] = [0.0004, 0.0008, 0.0012];
/** Maps the largest test value to 0.75, so the three read back 64 / 128 / 191. */
export const PROBE_AMPLIFY = 625;
/** Readback tolerance in 8-bit counts — generous, since this is a survival test, not a calibration. */
export const PROBE_TOLERANCE = 16;

export type Verdict = 'pass' | 'fail' | 'unavailable';

export interface PrecisionCheck {
  name: string;
  verdict: Verdict;
  /** What was measured, in words — never a bare boolean. */
  detail: string;
}

export interface GpuPrecisionReport {
  webgl: string;
  checks: PrecisionCheck[];
  limits: { maxTexture: number; maxRenderbuffer: number; highp: string };
  /** The best format that passed every test needed to accumulate into it. */
  best: string;
  /** What Night uses right now, whatever the probe found. */
  current: string;
  failure?: string;
}

/** Bytes for one texture of this size and format. */
export function textureBytes(width: number, height: number, bytesPerPixel: number): number {
  return width * height * bytesPerPixel;
}

export function describeBytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB (${(bytes / 2 ** 20).toFixed(1)} MiB)`;
}

/**
 * The whole report as text, for the diagnostics panel and for pasting back.
 * Pure, so it is tested without a GPU.
 */
export function describeGpuPrecision(report: GpuPrecisionReport): string {
  if (report.failure) return `NIGHT / GPU PRECISION\n\n${report.failure}`;
  const rows = report.checks.map((check) => {
    const mark = { pass: 'PASS', fail: 'FAIL', unavailable: '—' }[check.verdict];
    return `  ${check.name.padEnd(34)}${mark.padEnd(6)}${check.detail}`;
  });
  return [
    'NIGHT / GPU PRECISION',
    '',
    `  ${'WebGL version'.padEnd(34)}${report.webgl}`,
    ...rows,
    '',
    `  ${'MAX_TEXTURE_SIZE'.padEnd(34)}${report.limits.maxTexture}`,
    `  ${'MAX_RENDERBUFFER_SIZE'.padEnd(34)}${report.limits.maxRenderbuffer}`,
    `  ${'Fragment highp'.padEnd(34)}${report.limits.highp}`,
    '',
    `  ${'Current Night accumulator'.padEnd(34)}${report.current}`,
    `  ${'Best verified Night format'.padEnd(34)}${report.best}`
  ].join('\n');
}

/* --- The measurement itself ---------------------------------------------- */

interface Candidate {
  name: string;
  /** The texture TYPE constant, resolved from an extension where needed. */
  type: number | null;
  bytesPerPixel: number;
  /** Missing extensions, if any — reported rather than silently skipped. */
  missing: string[];
}

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
  return shader;
}

function program(gl: WebGLRenderingContext, fragment: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, PROBE_VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPosition');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
  return p;
}

/**
 * NEAREST, always. Half-float LINEAR sampling is its own extension and a
 * missing one would return black here and be misread as a precision failure —
 * so the probe never depends on it, and reports it separately as information.
 */
function makeTarget(
  gl: WebGLRenderingContext, width: number, height: number, type: number
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
  return texture;
}

/**
 * Allocate → attach → check complete → render the known values → amplify them
 * back into 8 bits → read → compare. Returns what actually came back.
 */
function survives(gl: WebGLRenderingContext, type: number): { ok: boolean; detail: string } {
  const constant = program(gl, PROBE_CONSTANT_FRAGMENT);
  const amplify = program(gl, PROBE_AMPLIFY_FRAGMENT);
  if (!constant || !amplify) return { ok: false, detail: 'the probe shaders would not compile' };

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const candidate = makeTarget(gl, 1, 1, type);
  const readable = makeTarget(gl, 1, 1, gl.UNSIGNED_BYTE);
  const fbo = gl.createFramebuffer();
  if (!candidate || !readable || !fbo) return { ok: false, detail: 'allocation refused' };

  // PASS 1 — write the known values into the candidate format.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, candidate, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    return { ok: false, detail: `framebuffer incomplete (0x${status.toString(16)}) — cannot render into it` };
  }
  gl.viewport(0, 0, 1, 1);
  gl.useProgram(constant);
  gl.uniform4f(gl.getUniformLocation(constant, 'uValue'),
    PROBE_VALUES[0], PROBE_VALUES[1], PROBE_VALUES[2], 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // PASS 2 — read it back through the amplifier into plain 8-bit.
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, readable, 0);
  gl.useProgram(amplify);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, candidate);
  gl.uniform1i(gl.getUniformLocation(amplify, 'uFrame'), 0);
  gl.uniform1f(gl.getUniformLocation(amplify, 'uAmplify'), PROBE_AMPLIFY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const got = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, got);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  for (const item of [candidate, readable]) gl.deleteTexture(item);
  gl.deleteFramebuffer(fbo);
  gl.deleteBuffer(buffer);

  const want = PROBE_VALUES.map((v) => Math.round(v * PROBE_AMPLIFY * 255));
  const ok = want.every((expected, i) => Math.abs(got[i] - expected) <= PROBE_TOLERANCE);
  return {
    ok,
    detail: `wrote ${PROBE_VALUES.join(' / ')}, expected ${want.join(' / ')}, read ${got[0]} / ${got[1]} / ${got[2]}`
  };
}

/** Try a full-size allocation of the winning format, on the throwaway context. */
function stressAllocate(
  gl: WebGLRenderingContext, width: number, height: number, type: number, bytesPerPixel: number
): PrecisionCheck {
  const name = `Ping-pong at ${width}×${height}`;
  const bytes = 2 * textureBytes(width, height, bytesPerPixel);
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (width > max || height > max) {
    return { name, verdict: 'fail', detail: `exceeds MAX_TEXTURE_SIZE ${max}` };
  }
  const pair = [makeTarget(gl, width, height, type), makeTarget(gl, width, height, type)];
  const fbo = gl.createFramebuffer();
  let verdict: Verdict = 'fail';
  let detail = 'allocation refused';
  if (pair[0] && pair[1] && fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pair[0], 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const error = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (gl.isContextLost()) {
      detail = `${describeBytes(bytes)} — THE CONTEXT WAS LOST allocating it`;
    } else if (!complete) {
      detail = `${describeBytes(bytes)} — framebuffer incomplete at this size`;
    } else if (error !== gl.NO_ERROR) {
      detail = `${describeBytes(bytes)} — GL error 0x${error.toString(16)}`;
    } else {
      verdict = 'pass';
      detail = `${describeBytes(bytes)} allocated and complete`;
    }
  }
  for (const texture of pair) if (texture) gl.deleteTexture(texture);
  if (fbo) gl.deleteFramebuffer(fbo);
  return { name, verdict, detail };
}

/**
 * Run the whole probe on a THROWAWAY context, so a loss during the full-size
 * allocation cannot take the live camera down with it.
 *
 * `photo` is the size a Night capture would really accumulate at, passed in
 * rather than assumed — the caller knows what the geometry authority resolved.
 */
export function probeGpuPrecision(photo: { width: number; height: number }): GpuPrecisionReport {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
  const hasWebgl2 = !!document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    return {
      webgl: 'unavailable', checks: [], best: 'none', current: 'RGBA8',
      limits: { maxTexture: 0, maxRenderbuffer: 0, highp: 'unknown' },
      failure: 'This browser gave no WebGL context, so nothing could be measured.'
    };
  }

  const halfExt = gl.getExtension('OES_texture_half_float') as { HALF_FLOAT_OES: number } | null;
  const candidates: Candidate[] = [
    { name: 'RGBA8 (control, expect FAIL)', type: gl.UNSIGNED_BYTE, bytesPerPixel: 4, missing: [] },
    {
      name: 'RGBA16F half-float',
      type: halfExt ? halfExt.HALF_FLOAT_OES : null,
      bytesPerPixel: 8,
      missing: [
        ...(halfExt ? [] : ['OES_texture_half_float']),
        ...(gl.getExtension('EXT_color_buffer_half_float') ? [] : ['EXT_color_buffer_half_float'])
      ]
    },
    {
      name: 'RGBA32F float',
      type: gl.getExtension('OES_texture_float') ? gl.FLOAT : null,
      bytesPerPixel: 16,
      missing: [
        ...(gl.getExtension('OES_texture_float') ? [] : ['OES_texture_float']),
        ...(gl.getExtension('WEBGL_color_buffer_float') ? [] : ['WEBGL_color_buffer_float'])
      ]
    }
  ];

  const checks: PrecisionCheck[] = [];
  let best = 'RGBA8';
  let bestType: number = gl.UNSIGNED_BYTE;
  let bestBpp = 4;
  for (const candidate of candidates) {
    if (candidate.type === null) {
      checks.push({
        name: candidate.name, verdict: 'unavailable',
        detail: `missing ${candidate.missing.join(', ')}`
      });
      continue;
    }
    const result = survives(gl, candidate.type);
    const control = candidate.name.startsWith('RGBA8');
    checks.push({
      name: candidate.name,
      verdict: result.ok ? 'pass' : 'fail',
      detail: control && !result.ok
        ? `${result.detail} — expected: 8 bits cannot hold these`
        : result.detail + (candidate.missing.length > 0 ? ` · missing ${candidate.missing.join(', ')}` : '')
    });
    // PREFER THE SMALLEST FORMAT THAT PASSES, not the highest precision.
    // 32F stores twice the bytes for resolution this problem does not need —
    // half-float is densest exactly where a dark stack lives, near zero — and
    // this project has already lost a context to memory pressure. So the
    // first passing candidate wins and later ones do not overwrite it.
    if (result.ok && !control && candidate.missing.length === 0 && best === 'RGBA8') {
      best = candidate.name; bestType = candidate.type; bestBpp = candidate.bytesPerPixel;
    }
  }

  checks.push({
    name: 'Half-float LINEAR sampling',
    verdict: gl.getExtension('OES_texture_half_float_linear') ? 'pass' : 'fail',
    detail: 'not required — the accumulator is sampled at exact texels'
  });

  // The size a Night capture would really want, in the best format found.
  checks.push(stressAllocate(gl, photo.width, photo.height, bestType, bestBpp));

  const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const report: GpuPrecisionReport = {
    webgl: `1 (webgl2 ${hasWebgl2 ? 'also available' : 'unavailable'})`,
    checks,
    limits: {
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      highp: highp && highp.precision > 0 ? `available (${highp.precision} bits)` : 'unavailable'
    },
    best: best === 'RGBA8'
      ? 'RGBA8 — nothing better survived the readback here'
      : `${best} (smallest that passed; 32F would cost twice for precision this does not need)`,
    current: `RGBA8 · ${describeBytes(2 * textureBytes(photo.width, photo.height, 4))} ping-pong at ${photo.width}×${photo.height}`
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return report;
}
