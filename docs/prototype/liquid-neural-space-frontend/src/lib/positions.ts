import * as THREE from 'three'

/**
 * Frame-shared registries. Written by AgentNode / AgentLink every frame,
 * read by links, necks, pulses and the camera controller.
 * Keeps everything decoupled from React renders.
 */

/** Current animated world position of every living agent. */
export const nodePositions = new Map<string, THREE.Vector3>()

/** Small visual-only drift around the semantic anchor. Links consume this in
 * their vertex shader, so local life does not force tube geometry rebuilds. */
export const visualOffsets = new Map<string, THREE.Vector3>()

/** Transform applied to the shared visual tissue group. Camera focus uses it
 * so a selected soma is centered in the same space the user actually sees. */
export const tissueTransform = {
  position: new THREE.Vector3(),
  scale: 1,
}

/** Curve handle of every rendered link (used by traffic pulses). */
export interface LinkHandle {
  curve: THREE.CatmullRomCurve3 | null
  active: boolean
}
export const linkHandles = new Map<string, LinkHandle>()
