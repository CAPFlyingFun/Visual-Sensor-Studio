/** Perspective-assist math and JPEG rectification. No camera ownership lives here. */
export type PerspectiveMode = 'off' | 'level' | 'straighten' | 'rectify';
export interface NormalPoint { x: number; y: number; }
export interface PerspectiveReading { pitch: number; roll: number; }

export const DEFAULT_QUAD: readonly NormalPoint[] = [
  { x: .12, y: .14 }, { x: .88, y: .14 }, { x: .88, y: .86 }, { x: .12, y: .86 }
];

export function screenPitchRoll(beta: number, gamma: number, screenAngle: number): PerspectiveReading {
  const a = ((screenAngle % 360) + 360) % 360;
  if (a === 90) return { pitch: -gamma, roll: beta };
  if (a === 270) return { pitch: gamma, roll: -beta };
  if (a === 180) return { pitch: -beta, roll: -gamma };
  return { pitch: beta, roll: gamma };
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
export async function rectifyJpeg(blob: Blob, width: number, height: number,
  quad: readonly NormalPoint[], quality = 1): Promise<Blob> {
  const h = squareToQuad(quad);
  if (!h) throw new Error('The four perspective corners do not form a usable plane.');
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is unavailable for perspective correction.');
    const vs = `attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*0.5;gl_Position=vec4(p,0,1);}`;
    const fs = `precision highp float; varying vec2 uv; uniform sampler2D image; uniform mat3 H; void main(){vec3 q=H*vec3(uv,1.0);vec2 s=q.xy/q.z;gl_FragColor=texture2D(image,vec2(s.x,1.0-s.y));}`;
    const shader=(type:number,src:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)||'Perspective shader failed');return s;};
    const program=gl.createProgram()!; gl.attachShader(program,shader(gl.VERTEX_SHADER,vs));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)||'Perspective program failed');
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const loc=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);
    // WebGL matrices are column-major; transpose our row-major homography.
    gl.uniformMatrix3fv(gl.getUniformLocation(program,'H'),false,new Float32Array([h[0],h[3],h[6],h[1],h[4],h[7],h[2],h[5],h[8]]));
    gl.viewport(0,0,width,height);gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();
    return await canvasBlob(canvas, quality);
  } finally { bitmap.close(); }
}
