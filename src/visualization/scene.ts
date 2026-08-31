import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp, type QuaternionLike } from '../core/math.js';
import type { GpsSample } from '../core/types.js';
import type { TerrainMesh } from '../terrain/mesh.js';

export type SceneQuality = 'low' | 'normal' | 'high';

export class FusionScene {
  private readonly scene: any;
  private readonly renderer: any;
  private readonly camera: any;
  private readonly controls: any;
  private readonly phoneGroup: any;
  private readonly accelerationArrow: any;
  private readonly gpsLine: any;
  private readonly gpsMarkers: any;
  private readonly resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private terrain: any = null;
  private terrainWire: any = null;
  private beacon: any = null;
  private rig: any = null;
  private readonly phoneBaseScale = 1;
  private readonly grid: any;
  private readonly defaultFogDensity = 0.008;

  constructor(private readonly container: HTMLElement, quality: SceneQuality = 'normal') {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080d16);
    this.scene.fog = new THREE.FogExp2(0x080d16, 0.008);

    // The far plane has to clear a two-mile terrain, which is thousands of
    // metres across in the same units the GPS track is measured in.
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 40000);
    this.camera.position.set(7, 6, 9);

    this.renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', alpha: false, powerPreference: 'high-performance' });
    this.setQuality(quality);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 80;
    this.controls.zoomSpeed = 1.1;

    this.scene.add(new THREE.HemisphereLight(0xa9c8ff, 0x162133, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 9, 4);
    this.scene.add(key);

    this.grid = new THREE.GridHelper(100, 50, 0x37506f, 0x182638);
    this.grid.position.y = -1.1;
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(2));

    this.phoneGroup = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 2.7, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x263849, metalness: 0.45, roughness: 0.42 })
    );
    this.phoneGroup.add(body);

    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.18, 2.45),
      new THREE.MeshStandardMaterial({ color: 0x183f5d, emissive: 0x0b2435, emissiveIntensity: 0.7 })
    );
    screen.position.z = 0.095;
    this.phoneGroup.add(screen);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.06, 24),
      new THREE.MeshStandardMaterial({ color: 0x070a0e, metalness: 0.6, roughness: 0.2 })
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(-0.42, 0.95, -0.12);
    this.phoneGroup.add(lens);

    const forward = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0), 2.1, 0x6fc4ff, 0.35, 0.18);
    this.phoneGroup.add(forward);
    this.phoneGroup.position.y = 0.6;
    this.scene.add(this.phoneGroup);

    this.accelerationArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -0.95, 0),
      0.01,
      0xffbd66,
      0.25,
      0.12
    );
    this.scene.add(this.accelerationArrow);

    this.gpsLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x6be6a7 }));
    this.scene.add(this.gpsLine);

    this.gpsMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xb4ffd8, size: 0.22, sizeAttenuation: true })
    );
    this.scene.add(this.gpsMarkers);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate();
  }

  /** A constructed scene is by definition available; the fallback is not. */
  readonly available = true;

  setQuality(quality: SceneQuality): void {
    const deviceRatio = window.devicePixelRatio || 1;
    const ratio = quality === 'low' ? 1 : quality === 'high' ? Math.min(deviceRatio, 2.5) : Math.min(deviceRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.resize();
  }

  setOrientation(quaternion: QuaternionLike): void {
    this.phoneGroup.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  setAcceleration(vector: { x: number; y: number; z: number }): void {
    const direction = new THREE.Vector3(vector.x, vector.z, -vector.y);
    const magnitude = direction.length();
    if (magnitude < 0.05) {
      this.accelerationArrow.setLength(0.01);
      return;
    }
    direction.normalize();
    this.accelerationArrow.setDirection(direction);
    this.accelerationArrow.setLength(clamp((magnitude / 9.81) * 2, 0.15, 3.5), 0.25, 0.12);
  }

  setGpsTrack(track: readonly GpsSample[]): void {
    const points = track.map((sample) => new THREE.Vector3(sample.local.x, sample.local.y - 1, sample.local.z));
    this.gpsLine.geometry.dispose();
    this.gpsLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.gpsMarkers.geometry.dispose();
    this.gpsMarkers.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  /**
   * Put a real hillside under the track.
   *
   * The mesh arrives already in local ENU metres, so nothing here transforms
   * it — the alignment is guaranteed by both having gone through the same
   * projection rather than by a scale factor kept in step by hand.
   */
  setTerrain(mesh: TerrainMesh | null): void {
    this.clearTerrain();
    if (!mesh || mesh.indices.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();

    this.terrain = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
        // Both faces, so looking up from under a ridge shows ground rather
        // than an invisible surface with the sky behind it.
        side: THREE.DoubleSide,
        flatShading: false
      })
    );
    this.scene.add(this.terrain);

    this.terrainWire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.06 })
    );
    this.scene.add(this.terrainWire);

    // The 100-metre helper grid is meaningless beside kilometres of ground,
    // and exponential fog tuned for a desk scene renders terrain solid black.
    this.grid.visible = false;
    // Exponential fog squares its argument, so a density that reads as gentle
    // at desk range turns kilometres of ground almost black. Tuned so the far
    // edge of the loaded area keeps most of its colour rather than being an
    // atmospheric effect applied to the whole scene.
    this.scene.fog = new THREE.FogExp2(0x080d16, 0.5 / Math.max(1, mesh.spanMetres));

    // The phone model is about 2.7 units tall, which against kilometres of
    // ground is a single pixel — the whole point of the view is seeing where
    // you are ON the terrain, so the marker is scaled to stay visible. It was
    // never to scale (a 2.7 m phone), and at terrain range it is a pin rather
    // than a model.
    const markerScale = Math.max(1, mesh.spanMetres / 900);
    this.phoneGroup.scale.setScalar(markerScale);
    this.phoneGroup.position.y = markerScale * 0.6;
    this.gpsMarkers.material.size = Math.max(0.22, mesh.spanMetres / 900);

    // A vertical line, because a pin on a hillside is much easier to find than
    // an object sitting in it.
    const reach = mesh.spanMetres * 0.06;
    this.beacon = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -reach * 0.35, 0),
        new THREE.Vector3(0, reach, 0)
      ]),
      // Excluded from fog: a position marker that fades with distance is
      // hardest to see exactly when it is most needed.
      new THREE.LineBasicMaterial({ color: 0xff3b6b, transparent: true, opacity: 0.9, fog: false })
    );
    this.scene.add(this.beacon);

    this.frameTerrain(mesh.spanMetres);
  }

  /**
   * Show a loaded rig, framed and lit.
   *
   * Scaled to a consistent on-screen size rather than shown at its authored
   * scale: a glTF may be in metres, centimetres or arbitrary units, and a rig
   * that arrives as a speck or fills the sky is indistinguishable from one that
   * failed to load.
   */
  setRig(root: any, radius: number): void {
    this.clearRig();
    if (!root) return;
    const scale = 2.2 / Math.max(0.001, radius);
    root.scale.setScalar(scale);
    root.position.set(0, 0, 0);
    this.rig = root;
    this.scene.add(root);
    this.phoneGroup.visible = false;
    this.camera.position.set(4.5, 3.2, 5.5);
    this.controls.target.set(0, 1, 0);
    this.controls.minDistance = 1;
    this.controls.maxDistance = 40;
    this.controls.update();
  }

  clearRig(): void {
    if (this.rig) this.scene.remove(this.rig);
    this.rig = null;
    this.phoneGroup.visible = true;
  }

  clearTerrain(): void {
    for (const object of [this.terrain, this.terrainWire, this.beacon]) {
      if (!object) continue;
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    this.terrain = null;
    this.terrainWire = null;
    this.beacon = null;
    this.grid.visible = true;
    // Back to desk scale, or the phone stays the size of a mountain.
    this.phoneGroup.scale.setScalar(this.phoneBaseScale);
    this.phoneGroup.position.y = 0.6;
    this.gpsMarkers.material.size = 0.22;
    this.scene.fog = new THREE.FogExp2(0x080d16, this.defaultFogDensity);
    this.controls.maxDistance = 80;
  }

  /** Pull the camera back far enough to see the whole loaded area. */
  frameTerrain(spanMetres: number): void {
    const span = Math.max(50, spanMetres);
    this.controls.maxDistance = span * 2.5;
    this.controls.minDistance = 2;
    this.camera.position.set(span * 0.45, span * 0.35, span * 0.55);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  get hasTerrain(): boolean {
    return this.terrain !== null;
  }

  resetView(): void {
    if (this.terrain) {
      this.frameTerrain(this.terrain.geometry.boundingSphere?.radius * 2 || 2000);
      return;
    }
    this.camera.position.set(7, 6, 9);
    this.controls.target.set(0, 0.8, 0);
    this.controls.update();
  }

  destroy(): void {
    this.clearRig();
    this.clearTerrain();
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(280, this.container.clientWidth);
    const height = Math.max(260, this.container.clientHeight || 360);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private readonly animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}