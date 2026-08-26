import { Multiplayer } from '../multiplayer';
import { getMpOption } from './mpOptions';

/**
 * 1.75.x — teammate ranged-charge aim lines.
 *
 * The owner streams `al` (the charge has FOCUSED into a single straight line),
 * the normalized aim direction (ax/ay) and the actual crosshair anchor position
 * (cax/cay/caz) on the existing playerState relay. Receivers draw:
 *  - the owner's crosshair anchor (the little targeting circle under their
 *    mouse), interpolated toward each network snapshot for smooth motion and
 *    clamped at the first wall so it can never sink into terrain;
 *  - a row of native CrosshairDot entities whose direction is computed FROM the
 *    interpolated anchor, including up to three wall reflections (the same
 *    bounce-after-wall behaviour the local crosshair has).
 *
 * The un-focused fan/cone phase is deliberately never shown. Opacity comes from
 * the mod options tab (多人 → 队友瞄准线透明度, default 0% = hidden).
 */

const MAX_DOTS = 12;
const DOT_STEP = 24;
const MAX_DIST = MAX_DOTS * DOT_STEP;
const MAX_BOUNCES = 3;
const FADE_RATE = 8;        // exponential line fade ≈0.12s, in real time
const ANCHOR_LERP = 20;     // anchor smoothing time-constant ≈50ms

interface IAimLine {
    dots: any[];
    alpha: number;
    target: number;
    /** Network direction (fallback when the anchor position is unavailable). */
    dir: { x: number, y: number };
    hasDir: boolean;
    /** Interpolated crosshair-anchor position (world/screen space, z = level). */
    ax: number;
    ay: number;
    az: number;
    hasAnchor: boolean;
    /** Latest network anchor target. */
    tx: number;
    ty: number;
    tz: number;
    hasAnchorTarget: boolean;
    /** Lightweight world-space entity rendering the owner's crosshair anchor. */
    anchorEnt: any | null;
    ent: any | null;
}

let installed = false;
let getMain: (() => Multiplayer | undefined) | null = null;
const lines: { [name: string]: IAimLine } = {};

function pickOpacity(): number {
    try {
        const v = getMpOption('aimLineOpacity');
        return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    } catch (_) { return 0; }
}

function hideDot(dot: any): void {
    if (!dot || dot._killed) return;
    try {
        dot._mpAimAlpha = 0;
        dot.animState.alpha = 0;
        dot.setPos(-10000, -10000, 0);
        if (dot.coll && dot.coll.shadow) dot.coll.shadow.size = 0;
    } catch (_) { /* hide is cosmetic */ }
}

function patchDot(dot: any): void {
    try {
        if (!dot || dot._mpAimPatched) return;
        dot._mpAimPatched = true;
        const origUpdate = dot.update;
        dot.update = function (this: any) {
            try { if (origUpdate) origUpdate.call(this); } catch (_) { /* ignore */ }
            // The engine resets CrosshairDot.animState.alpha to 0/1 every frame;
            // our per-frame alpha must win on the render that follows. While the
            // world clock is stopped (menu/pause, and no autoControl) hide like the
            // native crosshair dots do.
            try {
                const scAny: any = (window as any).sc;
                const stopped = (ig as any).system && (ig as any).system.timeFactor <= 0
                    && !(scAny && scAny.autoControl && typeof scAny.autoControl.isActive === 'function' && scAny.autoControl.isActive());
                this.animState.alpha = stopped ? 0 : ((typeof this._mpAimAlpha === 'number') ? this._mpAimAlpha : 0);
            } catch (_) { /* ignore */ }
        };
    } catch (_) { /* patch is best-effort */ }
}

function ensureDots(rec: IAimLine): void {
    if (!rec.dots) rec.dots = [];
    for (let i = 0; i < MAX_DOTS; i++) {
        let dot = rec.dots[i];
        try {
            if (!dot || dot._killed) {
                // The string overload of spawnEntity resolves global entity settings
                // BEFORE construction; with no settings object that resolver reads
                // `undefined.__GLOBAL__` and throws (the native crosshair passes the
                // CLASS, which skips that resolver entirely). Pass an explicit {}
                // so the string overload resolves cleanly.
                dot = (ig as any).game.spawnEntity('CrosshairDot', -10000, -10000, 0, {});
                rec.dots[i] = dot || null;
            }
            if (dot) {
                patchDot(dot);
                if (dot._mpAimAnim !== 'charged') {
                    try { dot.setCurrentAnim('charged', true); } catch (_) { /* keep whatever anim */ }
                    dot._mpAimAnim = 'charged';
                }
            }
        } catch (_) { rec.dots[i] = null; }
    }
}

// ---------------------------------------------------------------------------
// Anchor entity: a zero-footprint world-space sprite that draws the native
// crosshair icon (tile 0, charged row 6 = the red full-charge ring) at the
// interpolated remote anchor.
// ---------------------------------------------------------------------------

let anchorClass: any = null;

function getAnchorClass(): any | null {
    if (anchorClass) return anchorClass;
    try {
        const CH: any = (ig as any).ENTITY && (ig as any).ENTITY.Crosshair;
        const sheet = CH && CH.prototype && CH.prototype.tileSheet;
        const Entity: any = (ig as any).Entity;
        if (!sheet || !Entity || typeof Entity.extend !== 'function') return null;
        anchorClass = Entity.extend({
            tileSheet: sheet,
            init(this: any, x: number, y: number, z: number, settings: any) {
                this.parent(x, y, z, settings || {});
                this.coll.type = (ig as any).COLLTYPE.NONE;
                this.coll.setSize(0, 0, 0);
                try { this.coll.time.globalStatic = true; } catch (_) { /* ignore */ }
                this.setSpriteCount(1);
            },
            initSprites(this: any) {
                this.setSpriteCount(1);
            },
            updateSprites(this: any) {
                const s = this.sprites && this.sprites[0];
                if (!s) return;
                const a = (typeof this._mpAimAnchorAlpha === 'number') ? this._mpAimAnchorAlpha : 0;
                if (a <= 0.001) { try { s.setAlpha(0); } catch (_) { /* ignore */ } return; }
                const p = this.coll && this.coll.pos;
                if (!p) return;
                s.renderMode = 'source-over';
                // Native Crosshair.updateSprites geometry: 32x32 icon centred on
                // coll.pos, drawn at y - z for the isometric height projection.
                s.setPos(p.x - 16, p.y - p.z + 16, 0);
                s.setSize(32, 0, 32, 0);
                if (!this._mpAimSrc) this._mpAimSrc = { x: 0, y: 0 };
                // Rows 4/5/6 are the charged anchor frames; 4 is white and 6 is
                // the full-charge red ring the local crosshair shows.
                const src = this.tileSheet.getTileSrc(this._mpAimSrc, 6);
                s.setImageSrc(this.tileSheet.image, src.x, src.y);
                s.setAlpha(a);
            },
        });
    } catch (_) { return null; }
    return anchorClass;
}

function ensureAnchor(rec: IAimLine): void {
    if (rec.anchorEnt && !rec.anchorEnt._killed) return;
    const cls = getAnchorClass();
    if (!cls) { rec.anchorEnt = null; return; }
    try {
        rec.anchorEnt = (ig as any).game.spawnEntity(cls, -10000, -10000, 0, {}) || null;
    } catch (_) { rec.anchorEnt = null; }
}

function updateAnchor(rec: IAimLine, alpha: number, x?: number, y?: number, z?: number): void {
    if (!rec.anchorEnt) return;
    const a = rec.anchorEnt;
    if (!rec.hasAnchor || alpha <= 0.001 || a._killed) {
        try { a._mpAimAnchorAlpha = 0; a.setPos(-10000, -10000, 0); } catch (_) { /* ignore */ }
        return;
    }
    try {
        const px = typeof x === 'number' ? x : rec.ax;
        const py = typeof y === 'number' ? y : rec.ay;
        const pz = typeof z === 'number' ? z : rec.az;
        a._mpAimAnchorAlpha = alpha;
        a.setPos(px, py, pz);
        if (a.coll) a.coll.level = (typeof (ig as any).game.getLevelIdx === 'function')
            ? (ig as any).game.getLevelIdx(pz) : 0;
    } catch (_) { /* cosmetic */ }
}

function placeDot(dot: any, x: number, y: number, z: number, level: number, alpha: number): void {
    try {
        dot.setPos(x, y, z);
        dot.coll.level = level;
        if (dot.coll.shadow) dot.coll.shadow.size = 4;
        dot._mpAimAlpha = alpha;
        dot.animState.alpha = alpha;
    } catch (_) { hideDot(dot); }
}

function fallbackDir(rec: IAimLine, ent: any): { x: number, y: number } {
    if (rec.hasDir) {
        const len = Math.sqrt(rec.dir.x * rec.dir.x + rec.dir.y * rec.dir.y);
        if (len > 0.0001) return { x: rec.dir.x / len, y: rec.dir.y / len };
    }
    try {
        const f = ent && ent.face;
        if (f && (typeof f.x === 'number' || typeof f.xProtected === 'number') && (typeof f.y === 'number' || typeof f.yProtected === 'number')) {
            const x = typeof f.xProtected === 'number' ? f.xProtected : f.x;
            const y = typeof f.yProtected === 'number' ? f.yProtected : f.y;
            const len = Math.sqrt(x * x + y * y);
            if (len > 0.0001) return { x: x / len, y: y / len };
        }
    } catch (_) { /* fall through */ }
    return { x: 0, y: 1 };
}

function updateLine(rec: IAimLine, ent: any): void {
    ensureDots(rec);
    ensureAnchor(rec);
    const alpha = rec.alpha;
    if (!ent || ent._killed || alpha <= 0.001) {
        for (let i = 0; i < MAX_DOTS; i++) hideDot(rec.dots[i]);
        updateAnchor(rec, 0);
        return;
    }
    try {
        const C: any = (window as any).Constants || { BALL_HEIGHT: 12, BALL_SIZE: 8, BALL_Z_HEIGHT: 8 };
        const coll = ent.coll || { pos: { x: 0, y: 0, z: 0 }, size: { x: 16, y: 16, z: 24 } };
        const cp = coll.pos || { x: 0, y: 0, z: 0 };
        const size = coll.size || { x: 16, y: 16, z: 24 };
        // Two coordinate frames, exactly like the engine's crosshair:
        //  - screen/projected thrower pos (Crosshair._getThrowerPos) derives the
        //    DIRECTION from the anchor (anchor - projected thrower pos);
        //  - world pos (Crosshair.deferredUpdate's `c`) is what the trace and the
        //    dot entities use. Dots render at pos.y - pos.z, so they must receive
        //    WORLD y, not the pre-subtracted projected y.
        const screenX = Math.round(cp.x) + size.x / 2;
        const screenY = Math.round(cp.y - cp.z) + size.y / 2 - C.BALL_HEIGHT - C.BALL_SIZE / 2;
        const worldX = Math.round(cp.x) + size.x / 2 - C.BALL_SIZE / 2;
        const worldY = cp.y + size.y / 2 - C.BALL_SIZE / 2;
        const traceZ = cp.z + C.BALL_HEIGHT;
        // Start the trace just outside the mirror's own collision body: the local
        // player's crosshair can trace from its centre because the player coll is
        // VIRTUAL, but a remote mirror is Enemy-typed and would otherwise report a
        // zero-distance self-hit on the first frame.
        const pad = Math.sqrt(size.x * size.x + size.y * size.y) * 0.5 + 2;
        let ux = 1, uy = 0;
        if (rec.hasAnchor) {
            // Direction is derived from the interpolated ANCHOR (mouse world pos),
            // exactly like the owner's crosshair computes its own line.
            const dx = rec.ax - screenX;
            const dy = rec.ay - screenY;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.0001) { ux = dx / len; uy = dy / len; }
            else {
                const f = fallbackDir(rec, ent);
                ux = f.x; uy = f.y;
            }
        } else {
            const f = fallbackDir(rec, ent);
            ux = f.x; uy = f.y;
        }

        const levelIdx = (typeof (ig as any).game.getLevelIdx === 'function') ? (ig as any).game.getLevelIdx(traceZ) : 0;
        const game: any = (ig as any).game;
        let dotIdx = 0;
        const startX = worldX + ux * pad;
        const startY = worldY + uy * pad;
        let sx = startX;
        let sy = startY;
        let segLen = MAX_DIST - pad;
        let segAlpha = alpha;
        let firstHit = false;
        let firstHitRun = segLen;
        const ux0 = ux, uy0 = uy;
        const hideFrom = (from: number) => {
            for (let i = from; i < MAX_DOTS; i++) hideDot(rec.dots[i]);
        };

        for (let bounce = 0; bounce <= MAX_BOUNCES && dotIdx < MAX_DOTS; bounce++) {
            let run = segLen;
            let hit = false;
            let nx = 0, ny = 0;
            try {
                const tr: any = game.physics.initTraceResult(Vec3.create());
                // IMPORTANT: the physics tracer steps the ray in 16px segments,
                // so it must receive a direction vector AS LONG AS the segment we
                // want to test (the native crosshair scales its direction to
                // 24*12 = 288px). A unit vector would only ever test the first
                // 1px and never reach a wall. tr.dist is then a fraction of that
                // segment length (0..1), exactly like Crosshair._updateCrossHair.
                const tx = ux * segLen;
                const ty = uy * segLen;
                hit = !!game.trace(
                    tr,
                    sx, sy, traceZ,
                    tx, ty,
                    C.BALL_SIZE, C.BALL_SIZE, C.BALL_Z_HEIGHT,
                    (ig as any).COLLTYPE.PROJECTILE, null, null,
                );
                if (hit && tr && typeof tr.dist === 'number' && isFinite(tr.dist) && tr.dist >= 0) {
                    run = Math.max(0, Math.min(segLen, tr.dist * segLen));
                }
                if (hit && tr && tr.dir) {
                    if (typeof tr.dir.x === 'number' && isFinite(tr.dir.x)) nx = tr.dir.x;
                    if (typeof tr.dir.y === 'number' && isFinite(tr.dir.y)) ny = tr.dir.y;
                }
                if (bounce === 0) { firstHit = hit; firstHitRun = run; }
            } catch (_) { hit = false; run = segLen; if (bounce === 0) firstHitRun = segLen; }

            for (let n = 1; n * DOT_STEP <= run + 0.5 && dotIdx < MAX_DOTS; n++) {
                const dot = rec.dots[dotIdx];
                if (dot && !dot._killed) {
                    placeDot(dot, sx + ux * n * DOT_STEP, sy + uy * n * DOT_STEP, traceZ, levelIdx, segAlpha);
                }
                dotIdx++;
            }

            if (!hit || bounce >= MAX_BOUNCES) break;
            // Advance to the wall hit and reflect around the collision normal —
            // the same recursion the engine's Crosshair._updateCrossHair uses.
            sx += ux * run;
            sy += uy * run;
            const dot = ux * nx + uy * ny;
            if (nx === 0 && ny === 0) break;
            ux = ux - 2 * dot * nx;
            uy = uy - 2 * dot * ny;
            const rl = Math.sqrt(ux * ux + uy * uy);
            if (rl < 0.0001) break;
            ux /= rl; uy /= rl;
            segLen = MAX_DIST;
            segAlpha = Math.max(0.25, segAlpha * 0.75);
        }
        hideFrom(dotIdx);

        // Anchor display: keep it at the interpolated mouse position, but clamp
        // it to the FIRST wall hit when the mouse sits inside/beyond terrain, so
        // the remote anchor never sinks into a wall.
        let anchorX = rec.ax, anchorY = rec.ay, anchorZ = rec.az;
        if (rec.hasAnchor && firstHit) {
            const adx = rec.ax - worldX;
            const ady = rec.ay - worldY;
            const anchorDist = Math.sqrt(adx * adx + ady * ady);
            if (firstHitRun + 0.5 < anchorDist) {
                const back = Math.max(0, firstHitRun - 2);
                anchorX = startX + ux0 * back;
                anchorY = startY + uy0 * back;
                anchorZ = traceZ;
            }
        }
        updateAnchor(rec, alpha, anchorX, anchorY, anchorZ);
    } catch (_) { /* never break the frame */ }
}

function killDots(rec: IAimLine): void {
    if (rec.dots) {
        for (let i = 0; i < rec.dots.length; i++) {
            const dot = rec.dots[i];
            if (dot && !dot._killed) {
                try { dot.kill(); } catch (_) { /* ignore */ }
            }
            rec.dots[i] = null;
        }
    }
    if (rec.anchorEnt && !rec.anchorEnt._killed) {
        try { rec.anchorEnt.kill(); } catch (_) { /* ignore */ }
    }
    rec.anchorEnt = null;
    rec.hasAnchor = false;
    rec.hasAnchorTarget = false;
    rec.alpha = 0;
    rec.target = 0;
}

function tick(): void {
    try {
        const m = getMain && getMain();
        if (!m || !(ig as any).game || !(ig as any).game.playerEntity) {
            for (const name in lines) killDots(lines[name]);
            for (const name in lines) delete lines[name];
            return;
        }
        const opacity = pickOpacity();
        const party = m.partyMembers || [];
        const shown: { [name: string]: boolean } = {};
        for (let i = 0; i < party.length; i++) {
            const name = party[i];
            const pl: any = m.players[name];
            const ent = pl && pl.entity;
            let rec = lines[name];
            if (!rec) {
                rec = {
                    dots: [], alpha: 0, target: 0, dir: { x: 0, y: 1 }, hasDir: false,
                    ax: 0, ay: 0, az: 0, hasAnchor: false,
                    tx: 0, ty: 0, tz: 0, hasAnchorTarget: false,
                    anchorEnt: null, ent: null,
                };
                lines[name] = rec;
            }
            rec.ent = ent;
            const active = !!(pl && pl._mpAimLine) && !!ent && !ent._killed && !ent._hidden
                && !pl._mpCutscene && !pl._mpSoftDead && opacity > 0;
            rec.target = active ? opacity : 0;
            const dt = (typeof (ig as any).system.actualTick === 'number') ? (ig as any).system.actualTick
                : ((typeof (ig as any).system.tick === 'number') ? (ig as any).system.tick : 0);
            if (active) {
                if (typeof pl._mpAimDirX === 'number' && isFinite(pl._mpAimDirX)
                    && typeof pl._mpAimDirY === 'number' && isFinite(pl._mpAimDirY)) {
                    rec.dir.x = pl._mpAimDirX;
                    rec.dir.y = pl._mpAimDirY;
                    rec.hasDir = true;
                } else {
                    rec.hasDir = false; // fall back to the mirror's face direction
                }
                // Anchor target (owner's actual mouse/crosshair world position).
                // Snap on the first sample, then exponential-lerp toward each new
                // packet so the anchor (and therefore the line) moves smoothly.
                if (typeof pl._mpAimAnchorX === 'number' && isFinite(pl._mpAimAnchorX)
                    && typeof pl._mpAimAnchorY === 'number' && isFinite(pl._mpAimAnchorY)
                    && typeof pl._mpAimAnchorZ === 'number' && isFinite(pl._mpAimAnchorZ)) {
                    rec.tx = pl._mpAimAnchorX;
                    rec.ty = pl._mpAimAnchorY;
                    rec.tz = pl._mpAimAnchorZ;
                    if (!rec.hasAnchorTarget || !rec.hasAnchor) {
                        rec.ax = rec.tx;
                        rec.ay = rec.ty;
                        rec.az = rec.tz;
                        rec.hasAnchor = true;
                    } else {
                        const k = Math.min(1, dt * ANCHOR_LERP);
                        rec.ax += (rec.tx - rec.ax) * k;
                        rec.ay += (rec.ty - rec.ay) * k;
                        rec.az += (rec.tz - rec.az) * k;
                    }
                    rec.hasAnchorTarget = true;
                }
            }
            rec.alpha += (rec.target - rec.alpha) * Math.min(1, dt * FADE_RATE);
            if (Math.abs(rec.target - rec.alpha) < 0.002) rec.alpha = rec.target;
            if (rec.alpha > 0.001) {
                updateLine(rec, ent);
            } else {
                for (let j = 0; j < MAX_DOTS; j++) if (rec.dots[j]) hideDot(rec.dots[j]);
                if (rec.target <= 0 && rec.dots.length) {
                    // Fully faded out with no coming state — drop the entities.
                    killDots(rec);
                }
            }
            shown[name] = true;
        }
        // Players who left the party (or disconnected) fade/destroy immediately.
        for (const name in lines) {
            if (shown[name]) continue;
            const rec = lines[name];
            rec.target = 0;
            rec.alpha = 0;
            killDots(rec);
            delete lines[name];
        }
    } catch (_) { /* a visual failure must never break the frame */ }
}

/** Install the per-frame teammate aim-line renderer (idempotent). */
export function installPlayerAimLines(getter: () => Multiplayer | undefined): void {
    if (installed) return;
    if (typeof simplify === 'undefined' || typeof ig === 'undefined') return;
    installed = true;
    getMain = getter;
    simplify.registerUpdate(() => { try { tick(); } catch (_) { /* ignore */ } });
}
