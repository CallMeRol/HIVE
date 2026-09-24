import * as THREE from 'three'

/**
 * Liquid Agent material — a white translucent soma with an independently
 * colored workload glow. Surface flow, breathing and spawn bulges remain.
 *
 * The base is neutral so the five PRD workload colors stay legible.
 */

/**
 * Continuous trigonometric flow field — organic, lattice-free.
 * Replaces the previous hash-based value noise whose fract(large product)
 * quantized into blocky "scar" patches on the surface.
 */
const FLOW_GLSL = /* glsl */ `
float flowField(vec3 p, float t) {
  float a = sin(p.x * 3.1 + t * 0.35 + sin(p.z * 2.3 + t * 0.21) * 1.2);
  float b = sin(p.y * 2.6 - t * 0.28 + sin(p.x * 1.9 - t * 0.17) * 1.1);
  float c = sin(p.z * 3.4 + t * 0.22 + sin(p.y * 2.2 + t * 0.26) * 1.0);
  return (a + b + c) / 3.0; // smooth, -1..1, no lattice artifacts
}
`

export const LIQUID_PALETTE = {
  base: new THREE.Color('#edf3fa'),
  highlight: new THREE.Color('#ffffff'),
  core: new THREE.Color('#f4f8ff'),
  shadow: new THREE.Color('#536172'),
}

// The host's legacy light-mode iframe is inverted as a whole. Feed a dark
// neutral shell into that filter so the displayed soma stays near white.
const LIGHT_EMBED_PREFILTER_PALETTE = {
  base: new THREE.Color('#202a35'),
  highlight: new THREE.Color('#273444'),
  core: new THREE.Color('#1a2633'),
  shadow: new THREE.Color('#070d14'),
}

export interface AgentMaterialUniforms {
  uTime: { value: number }
  uBeat: { value: number }
  uBreath: { value: number }
  uActivity: { value: number }
  uCorePulse: { value: number }
  uHover: { value: number }
  uSelect: { value: number }
  uDim: { value: number }
  uError: { value: number }
  uStatusColor: { value: THREE.Color }
  uStatusGlow: { value: number }
  uBulge: { value: number }
  uBulgeDir: { value: THREE.Vector3 }
  uNeck: { value: number }
  uNeckDir: { value: THREE.Vector3 }
}

export function createAgentMaterial(lightEmbed = false): THREE.ShaderMaterial {
  const palette = lightEmbed ? LIGHT_EMBED_PREFILTER_PALETTE : LIQUID_PALETTE
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uBreath: { value: 0.2 },
      uActivity: { value: 0.35 },
      uCorePulse: { value: 0.05 },
      uHover: { value: 0 },
      uSelect: { value: 0 },
      uDim: { value: 0 },
      uError: { value: 0 },
      uStatusColor: { value: new THREE.Color('#58a6ff') },
      uStatusGlow: { value: 0.5 },
      uBulge: { value: 0 },
      uBulgeDir: { value: new THREE.Vector3(1, 0, 0) },
      uNeck: { value: 0 },
      uNeckDir: { value: new THREE.Vector3(1, 0, 0) },
      uBase: { value: palette.base.clone() },
      uHighlight: { value: palette.highlight.clone() },
      uCore: { value: palette.core.clone() },
      uShadow: { value: palette.shadow.clone() },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uBreath;
      uniform float uActivity;
      uniform float uHover;
      uniform float uBulge;
      uniform vec3 uBulgeDir;
      uniform float uNeck;
      uniform vec3 uNeckDir;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      varying vec3 vPosL;
      ${FLOW_GLSL}

      // Radial displacement field on the unit sphere. Everything that makes
      // the body read as LIQUID lives here: a slow large-scale tide that moves
      // the silhouette, finer viscous creep, breathing, the spawn bulge, and
      // surface tension pulling the surface toward a nearby soma.
      float surfaceDisp(vec3 n) {
        float motion = mix(0.22, 1.0, uActivity);
        float tide = flowField(n * 1.15, uTime * 0.5) * motion;
        float creep = flowField(n * 3.1 + 11.0, uTime * 0.85) * motion;
        float breathe = sin(uTime * 1.1) * 0.5 + 0.5;
        float beat = uBeat;
        float d = tide * 0.07 + creep * 0.022 + breathe * 0.022 * uBreath * motion
          + beat * (0.012 + 0.028 * uActivity) + uHover * 0.006;

        float bd = max(dot(n, normalize(uBulgeDir)), 0.0);
        d += uBulge * pow(bd, 3.0) * 0.75;

        float nd = max(dot(n, normalize(uNeckDir)), 0.0);
        d += uNeck * pow(nd, 2.0) * 0.5;
        return d;
      }

      void main() {
        vec3 n = normalize(position);
        float d0 = surfaceDisp(n);

        // Normal from the GRADIENT of the displacement field. A rigid sphere
        // normal keeps every highlight pinned in place, which is what made the
        // body look like frozen glass no matter how much it flowed.
        vec3 up = abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 t1 = normalize(cross(n, up));
        vec3 t2 = normalize(cross(n, t1));
        float eps = 0.09;
        float d1 = surfaceDisp(normalize(n + t1 * eps));
        float d2 = surfaceDisp(normalize(n + t2 * eps));
        vec3 grad = (t1 * (d1 - d0) + t2 * (d2 - d0)) / eps;
        vec3 nrm = normalize(n - grad * 0.9);

        vec3 p = position + n * d0;
        vPosL = position;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vPosW = world.xyz;
        // displacement is radial, so only the tangential gradient tilts the normal
        vNormalW = normalize(mat3(modelMatrix) * nrm);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uCorePulse;
      uniform float uActivity;
      uniform float uHover;
      uniform float uSelect;
      uniform float uDim;
      uniform float uError;
      uniform vec3 uStatusColor;
      uniform float uStatusGlow;
      uniform float uNeck;
      uniform vec3 uNeckDir;
      uniform vec3 uBase;
      uniform vec3 uHighlight;
      uniform vec3 uCore;
      uniform vec3 uShadow;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      varying vec3 vPosL;
      ${FLOW_GLSL}

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 2.6);

        // ── key light with a REAL terminator ──
        // A soft wrap term has no dark side, which is exactly why the bodies
        // read as flat discs. A terminator is what gives them volume.
        vec3 L1 = normalize(vec3(0.5, 0.82, 0.42));
        vec3 L2 = normalize(vec3(-0.65, -0.2, 0.6));
        float ndl1 = dot(N, L1);
        float key = smoothstep(-0.45, 0.85, ndl1);
        float fill = smoothstep(-0.6, 0.9, dot(N, L2)) * 0.22;

        vec3 col = uShadow * (0.15 + 0.12 * key);
        col += uBase * (0.27 + key * key * 0.34 + fill * 0.35);

        // Keep a soft volume cue without staining the neutral shell.
        col *= mix(0.72, 1.0, smoothstep(-0.85, 0.9, N.y));

        // inner occlusion before the rim: dark limb + thin bright edge reads
        // as a deep, high-density liquid rather than a painted ball
        col *= mix(1.0, 0.72, smoothstep(0.28, 1.0, fres));

        // Broad, low-contrast matter variation breaks the clean CG sphere
        // into dense fluid tissue. It is deliberately softer than a texture
        // map, so the surface keeps its liquid continuity.
        float coarseMatter = flowField(vPosL * 0.85 + 7.0, uTime * 0.12) * 0.5 + 0.5;
        float fineMatter = flowField(vPosL * 4.4 - 3.0, uTime * 0.32) * 0.5 + 0.5;
        float matter = mix(coarseMatter, fineMatter, 0.28);
        col *= 0.8 + matter * 0.24;

        // Subsurface-style back scatter keeps the white shell dimensional.
        float backScatter = pow(max(dot(-N, L1), 0.0), 1.4);
        col += uCore * backScatter * (0.06 + 0.11 * uActivity)
          * (0.55 + 0.45 * coarseMatter);

        // rim light, strongest where the key light grazes the surface
        float rimLit = 0.35 + 0.65 * smoothstep(-0.3, 0.9, ndl1);
        col += uHighlight * fres * fres * (0.16 * rimLit + uHover * 0.5 + uSelect * 0.75);

        // Neutral environment reflection; status tint is handled separately.
        vec3 R = reflect(-V, N);
        col += uHighlight * smoothstep(-0.15, 0.95, R.y) * 0.035;

        // A restrained cold reflection rides over the translucent shell.
        vec3 metalEnv = mix(vec3(0.025, 0.03, 0.03), vec3(0.34, 0.37, 0.36),
          smoothstep(-0.2, 0.95, R.y));
        float metalFilm = pow(fres, 0.72) * (0.1 + 0.1 * uActivity + 0.07 * uBeat)
          * (0.68 + 0.32 * coarseMatter);
        col += metalEnv * metalFilm;

        // inner luminous core — reads through the body like subsurface glow
        float core = uCorePulse * (0.6 + 0.4 * sin(uTime * 2.2));
        col += uCore * core * pow(ndv, 2.4) * 0.88;

        // A shared double beat gives the tissue a readable vital rhythm. It is
        // strongest in active matter, with a short peak instead of a constant neon wash.
        float beat = uBeat;
        col += uCore * beat * (0.08 + 0.16 * uCorePulse) * pow(ndv, 1.8);
        col += uHighlight * beat * fres * (0.08 + 0.12 * uActivity);

        // Each soma is one agent. Context-window load changes the emitted
        // light, while the underlying liquid body keeps its original shape.
        float statusRim = pow(fres, 1.8) * (0.52 + 0.42 * uStatusGlow);
        col += uStatusColor * (statusRim + pow(ndv, 2.8) * uStatusGlow * 0.16);

        // faint darker streaks drifting across the surface (viscous matter)
        float streak = flowField(vPosL * 2.6, uTime) * 0.5 + 0.5;
        col *= 0.86 + 0.18 * streak;

        // tight specular hotspot (now slides, because N carries the flow tilt)
        vec3 H = normalize(L1 + V);
        float spec = pow(clamp(dot(N, H), 0.0, 1.0), 28.0) * 0.2;
        col += uHighlight * spec;

        // broad wet sheen — the second, softer lobe that makes a surface read
        // as covered in liquid rather than polished
        vec3 H2 = normalize(L1 * 0.35 + V);
        col += uHighlight * pow(clamp(dot(N, H2), 0.0, 1.0), 9.0) * 0.09;

        // meniscus: the stretched bridge between two bodies is thinner, so
        // more light passes through it
        float nd2 = max(dot(N, normalize(uNeckDir)), 0.0);
        col += uHighlight * uNeck * pow(nd2, 2.2) * 0.24;

        // error: restrained orange-red flicker
        col += vec3(1.0, 0.32, 0.08) * uError * (0.35 + 0.35 * sin(uTime * 13.0)) * (0.35 + fres);

        // Focus mode should make unrelated matter recede without turning it
        // into a hard on/off layer. Keep a trace of the tissue silhouette so
        // the user never loses the spatial context.
        col *= mix(1.0, 0.12, uDim);
        float shellAlpha = clamp(0.35 + 0.44 * fres + 0.055 * matter +
          0.07 * (uHover + uSelect), 0.3, 0.88);
        gl_FragColor = vec4(col, shellAlpha * mix(1.0, 0.45, uDim));
      }
    `,
  })
}

/** Additive inner core — separate mesh, visible only when pulsing. */
export function createCoreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColor: { value: new THREE.Color('#FF233C') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPosW = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uColor;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        // brightest at the center of the disc, fading to the limb
        float body = pow(ndv, 1.6);
        float flicker = 0.85 + 0.15 * sin(uTime * 3.1);
        gl_FragColor = vec4(uColor * body * uIntensity * flicker, body * uIntensity);
      }
    `,
  })
}

// One small shared radial texture keeps the status halo cheap across agents.
const STATUS_HALO_SIZE = 64
const statusHaloPixels = new Uint8Array(STATUS_HALO_SIZE * STATUS_HALO_SIZE * 4)
for (let y = 0; y < STATUS_HALO_SIZE; y++) {
  for (let x = 0; x < STATUS_HALO_SIZE; x++) {
    const dx = (x + 0.5 - STATUS_HALO_SIZE / 2) / (STATUS_HALO_SIZE / 2)
    const dy = (y + 0.5 - STATUS_HALO_SIZE / 2) / (STATUS_HALO_SIZE / 2)
    const radius = Math.sqrt(dx * dx + dy * dy)
    const alpha = Math.pow(Math.max(0, 1 - radius), 2.2)
    const i = (y * STATUS_HALO_SIZE + x) * 4
    statusHaloPixels[i] = 255
    statusHaloPixels[i + 1] = 255
    statusHaloPixels[i + 2] = 255
    statusHaloPixels[i + 3] = Math.round(alpha * 255)
  }
}
const statusHaloTexture = new THREE.DataTexture(statusHaloPixels, STATUS_HALO_SIZE, STATUS_HALO_SIZE, THREE.RGBAFormat)
statusHaloTexture.magFilter = THREE.LinearFilter
statusHaloTexture.minFilter = THREE.LinearFilter
statusHaloTexture.needsUpdate = true

export function createStatusHaloMaterial(): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map: statusHaloTexture,
    color: '#58a6ff',
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

/**
 * Liquid synapse (connection) material. Each endpoint receives its agent's
 * current load color and the shaft blends smoothly between the two.
 */
export function createLinkMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uFlow: { value: 0.06 },
      uOffsetA: { value: new THREE.Vector3() },
      uOffsetB: { value: new THREE.Vector3() },
      uSpan: { value: 4 },
      uTubeR: { value: 0.04 },
      uPulsePos: { value: -1 },
      uPulseStrength: { value: 0 },
      uDim: { value: 0 },
      uAlpha: { value: 0.92 },
      uColorA: { value: new THREE.Color('#58a6ff') },
      uColorB: { value: new THREE.Color('#58a6ff') },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uFlow;
      uniform vec3 uOffsetA;
      uniform vec3 uOffsetB;
      uniform float uSpan;
      uniform float uTubeR;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      varying vec2 vUv;

      // Same lattice-free flow field as the somas, so a process and the body
      // it leaves share one fluid language.
      float linkFlow(vec3 p, float t) {
        return sin(p.x * 1.7 + t) * cos(p.y * 1.3 - t * 0.8) * 0.5
             + sin(p.z * 2.1 + t * 0.7) * 0.5;
      }

      void main() {
        vUv = uv;
        // Liquid creep along the process. A dead-straight tube reads as a rigid
        // rod, and straightness is the whole point of the layout now — so the
        // surface itself has to carry the fluid.
        //
        // The amplitude is a fraction of the TUBE RADIUS, never an absolute
        // distance: a fixed offset that looks like a ripple on a 0.09-radius
        // process flattens a 0.04-radius one into a twisted ribbon. It also
        // tapers to zero at both ends so the process plugs cleanly into its
        // somas.
        float endFade = smoothstep(0.0, 0.16, uv.x) * smoothstep(1.0, 0.84, uv.x);
        float creep = linkFlow(position * 1.9, uTime * 0.55) * 0.5 + 0.5;
        float beat = uBeat;
        float amp = uTubeR * 0.3 * endFade * (0.55 + 0.45 * uFlow + beat * 0.28);
        // finite-difference the field ALONG the normal so the wet highlight
        // slides over the ripples instead of sitting flat on a smooth rod
        float d0 = linkFlow(position * 1.9, uTime * 0.55);
        float d1 = linkFlow((position + normal * 0.5 * uTubeR) * 1.9, uTime * 0.55);
        float grad = (d1 - d0) / (0.5 * uTubeR);
        vec3 p = position + normal * ((creep - 0.5) * amp);
        // The semantic tube remains straight, while this small endpoint
        // offset lets the living visual shell drift without rebuilding the
        // tube geometry every frame.
        p += mix(uOffsetA, uOffsetB, uv.x);

        vec4 world = modelMatrix * vec4(p, 1.0);
        vPosW = world.xyz;
        vec3 n = normal - normal * (grad * amp * 0.5);
        vNormalW = normalize(mat3(modelMatrix) * normalize(n));
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uFlow;
      uniform float uSpan;
      uniform float uPulsePos;
      uniform float uPulseStrength;
      uniform float uDim;
      uniform float uAlpha;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      varying vec2 vUv;

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 2.0);

        float along = vUv.x;
        // Hold each node's exact color at its attachment, with a smooth
        // transition only through the middle of the process.
        vec3 bridgeColor = mix(uColorA, uColorB, smoothstep(0.08, 0.92, along));
        float beat = uBeat;
        vec3 L = normalize(vec3(0.5, 0.9, 0.4));
        // terminator along the tube cross-section: lit crest, dark underside —
        // a flat wrap term made the synapses read as painted ribbons
        float ndl = dot(N, L);
        float key = smoothstep(-0.5, 0.85, ndl);

        vec3 col = bridgeColor * (0.18 + key * key * 0.38);
        col *= mix(1.0, 0.42, pow(1.0 - ndv, 3.0));

        vec3 metalR = reflect(-V, N);
        vec3 metalEnv = mix(vec3(0.02, 0.025, 0.025), vec3(0.28, 0.3, 0.29),
          smoothstep(-0.25, 0.9, metalR.y));
        col += metalEnv * pow(fres, 0.8) * (0.045 + 0.07 * uFlow + 0.04 * uBeat);

        // Viscous flow streaks along the tube.
        //
        // The phase is measured in WORLD units, not in the normalised [0,1]
        // tube parameter. With a normalised phase the streak wavelength scales
        // with the edge, so a long process shows a few fat slow bands while a
        // short one shows a dense fast flicker — the tissue stops looking like
        // one fluid. A world phase gives every process the same wavelength and
        // the same linear speed, so the whole network flows as one substance.
        float worldS = along * uSpan;
        float flow = sin(worldS * 3.4 - uTime * (1.9 + uFlow * 2.6)) * 0.5 + 0.5;
        float flow2 = sin(worldS * 7.1 - uTime * (3.1 + uFlow * 4.4)) * 0.5 + 0.5;
        // sharper crests read as travelling packets of fluid rather than a
        // sine wash — the eye latches onto discrete moving features
        flow = pow(flow, 2.2);
        flow2 = pow(flow2, 2.6);
        col += bridgeColor * (flow * 0.72 + flow2 * 0.26) * uFlow * 0.82;

        // A faint travelling wake sits behind the ordinary stream. It is
        // world-unit based like the main flow, so long and short links share
        // the same living wavelength.
        float wakePhase = fract(worldS * 0.14 - uTime * 0.24);
        float wake = exp(-pow((wakePhase - 0.48) / 0.12, 2.0));
        col += bridgeColor * wake * uFlow * (0.035 + beat * 0.13);

        // broad wet sheen
        vec3 H2 = normalize(L * 0.35 + V);
        col += bridgeColor * pow(clamp(dot(N, H2), 0.0, 1.0), 9.0) * 0.08;

        // thin wet rim — the meniscus where liquid meets void
        col += bridgeColor * pow(1.0 - ndv, 3.5) * 0.42;

        // terminal boutons: small bright flares exactly where the process
        // meets a soma. Kept tight so short processes don't glow end-to-end.
        float endGlow = smoothstep(0.032, 0.0, min(along, 1.0 - along));
        col += bridgeColor * endGlow * (0.22 + 0.28 * uFlow);

        // travelling pulse band (return / merge) — width also in world units,
        // so a return reads at the same physical size on every process
        if (uPulseStrength > 0.001) {
          float d = abs(along - uPulsePos);
          d = min(d, 1.0 - d);
          float band = smoothstep(0.55 / max(uSpan, 0.5), 0.0, d);
          col += bridgeColor * band * uPulseStrength * 1.7;
          col += vec3(1.0) * band * uPulseStrength * 0.12;
        }

        col *= mix(1.0, 0.2, uDim);
        float alpha = min(1.0, uAlpha * (1.0 + 0.2 * endGlow)) * mix(1.0, 0.45, uDim);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  })
}
