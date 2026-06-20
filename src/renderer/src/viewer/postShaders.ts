import * as THREE from 'three'

/**
 * Screen-space post-processing shaders that read the scene's depth buffer (a
 * DepthTexture filled by a depth pre-pass). They work with the GPU-impostor
 * spheres because those write correct per-pixel depth (gl_FragDepth), so the
 * depth texture has true sphere silhouettes — unlike three's built-in SSAO/
 * outline passes, which re-render geometry with override materials and would see
 * the impostors' flat billboards.
 *
 * Both are disabled by default; enabling them is opt-in from Graphics settings.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const DEPTH_HELPERS = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform vec2 resolution;
varying vec2 vUv;

// Eye-space (linear) distance from the non-linear depth-buffer value.
float linearDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float z = d * 2.0 - 1.0;
  return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
}
`

/** Dark silhouette: darken pixels where linear depth changes sharply vs neighbors. */
export const OUTLINE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    resolution: { value: new THREE.Vector2(1, 1) },
    uStrength: { value: 0.85 }
  },
  vertexShader: VERTEX,
  fragmentShader:
    DEPTH_HELPERS +
    /* glsl */ `
    uniform float uStrength;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 px = 1.0 / resolution;
      float d = linearDepth(vUv);
      // Background (far plane) gets no outline.
      if (d >= cameraFar * 0.99) { gl_FragColor = color; return; }
      float dl = linearDepth(vUv - vec2(px.x, 0.0));
      float dr = linearDepth(vUv + vec2(px.x, 0.0));
      float dd = linearDepth(vUv - vec2(0.0, px.y));
      float du = linearDepth(vUv + vec2(0.0, px.y));
      float edge = abs(d - dl) + abs(d - dr) + abs(d - dd) + abs(d - du);
      // Threshold scales with depth so far geometry isn't all edges.
      float e = smoothstep(0.0, d * 0.04 + 0.02, edge);
      gl_FragColor = vec4(mix(color.rgb, vec3(0.0), e * uStrength), color.a);
    }
  `
}

/** Cheap depth-only ambient occlusion: darken pixels whose neighbors are nearer. */
export const AO_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    resolution: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 6.0 },
    uStrength: { value: 0.9 }
  },
  vertexShader: VERTEX,
  fragmentShader:
    DEPTH_HELPERS +
    /* glsl */ `
    uniform float uRadius;
    uniform float uStrength;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = linearDepth(vUv);
      if (d >= cameraFar * 0.99) { gl_FragColor = color; return; }
      vec2 px = uRadius / resolution;
      float occ = 0.0;
      // 8 taps in a ring; a neighbor markedly nearer than this pixel occludes it.
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853981634; // 2pi/8
        vec2 off = vec2(cos(a), sin(a)) * px;
        float dn = linearDepth(vUv + off);
        float diff = d - dn; // >0 when neighbor is closer (an occluder)
        occ += clamp(diff, 0.0, 1.0) / (1.0 + diff);
      }
      occ = clamp((occ / 8.0) * uStrength, 0.0, 1.0);
      gl_FragColor = vec4(color.rgb * (1.0 - occ), color.a);
    }
  `
}
