/**
 * A loaded rig, and the bones you can drive.
 *
 * Kept apart from the recorder so the recorder can be tested without a
 * renderer, and apart from the scene so the scene does not have to know what a
 * take is. This is the only piece that touches three.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { QuaternionLike } from './one-euro.js';

export interface BoneEntry {
  name: string;
  /** Depth in the skeleton, for indenting a list into something readable. */
  depth: number;
  /** Bones with no children — the tips of legs, antennae, mandibles. */
  isTip: boolean;
}

export interface LoadedRig {
  root: any;
  bones: BoneEntry[];
  /** Radius of the model, for framing a camera on it. */
  radius: number;
  /** Names of the animation clips the file already carried, if any. */
  clips: string[];
}

export class RigPuppet {
  private loader = new GLTFLoader();
  private current: LoadedRig | null = null;
  private boneMap = new Map<string, any>();
  /** Each bone's pose as the file authored it, so a take can be undone. */
  private restPose = new Map<string, any>();

  get rig(): LoadedRig | null {
    return this.current;
  }

  /**
   * Load a GLB or glTF from a local file.
   *
   * Read through an object URL rather than uploaded anywhere. The model never
   * leaves the device, which matters because a rig is usually someone's work.
   */
  async load(file: File): Promise<LoadedRig> {
    const url = URL.createObjectURL(file);
    try {
      const gltf = await this.loader.loadAsync(url);
      return this.adopt(gltf.scene, (gltf.animations ?? []).map((clip: any) => clip.name));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private adopt(root: any, clips: string[]): LoadedRig {
    this.dispose();
    this.boneMap.clear();
    this.restPose.clear();

    const bones: BoneEntry[] = [];
    const walk = (object: any, depth: number): void => {
      // Bones proper, plus any named node that has a parent — plenty of rigs
      // animate empties rather than Bone instances, and refusing those would
      // hide half the rig for no reason the user could see.
      const isBone = object.isBone === true;
      if ((isBone || object.type === 'Object3D') && object.name && object.parent) {
        if (!this.boneMap.has(object.name)) {
          this.boneMap.set(object.name, object);
          this.restPose.set(object.name, object.quaternion.clone());
          bones.push({
            name: object.name,
            depth,
            isTip: object.children.filter((child: any) =>
              child.isBone || child.type === 'Object3D').length === 0
          });
        }
      }
      for (const child of object.children) walk(child, depth + 1);
    };
    walk(root, 0);

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);

    this.current = { root, bones, radius: Math.max(0.001, size.length() / 2), clips };
    return this.current;
  }

  /** Apply a rotation to one bone, relative to how the file authored it. */
  setBoneRotation(name: string, rotation: QuaternionLike): void {
    const bone = this.boneMap.get(name);
    const rest = this.restPose.get(name);
    if (!bone || !rest) return;
    // Composed onto the rest pose rather than replacing it. Replacing throws
    // away the rig's own construction, and a leg authored at 40 degrees snaps
    // straight the instant it is touched.
    bone.quaternion.copy(rest).multiply(
      new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    );
  }

  /** Put one bone, or every bone, back the way the file had it. */
  resetBone(name?: string): void {
    if (name) {
      const bone = this.boneMap.get(name);
      const rest = this.restPose.get(name);
      if (bone && rest) bone.quaternion.copy(rest);
      return;
    }
    for (const [boneName, rest] of this.restPose) {
      this.boneMap.get(boneName)?.quaternion.copy(rest);
    }
  }

  has(name: string): boolean {
    return this.boneMap.has(name);
  }

  dispose(): void {
    const root = this.current?.root;
    this.current = null;
    if (!root) return;
    root.traverse((object: any) => {
      object.geometry?.dispose?.();
      const material = object.material;
      if (Array.isArray(material)) for (const m of material) m.dispose?.();
      else material?.dispose?.();
    });
    root.parent?.remove(root);
  }
}

/**
 * Guess which bones are legs, and in which order.
 *
 * A gait needs to know left from right and front from back, and rig naming is
 * a free-for-all. This reads the common conventions and is offered as a
 * SUGGESTION the user can correct — getting it wrong should cost a tap, not
 * produce an ant that walks sideways with nothing to explain why.
 */
export function guessLegOrder(bones: readonly BoneEntry[]): string[] {
  const candidates = bones.filter((bone) => /leg|limb/i.test(bone.name));
  if (candidates.length < 6) return [];

  const side = (name: string): number => {
    if (/[._-]?l(eft)?[._\d-]|^l\d|left/i.test(name)) return 0;
    if (/[._-]?r(ight)?[._\d-]|^r\d|right/i.test(name)) return 1;
    return 2;
  };
  const index = (name: string): number => {
    const match = name.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  };

  // Roots only: a leg chain has several bones and the gait drives the hip.
  const roots = candidates.filter((bone) =>
    !candidates.some((other) => other !== bone && bone.name.startsWith(other.name)));
  const source = roots.length >= 6 ? roots : candidates;

  return [...source]
    .sort((a, b) => side(a.name) - side(b.name) || index(a.name) - index(b.name))
    .slice(0, 6)
    .map((bone) => bone.name);
}
