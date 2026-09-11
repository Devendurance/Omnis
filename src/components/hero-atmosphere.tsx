"use client";

import { useAmbientMotion } from "@/components/ambient-motion";
import { useEffect, useRef } from "react";

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const SIMULATION_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_previous;
uniform vec2 u_pointer;
uniform vec2 u_velocity;
uniform vec2 u_resolution;
uniform float u_inject;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 texel = 1.0 / u_resolution;
  vec2 field = texture(u_previous, uv).rg * 2.0 - 1.0;
  vec2 left = texture(u_previous, uv - vec2(texel.x, 0.0)).rg * 2.0 - 1.0;
  vec2 right = texture(u_previous, uv + vec2(texel.x, 0.0)).rg * 2.0 - 1.0;
  vec2 up = texture(u_previous, uv + vec2(0.0, texel.y)).rg * 2.0 - 1.0;
  vec2 down = texture(u_previous, uv - vec2(0.0, texel.y)).rg * 2.0 - 1.0;
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 delta = (uv - u_pointer) * aspect;
  float influence = exp(-dot(delta, delta) * 22.0) * u_inject;
  vec2 radial = normalize(delta + vec2(0.0001));
  vec2 impulse = (u_velocity * 1.8 - radial * 0.22) * influence;
  vec2 diffusion = (left + right + up + down) * 0.25 - field;
  vec2 nextField = field * 0.965 + diffusion * 0.34 + impulse;
  nextField *= 0.985;
  nextField = clamp(nextField, vec2(-1.0), vec2(1.0));
  outColor = vec4(nextField * 0.5 + 0.5, 0.0, 1.0);
}`;

const RENDER_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_text;
uniform sampler2D u_displacement;
uniform vec2 u_resolution;
uniform float u_presence;
uniform float u_time;
out vec4 outColor;
float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_resolution.x, 1.0 - gl_FragCoord.y / u_resolution.y);
  vec2 field = (texture(u_displacement, uv).rg - 0.5) * 2.0;
  float energy = smoothstep(0.008, 0.62, length(field));
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 displacement = field * vec2(0.115 / max(aspect.x, 1.0), 0.115);
  vec2 displacedUv = clamp(uv + displacement, vec2(0.001), vec2(0.999));
  vec2 echoUv = clamp(uv - displacement * 0.72, vec2(0.001), vec2(0.999));
  vec4 clean = texture(u_text, uv);
  vec4 refracted = texture(u_text, displacedUv);
  vec4 echo = texture(u_text, echoUv);
  float grain = noise(uv * 74.0 + vec2(u_time * 0.45, -u_time * 0.31));
  float shards = smoothstep(0.34, 0.74, grain + energy * 0.4);
  float erosion = clamp(energy * shards * (0.9 + u_presence * 0.3), 0.0, 0.92);
  vec4 ink = mix(clean, refracted, min(1.0, energy * 1.35));
  ink.rgb = mix(ink.rgb, echo.rgb, energy * 0.42);
  ink.a *= 1.0 - erosion;
  outColor = ink;
}`;

type RenderUniforms = {
  text: WebGLUniformLocation | null;
  displacement: WebGLUniformLocation | null;
  resolution: WebGLUniformLocation | null;
  presence: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
};

type SimulationUniforms = {
  previous: WebGLUniformLocation | null;
  pointer: WebGLUniformLocation | null;
  velocity: WebGLUniformLocation | null;
  resolution: WebGLUniformLocation | null;
  inject: WebGLUniformLocation | null;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function HeroAtmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { allowed } = useAmbientMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const section = canvas?.closest("section");
    const lockup = section?.querySelector<HTMLElement>(
      ".hero-identity h1 .brand-lockup",
    );
    const mark = lockup?.querySelector<HTMLElement>(".wordmark");
    const dot = mark?.querySelector<HTMLElement>(".brand-dot");
    const logo = lockup?.querySelector<HTMLImageElement>(".brand-mark-light");
    if (!canvas || !section || !lockup || !mark || !dot || !logo || !allowed) {
      return;
    }

    if (!window.matchMedia("(pointer: fine)").matches) return;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) return;

    let renderProgram: WebGLProgram | null = null;
    let simulationProgram: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let buffer: WebGLBuffer | null = null;
    let textTexture: WebGLTexture | null = null;
    let simulationTextures: [WebGLTexture, WebGLTexture] | null = null;
    let simulationFramebuffers: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
    let renderUniforms: RenderUniforms | null = null;
    let simulationUniforms: SimulationUniforms | null = null;
    let raf = 0;
    let disposed = false;
    let contextLost = false;
    let sectionVisible = true;
    let simulationRead = 0;
    let presence = 0;
    let presenceTarget = 0;
    let pointerX = 0;
    let pointerY = 0;
    let velocityX = 0;
    let velocityY = 0;
    let motionEnergy = 0;
    let hasPointer = false;
    let lastTime = performance.now();
    let width = 1;
    let height = 1;
    let dpr = 1;
    let simWidth = 128;
    let simHeight = 80;
    let fontsReady = document.fonts.status === "loaded";

    const textCanvas = document.createElement("canvas");
    const textContext = textCanvas.getContext("2d");
    const initialLockupRect = lockup.getBoundingClientRect();
    width = Math.max(1, initialLockupRect.width);
    height = Math.max(1, initialLockupRect.height);
    simWidth = clamp(Math.round(width / 5), 96, 256);
    simHeight = clamp(Math.round(height / 5), 40, 96);

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const createProgram = (vertexSource: string, fragmentSource: string) => {
      const vertex = compile(gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      if (!vertex || !fragment) {
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        return null;
      }
      const program = gl.createProgram();
      if (!program) {
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return null;
      }
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
      }
      return program;
    };

    renderProgram = createProgram(VERTEX_SHADER, RENDER_SHADER);
    simulationProgram = createProgram(VERTEX_SHADER, SIMULATION_SHADER);
    vao = gl.createVertexArray();
    buffer = gl.createBuffer();
    textTexture = gl.createTexture();
    if (!renderProgram || !simulationProgram || !vao || !buffer || !textTexture) {
      if (renderProgram) gl.deleteProgram(renderProgram);
      if (simulationProgram) gl.deleteProgram(simulationProgram);
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      if (textTexture) gl.deleteTexture(textTexture);
      return;
    }

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    renderUniforms = {
      text: gl.getUniformLocation(renderProgram, "u_text"),
      displacement: gl.getUniformLocation(renderProgram, "u_displacement"),
      resolution: gl.getUniformLocation(renderProgram, "u_resolution"),
      presence: gl.getUniformLocation(renderProgram, "u_presence"),
      time: gl.getUniformLocation(renderProgram, "u_time"),
    };
    simulationUniforms = {
      previous: gl.getUniformLocation(simulationProgram, "u_previous"),
      pointer: gl.getUniformLocation(simulationProgram, "u_pointer"),
      velocity: gl.getUniformLocation(simulationProgram, "u_velocity"),
      resolution: gl.getUniformLocation(simulationProgram, "u_resolution"),
      inject: gl.getUniformLocation(simulationProgram, "u_inject"),
    };

    gl.bindTexture(gl.TEXTURE_2D, textTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const createSimulationTarget = () => {
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) {
        if (texture) gl.deleteTexture(texture);
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const neutral = new Uint8Array(simWidth * simHeight * 4);
      for (let index = 0; index < neutral.length; index += 4) {
        neutral[index] = 128;
        neutral[index + 1] = 128;
        neutral[index + 3] = 255;
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        simWidth,
        simHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        neutral,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(framebuffer);
        return null;
      }
      return { texture, framebuffer };
    };

    const firstTarget = createSimulationTarget();
    const secondTarget = createSimulationTarget();
    if (!firstTarget || !secondTarget) {
      if (firstTarget) {
        gl.deleteTexture(firstTarget.texture);
        gl.deleteFramebuffer(firstTarget.framebuffer);
      }
      if (secondTarget) {
        gl.deleteTexture(secondTarget.texture);
        gl.deleteFramebuffer(secondTarget.framebuffer);
      }
      gl.deleteProgram(renderProgram);
      gl.deleteProgram(simulationProgram);
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(textTexture);
      return;
    }
    simulationTextures = [firstTarget.texture, secondTarget.texture];
    simulationFramebuffers = [firstTarget.framebuffer, secondTarget.framebuffer];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const resetSimulation = () => {
      if (!simulationFramebuffers) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, simulationFramebuffers[0]);
      gl.clearColor(0.5, 0.5, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, simulationFramebuffers[1]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      simulationRead = 0;
      motionEnergy = 0;
    };

    const stepSimulation = (inject: number) => {
      if (!simulationTextures || !simulationFramebuffers || !simulationUniforms) return;
      const writeIndex = simulationRead === 0 ? 1 : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, simulationFramebuffers[writeIndex]);
      gl.viewport(0, 0, simWidth, simHeight);
      gl.useProgram(simulationProgram);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, simulationTextures[simulationRead]);
      gl.uniform1i(simulationUniforms.previous, 0);
      gl.uniform2f(
        simulationUniforms.pointer,
        clamp(pointerX / width, 0, 1),
        clamp(pointerY / height, 0, 1),
      );
      gl.uniform2f(simulationUniforms.velocity, velocityX, velocityY);
      gl.uniform2f(simulationUniforms.resolution, simWidth, simHeight);
      gl.uniform1f(simulationUniforms.inject, inject);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      simulationRead = writeIndex;
      velocityX *= 0.72;
      velocityY *= 0.72;
    };

    const draw = (time: number, nextPresence: number, simulate: boolean) => {
      if (!renderProgram || !vao || !textTexture || !simulationTextures || !renderUniforms) {
        return;
      }
      if (simulate) stepSimulation(nextPresence);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(renderProgram);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textTexture);
      gl.uniform1i(renderUniforms.text, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, simulationTextures[simulationRead]);
      gl.uniform1i(renderUniforms.displacement, 1);
      gl.uniform2f(renderUniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(renderUniforms.presence, nextPresence);
      gl.uniform1f(renderUniforms.time, time / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const paintLockup = () => {
      if (
        disposed ||
        contextLost ||
        !fontsReady ||
        !textContext ||
        !logo.complete ||
        logo.naturalWidth === 0
      ) {
        return false;
      }
      const style = getComputedStyle(mark);
      const sectionRect = section.getBoundingClientRect();
      const lockupRect = lockup.getBoundingClientRect();
      const markRect = mark.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const logoRect = logo.getBoundingClientRect();
      width = Math.max(1, lockupRect.width);
      height = Math.max(1, lockupRect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      canvas.style.left = `${lockupRect.left - sectionRect.left}px`;
      canvas.style.top = `${lockupRect.top - sectionRect.top}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      textCanvas.width = canvas.width;
      textCanvas.height = canvas.height;
      textContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      textContext.clearRect(0, 0, width, height);

      const logoX = logoRect.left - lockupRect.left;
      const logoY = logoRect.top - lockupRect.top;
      textContext.drawImage(logo, logoX, logoY, logoRect.width, logoRect.height);

      textContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      textContext.textBaseline = "alphabetic";
      textContext.textAlign = "left";
      const fontSize = Number.parseFloat(style.fontSize) || 140;
      const metrics = textContext.measureText("useOmnis");
      const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.72;
      const descent = metrics.actualBoundingBoxDescent || fontSize * 0.08;
      const textX = markRect.left - lockupRect.left;
      const textY = markRect.top - lockupRect.top;
      const wordWidth = Math.max(1, dotRect.left - markRect.left);
      const periodWidth = Math.max(1, markRect.right - dotRect.left);
      const baseline = textY + (markRect.height + ascent - descent) / 2;
      const measuredWordWidth = Math.max(1, metrics.width);
      textContext.save();
      textContext.translate(textX, baseline);
      textContext.scale(wordWidth / measuredWordWidth, 1);
      textContext.fillStyle = "#ffffff";
      textContext.fillText("useOmnis", 0, 0);
      textContext.restore();
      const periodMetrics = textContext.measureText(".");
      textContext.save();
      textContext.translate(textX + wordWidth, baseline);
      textContext.scale(periodWidth / Math.max(1, periodMetrics.width), 1);
      textContext.fillStyle = "#7b3ff2";
      textContext.fillText(".", 0, 0);
      textContext.restore();

      gl.bindTexture(gl.TEXTURE_2D, textTexture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        textCanvas,
      );
      resetSimulation();
      draw(0, 0, false);
      section.dataset.fluidWordmark = "ready";
      canvas.dataset.fluidState = "ready";
      return true;
    };

    const positionFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nextX = clamp(event.clientX - rect.left, 0, rect.width);
      const nextY = clamp(event.clientY - rect.top, 0, rect.height);
      if (!hasPointer) {
        pointerX = nextX;
        pointerY = nextY;
        velocityX = 0;
        velocityY = 0;
        hasPointer = true;
        return;
      }
      velocityX = clamp((nextX - pointerX) / Math.max(width, 1), -0.16, 0.16);
      velocityY = clamp((nextY - pointerY) / Math.max(height, 1), -0.16, 0.16);
      pointerX = nextX;
      pointerY = nextY;
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed || contextLost || !sectionVisible || document.hidden) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      presence += (presenceTarget - presence) * (1 - Math.exp(-dt * 10));
      motionEnergy = Math.max(
        motionEnergy * Math.exp(-dt * 2.4),
        Math.min(1, Math.hypot(velocityX, velocityY) * 5 + presence * 0.05),
      );
      draw(now, Math.max(presence, motionEnergy), true);
      if (presenceTarget > 0 || presence > 0.012 || motionEnergy > 0.012) {
        raf = window.requestAnimationFrame(frame);
      } else {
        canvas.dataset.fluidState = "ready";
        draw(now, 0, false);
      }
    };

    const start = () => {
      if (raf || disposed || contextLost || !sectionVisible || document.hidden) return;
      lastTime = performance.now();
      raf = window.requestAnimationFrame(frame);
    };

    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      positionFromEvent(event);
      presenceTarget = 1;
      canvas.dataset.fluidState = "active";
      start();
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      positionFromEvent(event);
      presenceTarget = 1;
      canvas.dataset.fluidState = "active";
      start();
    };
    const onLeave = () => {
      presenceTarget = 0;
      canvas.dataset.fluidState = "ready";
      start();
    };
    const onResize = () => {
      paintLockup();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      section.removeAttribute("data-fluid-wordmark");
      canvas.dataset.fluidState = "fallback";
    };
    const onLogoError = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      section.removeAttribute("data-fluid-wordmark");
      canvas.dataset.fluidState = "fallback";
    };
    const onVisibility = () => {
      if (document.hidden) {
        presenceTarget = 0;
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
        canvas.dataset.fluidState = "paused";
      }
    };
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        sectionVisible = entry?.isIntersecting ?? false;
        if (!sectionVisible) {
          presenceTarget = 0;
          if (raf) window.cancelAnimationFrame(raf);
          raf = 0;
          canvas.dataset.fluidState = "paused";
        }
      },
      { threshold: 0 },
    );
    const onLogoLoad = () => {
      if (!disposed && !contextLost) paintLockup();
    };

    lockup.addEventListener("pointerenter", onEnter);
    lockup.addEventListener("pointermove", onMove);
    lockup.addEventListener("pointerleave", onLeave);
    logo.addEventListener("load", onLogoLoad);
    logo.addEventListener("error", onLogoError);
    canvas.addEventListener("webglcontextlost", onContextLost);
    document.addEventListener("visibilitychange", onVisibility);
    intersectionObserver.observe(section);
    window.addEventListener("resize", onResize, { passive: true });
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(lockup);
    void document.fonts.ready.then(() => {
      fontsReady = true;
      onLogoLoad();
    });
    if (typeof logo.decode === "function") {
      void logo.decode().then(onLogoLoad).catch(() => undefined);
    }
    paintLockup();

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      lockup.removeEventListener("pointerenter", onEnter);
      lockup.removeEventListener("pointermove", onMove);
      lockup.removeEventListener("pointerleave", onLeave);
      logo.removeEventListener("load", onLogoLoad);
      logo.removeEventListener("error", onLogoError);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      document.removeEventListener("visibilitychange", onVisibility);
      intersectionObserver.disconnect();
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      section.removeAttribute("data-fluid-wordmark");
      if (simulationFramebuffers) {
        simulationFramebuffers.forEach((framebuffer) => gl.deleteFramebuffer(framebuffer));
      }
      if (simulationTextures) {
        simulationTextures.forEach((texture) => gl.deleteTexture(texture));
      }
      if (textTexture) gl.deleteTexture(textTexture);
      if (buffer) gl.deleteBuffer(buffer);
      if (vao) gl.deleteVertexArray(vao);
      if (renderProgram) gl.deleteProgram(renderProgram);
      if (simulationProgram) gl.deleteProgram(simulationProgram);
    };
  }, [allowed]);

  return (
    <canvas ref={canvasRef} className="fluid-wordmark-canvas" aria-hidden="true" />
  );
}
