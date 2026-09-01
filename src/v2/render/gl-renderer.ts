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

export interface RenderTargetSize {
  width: number;
  height: number;
}

export class GlRenderer {
  private gl: WebGLRenderingContext | null = null;
  private programs = new Map<string, WebGLProgram>();
  private frameTexture: WebGLTexture | null = null;
  private rampTexture: WebGLTexture | null = null;
  private failure = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      // The preview canvas is also read back for photo/record products, and a
      // cleared buffer reads as black without this.
      preserveDrawingBuffer: true,
      antialias: false,
      alpha: false
    });
    if (!gl) {
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

  private program(filter: FilterDefinition): WebGLProgram | null {
    const gl = this.gl;
    if (!gl) return null;
    const cached = this.programs.get(filter.id);
    if (cached) return cached;

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

    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, filter.fragment);
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
    this.programs.set(filter.id, program);
    return program;
  }

  /** One upload per camera frame; every product of that frame reuses it. */
  uploadFrame(video: HTMLVideoElement): boolean {
    const gl = this.gl;
    if (!gl || video.videoWidth === 0) return false;
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
  render(filterId: string, target: RenderTargetSize): boolean {
    const gl = this.gl;
    const filter = FILTERS.find((f) => f.id === filterId);
    if (!gl || !filter) return false;
    const program = this.program(filter);
    if (!program) return false;

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
    gl.uniform2f(gl.getUniformLocation(program, 'uTexel'), 1 / target.width, 1 / target.height);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}
