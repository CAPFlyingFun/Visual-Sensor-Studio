import { PERSPECTIVE_FRAGMENT } from '../filters/registry.js';
/** Perspective-assist math and JPEG rectification. No camera ownership lives here. */
export type PerspectiveMode = 'off' | 'level' | 'straighten' | 'rectify';
export interface NormalPoint { x: number; y: number; }
export interface PerspectiveReading { pitch: number; roll: number; }

export const DEFAULT_QUAD: readonly NormalPoint[] = [
  { x: .12, y: .14 }, { x: .88, y: .14 }, { x: .88, y: .86 }, { x: .12, y: .86 }
];

export function screenPitchRoll(beta: number, gamma: number, screenAngle: number): PerspectiveReading {
  // DeviceOrientation beta/gamma are Euler rotations, not independent camera
  // pitch/roll axes. Using gamma directly as roll becomes wildly exaggerated
  // when the phone is pitched steeply. Project gravity into the screen plane
  // instead, then rotate that vector into the current screen orientation.
  const br = beta * Math.PI / 180;
  const gr = gamma * Math.PI / 180;
  const ar = screenAngle * Math.PI / 180;
  const gx = -Math.cos(br) * Math.sin(gr);
  const gy = Math.sin(br);
  const sx = gx * Math.cos(ar) - gy * Math.sin(ar);
  const sy = gx * Math.sin(ar) + gy * Math.cos(ar);
  const roll = -Math.atan2(sx, sy) * 180 / Math.PI;

  // PITCH COMES OFF THE SAME VECTOR, and it did not used to.
  //
  // Roll was fixed by projecting gravity; pitch was left reading raw beta or
  // gamma per screen angle — the exact convention the comment above calls
  // wildly exaggerated. So the two halves of one reading disagreed about what
  // they were measuring, and only one of them had been corrected.
  //
  // The in-plane part of gravity is (sx, sy) and the out-of-plane part is
  // cos(beta)cos(gamma). The angle between them IS the camera's tilt, and
  // taking it from the rotated sy rather than the raw Euler angle means the
  // four screen orientations fall out of the projection instead of being
  // special-cased: at 90° it reproduces -gamma, at 270° +gamma, at 180° -beta
  // and at 0° beta, to within a rounding step, for every pose where those were
  // right in the first place.
  //
  // IT DOES CHANGE THE STEEP READINGS, which is the point rather than a side
  // effect: 108° of beta at -49° of gamma read 108 and now reads 102, for the
  // same reason gamma read as roll was wrong there. The poses the level
  // indicator is actually calibrated against — upright, flat, and landscape —
  // are identical to four decimal places.
  const pitch = Math.atan2(sy, Math.cos(br) * Math.cos(gr)) * 180 / Math.PI;
  return { pitch, roll };
}

/** Source quad for a roll correction, cropped just enough to avoid empty corners. */
export function straightenQuad(rollDegrees: number, aspect: number): NormalPoint[] {
  const r = rollDegrees * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  const a = Math.max(.01, aspect);
  // Scale destination inward until every inverse-rotated corner remains in source.
  const extentX = Math.abs(c) + Math.abs(sn) / a;
  const extentY = Math.abs(c) + Math.abs(sn) * a;
  const scale = 1 / Math.max(extentX, extentY);
  return [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}].map((p) => {
    const dx=(p.x-.5)*scale, dy=(p.y-.5)*scale;
    return { x:.5 + c*dx - sn*dy/a, y:.5 + sn*dx*a + c*dy };
  });
}

export function clampPoint(point: NormalPoint): NormalPoint {
  return { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
}

/** Solve an 8x8 linear system by pivoted Gauss-Jordan elimination. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col];
    for (let j = col; j <= n; j++) m[col][j] /= d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = m[row][col];
      for (let j = col; j <= n; j++) m[row][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

/** Homography mapping destination unit-square coordinates to source quad coordinates. */
export function squareToQuad(quad: readonly NormalPoint[]): number[] | null {
  if (quad.length !== 4) return null;
  const dst = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const a: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const x = dst[i].x, y = dst[i].y, u = quad[i].x, v = quad[i].y;
    a.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    a.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const h = solve(a,b);
  return h ? [...h, 1] : null;
}

export function mapHomography(h: readonly number[], x: number, y: number): NormalPoint {
  const w = h[6]*x + h[7]*y + h[8];
  return { x: (h[0]*x+h[1]*y+h[2])/w, y: (h[3]*x+h[4]*y+h[5])/w };
}

async function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Perspective canvas could not encode JPEG.');
  return blob;
}

/**
 * Rectify a four-corner region into the SAME output pixel geometry as the input.
 * This preserves MAX output dimensions; the selected plane is stretched to fill them.
 */
/**
 * ONE CANVAS, ONE CONTEXT, ONE PROGRAM, kept between rectifications.
 *
 * This used to build all of them per call. Two things came of that, and both
 * are the shapes this app has already been bitten by.
 *
 * MEMORY. The rectify runs on the FULL-SIZE still, so each call stood up a
 * fresh full-size canvas with its own drawing buffer and its own texture,
 * beside the bitmap decoded from the JPEG and everything the capture already
 * had alive. On a 36 MP photograph that is three more full-size allocations
 * at the one moment there was least room — which is exactly what v0.104
 * through v0.106 were spent taking OUT of this path.
 *
 * CONTEXTS. A browser keeps only so many live WebGL contexts (WebKit around
 * sixteen) and drops the oldest, or refuses. Nothing here released one, so a
 * long session would eventually get null back from getContext and report "
 * WebGL is unavailable for perspective correction" — a true sentence about
 * the wrong thing, since WebGL was fine and the app had simply used up its
 * share. The message now says which of the two happened.
 */
interface RectifyRig {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  /** Looked up once: getUniformLocation on every capture is a needless query. */
  homography: WebGLUniformLocation | null;
}
let rig: RectifyRig | null = null;

function rectifyRig(): RectifyRig {
  if (rig && !rig.gl.isContextLost()) return rig;
  const canvas = rig?.canvas ?? document.createElement('canvas');
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) {
    throw new Error(rig
      ? 'The perspective canvas lost its GPU context and could not get another.'
      : 'WebGL is unavailable for perspective correction.');
  }
  const vs = `attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*0.5;gl_Position=vec4(p,0,1);}`;
  const shader = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('Perspective shader could not be created.');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'Perspective shader failed');
    }
    return sh;
  };
  const program = gl.createProgram();
  if (!program) throw new Error('Perspective program could not be created.');
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, PERSPECTIVE_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Perspective program failed');
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  if (!texture) throw new Error('Perspective texture could not be created.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  rig = { canvas, gl, texture, homography: gl.getUniformLocation(program, 'H') };
  return rig;
}

/**
 * Rectify a four-corner region into the SAME output pixel geometry as the
 * input. This preserves MAX output dimensions; the selected plane is
 * stretched to fill them.
 */
export async function rectifyJpeg(blob: Blob, width: number, height: number,
  quad: readonly NormalPoint[], quality = 1): Promise<Blob> {
  const h = squareToQuad(quad);
  if (!h) throw new Error('The four perspective corners do not form a usable plane.');
  const { canvas, gl, texture, homography } = rectifyRig();
  // REFUSED RATHER THAN DRAWN AS NOTHING, the same way the main renderer's
  // uploads are: past MAX_TEXTURE_SIZE, texImage2D raises GL_INVALID_VALUE
  // instead of throwing, and a picture would come back black.
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (limit > 0 && (width > limit || height > limit)) {
    throw new Error(`This picture is ${width}×${height} and this GPU carries at `
      + `most ${limit} px on an edge, so it cannot be corrected here.`);
  }
  const bitmap = await createImageBitmap(blob);
  try {
    canvas.width = width;
    canvas.height = height;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // WebGL matrices are column-major; transpose our row-major homography.
    gl.uniformMatrix3fv(homography, false,
      new Float32Array([h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], h[8]]));
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.finish();
    return await canvasBlob(canvas, quality);
  } finally {
    bitmap.close();
    // The texture is kept for the next call, but not the PICTURE in it: a
    // full-size frame left bound is a full-size frame still allocated.
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
}
