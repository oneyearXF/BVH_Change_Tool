/**
 * Main Application Controller
 *
 * Wires together the BVH parser, 3D skeleton viewer, timeline editor,
 * and UI controls into a cohesive BVH editing tool.
 */

import { parseBVH, exportBVH, computeJointPositions, computeMotionIntensity } from './bvh-parser.js';
import { SkeletonViewer } from './skeleton-viewer.js';
import { Timeline } from './timeline.js';

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);

const dom = {
    // Toolbar
    btnImport: $('#btn-import'),
    btnExport: $('#btn-export'),
    btnExportFull: $('#btn-export-full'),
    btnResetCamera: $('#btn-reset-camera'),
    chkShowGround: $('#chk-show-ground'),
    chkShowTrail: $('#chk-show-trail'),
    selectSpeed: $('#select-speed'),
    infoFrame: $('#info-frame'),
    infoTime: $('#info-time'),
    infoDuration: $('#info-duration'),

    // Viewport
    viewportContainer: $('#viewport-container'),
    dropOverlay: $('#drop-overlay'),
    loadingOverlay: $('#loading-overlay'),

    // Sidebar
    jointTree: $('#joint-tree'),
    motionInfo: $('#motion-info'),

    // Timeline
    timelineCanvas: $('#timeline-canvas'),

    // Playback
    btnSkipStart: $('#btn-skip-start'),
    btnStepPrev: $('#btn-step-prev'),
    btnPlay: $('#btn-play'),
    btnStepNext: $('#btn-step-next'),
    btnSkipEnd: $('#btn-skip-end'),
    btnLoop: $('#btn-loop'),
    btnSetIn: $('#btn-set-in'),
    btnSetOut: $('#btn-set-out'),
    btnClearTrim: $('#btn-clear-trim'),
    trimRangeText: $('#trim-range-text'),
    statusText: $('#status-text'),

    // File input
    fileInput: $('#file-input'),
};

// ---- State ----
let bvhData = null;           // Parsed BVH
let currentFrame = 0;
let isPlaying = false;
let loopMode = false;
let inPoint = 0;
let outPoint = 0;  // will be set after load
let animationId = null;
let lastTime = 0;

// ---- Initialize Components ----
const viewer = new SkeletonViewer(dom.viewportContainer);
const timeline = new Timeline(dom.timelineCanvas);

// ---- Setup Callbacks ----

// Viewer frame change callback
viewer.onFrameChange = (frame) => {
    currentFrame = frame;
    timeline.setCurrentFrame(frame);
    updateInfoDisplay();
};

// Timeline callbacks
timeline.onSeek = (frame) => {
    currentFrame = frame;
    viewer.seekTo(frame);
    updateInfoDisplay();
};

timeline.onTrimChange = (inP, outP) => {
    inPoint = inP;
    outPoint = outP;
    updateTrimDisplay();
};

// ---- File Loading ----

async function loadBVHFile(file) {
    showLoading(true);
    setStatus('加载中...');

    try {
        const text = await readFileAsText(file);
        bvhData = parseBVH(text);

        // Set default trim range
        inPoint = 0;
        outPoint = bvhData.motion.frames;

        // Compute motion intensity for waveform
        setStatus('计算运动波形...');
        const intensity = await computeIntensityAsync(bvhData);

        // Update viewer
        viewer.loadBVH(bvhData);
        viewer.seekTo(0);

        // Update timeline
        timeline.setData(bvhData.motion.frames, bvhData.motion.frameTime, intensity);
        timeline.setTrimRange(inPoint, outPoint);

        // Update UI
        currentFrame = 0;
        updateInfoDisplay();
        updateJointTree();
        updateMotionInfo();
        updateTrimDisplay();
        enableControls(true);

        const fileName = file.name || 'unknown.bvh';
        setStatus(`已加载: ${fileName} (${bvhData.motion.frames} 帧, ${bvhData.jointNames.length} 关节)`);
    } catch (err) {
        console.error('BVH parse error:', err);
        setStatus(`❌ 解析失败: ${err.message}`);
        showToast('解析失败: ' + err.message);
    } finally {
        showLoading(false);
    }
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsText(file);
    });
}

function computeIntensityAsync(bvh) {
    return new Promise((resolve) => {
        // Use setTimeout to avoid blocking the UI
        setTimeout(() => {
            resolve(computeMotionIntensity(bvh));
        }, 50);
    });
}

// ---- UI Updates ----

function updateInfoDisplay() {
    if (!bvhData) {
        dom.infoFrame.textContent = '帧: -/-';
        dom.infoTime.textContent = '时间: -';
        dom.infoDuration.textContent = '总长: -';
        return;
    }

    const total = bvhData.motion.frames;
    const time = currentFrame * bvhData.motion.frameTime;
    const duration = bvhData.duration;

    dom.infoFrame.textContent = `帧: ${currentFrame}/${total}`;
    dom.infoTime.textContent = `时间: ${formatTime(time)}`;
    dom.infoDuration.textContent = `总长: ${formatTime(duration)}`;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2);
    return `${m}:${s.padStart(5, '0')}`;
}

function updateTrimDisplay() {
    if (!bvhData) {
        dom.trimRangeText.textContent = '';
        return;
    }

    const total = bvhData.motion.frames;
    if (inPoint <= 0 && outPoint >= total) {
        dom.trimRangeText.textContent = '全部帧';
    } else {
        const count = outPoint - inPoint;
        dom.trimRangeText.textContent = `裁剪: [${inPoint} → ${outPoint}] ${count}帧`;
    }
}

function updateJointTree() {
    if (!bvhData) return;

    const { jointNames, jointParents, jointIsEndSite } = bvhData;

    // Build indentation
    const depth = new Array(jointNames.length).fill(0);
    for (let i = 1; i < jointNames.length; i++) {
        depth[i] = depth[jointParents[i]] + 1;
    }

    let html = '';
    for (let i = 0; i < jointNames.length; i++) {
        const indent = '  '.repeat(depth[i]);
        const isRoot = jointParents[i] < 0;
        const isEnd = jointIsEndSite[i];
        let icon = '🦴';
        let cls = 'joint';
        if (isRoot) { icon = '⭐'; cls = 'root'; }
        if (isEnd) { icon = '•'; cls = 'end'; }

        html += `<div class="joint-node ${cls}" data-joint="${i}" title="${jointNames[i]}">
            <span class="indent">${indent}</span>
            <span class="joint-icon">${icon}</span>${jointNames[i]}
        </div>`;
    }

    dom.jointTree.innerHTML = html;

    // Click handler: highlight joint in 3D view
    dom.jointTree.querySelectorAll('.joint-node').forEach(el => {
        el.addEventListener('click', () => {
            dom.jointTree.querySelectorAll('.joint-node').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            // TODO: highlight joint in 3D viewer
        });
    });
}

function updateMotionInfo() {
    if (!bvhData) return;

    const fps = (1 / bvhData.motion.frameTime).toFixed(1);
    const duration = formatTime(bvhData.duration);

    dom.motionInfo.innerHTML = `
        <div class="info-row"><span class="info-label">帧数</span><span class="info-value">${bvhData.motion.frames}</span></div>
        <div class="info-row"><span class="info-label">帧率</span><span class="info-value">${fps} fps</span></div>
        <div class="info-row"><span class="info-label">时长</span><span class="info-value">${duration}</span></div>
        <div class="info-row"><span class="info-label">关节数</span><span class="info-value">${bvhData.jointNames.length}</span></div>
        <div class="info-row"><span class="info-label">通道数</span><span class="info-value">${bvhData.totalChannels}</span></div>
    `;
}

function enableControls(enabled) {
    const btns = [
        dom.btnExport, dom.btnExportFull, dom.btnResetCamera,
        dom.btnSkipStart, dom.btnStepPrev, dom.btnPlay,
        dom.btnStepNext, dom.btnSkipEnd,
        dom.btnSetIn, dom.btnSetOut, dom.btnClearTrim,
    ];
    btns.forEach(b => b.disabled = !enabled);
}

function setStatus(msg) {
    dom.statusText.textContent = msg;
    console.log('[BVH Clip]', msg);
}

// ---- Playback ----

function togglePlay() {
    if (!bvhData) return;

    if (isPlaying) {
        pause();
    } else {
        play();
    }
}

function play() {
    if (!bvhData || isPlaying) return;
    isPlaying = true;
    viewer.play();
    dom.btnPlay.textContent = '⏸';
    dom.btnPlay.classList.add('active');
    lastTime = performance.now();
    setStatus('▶ 播放中...');
}

function pause() {
    isPlaying = false;
    viewer.pause();
    dom.btnPlay.textContent = '▶';
    dom.btnPlay.classList.remove('active');
    setStatus('⏸ 已暂停');
}

/**
 * Continuous render loop — always runs so OrbitControls work.
 * Frame advancement only happens when isPlaying is true.
 */
function renderLoop(timestamp) {
    animationId = requestAnimationFrame(renderLoop);

    const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;

    if (isPlaying && bvhData) {
        // Animate skeleton (advances frame if enough time has passed)
        viewer.animate(deltaTime);

        // Sync with viewer's current frame
        if (viewer.currentFrame !== currentFrame) {
            currentFrame = viewer.currentFrame;
            timeline.setCurrentFrame(currentFrame);
            updateInfoDisplay();

            const totalFrames = bvhData.motion.frames;

            // Check if we hit the out point
            if (outPoint < totalFrames && currentFrame >= outPoint) {
                if (loopMode) {
                    viewer.seekTo(inPoint);
                    currentFrame = inPoint;
                    timeline.setCurrentFrame(currentFrame);
                } else {
                    pause();
                }
            }

            // Check if we hit end of data
            if (currentFrame >= totalFrames - 1) {
                if (loopMode) {
                    viewer.seekTo(inPoint);
                    currentFrame = inPoint;
                    timeline.setCurrentFrame(currentFrame);
                } else {
                    pause();
                }
            }
        }
    }

    // Always render the 3D view so OrbitControls work
    viewer.render();
}

function stepFrame(delta) {
    if (!bvhData) return;
    let newFrame = currentFrame + delta;
    newFrame = Math.max(0, Math.min(newFrame, bvhData.motion.frames - 1));
    currentFrame = newFrame;
    viewer.seekTo(currentFrame);
    timeline.setCurrentFrame(currentFrame);
    updateInfoDisplay();
}

function skipToStart() {
    if (!bvhData) return;
    currentFrame = inPoint;
    viewer.seekTo(currentFrame);
    timeline.setCurrentFrame(currentFrame);
    updateInfoDisplay();
}

function skipToEnd() {
    if (!bvhData) return;
    currentFrame = Math.max(0, outPoint - 1);
    viewer.seekTo(currentFrame);
    timeline.setCurrentFrame(currentFrame);
    updateInfoDisplay();
}

// ---- Export ----

function exportTrimmed() {
    if (!bvhData) return;

    const actualOut = Math.min(outPoint, bvhData.motion.frames);
    if (inPoint === 0 && actualOut >= bvhData.motion.frames) {
        showToast('未设置裁剪范围，将导出全部帧');
    }

    const bvhText = exportBVH(bvhData, inPoint, actualOut - 1);
    downloadFile(bvhText, getExportFileName('_cut'));
    showToast(`已导出 ${actualOut - inPoint} 帧`);
    setStatus(`已导出裁剪后的 BVH (${actualOut - inPoint} 帧)`);
}

function exportFull() {
    if (!bvhData) return;

    const bvhText = exportBVH(bvhData, 0, bvhData.motion.frames - 1);
    downloadFile(bvhText, getExportFileName('_full'));
    showToast(`已导出全部 ${bvhData.motion.frames} 帧`);
    setStatus(`已导出完整 BVH (${bvhData.motion.frames} 帧)`);
}

function getExportFileName(suffix) {
    const base = 'exported';
    return `${base}${suffix}.bvh`;
}

function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ---- UI Helpers ----

function showLoading(show) {
    dom.loadingOverlay.classList.toggle('hidden', !show);
}

function showToast(message, duration = 2500) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// ---- Event Bindings ----

// File import
dom.btnImport.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadBVHFile(file);
});

// Drag and drop on viewport
const viewportContainer = document.getElementById('viewport-container');
viewportContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dom.dropOverlay.classList.remove('hidden');
});
viewportContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!viewportContainer.contains(e.relatedTarget)) {
        dom.dropOverlay.classList.add('hidden');
    }
});
viewportContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dom.dropOverlay.classList.add('hidden');
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.bvh') || file.type === 'application/octet-stream')) {
        loadBVHFile(file);
    }
});

// Drag and drop on whole document (for convenience)
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!viewportContainer.contains(e.target)) {
        dom.dropOverlay.classList.remove('hidden');
    }
});
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropOverlay.classList.add('hidden');
    // Only handle if not already handled by viewport
    if (!viewportContainer.contains(e.target)) {
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.bvh')) {
            loadBVHFile(file);
        }
    }
});

// Export
dom.btnExport.addEventListener('click', exportTrimmed);
dom.btnExportFull.addEventListener('click', exportFull);

// Camera reset
dom.btnResetCamera.addEventListener('click', () => viewer.resetCamera());

// Show ground toggle
dom.chkShowGround.addEventListener('change', () => {
    viewer.setShowGround(dom.chkShowGround.checked);
});
dom.chkShowTrail.addEventListener('change', () => {
    viewer.setShowTrail(dom.chkShowTrail.checked);
});

// Speed
dom.selectSpeed.addEventListener('change', () => {
    const speed = parseFloat(dom.selectSpeed.value);
    viewer.setSpeed(speed);
});

// Playback controls
dom.btnPlay.addEventListener('click', togglePlay);
dom.btnStepPrev.addEventListener('click', () => stepFrame(-1));
dom.btnStepNext.addEventListener('click', () => stepFrame(1));
dom.btnSkipStart.addEventListener('click', skipToStart);
dom.btnSkipEnd.addEventListener('click', skipToEnd);

// Loop toggle
dom.btnLoop.addEventListener('click', () => {
    loopMode = !loopMode;
    viewer.setLoop(loopMode);
    if (loopMode) {
        dom.btnLoop.classList.add('active');
        setStatus('🔁 循环播放: 开');
    } else {
        dom.btnLoop.classList.remove('active');
        setStatus('🔁 循环播放: 关');
    }
});

// Trim controls
dom.btnSetIn.addEventListener('click', () => {
    if (!bvhData) return;
    inPoint = currentFrame;
    if (inPoint >= outPoint) outPoint = Math.min(inPoint + 1, bvhData.motion.frames);
    timeline.setTrimRange(inPoint, outPoint);
    updateTrimDisplay();
    showToast(`入点已设置: 帧 ${inPoint}`);
});
dom.btnSetOut.addEventListener('click', () => {
    if (!bvhData) return;
    outPoint = currentFrame;
    if (outPoint <= inPoint) inPoint = Math.max(0, outPoint - 1);
    timeline.setTrimRange(inPoint, outPoint);
    updateTrimDisplay();
    showToast(`出点已设置: 帧 ${outPoint}`);
});
dom.btnClearTrim.addEventListener('click', () => {
    if (!bvhData) return;
    inPoint = 0;
    outPoint = bvhData.motion.frames;
    timeline.clearTrim();
    updateTrimDisplay();
    showToast('裁剪范围已清除');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Don't capture when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            stepFrame(e.shiftKey ? -10 : -1);
            break;
        case 'ArrowRight':
            e.preventDefault();
            stepFrame(e.shiftKey ? 10 : 1);
            break;
        case 'KeyI':
            e.preventDefault();
            dom.btnSetIn.click();
            break;
        case 'KeyO':
            e.preventDefault();
            dom.btnSetOut.click();
            break;
        case 'Home':
            e.preventDefault();
            skipToStart();
            break;
        case 'End':
            e.preventDefault();
            skipToEnd();
            break;
        case 'KeyL':
            if (!e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                dom.btnLoop.click();
            }
            break;
        case 'KeyF':
            if (!e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                viewer.resetCamera();
            }
            break;
        case 'Escape':
            if (isPlaying) pause();
            break;
    }
});

// Window resize
window.addEventListener('resize', () => {
    viewer.resize();
    timeline.resize();
});

// ---- Initialization ----

function init() {
    viewer.resize();
    timeline.resize();
    // Start continuous render loop so OrbitControls always work
    lastTime = performance.now();
    animationId = requestAnimationFrame(renderLoop);
    setStatus('拖放 BVH 文件到窗口或点击"导入"按钮开始');
    showToast('🎬 拖放 BVH 文件开始编辑', 3000);
}

// Run
init();
