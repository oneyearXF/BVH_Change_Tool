/**
 * Timeline Editor (Canvas-based)
 *
 * Renders a video-editor-style timeline with:
 * - Time ruler with frame numbers and timecodes
 * - Motion intensity waveform
 * - Playhead (draggable red line)
 * - In/Out trim handles
 * - Selected range highlight
 * - Zoom (mouse wheel) and pan (middle-button drag)
 */

export class Timeline {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // State
        this.totalFrames = 0;
        this.frameTime = 1/60;
        this.currentFrame = 0;
        this.inPoint = 0;
        this.outPoint = 0;  // 0 = unset (use totalFrames)
        this.pxPerFrame = 1;
        this.scrollOffset = 0;
        this.intensity = null;  // Float32Array of motion intensity per frame

        // Interaction state
        this.dragging = null;       // 'playhead' | 'inpoint' | 'outpoint' | 'pan' | null
        this.hoverTarget = null;    // 'playhead' | 'inpoint' | 'outpoint' | null
        this.panStart = { x: 0, scrollOffset: 0 };
        this.lastMouseX = 0;

        // Callbacks
        this.onSeek = null;         // (frameIndex) => void
        this.onTrimChange = null;   // (inPoint, outPoint) => void

        this.initEvents();
    }

    // ---- Public API ----

    setData(totalFrames, frameTime, intensity) {
        this.totalFrames = totalFrames;
        this.frameTime = frameTime;
        this.intensity = intensity;
        this.outPoint = totalFrames; // default: full range
        this.fitToWidth();
        this.draw();
    }

    setCurrentFrame(frame) {
        this.currentFrame = Math.max(0, Math.min(frame, this.totalFrames - 1));
        this.draw();
    }

    setTrimRange(inPoint, outPoint) {
        this.inPoint = Math.max(0, inPoint);
        this.outPoint = Math.min(outPoint, this.totalFrames);
        this.draw();
    }

    clearTrim() {
        this.inPoint = 0;
        this.outPoint = this.totalFrames;
        this.draw();
        if (this.onTrimChange) this.onTrimChange(0, this.totalFrames);
    }

    getTrimRange() {
        return {
            inPoint: this.inPoint,
            outPoint: Math.min(this.outPoint, this.totalFrames),
        };
    }

    fitToWidth() {
        const w = this.canvas.width;
        if (this.totalFrames > 0) {
            this.pxPerFrame = Math.max(0.5, w / this.totalFrames);
        } else {
            this.pxPerFrame = 10;
        }
        this.scrollOffset = 0;
    }

    resize() {
        const container = this.canvas.parentElement;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;

        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.displayWidth = w;
        this.displayHeight = h;
        this.draw();
    }

    // ---- Drawing ----

    draw() {
        const ctx = this.ctx;
        const w = this.displayWidth || this.canvas.width;
        const h = this.displayHeight || this.canvas.height;
        if (!w || !h) return;

        ctx.clearRect(0, 0, w, h);

        // Layout regions
        const rulerH = 26;
        const waveformH = h - rulerH;

        this.drawBackground(ctx, w, h);
        this.drawWaveform(ctx, 0, rulerH, w, waveformH);
        this.drawTrimHighlight(ctx, 0, rulerH, w, waveformH);
        this.drawRuler(ctx, 0, 0, w, rulerH);
        this.drawPlayhead(ctx, 0, 0, w, h);
        this.drawTrimHandles(ctx, 0, rulerH, w, waveformH);
    }

    drawBackground(ctx, w, h) {
        // Dark background
        ctx.fillStyle = '#1a1f2e';
        ctx.fillRect(0, 0, w, h);

        // Subtle grid lines every second
        const fps = 1 / this.frameTime;
        const framesPerSecond = Math.round(fps);
        const pxPerSec = this.pxPerFrame * framesPerSecond;

        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        for (let s = 0; s * pxPerSec < w + this.scrollOffset; s++) {
            const x = s * pxPerSec - this.scrollOffset;
            if (x >= 0 && x < w) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }
    }

    drawRuler(ctx, x, y, w, h) {
        // Ruler background
        ctx.fillStyle = '#141820';
        ctx.fillRect(x, y, w, h);

        // Bottom border
        ctx.strokeStyle = '#2a3a4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + h - 0.5);
        ctx.lineTo(x + w, y + h - 0.5);
        ctx.stroke();

        if (this.totalFrames === 0) return;

        const fps = Math.round(1 / this.frameTime);
        const pxPerSec = this.pxPerFrame * fps;

        // Decide tick interval based on zoom
        let tickInterval; // in seconds
        if (pxPerSec > 200) tickInterval = 0.1;
        else if (pxPerSec > 80) tickInterval = 0.25;
        else if (pxPerSec > 40) tickInterval = 0.5;
        else if (pxPerSec > 15) tickInterval = 1;
        else if (pxPerSec > 5) tickInterval = 2;
        else tickInterval = 5;

        const tickPx = tickInterval * pxPerSec;
        const startSec = Math.floor(this.scrollOffset / pxPerSec / tickInterval) * tickInterval;

        ctx.fillStyle = '#a0a0a0';
        ctx.font = '10px "SF Mono", "Cascadia Code", Consolas, monospace';
        ctx.textAlign = 'center';

        for (let sec = startSec; ; sec += tickInterval) {
            const tickX = sec * pxPerSec - this.scrollOffset;
            if (tickX > w) break;
            if (tickX < -50) continue;

            // Major tick
            const isMajor = sec % 1 < 0.001 || sec % 1 > 0.999;
            const tickTop = isMajor ? y + 8 : y + 16;
            ctx.strokeStyle = isMajor ? '#606070' : '#3a3a4a';
            ctx.lineWidth = isMajor ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(tickX, tickTop);
            ctx.lineTo(tickX, y + h);
            ctx.stroke();

            if (isMajor) {
                const mins = Math.floor(sec / 60);
                const secs = (sec % 60).toFixed(0);
                const label = `${mins}:${secs.padStart(2, '0')}`;
                ctx.fillStyle = '#a0a0a0';
                ctx.fillText(label, tickX, y + 20);
            }
        }
    }

    drawWaveform(ctx, x, y, w, h) {
        if (!this.intensity || this.totalFrames === 0) return;

        const midY = y + h / 2;
        const maxH = h * 0.45;

        // Find the max intensity for normalization
        let maxIntensity = 0;
        for (let i = 0; i < this.intensity.length; i++) {
            if (this.intensity[i] > maxIntensity) maxIntensity = this.intensity[i];
        }
        if (maxIntensity === 0) maxIntensity = 1;

        // Draw waveform as filled area
        ctx.fillStyle = 'rgba(79, 195, 247, 0.15)';
        ctx.strokeStyle = 'rgba(79, 195, 247, 0.6)';
        ctx.lineWidth = 1;

        ctx.beginPath();
        const startFrame = Math.max(0, Math.floor(this.scrollOffset / this.pxPerFrame));
        const endFrame = Math.min(this.totalFrames, Math.ceil((this.scrollOffset + w) / this.pxPerFrame));

        ctx.moveTo(0, midY);
        for (let f = startFrame; f <= endFrame; f++) {
            const fx = f * this.pxPerFrame - this.scrollOffset;
            const val = this.intensity[f] / maxIntensity;
            const fy = midY - val * maxH;
            ctx.lineTo(fx, fy);
        }
        for (let f = endFrame; f >= startFrame; f--) {
            const fx = f * this.pxPerFrame - this.scrollOffset;
            const val = this.intensity[f] / maxIntensity;
            const fy = midY + val * maxH;
            ctx.lineTo(fx, fy);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    drawTrimHighlight(ctx, x, y, w, h) {
        if (this.inPoint <= 0 && this.outPoint >= this.totalFrames) return;

        const inX = this.inPoint * this.pxPerFrame - this.scrollOffset;
        const outX = this.outPoint * this.pxPerFrame - this.scrollOffset;

        // Dim areas outside trim range
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        if (inX > 0) ctx.fillRect(0, y, Math.min(inX, w), h);
        if (outX < w) ctx.fillRect(Math.max(0, outX), y, w - Math.max(0, outX), h);

        // Highlight selected range border
        if (inX >= 0 || outX <= w) {
            ctx.fillStyle = 'rgba(79, 195, 247, 0.05)';
            ctx.fillRect(
                Math.max(0, inX), y,
                Math.min(w, outX) - Math.max(0, inX), h
            );
        }
    }

    drawPlayhead(ctx, x, y, w, h) {
        const px = this.currentFrame * this.pxPerFrame - this.scrollOffset;
        if (px < -5 || px > w + 5) return;

        // Line
        ctx.strokeStyle = this.dragging === 'playhead' ? '#ff7043' : '#ff5252';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px, y + h);
        ctx.stroke();

        // Triangle handle on top
        ctx.fillStyle = this.dragging === 'playhead' ? '#ff7043' : '#ff5252';
        ctx.beginPath();
        ctx.moveTo(px - 6, y);
        ctx.lineTo(px + 6, y);
        ctx.lineTo(px, y + 8);
        ctx.closePath();
        ctx.fill();
    }

    drawTrimHandles(ctx, x, y, w, h) {
        if (this.totalFrames === 0) return;

        const inX = this.inPoint * this.pxPerFrame - this.scrollOffset;
        const outX = (this.outPoint >= this.totalFrames ? this.totalFrames : this.outPoint) * this.pxPerFrame - this.scrollOffset;

        // In-point handle
        if (this.inPoint > 0) {
            this.drawHandle(ctx, inX, y, h, '#4caf50', 'inpoint');
            // Label
            ctx.fillStyle = '#4caf50';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`入:${this.inPoint}`, inX + 8, y + 12);
        }

        // Out-point handle
        if (this.outPoint < this.totalFrames) {
            this.drawHandle(ctx, outX, y, h, '#ff9800', 'outpoint');
            // Label
            ctx.fillStyle = '#ff9800';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`出:${this.outPoint}`, outX - 8, y + 12);
        }
    }

    drawHandle(ctx, px, y, h, color, type) {
        const isHover = this.hoverTarget === type;
        const isDrag = this.dragging === type;
        const alpha = isDrag ? 1 : isHover ? 0.8 : 0.6;

        // Vertical line
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(px, y + 6);
        ctx.lineTo(px, y + h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Bracket icon
        const bw = 7;
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        if (type === 'inpoint') {
            // Left bracket: [
            ctx.moveTo(px + bw, y);
            ctx.lineTo(px, y);
            ctx.lineTo(px, y + bw * 2);
        } else {
            // Right bracket: ]
            ctx.moveTo(px - bw, y);
            ctx.lineTo(px, y);
            ctx.lineTo(px, y + bw * 2);
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // ---- Interaction ----

    initEvents() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    }

    getMouseFrame(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const frame = Math.round((mx + this.scrollOffset) / this.pxPerFrame);
        return Math.max(0, Math.min(frame, this.totalFrames - 1));
    }

    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    onMouseDown(e) {
        if (this.totalFrames === 0) return;

        const pos = this.getMousePos(e);
        const rulerH = 26;
        const h = this.displayHeight;

        // Middle button = pan
        if (e.button === 1 || (e.altKey && e.button === 0)) {
            this.dragging = 'pan';
            this.panStart = { x: pos.x, scrollOffset: this.scrollOffset };
            this.canvas.style.cursor = 'grabbing';
            e.preventDefault();
            return;
        }

        if (e.button !== 0) return;

        // Check playhead (wider hit area)
        const phX = this.currentFrame * this.pxPerFrame - this.scrollOffset;
        if (Math.abs(pos.x - phX) < 6) {
            this.dragging = 'playhead';
            this.canvas.style.cursor = 'col-resize';
            return;
        }

        // Check in-point handle (only if set and in waveform area)
        if (this.inPoint > 0 && pos.y > rulerH) {
            const inX = this.inPoint * this.pxPerFrame - this.scrollOffset;
            if (Math.abs(pos.x - inX) < 8) {
                this.dragging = 'inpoint';
                this.canvas.style.cursor = 'ew-resize';
                return;
            }
        }

        // Check out-point handle
        if (this.outPoint < this.totalFrames && pos.y > rulerH) {
            const outX = this.outPoint * this.pxPerFrame - this.scrollOffset;
            if (Math.abs(pos.x - outX) < 8) {
                this.dragging = 'outpoint';
                this.canvas.style.cursor = 'ew-resize';
                return;
            }
        }

        // Click on ruler/waveform = seek
        const frame = this.getMouseFrame(e);
        this.currentFrame = frame;
        if (this.onSeek) this.onSeek(frame);
        this.draw();
        // Start playhead drag
        this.dragging = 'playhead';
        this.canvas.style.cursor = 'col-resize';
    }

    onMouseMove(e) {
        const pos = this.getMousePos(e);
        const rulerH = 26;

        if (this.dragging === 'playhead') {
            const frame = this.getMouseFrame(e);
            this.currentFrame = frame;
            if (this.onSeek) this.onSeek(frame);
            this.draw();
            return;
        }

        if (this.dragging === 'inpoint') {
            let frame = this.getMouseFrame(e);
            frame = Math.max(0, Math.min(frame, this.outPoint - 1));
            this.inPoint = frame;
            if (this.onTrimChange) this.onTrimChange(this.inPoint, this.outPoint);
            this.draw();
            return;
        }

        if (this.dragging === 'outpoint') {
            let frame = this.getMouseFrame(e);
            frame = Math.max(this.inPoint + 1, Math.min(frame, this.totalFrames));
            this.outPoint = frame;
            if (this.onTrimChange) this.onTrimChange(this.inPoint, this.outPoint);
            this.draw();
            return;
        }

        if (this.dragging === 'pan') {
            const dx = this.panStart.x - pos.x;
            this.scrollOffset = Math.max(0, this.panStart.scrollOffset + dx);
            this.draw();
            return;
        }

        // Hover detection
        const phX = this.currentFrame * this.pxPerFrame - this.scrollOffset;
        if (Math.abs(pos.x - phX) < 5) {
            this.hoverTarget = 'playhead';
            this.canvas.style.cursor = 'col-resize';
        } else if (this.inPoint > 0 && pos.y > rulerH &&
                   Math.abs(pos.x - (this.inPoint * this.pxPerFrame - this.scrollOffset)) < 8) {
            this.hoverTarget = 'inpoint';
            this.canvas.style.cursor = 'ew-resize';
        } else if (this.outPoint < this.totalFrames && pos.y > rulerH &&
                   Math.abs(pos.x - (this.outPoint * this.pxPerFrame - this.scrollOffset)) < 8) {
            this.hoverTarget = 'outpoint';
            this.canvas.style.cursor = 'ew-resize';
        } else {
            this.hoverTarget = null;
            this.canvas.style.cursor = 'default';
        }
        this.draw();
    }

    onMouseUp(e) {
        this.dragging = null;
        this.canvas.style.cursor = 'default';
    }

    onWheel(e) {
        if (this.totalFrames === 0) return;

        e.preventDefault();
        const pos = this.getMousePos(e);

        // Ctrl+wheel = zoom
        if (e.ctrlKey || e.metaKey) {
            const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const oldPxPerFrame = this.pxPerFrame;

            // Zoom centered on mouse position
            const mouseFrame = (pos.x + this.scrollOffset) / oldPxPerFrame;
            this.pxPerFrame = Math.max(0.1, Math.min(50, this.pxPerFrame * zoomFactor));
            this.scrollOffset = mouseFrame * this.pxPerFrame - pos.x;
            this.scrollOffset = Math.max(0, this.scrollOffset);
        } else {
            // Normal scroll = horizontal pan
            this.scrollOffset += e.deltaY;
            this.scrollOffset = Math.max(0, this.scrollOffset);
        }

        this.draw();
    }

    onDblClick(e) {
        // Double-click on waveform = toggle trim at that position
        if (this.totalFrames === 0) return;
        const frame = this.getMouseFrame(e);
        this.currentFrame = frame;
        if (this.onSeek) this.onSeek(frame);
        this.draw();
    }
}
