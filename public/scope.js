/**
 * WebGL2 3D Oscilloscope — Lissajous figure renderer
 *
 * Renders 3 audio signals as X/Y/Z coordinates in a 3D Lissajous knot.
 * Optional 4th audio channel drives brightness along the knot.
 * Continuous ring buffer with configurable history length.
 */

// --- Minimal mat4 math (column-major Float32Array) ---

function mat4Identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Perspective(fov, aspect, near, far) {
  const f = 1.0 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4Translate(x, y, z) {
  const m = mat4Identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
  return out;
}

// --- Quaternion math ---

function quatFromAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle * 0.5);
  return [ax * s, ay * s, az * s, Math.cos(angle * 0.5)];
}

function quatMultiply(a, b) {
  return [
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
  ];
}

function quatNormalize(q) {
  const len = Math.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]);
  if (len > 0) { q[0]/=len; q[1]/=len; q[2]/=len; q[3]/=len; }
  return q;
}

function quatToMat4(q) {
  const [x,y,z,w] = q, m = new Float32Array(16);
  m[0]=1-2*(y*y+z*z); m[1]=2*(x*y+w*z); m[2]=2*(x*z-w*y);
  m[4]=2*(x*y-w*z); m[5]=1-2*(x*x+z*z); m[6]=2*(y*z+w*x);
  m[8]=2*(x*z+w*y); m[9]=2*(y*z-w*x); m[10]=1-2*(x*x+y*y); m[15]=1;
  return m;
}

// --- Scope renderer ---

let _scopeAnimFrame = null;
let _scopeCleanup = null;

const _scopeParams = {
  persistence: 0.5, zoom: 3, spin: 0.1,
  density: 0,
};

function setScopeParams(params) {
  for (const [k, v] of Object.entries(params))
    if (k in _scopeParams && typeof v === "number") _scopeParams[k] = v;
}

function initScope(canvas, instances) {
  if (_scopeAnimFrame) { cancelAnimationFrame(_scopeAnimFrame); _scopeAnimFrame = null; }
  if (_scopeCleanup) { _scopeCleanup(); _scopeCleanup = null; }

  const N = instances.length;
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) { console.warn("WebGL2 not available"); return; }

  const RING_CAPACITY = 256 * 1024;
  const FLOATS_PER_VERT = 7; // x, y, z, hue, saturation, brightness, pad
  const BYTES_PER_VERT = FLOATS_PER_VERT * 4;

  const vsSource = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in float aHue;
layout(location = 2) in float aSaturation;
layout(location = 3) in float aBrightness;
uniform mat4 uMVP;
uniform float uAlphaBase;
out vec4 vColor;

vec3 hsb2rgb(float h, float s, float b) {
  vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return b * mix(vec3(1.0), rgb, s);
}

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  float b = clamp(aBrightness, 0.0, 1.0);
  float s = clamp(aSaturation, 0.0, 1.0);
  vec3 rgb = hsb2rgb(aHue, s, max(b, 0.3));
  vColor = vec4(rgb, uAlphaBase);
}`;

  const fsSource = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

  function compileShader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
    return s;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(program)); return; }

  const uMVP = gl.getUniformLocation(program, "uMVP");
  const uAlphaBase = gl.getUniformLocation(program, "uAlphaBase");

  // Per-instance data
  const instData = instances.map((inst) => {
    const analyserSamples = inst.analyserX.fftSize;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, RING_CAPACITY * BYTES_PER_VERT, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, BYTES_PER_VERT, 0);  // x,y,z
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, BYTES_PER_VERT, 12); // hue
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, BYTES_PER_VERT, 16); // saturation
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, BYTES_PER_VERT, 20); // brightness
    gl.bindVertexArray(null);

    return {
      vao, vbo,
      writePos: 0,       // next write position in ring
      totalWritten: 0,   // total vertices written (for knowing how full the ring is)
      analyserSamples,
      bufX: new Float32Array(analyserSamples),
      bufY: new Float32Array(analyserSamples),
      bufZ: new Float32Array(analyserSamples),
      bufH: new Float32Array(analyserSamples),
      bufS: new Float32Array(analyserSamples),
      bufB: new Float32Array(analyserSamples),
      batchBuf: new Float32Array(analyserSamples * FLOATS_PER_VERT),
      analyserX: inst.analyserX, analyserY: inst.analyserY, analyserZ: inst.analyserZ,
      analyserH: inst.analyserH || null, analyserS: inst.analyserS || null, analyserB: inst.analyserB || null,
      pointBuf: new Float32Array(FLOATS_PER_VERT),
      maxX: 0.1, maxY: 0.1, maxZ: 0.1,
      // Track chunk boundaries for pen-lifting between frames
      chunks: [],       // ring of { start, count } — each analyser frame is one chunk
      maxChunks: 4096,  // max tracked chunks
    };
  });

  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  // Orbit state
  const orientation = [0, 0, 0, 1];
  const angVel = [0, 0, 0];
  let lastTime = 0;
  let dragging = false, lastPtrX = 0, lastPtrY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastPtrX = e.clientX; lastPtrY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    angVel[0] = angVel[1] = angVel[2] = 0;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = quatMultiply(quatFromAxisAngle(0,1,0,(e.clientX-lastPtrX)*0.01), quatFromAxisAngle(1,0,0,(e.clientY-lastPtrY)*0.01));
    const q = quatMultiply(r, orientation);
    orientation[0]=q[0]; orientation[1]=q[1]; orientation[2]=q[2]; orientation[3]=q[3];
    quatNormalize(orientation);
    lastPtrX = e.clientX; lastPtrY = e.clientY;
  });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); }, { passive: false });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });

  let _debugCount = 0;
  function render(time) {
    _scopeAnimFrame = requestAnimationFrame(render);
    const p = _scopeParams;

    // Persistence: 0-1 maps to 256 vertices up to full ring capacity (256K)
    // This gives many orders of magnitude of trail length
    const displayCount = Math.min(RING_CAPACITY, Math.max(256, Math.round(Math.pow(p.persistence, 3) * RING_CAPACITY)));

    // Resize
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr | 0, h = canvas.clientHeight * dpr | 0;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    // Physics
    if (lastTime === 0) lastTime = time;
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    if (!dragging && p.spin > 0) {
      angVel[0] += -Math.sin(time * 0.0003) * p.spin * dt;
      angVel[1] += Math.cos(time * 0.0003) * p.spin * dt;
    }
    const decay = Math.exp(-dt / 3.0);
    angVel[0] *= decay; angVel[1] *= decay; angVel[2] *= decay;
    const speed = Math.sqrt(angVel[0]*angVel[0]+angVel[1]*angVel[1]+angVel[2]*angVel[2]);
    if (speed > 0.0001) {
      const r = quatMultiply(quatFromAxisAngle(angVel[0]/speed, angVel[1]/speed, angVel[2]/speed, speed*dt), orientation);
      orientation[0]=r[0]; orientation[1]=r[1]; orientation[2]=r[2]; orientation[3]=r[3];
      quatNormalize(orientation);
    }

    const model = quatToMat4(orientation);
    const view = mat4Translate(0, 0, -Math.max(0.5, p.zoom));

    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    for (let i = 0; i < N; i++) {
      const d = instData[i];

      // Read latest samples from each analyser
      d.analyserX.getFloatTimeDomainData(d.bufX);
      d.analyserY.getFloatTimeDomainData(d.bufY);
      d.analyserZ.getFloatTimeDomainData(d.bufZ);
      if (d.analyserH) d.analyserH.getFloatTimeDomainData(d.bufH);
      if (d.analyserS) d.analyserS.getFloatTimeDomainData(d.bufS);
      if (d.analyserB) d.analyserB.getFloatTimeDomainData(d.bufB);

      if (_debugCount++ === 120 && i === 0) {
        let pX=0,pY=0,pZ=0;
        for (let s=0;s<d.analyserSamples;s++) { pX=Math.max(pX,Math.abs(d.bufX[s])); pY=Math.max(pY,Math.abs(d.bufY[s])); pZ=Math.max(pZ,Math.abs(d.bufZ[s])); }
        console.log("scope @2s: X="+pX.toFixed(4)+" Y="+pY.toFixed(4)+" Z="+pZ.toFixed(4)+" written="+d.totalWritten+" display="+displayCount+" density="+p.density);
      }

      // Density controls how many samples to write per frame (1 to analyserSamples)
      const maxSamples = d.analyserSamples;
      const samplesPerFrame = Math.max(1, Math.round(Math.pow(maxSamples, Math.max(0, Math.min(1, p.density)))));
      const step = maxSamples / samplesPerFrame;

      // Auto-scale: track peak per axis independently
      for (let s = 0; s < d.analyserSamples; s++) {
        const ax = Math.abs(d.bufX[s]), ay = Math.abs(d.bufY[s]), az = Math.abs(d.bufZ[s]);
        if (ax > d.maxX) d.maxX = ax;
        if (ay > d.maxY) d.maxY = ay;
        if (az > d.maxZ) d.maxZ = az;
      }
      d.maxX *= 0.9999; d.maxY *= 0.9999; d.maxZ *= 0.9999;
      d.maxX = Math.max(d.maxX, 0.001); d.maxY = Math.max(d.maxY, 0.001); d.maxZ = Math.max(d.maxZ, 0.001);
      const scX = 1.0 / d.maxX, scY = 1.0 / d.maxY, scZ = 1.0 / d.maxZ;

      // Build chunk in batch buffer, then upload once
      for (let j = 0; j < samplesPerFrame; j++) {
        const s = Math.min(Math.floor(j * step), d.analyserSamples - 1);
        const off = j * FLOATS_PER_VERT;
        d.batchBuf[off]   = d.bufX[s] * scX;
        d.batchBuf[off+1] = d.bufY[s] * scY;
        d.batchBuf[off+2] = d.bufZ[s] * scZ;
        d.batchBuf[off+3] = d.analyserH ? Math.abs(d.bufH[s]) : 0.6;
        d.batchBuf[off+4] = d.analyserS ? Math.abs(d.bufS[s]) : 1.0;
        d.batchBuf[off+5] = d.analyserB ? Math.max(0.15, Math.abs(d.bufB[s])) : 1.0;
        d.batchBuf[off+6] = 0;
      }

      // Upload batch to ring buffer (may wrap)
      gl.bindBuffer(gl.ARRAY_BUFFER, d.vbo);
      const chunkStart = d.writePos;
      const spaceAtEnd = RING_CAPACITY - d.writePos;
      const chunk = d.batchBuf.subarray(0, samplesPerFrame * FLOATS_PER_VERT);
      if (samplesPerFrame <= spaceAtEnd) {
        gl.bufferSubData(gl.ARRAY_BUFFER, d.writePos * BYTES_PER_VERT, chunk);
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, d.writePos * BYTES_PER_VERT, d.batchBuf.subarray(0, spaceAtEnd * FLOATS_PER_VERT));
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.batchBuf.subarray(spaceAtEnd * FLOATS_PER_VERT, samplesPerFrame * FLOATS_PER_VERT));
      }
      d.writePos = (d.writePos + samplesPerFrame) % RING_CAPACITY;
      d.totalWritten += samplesPerFrame;

      // Record this chunk
      d.chunks.push({ start: chunkStart, count: samplesPerFrame });
      if (d.chunks.length > d.maxChunks) d.chunks.shift();

      // How many vertices to draw
      const available = Math.min(d.totalWritten, RING_CAPACITY);
      const drawCount = Math.min(available, displayCount);
      if (drawCount < 2) continue;

      // Viewport strip
      const stripWidth = Math.round(canvas.width / N);
      const x = Math.round(i * canvas.width / N);
      gl.viewport(x, 0, stripWidth, canvas.height);

      const aspect = stripWidth / canvas.height;
      const proj = mat4Perspective(Math.PI / 6, aspect, 0.1, 100);
      const mvp = mat4Multiply(proj, mat4Multiply(view, model));
      gl.uniformMatrix4fv(uMVP, false, mvp);
      gl.uniform1f(uAlphaBase, 0.8);
      gl.bindVertexArray(d.vao);

      // Draw as continuous LINE_STRIP
      const startVert = (d.writePos - drawCount + RING_CAPACITY) % RING_CAPACITY;
      if (startVert + drawCount <= RING_CAPACITY) {
        gl.drawArrays(gl.LINE_STRIP, startVert, drawCount);
      } else {
        const firstCount = RING_CAPACITY - startVert;
        gl.drawArrays(gl.LINE_STRIP, startVert, firstCount);
        gl.drawArrays(gl.LINE_STRIP, 0, drawCount - firstCount);
      }

      gl.bindVertexArray(null);
    }
  }

  _scopeAnimFrame = requestAnimationFrame(render);
  _scopeCleanup = () => { for (const d of instData) { gl.deleteVertexArray(d.vao); gl.deleteBuffer(d.vbo); } };
}
