/**
 * WebGL2 3D Oscilloscope — Lissajous figure renderer
 *
 * Renders F1->X, F2->Y, F3->Z as a 3D Lissajous knot
 * with phosphor persistence and slow auto-rotation.
 * Supports 1-N instances as horizontal strips.
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
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
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
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[i]      * b[j * 4]     +
        a[4 + i]  * b[j * 4 + 1] +
        a[8 + i]  * b[j * 4 + 2] +
        a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

// --- Quaternion math ([x, y, z, w]) ---

function quatFromAxisAngle(ax, ay, az, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

function quatMultiply(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}

function quatNormalize(q) {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
  if (len > 0) { q[0] /= len; q[1] /= len; q[2] /= len; q[3] /= len; }
  return q;
}

function quatToMat4(q) {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0]  = 1 - 2*(y*y + z*z);
  m[1]  = 2*(x*y + w*z);
  m[2]  = 2*(x*z - w*y);
  m[4]  = 2*(x*y - w*z);
  m[5]  = 1 - 2*(x*x + z*z);
  m[6]  = 2*(y*z + w*x);
  m[8]  = 2*(x*z + w*y);
  m[9]  = 2*(y*z - w*x);
  m[10] = 1 - 2*(x*x + y*y);
  m[15] = 1;
  return m;
}

// --- Scope renderer ---

let _scopeAnimFrame = null;
let _scopeCleanup = null;

function initScope(canvas, instances) {
  // Cancel previous render loop and clean up GL resources
  if (_scopeAnimFrame) {
    cancelAnimationFrame(_scopeAnimFrame);
    _scopeAnimFrame = null;
  }
  if (_scopeCleanup) {
    _scopeCleanup();
    _scopeCleanup = null;
  }

  // instances = [{ analyserF1, analyserF2, analyserF3 }, ...]
  const N = instances.length;

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });

  if (!gl) {
    console.warn("WebGL2 not available — scope disabled");
    return;
  }

  const TRAIL_COUNT = 12;

  // --- Shaders ---

  const vsSource = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uMVP;
uniform float uAlpha;
out float vAlpha;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  vAlpha = uAlpha;
}`;

  const fsSource = `#version 300 es
precision mediump float;
in float vAlpha;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0, 1.0, 1.0, vAlpha);
}`;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    return;
  }

  const uMVP = gl.getUniformLocation(program, "uMVP");
  const uAlpha = gl.getUniformLocation(program, "uAlpha");

  // --- Per-instance VBO/VAO and ring buffers ---

  const instData = instances.map((inst) => {
    const samples = inst.analyserF1.fftSize;
    const floatsPerFrame = samples * 3;
    const totalFloats = TRAIL_COUNT * floatsPerFrame;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, totalFloats * 4, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    return {
      vao, vbo,
      ringIndex: 0,
      samples,
      floatsPerFrame,
      frameData: new Float32Array(floatsPerFrame),
      bufX: new Float32Array(samples),
      bufY: new Float32Array(samples),
      bufZ: new Float32Array(samples),
      analyserX: inst.analyserF1,
      analyserY: inst.analyserF2,
      analyserZ: inst.analyserF3,
    };
  });

  // --- GL state ---

  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  // --- Orbit state (quaternion + velocity) ---

  const orientation = [0, 0, 0, 1];
  const angVel = [0, 0, 0];
  let thrustAngle = 0;
  let thrustMag = 0;
  const DRAG_TAU = 3.0;
  let lastTime = 0;
  let dragging = false;
  let lastPtrX = 0, lastPtrY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    angVel[0] = angVel[1] = angVel[2] = 0;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - lastPtrX) * 0.01;
    const dy = (e.clientY - lastPtrY) * 0.01;
    const q = quatMultiply(
      quatFromAxisAngle(0, 1, 0, dx),
      quatFromAxisAngle(1, 0, 0, dy)
    );
    const r = quatMultiply(q, orientation);
    orientation[0] = r[0]; orientation[1] = r[1];
    orientation[2] = r[2]; orientation[3] = r[3];
    quatNormalize(orientation);
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
  });

  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); }, { passive: false });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });

  // --- Render loop ---

  function render(time) {
    _scopeAnimFrame = requestAnimationFrame(render);

    // Resize canvas to display size
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr | 0;
    const h = canvas.clientHeight * dpr | 0;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // Physics: thrust -> angular velocity -> orientation
    if (lastTime === 0) lastTime = time;
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    if (!dragging && thrustMag > 0) {
      angVel[0] += -Math.sin(thrustAngle) * thrustMag * dt;
      angVel[1] += Math.cos(thrustAngle) * thrustMag * dt;
    }

    const decay = Math.exp(-dt / DRAG_TAU);
    angVel[0] *= decay;
    angVel[1] *= decay;
    angVel[2] *= decay;

    const speed = Math.sqrt(angVel[0]*angVel[0] + angVel[1]*angVel[1] + angVel[2]*angVel[2]);
    if (speed > 0.0001) {
      const r = quatMultiply(
        quatFromAxisAngle(angVel[0]/speed, angVel[1]/speed, angVel[2]/speed, speed * dt),
        orientation
      );
      orientation[0] = r[0]; orientation[1] = r[1];
      orientation[2] = r[2]; orientation[3] = r[3];
      quatNormalize(orientation);
    }

    const model = quatToMat4(orientation);
    const view = mat4Translate(0, 0, -3);

    // Clear full canvas
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    // Draw each instance in its own viewport strip
    for (let i = 0; i < N; i++) {
      const d = instData[i];

      // Read analyser time-domain data
      d.analyserX.getFloatTimeDomainData(d.bufX);
      d.analyserY.getFloatTimeDomainData(d.bufY);
      d.analyserZ.getFloatTimeDomainData(d.bufZ);

      // Interleave into frame buffer
      for (let s = 0; s < d.samples; s++) {
        const idx = s * 3;
        d.frameData[idx]     = d.bufX[s];
        d.frameData[idx + 1] = d.bufY[s];
        d.frameData[idx + 2] = d.bufZ[s];
      }

      // Upload current frame to ring buffer slot
      gl.bindBuffer(gl.ARRAY_BUFFER, d.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, d.ringIndex * d.floatsPerFrame * 4, d.frameData);

      // Viewport: horizontal strip
      const stripWidth = Math.round(canvas.width / N);
      const x = Math.round(i * canvas.width / N);
      gl.viewport(x, 0, stripWidth, canvas.height);

      // Build MVP with strip aspect ratio
      const aspect = stripWidth / canvas.height;
      const proj = mat4Perspective(Math.PI / 6, aspect, 0.1, 100);
      const mvp = mat4Multiply(proj, mat4Multiply(view, model));

      gl.uniformMatrix4fv(uMVP, false, mvp);
      gl.bindVertexArray(d.vao);

      // Draw oldest to newest with increasing alpha
      for (let t = 0; t < TRAIL_COUNT; t++) {
        const frameIdx = (d.ringIndex + 1 + t) % TRAIL_COUNT;
        const a = ((t + 1) / TRAIL_COUNT);
        gl.uniform1f(uAlpha, a * a);
        gl.drawArrays(gl.LINE_STRIP, frameIdx * d.samples, d.samples);
      }

      gl.bindVertexArray(null);

      // Advance ring index
      d.ringIndex = (d.ringIndex + 1) % TRAIL_COUNT;
    }
  }

  _scopeAnimFrame = requestAnimationFrame(render);

  // Register cleanup for reinit
  _scopeCleanup = () => {
    for (const d of instData) {
      gl.deleteVertexArray(d.vao);
      gl.deleteBuffer(d.vbo);
    }
  };

  return function setOrbit(angle, thrust) {
    if (angle !== undefined) thrustAngle = angle;
    if (thrust !== undefined) thrustMag = thrust;
  };
}
