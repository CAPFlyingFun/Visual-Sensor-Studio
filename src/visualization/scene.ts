import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp, type QuaternionLike } from '../core/math.js';
import type { GpsSample } from '../core/types.js';

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

  constructor(private readonly container: HTMLElement, quality: SceneQuality = 'normal') {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080d16);
    this.scene.fog = new THREE.FogExp2(0x080d16, 0.008);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 500);
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

    this.scene.add(new THREE.HemisphereLight(0xa9c8ff, 0x162133, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 9, 4);
    this.scene.add(key);

    const grid = new THREE.GridHelper(100, 50, 0x37506f, 0x182638);
    grid.position.y = -1.1;
    this.scene.add(grid);
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

  resetView(): void {
    this.camera.position.set(7, 6, 9);
    this.controls.target.set(0, 0.8, 0);
    this.controls.update();
  }

  destroy(): void {
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