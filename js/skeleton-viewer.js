/**
 * 3D Skeleton Viewer — Three.js based BVH skeleton renderer
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeJointPositions } from './bvh-parser.js';

export class SkeletonViewer {
    constructor(container) {
        // container is the DOM element to put the canvas into
        this.container = container;
        this.bvh = null;
        this.currentFrame = 0;
        this.isPlaying = false;
        this.playSpeed = 1;
        this.loop = false;
        this.showGround = true;
        this.showTrail = false;
        this.skeletonScale = 1;
        this._accumulator = 0;
        this.onFrameChange = null;

        this._init();
    }

    _init() {
        const w = this.container.clientWidth || 800;
        const h = this.container.clientHeight || 600;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h);
        this.renderer.setClearColor(0x1a2540);
        this.container.appendChild(this.renderer.domElement);

        // Scene
        this.scene = new THREE.Scene();

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, w / Math.max(h, 1), 0.01, 200);
        this.camera.position.set(2, 1.5, 4);
        this.camera.lookAt(0, 0.9, 0);

        // Lights
        this.scene.add(new THREE.AmbientLight(0x606080, 3));
        const key = new THREE.DirectionalLight(0xffffff, 3);
        key.position.set(5, 8, 5);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0x8ab4f8, 1.5);
        fill.position.set(-3, 2, -2);
        this.scene.add(fill);

        // Ground grid
        this.groundGroup = new THREE.Group();
        this.groundGroup.add(new THREE.GridHelper(6, 20, 0x4a6070, 0x2a3a4a));
        this.scene.add(this.groundGroup);

        // Axes (small reference)
        this.scene.add(new THREE.AxesHelper(0.5));

        // Bone container
        this.boneGroup = new THREE.Group();
        this.scene.add(this.boneGroup);
        this.boneLines = [];
        this.jointSpheres = [];
        this.trailLine = null;

        // OrbitControls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0.9, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.minDistance = 0.3;
        this.controls.maxDistance = 20;
        this.controls.update();

        // Handle resize
        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.container);

        console.log('[SkeletonViewer] initialized', { w, h, container: this.container });
    }

    loadBVH(bvh) {
        this.bvh = bvh;
        this.currentFrame = 0;
        this._clearSkeleton();
        this._buildSkeleton();
        this._autoScale();
        this._updateSkeleton(0);
        this._resetCamera();
    }

    _clearSkeleton() {
        for (const obj of [...this.boneGroup.children]) {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        }
        this.boneGroup.clear();
        this.boneLines = [];
        this.jointSpheres = [];
        if (this.trailLine) {
            this.trailLine.geometry.dispose();
            this.trailLine.material.dispose();
            this.scene.remove(this.trailLine);
            this.trailLine = null;
        }
    }

    _buildSkeleton() {
        const { jointNames, jointParents, jointOffsets, jointIsEndSite } = this.bvh;
        const n = jointNames.length;

        const boneMat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.5, metalness: 0.1 });
        const rootMat = new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.4, metalness: 0.2, emissive: 0x331100, emissiveIntensity: 0.4 });
        const endMat = new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 0.6, metalness: 0 });

        for (let i = 0; i < n; i++) {
            const isRoot = jointParents[i] < 0;
            const isEnd = jointIsEndSite[i];
            const r = isRoot ? 0.04 : (isEnd ? 0.012 : 0.022);
            const mat = isRoot ? rootMat : (isEnd ? endMat : boneMat);

            const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat.clone());
            sphere.userData = { jointIndex: i, name: jointNames[i] };
            this.boneGroup.add(sphere);
            this.jointSpheres.push(sphere);

            // Bone cylinder (skip end sites and roots)
            if (!isRoot && !isEnd) {
                const off = jointOffsets[i];
                const len = Math.sqrt(off[0]*off[0] + off[1]*off[1] + off[2]*off[2]) || 0.001;
                const cyl = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.01, 0.01, 1, 8, 1),
                    boneMat.clone()
                );
                cyl.userData = { jointIndex: i, boneLen: len };
                this.boneGroup.add(cyl);
                this.boneLines.push(cyl);
            }
        }
    }

    _autoScale() {
        if (!this.bvh) return;
        const pos = computeJointPositions(this.bvh, 0);
        let maxY = 0, maxE = 0;
        for (const p of pos) {
            if (p[1] > maxY) maxY = p[1];
            const e = Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]);
            if (e > maxE) maxE = e;
        }
        const h = maxY > 0 ? maxY : maxE / 3;
        this.skeletonScale = h > 0 ? 2 / h : 1;
    }

    _updateSkeleton(frameIndex) {
        if (!this.bvh) return;
        this.currentFrame = frameIndex;
        const positions = computeJointPositions(this.bvh, frameIndex);
        const { jointParents } = this.bvh;
        const s = this.skeletonScale;

        // Joint spheres
        for (let i = 0; i < this.jointSpheres.length; i++) {
            const p = positions[i];
            this.jointSpheres[i].position.set(p[0] * s, p[1] * s, p[2] * s);
            this.jointSpheres[i].visible = (i < positions.length);
        }

        // Bone cylinders
        for (const cyl of this.boneLines) {
            const i = cyl.userData.jointIndex;
            const parentIdx = jointParents[i];
            const pp = positions[parentIdx];
            const cp = positions[i];
            const mx = (pp[0] + cp[0]) / 2 * s;
            const my = (pp[1] + cp[1]) / 2 * s;
            const mz = (pp[2] + cp[2]) / 2 * s;
            const dx = (cp[0] - pp[0]) * s;
            const dy = (cp[1] - pp[1]) * s;
            const dz = (cp[2] - pp[2]) * s;
            const len = Math.sqrt(dx*dx + dy*dy + dz*dz);

            cyl.position.set(mx, my, mz);
            if (len > 0.0001) {
                const dir = new THREE.Vector3(dx, dy, dz).normalize();
                const up = new THREE.Vector3(0, 1, 0);
                cyl.quaternion.setFromUnitVectors(up, dir);
            }
            cyl.scale.set(1, Math.max(len, 0.001), 1);
        }
    }

    _resetCamera() {
        this.camera.position.set(2, 1.5, 4);
        this.controls.target.set(0, 0.9, 0);
        this.controls.update();
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    render() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    animate(deltaTime) {
        if (!this.isPlaying || !this.bvh) return false;
        const fps = 1 / this.bvh.motion.frameTime;
        this._accumulator += fps * deltaTime * this.playSpeed;

        let changed = false;
        while (this._accumulator >= 1) {
            this._accumulator -= 1;
            this.currentFrame++;
            if (this.currentFrame >= this.bvh.motion.frames) {
                this.currentFrame = this.loop ? 0 : this.bvh.motion.frames - 1;
                if (!this.loop) this.isPlaying = false;
            }
            changed = true;
        }

        if (changed) {
            this._updateSkeleton(this.currentFrame);
            if (this.onFrameChange) this.onFrameChange(this.currentFrame);
        }
        return changed;
    }

    play() { this.isPlaying = true; this._accumulator = 0; }
    pause() { this.isPlaying = false; }
    togglePlay() { if (this.isPlaying) this.pause(); else this.play(); return this.isPlaying; }

    seekTo(frame) {
        if (!this.bvh) return;
        this.currentFrame = Math.max(0, Math.min(frame, this.bvh.motion.frames - 1));
        this._accumulator = 0;
        this._updateSkeleton(this.currentFrame);
    }

    resetCamera() { this._resetCamera(); }
    setShowGround(v) { this.groundGroup.visible = v; }
    setShowTrail(v) { this.showTrail = v; }
    setSpeed(v) { this.playSpeed = v; }
    setLoop(v) { this.loop = v; }
}
