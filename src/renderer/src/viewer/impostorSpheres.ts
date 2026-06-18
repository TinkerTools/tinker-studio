import * as THREE from 'three'

/**
 * GPU impostor spheres: instead of tessellating each atom into hundreds of
 * triangles, we draw one camera-facing quad per atom and ray-trace a perfect
 * sphere in the fragment shader (writing gl_FragDepth so spheres intersect
 * bonds and each other correctly). This stays pixel-perfect at any zoom and
 * scales to very large systems — the standard technique behind PyMOL/VMD/NGL.
 *
 * Colors are provided in linear space; the final sRGB conversion happens in the
 * post-processing OutputPass, so this shader outputs linear color.
 */

export interface SphereInstances {
  /** xyz per atom. */
  centers: Float32Array
  /** radius per atom. */
  radii: Float32Array
  /** linear rgb per atom. */
  colors: Float32Array
  count: number
}

const VERTEX = /* glsl */ `
in vec3 aCenter;
in float aRadius;
in vec3 aColor;

out vec3 vColor;
out vec3 vViewCenter;
out float vRadius;
out vec3 vViewPos;

void main() {
  vec4 viewCenter = modelViewMatrix * vec4(aCenter, 1.0);
  // Billboard the quad at the sphere's depth, sized with a small margin so the
  // silhouette is never clipped under perspective.
  vec3 viewPos = viewCenter.xyz + vec3(position.xy * aRadius * 1.25, 0.0);
  vViewCenter = viewCenter.xyz;
  vRadius = aRadius;
  vViewPos = viewPos;
  vColor = aColor;
  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
}
`

const FRAGMENT = /* glsl */ `
uniform mat4 projectionMatrix;

// View-space light directions + colors (intensity baked in) + ambient, kept in
// sync with the scene's lights so atoms shade like the cylinder bonds.
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform float uAmbient;

in vec3 vColor;
in vec3 vViewCenter;
in float vRadius;
in vec3 vViewPos;

out vec4 fragColor;

void main() {
  // Ray from the camera (origin in view space) through this fragment.
  vec3 rayDir = normalize(vViewPos);
  vec3 oc = -vViewCenter;
  float b = dot(oc, rayDir);
  float c = dot(oc, oc) - vRadius * vRadius;
  float disc = b * b - c;
  if (disc < 0.0) discard;

  float t = -b - sqrt(disc);
  vec3 hit = rayDir * t;
  vec3 normal = normalize(hit - vViewCenter);

  // Correct per-pixel depth from the true sphere surface.
  vec4 clip = projectionMatrix * vec4(hit, 1.0);
  gl_FragDepth = 0.5 + 0.5 * (clip.z / clip.w);

  float kd = max(dot(normal, uKeyDir), 0.0);
  float fd = max(dot(normal, uFillDir), 0.0);
  vec3 color = vColor * (uAmbient + uKeyColor * kd + uFillColor * fd);
  // A faint highlight (the cylinders' PBR has a little), kept subtle.
  vec3 h = normalize(uKeyDir + normalize(-hit));
  color += uKeyColor * pow(max(dot(normal, h), 0.0), 30.0) * 0.12;
  fragColor = vec4(color, 1.0);
}
`

// One shared material (stateless except the lighting uniforms, which the scene
// keeps in sync each frame). Never disposed — disposeGroup skips ShaderMaterials.
let sharedMaterial: THREE.ShaderMaterial | null = null
function impostorMaterial(): THREE.ShaderMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uKeyDir: { value: new THREE.Vector3(0, 0, 1) },
        uKeyColor: { value: new THREE.Color(1, 1, 1) },
        uFillDir: { value: new THREE.Vector3(0, 0, -1) },
        uFillColor: { value: new THREE.Color(0.2, 0.2, 0.3) },
        uAmbient: { value: 0.55 }
      }
    })
  }
  return sharedMaterial
}

/**
 * Keep the impostor lighting in sync with the scene's directional lights (passed
 * as view-space directions) so atoms shade like the standard-material bonds.
 */
export function updateImpostorLighting(
  keyDir: THREE.Vector3,
  keyColor: THREE.Color,
  fillDir: THREE.Vector3,
  fillColor: THREE.Color,
  ambient: number
): void {
  if (!sharedMaterial) return
  const u = sharedMaterial.uniforms
  ;(u.uKeyDir.value as THREE.Vector3).copy(keyDir)
  ;(u.uKeyColor.value as THREE.Color).copy(keyColor)
  ;(u.uFillDir.value as THREE.Vector3).copy(fillDir)
  ;(u.uFillColor.value as THREE.Color).copy(fillColor)
  u.uAmbient.value = ambient
}

export function createImpostorSpheres(data: SphereInstances): THREE.Mesh {
  const geometry = new THREE.InstancedBufferGeometry()
  // A unit quad in the XY plane; the vertex shader billboards it.
  const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])
  geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  geometry.instanceCount = data.count
  geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(data.centers, 3))
  geometry.setAttribute('aRadius', new THREE.InstancedBufferAttribute(data.radii, 1))
  geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(data.colors, 3))

  const mesh = new THREE.Mesh(geometry, impostorMaterial())
  // Per-instance billboards make the geometry's bounding sphere meaningless.
  mesh.frustumCulled = false
  return mesh
}
