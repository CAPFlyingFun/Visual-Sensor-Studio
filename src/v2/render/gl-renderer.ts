/**
 * The one renderer — the shared render contract of Rule 4.
 *
 * One WebGL context, one texture upload per camera frame, one program per
 * filter, and every product (preview now; photo on demand; record in
 * Milestone C) is the SAME program drawn at a different target size. The
 * renderer owns no sizes: every draw is told its geometry by the caller, which
 * gets it from the geometry authority.
 *
 * WebGL1 on purpose: every iPhone that runs this app has it, and nothing in
 * Milestone B needs WebGL2. Where even WebGL1 is unavailable the failure is
 * REPORTED — there is no CPU fallback, because a second implementation of the
 * same filters is exactly what Rule 4 exists to prevent.
 */

import {
  AVERAGE_FRAGMENT, FILTERS, NIGHT_RECOVERY_FRAGMENT, filterById, ironbowLut,
  type FilterDefinition
} from '../filters/registry.js';
import { frameAverageWeight as emaWeight } from './frame-average.js';

const VERTEX = `attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // Flip Y: video frames arrive top-down, GL draws bottom-up.
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * OFFSCREEN passes must NOT flip. The frame history and the filter state
 * are textures that the display pass samples with the SAME coordinates as
 * the frame, so they must be stored in the frame's own layout. Writing them
 * through the flipping shader stored them upside-down — and a temporal
 * filter then compared every frame against its own vertical mirror, which
 * reads as a kaleidoscope (Joshua, 2026-09-01: "Motion, Speed and Trails
 * all look the same, like a kaleidoscope"). Same-layout in, same-layout out.
 */
const VERTEX_OFFSCREEN = `attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** What the recovery pass was told to do — every number measured, none assumed. */
export interface NightRecovery {
  gain: number;
  lift: number;
  /**
   * Per-channel trim, applied after the curve. Optional so a caller that has
   * not measured one is not forced to invent it; absent means (1,1,1), which
   * the shader treats as an identity.
   */
  balance?: [number, number, number];
}

/**
 * The EMA weight that removes as much noise as a true average of N frames.
 *
 * An EMA's variance is alpha / (2 - alpha) of its input's, so alpha =
 * 2 / (N + 1) is the value at which the two match. The obvious guess, 1/N,
 * would quietly do about twice the smoothing the label on the chip promises.
 * That weight lives in render/frame-average.ts, which owns the ladder; this
 * module imports it rather than restating the arithmetic.
 */


export interface RenderTargetSize {
  width: number;
  height: number;
}

export class GlRenderer {
  private gl: WebGLRenderingContext | null = null;
  private programs = new Map<string, WebGLProgram>();
  private frameTexture: WebGLTexture | null = null;
  private rampTexture: WebGLTexture | null = null;
  private historyTexture: WebGLTexture | null = null;
  private historyFramebuffer: WebGLFramebuffer | null = null;
  private historySize = { width: 0, height: 0 };
  /**
   * Filter STATE — the accumulation a Speed or Trails filter carries between
   * frames. Two textures ping-pong (read one, write the other) at the bounded
   * analysis size; a filter change clears both, so no filter inherits
   * another's memory.
   */
  private stateTextures: [WebGLTexture, WebGLTexture] | null = null;
  private stateFramebuffer: WebGLFramebuffer | null = null;
  private stateSize = { width: 0, height: 0 };
  private stateRead = 0;
  private stateOwner = '';
  /** Per-filter ramp textures (custom lenses), keyed by filter id; re-uploaded when rampKey changes. */
  private rampTextures = new Map<string, { key: string; texture: WebGLTexture }>();
  /** The frame's hue histogram, uploaded when the shell measures a new one. */
  private histogramTexture: WebGLTexture | null = null;
  private histogramVersion = -1;
  private dominant: [number, number, number] = [0, 0, 0];
  /**
   * FRAME AVERAGING — a running average of the camera's own frames, so every
   * pass sees one steadier picture instead of a fresh roll of sensor noise.
   * Two textures ping-pong (read one, write the other) at the render size.
   * `averaging` is set per render: a still, which asks for none, must sample
   * the camera's real frame rather than the preview's accumulation.
   */
  private averageTextures: [WebGLTexture, WebGLTexture] | null = null;
  private averageFramebuffer: WebGLFramebuffer | null = null;
  private averageProgram: WebGLProgram | null = null;
  private nightRecoveryProgram: WebGLProgram | null = null;
  private averageSize = { width: 0, height: 0 };
  private averageRead = 0;
  private averaging = false;
  private averagePrimed = false;
  /**
   * NIGHT'S OWN ACCUMULATOR — Milestone 1, deliberately separate from the
   * live one above rather than sharing it.
   *
   * The two have incompatible update rhythms: the live accumulator advances
   * on every DISPLAYED frame at a weight that keeps forgetting old content
   * (frame-average.ts's fixed EMA); Night advances per delivered frame at a
   * weight that CONVERGES (vision/night-stack.ts's 1/n). If they shared one
   * pair of textures, whichever one last wrote to it would silently corrupt
   * the other's in-progress picture. Same compiled shader program either
   * way (AVERAGE_FRAGMENT, already verified for live alignment) — two
   * accumulators, not two mechanisms.
   */
  private nightTextures: [WebGLTexture, WebGLTexture] | null = null;
  private nightFramebuffer: WebGLFramebuffer | null = null;
  private nightSize = { width: 0, height: 0 };
  private nightRead = 0;
  private nightPrimed = false;
  /** What the pair was actually allocated as — see allocateNightStack. */
  private nightFormat: 'RGBA8' | 'RGBA16F' = 'RGBA8';
  /** The camera frame's own size, so the aids measure at sensor scale. */
  private frameSize = { width: 0, height: 0 };
  /** Which program key each filter id currently owns, so an edited lens frees its old program. */
  private programKeys = new Map<string, string>();
  private failure = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    // A GPU context CAN be taken away — measured on device: a 12 MP filtered
    // recording (render + H.264 encode of 47k macroblocks per frame) put
    // enough memory pressure on WebKit that the context was lost and the
    // viewfinder went permanently black, while the camera itself kept
    // delivering. preventDefault() on the lost event is what makes the
    // browser willing to restore; the restored event rebuilds everything.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.failure = 'The GPU context was lost — usually memory pressure at very large '
        + 'render sizes. Recovering…';
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.initialize();
    });
    this.initialize();
  }

  /** First-time setup AND post-loss recovery: one path, so they cannot drift. */
  private initialize(): void {
    this.programs.clear();
    const gl = this.canvas.getContext('webgl', {
      // The preview canvas is also read back for photo/record products, and a
      // cleared buffer reads as black without this.
      preserveDrawingBuffer: true,
      antialias: false,
      alpha: false
    });
    if (!gl || gl.isContextLost()) {
      this.gl = null;
      this.failure = 'WebGL is unavailable in this browser, so filters cannot render. '
        + 'The legacy app still works.';
      return;
    }
    this.gl = gl;

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.frameTexture = this.makeTexture(gl);
    this.rampTexture = this.makeTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, ironbowLut());
    // History and state belong to the old context; forget them so restore
    // reallocates.
    this.historyTexture = null;
    this.historyFramebuffer = null;
    this.historySize = { width: 0, height: 0 };
    this.stateTextures = null;
    this.stateFramebuffer = null;
    this.stateSize = { width: 0, height: 0 };
    this.stateOwner = '';
    // A lost context invalidates every GL object, Night's accumulator
    // included — forgotten here so the next capture reallocates rather than
    // reusing texture handles that belonged to a context that no longer
    // exists.
    this.nightTextures = null;
    this.nightFramebuffer = null;
    this.nightSize = { width: 0, height: 0 };
    this.nightPrimed = false;
    // The format is a property of textures that no longer exist. The next
    // capture re-measures it rather than inheriting a claim about a dead
    // context — which, on a device that lost the context to memory pressure,
    // is exactly the claim most likely to be wrong.
    this.nightFormat = 'RGBA8';
    this.rampTextures.clear();
    this.programKeys.clear();
    this.histogramTexture = null;
    this.histogramVersion = -1;
    this.failure = '';
  }

  /** Empty when the renderer works; the honest sentence when it cannot. */
  get unavailableReason(): string {
    return this.failure;
  }

  /**
   * The canvas every product is drawn into. One WebGL context means one
   * canvas: a photo renders here at photo size and is copied out, and the next
   * preview frame simply resizes it back.
   */
  get targetCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * The frame every pass reads: the camera's, or the running average of the
   * last few. ONE accessor, so the display pass, the state pass and the
   * history copy can never disagree about which picture this frame is —
   * comparing an averaged present against a raw past would read as motion
   * everywhere.
   */
  private get sourceTexture(): WebGLTexture | null {
    return this.averaging && this.averageTextures
      ? this.averageTextures[this.averageRead]
      : this.frameTexture;
  }

  private makeTexture(gl: WebGLRenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (!texture) throw new Error('could not allocate a texture');
    return texture;
  }

  /**
   * display  the filter's fragment, drawn to the canvas (Y flipped).
   * state    the filter's state pass, drawn to the state texture (no flip).
   * copy     the filter's fragment drawn to a texture (no flip) — used with
   *          RGB to store the frame history in the frame's own layout.
   */
  private program(filter: FilterDefinition, pass: 'display' | 'state' | 'copy' = 'display'): WebGLProgram | null {
    const gl = this.gl;
    if (!gl) return null;
    const base = pass === 'display' ? filter.id : `${filter.id}:${pass}`;
    // A custom lens edited live changes its shader: the revision is part of
    // the key, and the previous revision's program is released.
    const key = filter.revision ? `${base}@${filter.revision}` : base;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const previous = this.programKeys.get(base);
    if (previous && previous !== key) {
      const stale = this.programs.get(previous);
      if (stale) gl.deleteProgram(stale);
      this.programs.delete(previous);
    }
    this.programKeys.set(base, key);
    const source = pass === 'state' ? filter.state : filter.fragment;
    if (!source) return null;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        this.failure = `The ${filter.name} shader failed to compile: `
          + (gl.getShaderInfoLog(shader) ?? 'no reason given');
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, pass === 'display' ? VERTEX : VERTEX_OFFSCREEN);
    const fragment = compile(gl.FRAGMENT_SHADER, source);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.failure = `The ${filter.name} shader failed to link: `
        + (gl.getProgramInfoLog(program) ?? 'no reason given');
      return null;
    }
    this.programs.set(key, program);
    return program;
  }

  /**
   * Advance a filter's STATE by one frame at the bounded analysis size:
   * read the previous state, the current frame and the previous frame,
   * write the new state. Returns the texture the display pass should
   * sample as uState. A different filter than last time starts from zero.
   */
  private advanceState(filter: FilterDefinition, size: RenderTargetSize): WebGLTexture | null {
    const gl = this.gl;
    if (!gl || !filter.state || size.width <= 0 || size.height <= 0) return null;
    const program = this.program(filter, 'state');
    if (!program) return null;

    if (!this.stateTextures) this.stateTextures = [this.makeTexture(gl), this.makeTexture(gl)];
    if (!this.stateFramebuffer) this.stateFramebuffer = gl.createFramebuffer();
    const resized = this.stateSize.width !== size.width || this.stateSize.height !== size.height;
    if (resized) {
      this.stateSize = { width: size.width, height: size.height };
      for (const texture of this.stateTextures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFramebuffer);
    if (resized || this.stateOwner !== filter.id) {
      // Fresh memory for a new filter (or a new size): both buffers to zero.
      this.stateOwner = filter.id;
      for (const texture of this.stateTextures) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    const read = this.stateTextures[this.stateRead];
    const write = this.stateTextures[1 - this.stateRead];
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, write, 0);
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    if (this.historyTexture) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.historyTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'uPrevious'), 2);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, read);
    gl.uniform1i(gl.getUniformLocation(program, 'uState'), 3);
    gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / size.width, 1 / size.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stateRead = 1 - this.stateRead;
    return write;
  }

  /**
   * Advance the running frame average by one camera frame.
   *
   * new = mix(previous average, this frame, weight). One texture's worth of
   * memory holds an average of many frames, which is the whole reason it is
   * an exponential average and not a stack of the last N — a ten-frame stack
   * at record size is ten full-resolution buffers, and this device has
   * already lost a GPU context to memory once.
   *
   * PRIMED, NEVER FADED IN. On the first frame, a resize, or the control
   * being switched on, both buffers are filled with the current frame at full
   * weight. Starting from black would fade the picture up over a third of a
   * second and look like a fault.
   */
  private advanceAverage(
    size: RenderTargetSize, frames: number, align?: [number, number]
  ): void {
    const gl = this.gl;
    this.averaging = false;
    if (!gl || !(frames > 1) || size.width <= 0 || size.height <= 0) return;

    this.averageProgram ??= this.buildProgram(VERTEX_OFFSCREEN, AVERAGE_FRAGMENT);
    const program = this.averageProgram;
    if (!program) return;
    if (!this.averageTextures) this.averageTextures = [this.makeTexture(gl), this.makeTexture(gl)];
    if (!this.averageFramebuffer) this.averageFramebuffer = gl.createFramebuffer();

    // A size change makes the stored average meaningless — it is a picture of
    // a different rectangle — so it is rebuilt from this frame rather than
    // stretched.
    const resized = this.averageSize.width !== size.width
      || this.averageSize.height !== size.height;
    if (resized) {
      this.averageSize = { width: size.width, height: size.height };
      for (const texture of this.averageTextures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.averageFramebuffer);
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);

    // Weight 1 ignores whatever is in the buffer, so priming is the same
    // pass run into both textures rather than a second code path.
    const priming = resized || !this.averagePrimed;
    const passes: Array<{ read: WebGLTexture; write: WebGLTexture; weight: number }> = priming
      ? [
        { read: this.averageTextures[0], write: this.averageTextures[1], weight: 1 },
        { read: this.averageTextures[1], write: this.averageTextures[0], weight: 1 }
      ]
      : [{
        read: this.averageTextures[this.averageRead],
        write: this.averageTextures[1 - this.averageRead],
        weight: emaWeight(frames)
      }];

    for (const pass of passes) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pass.write, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, pass.read);
      gl.uniform1i(gl.getUniformLocation(program, 'uAverage'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'uWeight'), pass.weight);
      // Priming adopts the frame whole, so it defines the reference the later
      // passes align TO — it must not be offset itself.
      const offset = pass.weight >= 1 ? [0, 0] : align ?? [0, 0];
      gl.uniform2f(gl.getUniformLocation(program, 'uAlign'), offset[0], offset[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.averageRead = pass.write === this.averageTextures[0] ? 0 : 1;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.averagePrimed = true;
    this.averaging = true;
  }

  /**
   * Fold one candidate frame into Night's OWN accumulator, at an explicit
   * caller-supplied weight — vision/night-stack.ts's 1/n, not the live
   * ladder's fixed EMA. Reads `this.frameTexture`, exactly what the ordinary
   * per-frame preview loop already uploaded a moment earlier — Night does
   * not upload a second time, it just reads what is already current.
   *
   * `restart` re-primes (adopts this frame whole, into both textures) —
   * used for the very first frame of a fresh capture, and again whenever
   * vision/alignment.ts's StackAligner reports the drift left the
   * accumulation behind. Mirrors advanceAverage's own priming branch
   * exactly, because it is the same situation: starting from black would
   * fade the picture in and look like a fault.
   *
   * Returns whether the accumulator now holds something displayable.
   */
  advanceNightStack(
    size: RenderTargetSize, weight: number, align: [number, number], restart: boolean
  ): boolean {
    const gl = this.gl;
    if (!gl || size.width <= 0 || size.height <= 0) return false;

    this.averageProgram ??= this.buildProgram(VERTEX_OFFSCREEN, AVERAGE_FRAGMENT);
    const program = this.averageProgram;
    if (!program) return false;
    if (!this.nightTextures) {
      this.nightTextures = [this.makeTexture(gl), this.makeTexture(gl)];
      // NEAREST, unlike every other texture here, for two reasons that agree.
      // The accumulator is only ever sampled at vUv — exact texel centres, at
      // 1:1 — so LINEAR and NEAREST return the identical value and nothing is
      // given up. (The sub-texel alignment offset is applied to the ARRIVING
      // FRAME, uFrame, which keeps its LINEAR sampling; see AVERAGE_FRAGMENT.)
      // And a half-float texture filtered LINEAR is INCOMPLETE wherever
      // OES_texture_half_float_linear is missing — it samples as pure black,
      // which would look like a broken capture rather than a missing
      // extension. NEAREST removes that dependency entirely.
      for (const texture of this.nightTextures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }
    }
    if (!this.nightFramebuffer) this.nightFramebuffer = gl.createFramebuffer();

    // A size change makes the stored stack meaningless — it is a picture of
    // a different rectangle — so it starts over rather than stretching.
    const resized = this.nightSize.width !== size.width || this.nightSize.height !== size.height;
    if (resized) {
      this.nightSize = { width: size.width, height: size.height };
      this.allocateNightStack(gl, size);
      this.nightPrimed = false;
    }
    if (restart) this.nightPrimed = false;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.nightFramebuffer);
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);

    const priming = !this.nightPrimed;
    const passes: Array<{ read: WebGLTexture; write: WebGLTexture; weight: number }> = priming
      ? [
        { read: this.nightTextures[0], write: this.nightTextures[1], weight: 1 },
        { read: this.nightTextures[1], write: this.nightTextures[0], weight: 1 }
      ]
      : [{
        read: this.nightTextures[this.nightRead],
        write: this.nightTextures[1 - this.nightRead],
        weight
      }];

    for (const pass of passes) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pass.write, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, pass.read);
      gl.uniform1i(gl.getUniformLocation(program, 'uAverage'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'uWeight'), pass.weight);
      // Priming defines the reference everything after it aligns TO, so it
      // must not be offset itself — same reasoning as advanceAverage.
      const offset = pass.weight >= 1 ? [0, 0] : align;
      gl.uniform2f(gl.getUniformLocation(program, 'uAlign'), offset[0], offset[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.nightRead = pass.write === this.nightTextures[0] ? 0 : 1;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.nightPrimed = true;
    return true;
  }

  /**
   * Allocate Night's ping-pong pair at the most precision this device will
   * actually RENDER TO, and fall back to RGBA8 when it will not.
   *
   * WHY THIS IS NOT A DETAIL. An 8-bit accumulator stores 256 values per
   * channel, and every blend rounds to the nearest one. Since the blend
   * weight is 1/n (night-stack.ts), the stored value only moves at all when
   * the arriving frame differs from the accumulation by more than n × 0.5/255
   * — at 15 frames, by more than seven 8-bit steps. In a near-black room the
   * whole scene sits at two or three steps and consecutive frames differ by
   * about one, so from the THIRD frame onward the blend rounds to the value
   * already stored and the rest of the capture writes back what it held. The
   * mean such a scene converges to lies BETWEEN two 8-bit steps — which is
   * precisely the information stacking exists to recover, and precisely what
   * this storage cannot represent. A storage problem, not an algorithm one;
   * the arithmetic is pinned in tests/v2-night-stack.test.mjs. Half-float's precision is RELATIVE, so it keeps roughly
   * a thousandth of the value wherever the value happens to sit — which is
   * exactly what a dark stack needs, since its whole signal lives near zero.
   *
   * VERIFIED, NOT ASSUMED. The extension strings are necessary but not
   * sufficient: an implementation may expose OES_texture_half_float and still
   * refuse to render to it. So the pair is allocated, attached, and the
   * framebuffer's completeness is CHECKED — and the GL error queue is drained
   * first and read after, because a full-size pair is a large request and
   * OUT_OF_MEMORY is reported there rather than thrown. Anything short of a
   * complete framebuffer falls back to the RGBA8 the accumulator has always
   * used: worse, but working, and the readout says which one it got.
   */
  private allocateNightStack(gl: WebGLRenderingContext, size: RenderTargetSize): void {
    const textures = this.nightTextures;
    const framebuffer = this.nightFramebuffer;
    if (!textures || !framebuffer) return;

    const attempt = (type: number): boolean => {
      // Drain first: an error left by earlier work is not evidence about THIS
      // allocation, and reading a stale one would reject a format that works.
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      for (const texture of textures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0, gl.RGBA, type, null);
      }
      if (gl.getError() !== gl.NO_ERROR) return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures[0], 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return complete;
    };

    const half = gl.getExtension('OES_texture_half_float') as { HALF_FLOAT_OES: number } | null;
    const renderable = gl.getExtension('EXT_color_buffer_half_float');
    if (half && renderable && attempt(half.HALF_FLOAT_OES)) {
      this.nightFormat = 'RGBA16F';
      return;
    }
    attempt(gl.UNSIGNED_BYTE);
    this.nightFormat = 'RGBA8';
  }

  /**
   * Which format Night's accumulator actually GOT — measured at allocation,
   * never predicted from an extension string. Empty until one is allocated.
   */
  nightAccumulatorFormat(): string {
    return this.nightTextures ? this.nightFormat : '';
  }

  /**
   * Show the current Night accumulator in the viewer — "keep the result in
   * the viewer after completion so I can inspect it" (Joshua, 2026-09-03).
   *
   * Deliberately the plain RGB filter's own compiled program, run once
   * against Night's texture instead of the camera's: no lens, no brightness
   * curve, nothing this milestone was told not to apply yet — RGB's whole
   * fragment body is one texture read, so reusing it here is the identity
   * draw, not a filter choice. uZebra/uPeak are forced to 0 explicitly:
   * that program object is the SAME one the live preview already uses, so
   * without this a zebra or peaking aid left on from a moment ago would
   * still be sitting in this program's uniform state and bake itself into
   * what is supposed to be an unfiltered diagnostic view.
   */
  renderNightResult(target: RenderTargetSize, recovery?: NightRecovery): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || !this.nightPrimed || !this.nightTextures) return false;
    // WITH a recovery, the stack goes through the lift it measured for
    // itself; WITHOUT one, through plain RGB — which is how the raw stack is
    // drawn in order to be measured in the first place. Same texture, same
    // target size; only the program differs.
    let program: WebGLProgram | null;
    if (recovery) {
      this.nightRecoveryProgram ??= this.buildProgram(VERTEX, NIGHT_RECOVERY_FRAGMENT);
      program = this.nightRecoveryProgram;
    } else {
      const rgb = filterById('rgb');
      if (!rgb) return false;
      program = this.program(rgb);
    }
    if (!program) return false;

    if (this.canvas.width !== target.width) this.canvas.width = target.width;
    if (this.canvas.height !== target.height) this.canvas.height = target.height;
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.nightTextures[this.nightRead]);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    if (recovery) {
      gl.uniform1f(gl.getUniformLocation(program, 'uGain'), recovery.gain);
      gl.uniform1f(gl.getUniformLocation(program, 'uLift'), recovery.lift);
      // ALWAYS SET, never left to whatever the last draw put there. This
      // program object outlives a capture, so an unset uniform would carry a
      // previous stack's colour trim into this one — the same trap uZebra
      // and uPeak are forced to zero for a few lines below.
      const balance = recovery.balance ?? [1, 1, 1];
      gl.uniform3f(gl.getUniformLocation(program, 'uBalance'),
        balance[0], balance[1], balance[2]);
    } else {
      gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / target.width, 1 / target.height);
      // The aids are forced off: a zebra stripe or a peaking edge is a
      // VIEWING aid and must never reach a measurement or a file.
      gl.uniform1f(gl.getUniformLocation(program, 'uZebra'), 0);
      gl.uniform1f(gl.getUniformLocation(program, 'uPeak'), 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Compile and link one offscreen program; renderer machinery, not a filter. */
  private buildProgram(vertexSource: string, fragmentSource: string): WebGLProgram | null {
    const gl = this.gl;
    if (!gl) return null;
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        this.failure = 'The frame-average shader failed to compile: '
          + (gl.getShaderInfoLog(shader) ?? 'no reason given');
        return null;
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.failure = 'The frame-average shader failed to link: '
        + (gl.getProgramInfoLog(program) ?? 'no reason given');
      return null;
    }
    return program;
  }

  /** One upload per camera frame; every product of that frame reuses it. */
  /**
   * The same upload, for a STILL that came from a file rather than the camera.
   *
   * A separate entry point rather than a widened uploadFrame, because the two
   * have different emptiness tests — a video reports videoWidth 0 until it has
   * decoded something, an image reports naturalWidth 0 until it has loaded —
   * and conflating them would let one's "not ready yet" pass as the other's.
   * Everything downstream is identical: the same texture, so the same one
   * program per filter draws it (Rule 4). There is no import-only filter path.
   */
  uploadStill(image: HTMLImageElement): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || image.naturalWidth === 0) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this.frameSize = { width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      return false;
    }
    return true;
  }

  uploadFrame(video: HTMLVideoElement): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || video.videoWidth === 0) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.frameSize = { width: video.videoWidth, height: video.videoHeight };
    } catch {
      // A mid-switch video element can briefly refuse; the next frame recovers.
      return false;
    }
    return true;
  }

  /**
   * Draw one filter at one explicit size. The size comes from the geometry
   * authority via the caller — passing it here is what keeps the renderer
   * from owning a resolution opinion of its own.
   */
  render(
    filterId: string,
    target: RenderTargetSize,
    stateSize?: RenderTargetSize,
    extras: {
      fps?: number;
      histogram?: { bins: Uint8Array; dominant: [number, number, number]; version: number };
      /** The frame's measured [min, max] luma, 0..1 — relief's stretch. */
      lumaRange?: [number, number];
      /** Frames to average together — see render/frame-average.ts. 1 = none. */
      frames?: number;
      /**
       * Where the scene has drifted to since the accumulation began, in UV.
       * Each arriving frame is sampled at this offset so it lands back on the
       * accumulation instead of smearing across it.
       */
      align?: [number, number];
      /** Throw the accumulation away and start again from this frame. */
      restartAverage?: boolean;
      /**
       * VIEWING AIDS, thresholds from render/overlays.ts. 0 is off, and off
       * is what the photo and recording paths pass: an aid must never reach a
       * file. Only the preview asks for them.
       */
      aids?: { zebra?: number; peaking?: number };
    } = {}
  ): boolean {
    const gl = this.gl;
    const filter = filterById(filterId);
    if (!gl || gl.isContextLost() || !filter || filter.unavailableReason) return false;
    const program = this.program(filter);
    if (!program) return false;
    // The average advances BEFORE the state pass, because a filter's memory
    // must be built from the same picture its live frame is.
    if (extras.restartAverage) this.averagePrimed = false;
    this.advanceAverage(target, extras.frames ?? 1, extras.align);
    // A stateful filter advances its memory first, at the ANALYSIS size the
    // caller resolves — the display pass then reads it, whatever its own size.
    const state = filter.state && stateSize ? this.advanceState(filter, stateSize) : null;

    if (this.canvas.width !== target.width) this.canvas.width = target.width;
    if (this.canvas.height !== target.height) this.canvas.height = target.height;
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rampFor(filter));
    gl.uniform1i(gl.getUniformLocation(program, 'uRamp'), 1);
    if (this.historyTexture) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.historyTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'uPrevious'), 2);
    }
    if (state) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, state);
      gl.uniform1i(gl.getUniformLocation(program, 'uState'), 3);
    }
    gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / target.width, 1 / target.height);
    // The aids sample the CAMERA frame, so their texel is the frame's, not
    // the target's: peaking must find the same edges whatever size this is
    // being drawn at, or the preview and a still would disagree about focus.
    const frame = this.frameSize.width > 0 ? this.frameSize : target;
    gl.uniform2f(gl.getUniformLocation(program, 'uAidTexel'),
      1 / frame.width, 1 / frame.height);
    const range = extras.lumaRange ?? [0, 1];
    gl.uniform2f(gl.getUniformLocation(program, 'uLumaRange'), range[0], range[1]);
    gl.uniform1f(gl.getUniformLocation(program, 'uZebra'), extras.aids?.zebra ?? 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uPeak'), extras.aids?.peaking ?? 0);
    // Unit conversions a lens may need: a missing location is simply ignored.
    gl.uniform1f(gl.getUniformLocation(program, 'uFps'), extras.fps ?? 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uAnalysisWidth'), stateSize?.width ?? 0);
    // The frame's colour census. Always bound, so a photo taken between
    // measurements uses the last real one rather than an empty texture.
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.histogramFor(extras.histogram));
    gl.uniform1i(gl.getUniformLocation(program, 'uHistogram'), 4);
    gl.uniform3f(gl.getUniformLocation(program, 'uDominant'),
      this.dominant[0], this.dominant[1], this.dominant[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /**
   * The histogram texture, uploaded only when the shell reports a NEW
   * measurement. Until one arrives every hue reads equally common, so a
   * rarity lens says "nothing unusual" while it waits instead of declaring
   * the whole picture rare.
   */
  private histogramFor(
    measurement?: { bins: Uint8Array; dominant: [number, number, number]; version: number }
  ): WebGLTexture | null {
    const gl = this.gl;
    if (!gl) return null;
    if (!this.histogramTexture) {
      this.histogramTexture = this.makeTexture(gl);
      const blank = new Uint8Array(64 * 4).fill(255);
      gl.bindTexture(gl.TEXTURE_2D, this.histogramTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blank);
    }
    if (measurement && measurement.version !== this.histogramVersion) {
      this.histogramVersion = measurement.version;
      this.dominant = measurement.dominant;
      const texels = new Uint8Array(measurement.bins.length * 4);
      for (let i = 0; i < measurement.bins.length; i++) {
        texels[i * 4] = measurement.bins[i];
        texels[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.histogramTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, measurement.bins.length, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, texels);
    }
    return this.histogramTexture;
  }

  /** The filter's own ramp texture, uploaded when its rampKey changes; else the Ironbow ramp. */
  private rampFor(filter: FilterDefinition): WebGLTexture | null {
    const gl = this.gl;
    if (!gl || !filter.ramp) return this.rampTexture;
    const key = filter.rampKey ?? '';
    const held = this.rampTextures.get(filter.id);
    if (held && held.key === key) return held.texture;
    const texture = held?.texture ?? this.makeTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, filter.ramp);
    this.rampTextures.set(filter.id, { key, texture });
    return texture;
  }

  /**
   * Store the CURRENT uploaded frame as the next frame's uPrevious, at the
   * BOUNDED size the caller resolves (the ANALYSIS geometry) — never at the
   * stream's own size: a 12 MP history texture is exactly the memory
   * pressure that killed the context on device, and docs/camera_rule.md
   * requires temporal history to state its resolution rather than pretend.
   * Call AFTER render(), so temporal filters always compare against the
   * previous frame, not the current one.
   */
  snapshotHistory(size: RenderTargetSize): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || size.width <= 0 || size.height <= 0) return false;
    const rgb = FILTERS.find((f) => f.id === 'rgb');
    if (!rgb) return false;
    // The COPY variant: same fragment, no Y flip, so the history lands in the
    // frame's own layout and samples true against it.
    const program = this.program(rgb, 'copy');
    if (!program) return false;

    if (!this.historyTexture) this.historyTexture = this.makeTexture(gl);
    if (!this.historyFramebuffer) this.historyFramebuffer = gl.createFramebuffer();
    if (this.historySize.width !== size.width || this.historySize.height !== size.height) {
      this.historySize = { width: size.width, height: size.height };
      gl.bindTexture(gl.TEXTURE_2D, this.historyTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size.width, size.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.historyFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      this.historyTexture, 0);
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }
}
