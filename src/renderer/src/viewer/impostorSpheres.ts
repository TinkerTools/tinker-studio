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

  // Simple two-light view-space shading + a soft specular highlight.
  vec3 viewDir = normalize(-hit);
  vec3 key = normalize(vec3(0.5, 0.7, 0.9));
  vec3 fill = normalize(vec3(-0.6, -0.3, -0.4));
  float diffuse = max(dot(normal, key), 0.0) * 0.9 + max(dot(normal, fill), 0.0) * 0.22;
  vec3 half0 = normalize(key + viewDir);
  float specular = pow(max(dot(normal, half0), 0.0), 40.0) * 0.3;
  float ambient = 0.45;

  vec3 color = vColor * (ambient + diffuse) + vec3(specular);
  fragColor = vec4(color, 1.0);
}
`

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

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {}
  })

  const mesh = new THREE.Mesh(geometry, material)
  // Per-instance billboards make the geometry's bounding sphere meaningless.
  mesh.frustumCulled = false
  return mesh
}
