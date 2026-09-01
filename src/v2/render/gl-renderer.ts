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

import { FILTERS, ironbowLut, type FilterDefinition } from '../filters/registry.js';

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
    const key = pass === 'display' ? filter.id : `${filter.id}:${pass}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
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
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
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

  /** One upload per camera frame; every product of that frame reuses it. */
  uploadFrame(video: HTMLVideoElement): boolean {
    const gl = this.gl;
    if (!gl || gl.isContextLost() || video.videoWidth === 0) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
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
  render(filterId: string, target: RenderTargetSize, stateSize?: RenderTargetSize): boolean {
    const gl = this.gl;
    const filter = FILTERS.find((f) => f.id === filterId);
    if (!gl || gl.isContextLost() || !filter) return false;
    const program = this.program(filter);
    if (!program) return false;
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
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
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

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
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
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }
}
