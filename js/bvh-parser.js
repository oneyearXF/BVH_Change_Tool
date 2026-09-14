/**
 * BVH (Biovision Hierarchy) File Parser
 *
 * Parses standard BVH motion capture files and provides
 * methods to compute world-space joint positions for any frame.
 */

// ---- Channel name mapping ----
const CHANNEL_ALIASES = {
    'Xposition': 'tx', 'Yposition': 'ty', 'Zposition': 'tz',
    'Xrotation': 'rx', 'Yrotation': 'ry', 'Zrotation': 'rz',
};

/**
 * Parse a BVH file string into structured data.
 * @param {string} text - Raw BVH file content
 * @returns {object} Parsed BVH data
 */
export function parseBVH(text) {
    const lines = text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    let pos = 0;

    // Expect HIERARCHY header
    if (lines[pos] !== 'HIERARCHY') {
        throw new Error('Not a BVH file: missing HIERARCHY keyword');
    }
    pos++;

    // Parse hierarchy tree
    const hierarchy = parseJoint(lines, pos);
    pos = hierarchy.nextPos;

    // Expect MOTION header
    if (lines[pos] !== 'MOTION') {
        throw new Error('Not a BVH file: missing MOTION keyword');
    }
    pos++;

    // Parse motion data
    const motion = parseMotion(lines, pos);

    // Flatten joint hierarchy for fast access
    const jointNames = [];
    const jointParents = [];
    const jointOffsets = [];
    const jointChannels = [];
    const jointIsEndSite = [];

    flattenHierarchy(hierarchy.node, -1, jointNames, jointParents, jointOffsets, jointChannels, jointIsEndSite);

    // Build channel map: for each joint, which channel indices in motion data
    const channelMap = [];
    let channelIndex = 0;
    for (let i = 0; i < jointNames.length; i++) {
        const chNames = jointChannels[i];
        channelMap.push({
            channelStart: channelIndex,
            channelNames: chNames,
            count: chNames.length,
        });
        channelIndex += chNames.length;
    }

    return {
        hierarchy: hierarchy.node,
        motion,
        jointNames,
        jointParents,
        jointOffsets,
        jointChannels,
        jointIsEndSite,
        channelMap,
        totalChannels: channelIndex,
        duration: motion.frames * motion.frameTime,
    };
}

function parseJoint(lines, startPos) {
    let pos = startPos;
    const line = lines[pos];

    // Check for ROOT, JOINT, or End Site
    const isRoot = line === 'ROOT' || line.startsWith('ROOT ');
    const isJoint = line === 'JOINT' || line.startsWith('JOINT ');
    const isEndSite = (line === 'End Site' || line === 'End') && lines[pos + 1] === '{';

    if (isEndSite) {
        // End Site: no name, just offset inside braces
        pos += 2; // skip "End Site" (or "End") and "{"
        const offset = parseOffset(lines[pos]);
        pos++;
        // expect "}"
        if (lines[pos] === '}') pos++;
        return {
            node: {
                name: 'EndSite',
                offset: offset,
                channels: [],
                children: [],
                isEndSite: true,
            },
            nextPos: pos,
        };
    }

    const name = line.split(/\s+/)[1];
    pos++; // skip name line
    // expect "{"
    if (lines[pos] === '{') pos++;

    // Parse OFFSET
    const offset = parseOffset(lines[pos]);
    pos++;

    // Parse CHANNELS (optional for EndSite-like nodes)
    let channels = [];
    if (lines[pos] && lines[pos].startsWith('CHANNELS')) {
        channels = parseChannels(lines[pos]);
        pos++;
    }

    // Parse children joints recursively
    const children = [];
    while (pos < lines.length && lines[pos] !== '}') {
        const child = parseJoint(lines, pos);
        children.push(child.node);
        pos = child.nextPos;
    }

    // skip "}"
    if (pos < lines.length && lines[pos] === '}') pos++;

    return {
        node: {
            name,
            offset,
            channels,
            children,
            isEndSite: false,
            isRoot: isRoot,
        },
        nextPos: pos,
    };
}

function parseOffset(line) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'OFFSET' && parts.length >= 4) {
        return {
            x: parseFloat(parts[1]),
            y: parseFloat(parts[2]),
            z: parseFloat(parts[3]),
        };
    }
    throw new Error(`Invalid OFFSET line: ${line}`);
}

function parseChannels(line) {
    const parts = line.trim().split(/\s+/);
    const count = parseInt(parts[1], 10);
    const channels = parts.slice(2, 2 + count);
    return channels;
}

function parseMotion(lines, startPos) {
    let pos = startPos;

    // Parse Frames: N
    const framesMatch = lines[pos].match(/^Frames:\s*(\d+)/i);
    if (!framesMatch) throw new Error(`Invalid Frames line: ${lines[pos]}`);
    const frames = parseInt(framesMatch[1], 10);
    pos++;

    // Parse Frame Time: T
    const ftMatch = lines[pos].match(/^Frame Time:\s*([\d.]+)/i);
    if (!ftMatch) throw new Error(`Invalid Frame Time line: ${lines[pos]}`);
    const frameTime = parseFloat(ftMatch[1]);
    pos++;

    // Parse frame data
    const data = [];
    for (let i = 0; i < frames; i++) {
        const values = lines[pos].trim().split(/\s+/).map(parseFloat);
        data.push(values);
        pos++;
    }

    return { frames, frameTime, data };
}

/**
 * Flatten the joint hierarchy into parallel arrays.
 */
function flattenHierarchy(node, parentIdx, names, parents, offsets, channels, isEndSite) {
    const idx = names.length;
    names.push(node.name);
    parents.push(parentIdx);
    offsets.push([node.offset.x, node.offset.y, node.offset.z]);
    channels.push(node.channels || []);
    isEndSite.push(node.isEndSite || false);

    for (const child of node.children) {
        flattenHierarchy(child, idx, names, parents, offsets, channels, isEndSite);
    }

    return idx;
}

/**
 * Compute world-space joint positions for a given frame.
 *
 * BVH Forward Kinematics:
 * - Each joint has an OFFSET (bone vector from parent, in parent's local frame)
 * - ROOT has position channels (world translation) + rotation channels
 * - Other joints have only rotation channels
 * - Channels are applied in the order listed (e.g., Zrot Yrot Xrot = Rz*Ry*Rx)
 * - World transform = parent_world * T(offset) * R(channels)
 * - For ROOT: World transform = T(position) * R(channels)
 *
 * @param {object} bvh - Parsed BVH data
 * @param {number} frameIndex - Frame number (0-based)
 * @returns {Float32Array[]} Array of [x,y,z] positions for each joint (world space)
 */
export function computeJointPositions(bvh, frameIndex) {
    const { jointNames, jointParents, jointOffsets, channelMap, motion } = bvh;
    const frameData = motion.data[frameIndex];
    const n = jointNames.length;

    const worldMatrices = new Array(n);
    const worldPositions = new Array(n);
    const localMat = new Array(16);
    const tmpMat = new Array(16);

    for (let i = 0; i < n; i++) {
        const cm = channelMap[i];
        const ch = readJointChannels(frameData, cm);
        // Position channels (root) come from the motion data; every other joint
        // sits at its rest-pose OFFSET from the parent.
        const translation = ch.hasPos ? [ch.tx, ch.ty, ch.tz] : jointOffsets[i];
        mat4LocalInto(localMat, cm.channelNames, ch, translation);

        const parent = jointParents[i];
        if (parent >= 0) {
            mat4MultiplyInto(tmpMat, worldMatrices[parent], localMat);
            worldMatrices[i] = tmpMat.slice();
        } else {
            worldMatrices[i] = localMat.slice();
        }
        const m = worldMatrices[i];
        worldPositions[i] = [m[3], m[7], m[11]];
    }

    return worldPositions;
}

// ---- 4x4 Matrix utilities ----
//
// Matrices are plain row-major 4x4 arrays: element (row r, col c) lives at
// index r*4 + c, and the translation sits in the LAST COLUMN (indices 3/7/11).
// Points are column vectors, so a joint chain composes as
//     world = parent * local
// and a joint's world position is [m[3], m[7], m[11]].
//
// (An earlier version wrote the translation to indices 12/13/14 — the
//  row-vector layout — while multiplying rows and columns the other way
//  round, so parent transforms lost their translation.)

const DEG2RAD = Math.PI / 180;

function mat4IdentityInto(out) {
    out[0] = 1; out[1] = 0; out[2] = 0;  out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0;  out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

/** out = a * b (row-major). Safe when out === a, NOT when out === b. */
function mat4MultiplyInto(out, a, b) {
    for (let i = 0; i < 4; i++) {
        const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2], a3 = a[i * 4 + 3];
        out[i * 4]     = a0 * b[0]  + a1 * b[4]  + a2 * b[8]  + a3 * b[12];
        out[i * 4 + 1] = a0 * b[1]  + a1 * b[5]  + a2 * b[9]  + a3 * b[13];
        out[i * 4 + 2] = a0 * b[2]  + a1 * b[6]  + a2 * b[10] + a3 * b[14];
        out[i * 4 + 3] = a0 * b[3]  + a1 * b[7]  + a2 * b[11] + a3 * b[15];
    }
    return out;
}

function mat4RotateXInto(out, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    out[0] = 1; out[1] = 0; out[2] = 0;  out[3] = 0;
    out[4] = 0; out[5] = c; out[6] = -s; out[7] = 0;
    out[8] = 0; out[9] = s; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

function mat4RotateYInto(out, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    out[0] = c;  out[1] = 0; out[2] = s;  out[3] = 0;
    out[4] = 0;  out[5] = 1; out[6] = 0;  out[7] = 0;
    out[8] = -s; out[9] = 0; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

function mat4RotateZInto(out, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    out[0] = c; out[1] = -s; out[2] = 0; out[3] = 0;
    out[4] = s; out[5] = c;  out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0;  out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

/** out = R(rotation channels), composed in the order the channels are listed
 *  (Zrotation Yrotation Xrotation  ->  R = Rz * Ry * Rx, the BVH convention). */
function mat4RotationInto(out, channelNames, rx, ry, rz) {
    mat4IdentityInto(out);
    const axisMat = new Array(16);
    for (let k = 0; k < channelNames.length; k++) {
        const name = channelNames[k];
        if (!name.endsWith('rotation')) continue;
        const axis = name[0];
        const angle = axis === 'X' ? rx : (axis === 'Y' ? ry : rz);
        if (axis === 'X') mat4RotateXInto(axisMat, angle);
        else if (axis === 'Y') mat4RotateYInto(axisMat, angle);
        else mat4RotateZInto(axisMat, angle);
        mat4MultiplyInto(out, out, axisMat);
    }
    return out;
}

/** out = T(translation) * R(rotation) — a joint's local transform. */
function mat4LocalInto(out, channelNames, ch, translation) {
    mat4RotationInto(out, channelNames, ch.rx, ch.ry, ch.rz);
    out[3] = translation[0]; out[7] = translation[1]; out[11] = translation[2];
    return out;
}

/** Pull one joint's channel values out of a frame. */
function readJointChannels(frameData, cm) {
    const names = cm.channelNames, base = cm.channelStart;
    let tx = 0, ty = 0, tz = 0, rx = 0, ry = 0, rz = 0, hasPos = false;
    for (let j = 0; j < names.length; j++) {
        const v = frameData[base + j], name = names[j];
        if (name === 'Xposition') { tx = v; hasPos = true; }
        else if (name === 'Yposition') { ty = v; hasPos = true; }
        else if (name === 'Zposition') { tz = v; hasPos = true; }
        else if (name === 'Xrotation') rx = v * DEG2RAD;
        else if (name === 'Yrotation') ry = v * DEG2RAD;
        else if (name === 'Zrotation') rz = v * DEG2RAD;
    }
    return { tx, ty, tz, rx, ry, rz, hasPos };
}

/**
 * Export BVH data (optionally trimmed to [startFrame, endFrame]).
 * @param {object} bvh - Parsed BVH data
 * @param {number} startFrame - Start frame (inclusive)
 * @param {number} endFrame - End frame (inclusive)
 * @returns {string} BVH file content
 */
export function exportBVH(bvh, startFrame, endFrame) {
    startFrame = Math.max(0, startFrame || 0);
    endFrame = endFrame !== undefined ? Math.min(bvh.motion.frames - 1, endFrame) : bvh.motion.frames - 1;

    const lines = [];
    lines.push('HIERARCHY');
    exportJoint(bvh.hierarchy, 0, lines);
    lines.push('MOTION');

    const frameCount = endFrame - startFrame + 1;
    lines.push(`Frames: ${frameCount}`);
    lines.push(`Frame Time: ${bvh.motion.frameTime}`);

    for (let f = startFrame; f <= endFrame; f++) {
        const frameData = bvh.motion.data[f];
        // Format with 6 decimal places like standard BVH
        const line = frameData.map(v => {
            const s = v.toFixed(6);
            // Trim trailing zeros but keep at least one decimal
            return s.replace(/\.?0+$/, '') || '0';
        }).join(' ');
        lines.push(line);
    }

    return lines.join('\n');
}

function exportJoint(node, indent, lines) {
    const prefix = '  '.repeat(indent);

    if (node.isEndSite) {
        lines.push(`${prefix}End Site`);
        lines.push(`${prefix}{`);
        lines.push(`${prefix}  OFFSET ${fmt(node.offset.x)} ${fmt(node.offset.y)} ${fmt(node.offset.z)}`);
        lines.push(`${prefix}}`);
        return;
    }

    const type = node.isRoot ? 'ROOT' : 'JOINT';
    lines.push(`${prefix}${type} ${node.name}`);
    lines.push(`${prefix}{`);
    lines.push(`${prefix}  OFFSET ${fmt(node.offset.x)} ${fmt(node.offset.y)} ${fmt(node.offset.z)}`);

    if (node.channels.length > 0) {
        lines.push(`${prefix}  CHANNELS ${node.channels.length} ${node.channels.join(' ')}`);
    }

    for (const child of node.children) {
        exportJoint(child, indent + 1, lines);
    }

    lines.push(`${prefix}}`);
}

function fmt(n) {
    const s = n.toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
}

/**
 * Generate motion intensity data for timeline waveform visualization.
 *
 * Uses root-joint displacement as the primary intensity signal
 * (fast path: only computes 1 joint's FK, not all joints).
 * For large files (>2000 frames), samples every Nth frame.
 *
 * @returns {Float32Array} intensity per frame (for waveform display)
 */
export function computeMotionIntensity(bvh) {
    const n = bvh.motion.frames;
    const intensity = new Float32Array(n);
    if (n === 0) return intensity;

    // Stride: sample at most ~1500 frames for the waveform
    const stride = Math.max(1, Math.floor(n / 1500));

    let prevRootPos = null;

    for (let f = 0; f < n; f += stride) {
        // Fast path: only compute root joint position (index 0)
        const rootPos = computeSingleJointPosition(bvh, f, 0);

        if (f === 0) {
            // Fill leading frames with 0
            for (let k = 0; k < stride && k < n; k++) {
                intensity[k] = 0;
            }
        } else {
            const dx = rootPos[0] - prevRootPos[0];
            const dy = rootPos[1] - prevRootPos[1];
            const dz = rootPos[2] - prevRootPos[2];
            const disp = Math.sqrt(dx*dx + dy*dy + dz*dz);
            // Fill all frames in this stride block with the same intensity
            for (let k = f; k < f + stride && k < n; k++) {
                intensity[k] = disp;
            }
        }
        prevRootPos = rootPos;
    }

    return intensity;
}

/**
 * Fast-path: compute world position for a single joint at a given frame.
 * Avoids computing all joints when only one is needed.
 */
function computeSingleJointPosition(bvh, frameIndex, jointIndex) {
    const { jointParents, jointOffsets, channelMap, motion } = bvh;
    const frameData = motion.data[frameIndex];

    // We need to compute the chain from root to target joint
    // Build ancestor chain
    const chain = [];
    let idx = jointIndex;
    while (idx >= 0) {
        chain.unshift(idx);
        idx = jointParents[idx];
    }

    // Compute world transform for each joint in the chain
    const worldMats = {};
    const localMat = new Array(16);
    const tmpMat = new Array(16);
    for (const i of chain) {
        const cm = channelMap[i];
        const ch = readJointChannels(frameData, cm);
        const translation = ch.hasPos ? [ch.tx, ch.ty, ch.tz] : jointOffsets[i];
        mat4LocalInto(localMat, cm.channelNames, ch, translation);

        const parentIdx = jointParents[i];
        if (parentIdx >= 0 && worldMats[parentIdx]) {
            mat4MultiplyInto(tmpMat, worldMats[parentIdx], localMat);
            worldMats[i] = tmpMat.slice();
        } else {
            worldMats[i] = localMat.slice();
        }
    }

    const mat = worldMats[jointIndex];
    return [mat[3], mat[7], mat[11]];
}
