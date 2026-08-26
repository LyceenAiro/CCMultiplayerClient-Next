import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import type { INetQuality, NetTier } from '../connection';
import { getMpUiScale } from './uiScale';
import { showMpToast } from './toasts';
import { openPrivateChannel } from './chatBox';

/**
 * Round 24: network-quality DIAMOND badges on the party-HUD portraits and the
 * player's element-mode indicator, plus hover tooltips (ping/loss on a badge,
 * member name + level on a portrait). Reworked to PIXEL-ART scanline diamonds
 * (no rotation / anti-aliasing, matching the in-game UI) — see drawDiamond.
 *
 * WHY RENDERER DRAW-STEPS, NOT RAW 2D CONTEXT: a raw `ig.system.context` draw
 * inside a gui `draw()` override runs BEFORE the element's transform is applied —
 * the gui collects draw-steps during onDeferredUpdate and applies their transforms
 * later in renderer.draw(), so a direct-context draw can't be positioned reliably.
 * The ig.GuiRenderer's plain addColor draw-steps ARE applied in the element's own
 * space, so the badge tracks the portrait/element automatically at the correct
 * scale — the pixel coords below are element-local integers.
 *
 * Hover hit-testing uses the engine-maintained `hook.screenCoords` rect (seeded
 * here; ig.gui recomputes it every frame in gui coords) vs `ig.input.mouse` —
 * which the engine compares against screenCoords in _updateGuiMouse, so they share
 * one coordinate space. Tooltips are a single fixed-position DOM div (the mod's
 * CJK-safe font stack, pointer-events:none) repositioned from `ig.input.mouse` via
 * `ig.system.getDrawPos`.
 */

/** Tier -> fill color for the diamond (spec: green/yellow/orange/red). */
const TIER_COLORS: Record<NetTier, string> = {
    green: '#4caf50',
    yellow: '#ffc107',
    orange: '#ff9800',
    red: '#f44336',
};
/** Round 27 (item 2): the diamond of a teammate who is OFF our map renders grey
 * (instead of a live tier color) and its hover tooltip says 不在同一房间. */
const OFFMAP_COLOR = '#8a8a92';

/** Same thresholds as SocketIOConnector.computeNetTier (loss dominates, then
 * latency). Used locally so member badges can tier a RELATIVE ping. */
function tierFor(ping: number, lossPct: number): NetTier {
    if (lossPct > 50 || ping > 300) return 'red';
    if (lossPct > 20 || ping > 150) return 'orange';
    if (lossPct > 5 || ping > 75) return 'yellow';
    return 'green';
}

/** Subtle dark outline behind the diamond so it reads on any portrait. */
const BADGE_OUTLINE = '#16161f';


/** Diamond half-sizes (integer gui px). Pixel-diamond rows are 2*(h-|dy|)+1 px, so
 * the fill is 2h+1 px wide and the outline 2(h+1)+1 px. Self badge = 50% of the old
 * 9px fill (h=2 → 5px fill / 7px outline); member badge = 25% (h=1 → 3px / 5px). */
const BADGE_HALF_SELF = 2;
const BADGE_HALF_MEMBER = 1;

/** Badge center offsets (gui px). The member badge sits neatly in the portrait's
 * top-left corner at (3,3). The self badge has TWO anchors, both StatusHudGui-local
 * and element-INDEPENDENT: MINIMIZED (normal play) it sits at the fixed (6,6) icon-
 * box spot; EXPANDED (element switch display / Shift quick menu / backpack menu —
 * gui.selectBg true) it rides the element WHEEL (elementBgGui), not the sliding
 * current-element icon, at wheel-origin + (14,14) — OUTSIDE the wheel bg's solid
 * diamond (measured from status-gui.png: the 80x80 wheel's top-left outer edge is
 * the x+y=39 diagonal, vertices (39,0)/(0,39)). The badge is itself a diamond whose
 * UI-facing edge sits at x+y = 2*off+3 = 31, so the badge<->wheel gap is
 * (39-31)/sqrt2 = 5.7 gui px — matched to the MINIMIZED gap (box diamond edge
 * x+y=22 vs badge edge x+y=15 -> 5.0 px). The old +17 spot left only 1.4 px (edge
 * kissing the diamond); the +26 spot sat ON the cold<->wave connector line. Riding
 * the sliding StatusElementModeGui itself was the fire-element bug: heat's slot is
 * the bottom (35,59), so the badge jumped across the wheel per selected element.
 * Menu mode shifts the wheel (+2,+21) and the badge follows. */
const BADGE_OFF_MEMBER = 3;
const BADGE_SELF_POS = 6;
const BADGE_OFF_WHEEL = 14;
/** Badge hover target is the diamond plus a small pad for easy hovering. */
const BADGE_HOVER_PAD = 2;

/** One install per game session (same pattern as the other installers). */
let installed = false;
let mpGetMain: (() => Multiplayer | undefined) | null = null;

/** Latest quality, refreshed once per frame by the pump. */
let mpQuality: INetQuality | null = null;

/** One hoverable rect collected during this frame's gui draws, consumed by the
 * pump on the next frame. Badges are pushed after portraits and win tie-breaks. */
interface HoverTarget {
    x: number; y: number; w: number; h: number;
    kind: 'badge' | 'portrait';
    name?: string;
    level?: number;
    /** Round 27 (item 2): this member is off our map — grey diamond + tooltip. */
    offMap?: boolean;
    /** Member badge tooltip = the MEMBER's own server link only: their ping
     * (relayed ~1/s via playerPing) plus the loss %, in the same format as the
     * self badge. (The diamond TIER still uses the relative link — see
     * collectMemberHud — only the hover text changed.) */
    peerPing?: number;
    lossPct?: number;
}
let hoverTargets: HoverTarget[] = [];

/** The single reusable tooltip div (null until first shown). */
let mpTooltip: JQuery | null = null;
let tipStyleInstalled = false;

/** True while badges should render: connected + actually in a game world. The HUD
 * guis only draw in-game anyway; this is the belt-and-braces connection gate. */
function netBadgeActive(): boolean {
    try {
        const m = mpGetMain && mpGetMain();
        if (!m) return false;
        const conn: any = m.connection;
        if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return false;
        const g: any = (ig as any).game;
        if (!g || !g.playerEntity) return false;
        return true;
    } catch (_) { return false; }
}

/** In a game menu? Tooltips/badges are in-game-only; this hides a stale tooltip
 * the moment a menu opens (mirrors the net-HUD overlay's anyMenuOpen gate). */
function anyMenuOpen(): boolean {
    try {
        const menu: any = (sc as any).menu;
        return !!(menu && menu.menuStack && menu.menuStack.length > 0);
    } catch (_) { return false; }
}

/** Draw a PIXEL-ART scanline diamond (no setRotate/setPivot, no anti-aliasing —
 * matches the in-game UI). For integer half-size `h`, one addColor rect per row:
 * for dy in -h..h, rowWidth = 2*(h-|dy|)+1 pixels centered at (cx, cy+dy). The
 * outline backs the fill as a diamond of half-size h+1 drawn FIRST (same scanline
 * loop), then the tier-color diamond of half-size h on top. Coords are element-local
 * integers (the gui renderer applies the element transform), so the diamond lands
 * exactly at the badge offset. */
function drawDiamond(renderer: any, cx: number, cy: number, h: number, color: string): void {
    for (let dy = -(h + 1); dy <= h + 1; dy++) {
        const half = (h + 1) - Math.abs(dy);
        renderer.addColor(BADGE_OUTLINE, cx - half, cy + dy, half * 2 + 1, 1);
    }
    for (let dy = -h; dy <= h; dy++) {
        const half = h - Math.abs(dy);
        renderer.addColor(color, cx - half, cy + dy, half * 2 + 1, 1);
    }
}

/** Ensure `hook.screenCoords` exists so ig.gui keeps it current every frame
 * (screenCoords is normally only allocated for mouse-recorded hooks; seeding it
 * here has no input side-effects). Seeds the hook AND every child hook of the
 * instrumented gui — MemberHudGui owns child HUD hooks (HP/SP bars, portrait)
 * that the engine's _updateGuiMouse and hit-testing can touch, so EVERY one must
 * carry a rect or a hover can crash on a missing one. Returns the (now valid) rect. */
function ensureScreenCoords(h: any): any {
    if (!h.screenCoords) {
        h.screenCoords = {
            x: 0,
            y: 0,
            w: h.size ? h.size.x : 0,
            h: h.size ? h.size.y : 0,
            active: false,
            zIndex: 0,
        };
    }
    const kids = h.children;
    if (kids && kids.length) {
        for (let i = 0; i < kids.length; i++) {
            if (kids[i] && !kids[i].screenCoords) {
                try { ensureScreenCoords(kids[i]); } catch (_) { /* one bad child must not stop the rest */ }
            }
        }
    }
    return h.screenCoords;
}

/** Round 27 (item 2): resolve the off-map state of the party mate a MemberHudGui
 * renders. Returns undefined when the mate is on our map (or unknown -> show). */
function memberOffMap(model: any): boolean {
    try {
        const name = model ? (model._mpName || model.name) : undefined;
        if (!name) return false;
        const m = mpGetMain && mpGetMain();
        if (m && typeof (m as any).isPartyMateOnMap === 'function') {
            return !(m as any).isPartyMateOnMap(name);
        }
    } catch (_) { /* ignore */ }
    return false;
}

/** Injected into sc.MemberHudGui.updateDrawables: diamond badge at the portrait's
 * top-left + a hoverable portrait rect (name/level come from the member model).
 * Round 27 (item 2): when the mate is OFF our map the diamond renders grey and the
 * badge hover target is tagged offMap (tooltip = 不在同一房间). */
function collectMemberHud(gui: any, renderer: any): void {
    if (!netBadgeActive()) return;
    const h = gui.hook;
    const sc = ensureScreenCoords(h);
    // Portrait hover target first, badge after — the pump's topmost-wins scan
    // iterates last-pushed first, so the badge (drawn on top) wins overlaps.
    const model: any = gui.model;
    const offMap = memberOffMap(model);
    const name: string = model ? String(model._mpName || model.name || '') : '';
    // 1.71.9 (issue 5): member DIAMONDS still tier on the RELATIVE link between
    // us and that member (my RTT/2 to the server + the member's RTT/2, the sum of
    // both half-trips). The hover TOOLTIP, however, reports only the member's own
    // server link: their route is `main.remotePings[name]` (their own server RTT,
    // ~1/s), so resolve it even when our own probe hasn't answered yet.
    let relPing: number | undefined;
    let myPing: number | undefined;
    let peerPing: number | undefined;
    let lossPct: number | undefined;
    let tier: NetTier | null = null;
    if (!offMap && name) {
        try {
            const m = mpGetMain && mpGetMain();
            const q = m && m.connection && typeof m.connection.getNetQuality === 'function'
                ? m.connection.getNetQuality() : null;
            const local = q && q.known ? q : null;
            const peer = m && m.remotePings && typeof m.remotePings[name] === 'number' ? m.remotePings[name] : -1;
            if (peer >= 0) peerPing = Math.round(peer);
            if (local) {
                myPing = local.ping >= 0 ? Math.round(local.ping) : undefined;
                lossPct = local.lossPct || 0;
                if (peerPing != null) {
                    relPing = Math.round((Number(myPing) + Number(peerPing)) / 2);
                } else {
                    relPing = myPing; // peer probe unknown -> fall back to our route
                }
                tier = tierFor(relPing != null ? relPing : 0, lossPct);
            }
        } catch (_) { /* fall back to the shared local quality below */ }
    }
    const q = mpQuality;
    const tierColor = offMap ? OFFMAP_COLOR : (tier ? TIER_COLORS[tier] : (q ? TIER_COLORS[q.tier] : OFFMAP_COLOR));
    const hasBadge = !!q || offMap;
    // ROUND 30 (item 5): hide an off-map member's HP/SP/EXP bars by zeroing the
    // child guis' hook localAlpha. The engine's draw gate is `x.localAlpha > 0`
    // on EACH hook (updateDrawables is skipped entirely at 0), and localAlpha
    // does NOT propagate to children — so the background frame, hpBar and spBar
    // must each be zeroed. A skip in MemberHpExpSpGui.updateDrawables alone only
    // hid the background (its children are drawn separately by the renderer).
    // Nothing else writes these hooks' localAlpha (the engine only sets it on
    // StatusHudGui's own hook), so per-frame write-on-change is safe.
    try {
        const bars: any = gui.hpExpSpGui;
        if (bars) {
            const want = offMap ? 0 : 1;
            const hookList: any[] = [bars.hook];
            if (bars.hpBar && bars.hpBar.hook) hookList.push(bars.hpBar.hook);
            if (bars.spBar && bars.spBar.hook) hookList.push(bars.spBar.hook);
            for (const hk of hookList) {
                if (hk && hk.localAlpha !== want) hk.localAlpha = want;
            }
        }
    } catch (_) { /* a bar-hide failure must never break the HUD draw */ }
    hoverTargets.push({
        x: sc.x, y: sc.y, w: sc.w, h: sc.h, kind: 'portrait',
        name: name || undefined,
        level: model && typeof model.level === 'number' ? model.level : undefined,
        offMap,
    });
    if (hasBadge) {
        drawDiamond(renderer, BADGE_OFF_MEMBER, BADGE_OFF_MEMBER, BADGE_HALF_MEMBER, tierColor);
        const pad = BADGE_HALF_MEMBER + BADGE_HOVER_PAD;
        hoverTargets.push({
            x: sc.x + BADGE_OFF_MEMBER - pad, y: sc.y + BADGE_OFF_MEMBER - pad,
            w: pad * 2, h: pad * 2, kind: 'badge', offMap,
            name: name || undefined, peerPing, lossPct,
        });
    }
}

/** The 30x30 yellow diamond fill (src: status-gui.png 64,112,40,40 — the SAME
 * sprite the own HUD's StatusElementModeGui fills the element slot with),
 * pre-rendered into an offscreen canvas once per ui-scale. Sampled from a RAW
 * DOM image (not the engine's nearest-neighbour pre-scaled ig.Image data) with
 * bilinear smoothing ON — that is what kills the staircase jaggies on the
 * diamond outline. Returns null while the raw sheet is still loading — the
 * overlay just skips a few frames on its very first show. */
let mpOvFillRaw: HTMLImageElement | null = null;
let mpOvFillImg: any = null;
let mpOvFillScale = 0;

function getOverloadFillImage(): any {
    const k: number = ((ig as any).system && (ig as any).system.scale) || 1;
    if (mpOvFillImg && mpOvFillScale === k) return mpOvFillImg;
    try {
        if (!mpOvFillRaw) {
            const raw = new Image();
            raw.onload = () => { mpOvFillRaw = raw; };
            raw.src = ((ig as any).root || '') + 'media/gui/status-gui.png';
            return null;
        }
        const size = Math.max(1, Math.round(30 * k));
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true; // smooth outline (spec: 去锯齿)
        ctx.drawImage(mpOvFillRaw, 64, 112, 40, 40, 0, 0, size, size);
        // Minimal ig.Image duck: draw() only touches loaded/width/height/filtered/data.
        const img: any = Object.create((ig as any).Image.prototype);
        img.data = canvas;
        img.width = 30;
        img.height = 30;
        img.loaded = true;
        img.filtered = {};
        mpOvFillImg = img;
        mpOvFillScale = k;
        return img;
    } catch (_) { return null; }
}

/** Injected next to collectMemberHud: the teammate's ELEMENT OVERLOAD as an
 * overlay floating on the portrait, styled like the own HUD's element load fill
 * (StatusElementModeGui): the yellow diamond fill sprite rising from the bottom
 * of the diamond, blinking faster as the load climbs past 0.5/0.75/0.9 — with a
 * reduced peak alpha (0.55) so the face stays readable. The 30px diamond is
 * centred on the head (head: 24x24 at (0,-2), centre (12,10)) and the fill is
 * bottom-aligned inside it, exactly like the vanilla slot. Hidden at zero load.
 * Data: updatePlayerStats (el/ov) -> PartyMemberModel._mpElementLoad/_mpOverload. */
function drawMemberOverloadOverlay(gui: any, renderer: any): void {
    if (!netBadgeActive()) return;
    const model: any = gui && gui.model;
    if (!model || !model._mpName) return; // remote players only, never native bots
    const overload: boolean = model._mpOverload === true;
    let load = (typeof model._mpElementLoad === 'number') ? model._mpElementLoad : 0;
    if (overload) load = 1;
    if (load <= 0.01) return;
    // Vanilla: d = ceil(load*33)+4 on a 40px slot -> *0.75 on our 30px diamond.
    let d = Math.ceil(load * 24.75) + 3;
    if (d > 30) d = 30;
    // Blink intervals: vanilla 2/1/0.5/0.25 halved to 4/2/1/0.5 (spec: 呼吸频率
    // 降低一半 — the overlay breathes at half the own HUD's pace).
    let interval = 4;
    if (load >= 0.9) interval = 0.5; else if (load >= 0.75) interval = 1; else if (load >= 0.5) interval = 2;
    const t = (gui._mpOverloadTimer = ((gui._mpOverloadTimer || 0) + ((ig as any).system.actualTick || 0)) % 8);
    let c = (t % interval) / interval;
    c = c < 0.5 ? c * 2 : (1 - c) * 2; // 0..1 triangle blink
    if (c <= 0.02) return;
    const img = getOverloadFillImage();
    if (!img) return;
    // Diamond frame: x[-2..28], y[-2..28] — 30px centred on (13,13). Calibrated
    // over three rounds of screenshots: the head graphic's own margins are
    // asymmetric (face centre ~12.5,12.5) and the plate's bottom shadow weighs
    // in; the perceived centre sits slightly down-right of the plate's
    // geometric centre (12,12). Fill rises from the frame's bottom edge
    // (y=28); blink peak alpha 0.75.
    renderer.addGfx(img, -2, 28 - d, 0, 30 - d, 30, d).setAlpha(c * 0.75);
}

/** 1.75.x (self ping semantics): the SELF badge's latency = the EFFECTIVE
 * end-to-end link for this client's gameplay. Host: its own RTT to the server (the
 * host's world is the authority, one leg away). Member: own RTT + the host's RTT —
 * every member input travels member->server->host and the authoritative state comes
 * back the same way, so the two legs sum. The host's RTT rides the playerPing relay
 * (remotePings[instanceHost], ~1/s); host unknown / report not in yet / negative
 * sample -> fall back to the own RTT alone. The same value tiers the diamond, so
 * color and tooltip never disagree. */
function selfEffectivePing(): { ping: number; lossPct: number } | null {
    const q = mpQuality;
    if (!q) return null;
    let ping = q.ping;
    try {
        const m: any = mpGetMain && mpGetMain();
        if (m && !m.host) {
            const hn: any = m.instanceHost;
            const hp: number = (hn && m.remotePings && typeof m.remotePings[hn] === 'number') ? m.remotePings[hn] : -1;
            if (q.ping >= 0 && hp >= 0) ping = Math.round(q.ping + hp);
        }
    } catch (_) { /* fall back to the own RTT */ }
    return { ping, lossPct: q.lossPct };
}

/** Change-gated badge-anchor diagnostic (1.75.x): logged once per anchor CHANGE
 * so a retest can tell detection failures (no log on Shift/switch/backpack) from
 * positioning failures (log shows the wheel anchor but the diamond didn't move). */
let _mpBadgeAnchor = '';

/** 1.75.x: the badge's EASED StatusHudGui-local position. Anchor changes (minimized
 * <-> wheel) glide exponentially (tau 80ms -> settles in ~0.3s) instead of snapping;
 * a >40px jump (first frame / reappear after the HUD hid) snaps instead of flying
 * across the screen. */
let _mpBadgePos: { x: number; y: number } | null = null;

/** Injected into sc.StatusElementModeGui.updateDrawables: the self badge. 1.75.x:
 * two element-INDEPENDENT anchors (see the constants block) — minimized: fixed
 * (6,6); expanded: the wheel's origin + (17,17), OUTSIDE the ring's top-left edge,
 * reading elementBgGui's live hook.pos + currentState offset so the badge follows
 * the wheel through its menu slide animations but NEVER the per-element slot this
 * gui itself slides to. Anchor switches ease smoothly via _mpBadgePos (no snap).
 * EXPANDED is detected from the WHEEL's own state (currentStateName not HIDDEN* —
 * StatusElementBgGui sits in HIDDEN/HIDDEN_MENU during normal play and goes
 * DEFAULT/QUICKMENU/MENU for the element-switch display, the Shift quick menu and
 * the backpack respectively), with gui.selectBg as a secondary signal — the state
 * machine is the on-screen truth, the flag alone proved unreliable. Subtracting
 * this gui's live hook.pos converts the StatusHudGui-local target back into
 * element-local draw coords. Latency shown/tiered is the EFFECTIVE self link. */
function collectElementHud(gui: any, renderer: any): void {
    if (!netBadgeActive()) return;
    const h = gui.hook;
    const scr = ensureScreenCoords(h);
    const eff = selfEffectivePing();
    if (!eff) return;
    let tx = BADGE_SELF_POS, ty = BADGE_SELF_POS;
    let anchor = 'min';
    let wheelState = '';
    try {
        const hud: any = (sc as any).gui && (sc as any).gui.statusHud;
        const bg: any = hud && hud.elementBgGui;
        const bh: any = bg && bg.hook;
        wheelState = (bg && typeof bg.currentStateName === 'string') ? bg.currentStateName : '';
        const wheelShown = !!(bh && bh.pos && wheelState && wheelState.indexOf('HIDDEN') !== 0);
        if (wheelShown || gui.selectBg) {
            if (bh && bh.pos) {
                const st: any = bh.currentState || {};
                tx = bh.pos.x + (typeof st.offsetX === 'number' ? st.offsetX : 0) + BADGE_OFF_WHEEL;
                ty = bh.pos.y + (typeof st.offsetY === 'number' ? st.offsetY : 0) + BADGE_OFF_WHEEL;
                anchor = 'wheel';
            }
        }
    } catch (_) { /* keep the minimized spot */ }
    // 1.75.x: ease the drawn position toward the anchor target (see _mpBadgePos).
    try {
        const dt: number = ((ig as any).system && typeof (ig as any).system.actualTick === 'number') ? (ig as any).system.actualTick : 0.016;
        if (!_mpBadgePos || Math.abs(_mpBadgePos.x - tx) > 40 || Math.abs(_mpBadgePos.y - ty) > 40) {
            _mpBadgePos = { x: tx, y: ty };
        } else {
            const k = 1 - Math.exp(-dt / 0.08);
            _mpBadgePos.x += (tx - _mpBadgePos.x) * k;
            _mpBadgePos.y += (ty - _mpBadgePos.y) * k;
        }
    } catch (_) { _mpBadgePos = { x: tx, y: ty }; }
    const px: number = (h && h.pos && typeof h.pos.x === 'number') ? h.pos.x : 0;
    const py: number = (h && h.pos && typeof h.pos.y === 'number') ? h.pos.y : 0;
    const offX = Math.round(_mpBadgePos.x - px);
    const offY = Math.round(_mpBadgePos.y - py);
    const diag = anchor + '(' + tx + ',' + ty + ')';
    if (diag !== _mpBadgeAnchor) {
        _mpBadgeAnchor = diag;
        try { console.log('[mpbadge] anchor -> ' + diag + ' selectBg=' + !!gui.selectBg + ' wheel=' + (wheelState || '?') + ' guiPos=' + Math.round(px) + ',' + Math.round(py)); } catch (_) { /* ignore */ }
    }
    drawDiamond(renderer, offX, offY, BADGE_HALF_SELF, TIER_COLORS[tierFor(eff.ping, eff.lossPct)]);
    const pad = BADGE_HALF_SELF + BADGE_HOVER_PAD;
    hoverTargets.push({
        x: scr.x + offX - pad, y: scr.y + offY - pad,
        w: pad * 2, h: pad * 2, kind: 'badge',
    });
}

// --------------------------------------------------------------- DOM tooltip

/** Inject the tooltip stylesheet exactly once. */
function ensureTipStyle(): void {
    if (tipStyleInstalled) return;
    tipStyleInstalled = true;
    const style = document.createElement('style');
    style.id = 'mpNetBadgeTipStyle';
    style.textContent = `
.mpNetBadgeTip { position: fixed; z-index: 10003; padding: 4px 9px;
    background: rgba(6, 18, 30, 0.94); border: 1px solid #6fc7ff; border-radius: 4px;
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
    font-size: 12px; line-height: 1.4; white-space: nowrap; pointer-events: none;
    box-shadow: 0 0 10px rgba(111, 199, 255, 0.3); }
`;
    try {
        if (document.head) document.head.appendChild(style);
        else if (document.documentElement) document.documentElement.appendChild(style);
    } catch (_) { /* document not ready — the tooltip would fail anyway */ }
}

/** Lazily create the (single) tooltip div. Returns null when no body yet. */
function ensureTooltip(): JQuery | null {
    if (typeof document === 'undefined' || !document.body) return null;
    if (mpTooltip && document.body.contains(mpTooltip[0])) return mpTooltip;
    mpTooltip = $('<div class="mpNetBadgeTip"></div>');
    $(document.body).append(mpTooltip);
    return mpTooltip;
}

/** Show the tooltip near the mouse. `mx/my` are in gui/game coords; getDrawPos
 * converts to screen px. ROUND 30 (item 6): getDrawPos multiplies by
 * `ig.system.scale` — the scale the canvas's internal pixel buffer was sized
 * with — but the canvas's CSS box is sized independently (setCanvasSize sets
 * style.width/height and screenWidth from the window). When the two differ
 * (HiDPI / non-native window size), getDrawPos under/over-shoots by a factor
 * that grows with distance from the top-left origin — exactly the reported
 * drift. The engine's own mouse path (getMouseCoords) reads raw CSS px then
 * scales by `width/screenWidth`, so the correct game->CSS factor is
 * `screenWidth/width` — NOT `system.scale`. Recompute from the canvas's real
 * CSS rect so the tooltip tracks the cursor at any zoom/DPR. */
function showTooltip(text: string, mx: number, my: number): void {
    const tip = ensureTooltip();
    if (!tip) return;
    ensureTipStyle();
    const ui = getMpUiScale();
    let x = mx + 14 * ui, y = my + 16 * ui;
    try {
        const sys: any = (ig as any).system;
        const canvas: any = sys && sys.canvas;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            const scaleX = (sys.width > 0 && rect.width > 0) ? rect.width / sys.width : (sys.scale || 1);
            const scaleY = (sys.height > 0 && rect.height > 0) ? rect.height / sys.height : (sys.scale || 1);
            x = rect.left + mx * scaleX + 14 * ui;
            y = rect.top + my * scaleY + 16 * ui;
        } else if (sys && typeof sys.getDrawPos === 'function') {
            x = sys.getDrawPos(mx) + 14 * ui; y = sys.getDrawPos(my) + 16 * ui;
        }
    } catch (_) { /* fall back to raw coords */ }
    // 1.71.10: the tooltip root is zoomed and Chromium multiplies authored
    // left/top, so the DESIRED CSS position is divided by the zoom factor. The
    // keep-on-screen clamp below works in real (post-zoom) CSS px.
    const setAt = (left: number, top: number): void => {
        tip.css({ left: Math.round(left / ui), top: Math.round(top / ui) }).text(text).show();
    };
    setAt(x, y);
    // Keep it fully on-screen (the tooltip is nowrap; measure after show).
    const rect = tip[0].getBoundingClientRect();
    const maxX = (window.innerWidth || document.documentElement.clientWidth) - rect.width - 4;
    const maxY = (window.innerHeight || document.documentElement.clientHeight) - rect.height - 4;
    if (rect.left > maxX || rect.top > maxY) {
        setAt(Math.max(4, Math.min(maxX, x)), Math.max(4, Math.min(maxY, y)));
    }
}

function hideTooltip(): void {
    // Z3: hide AND clear the stale content — a hidden tooltip must not keep its
    // last position/ping/loss text and re-show it after a hover gap.
    if (mpTooltip) { try { mpTooltip.hide().text(''); } catch (_) { /* ignore */ } }
}

// ------------------------------------------- party-avatar click action menu

/** Latest frame's hover targets, stashed by the pump so the click handler can
 * hit-test party plates at any moment (hoverTargets itself is cleared every
 * frame by the gui draws). */
let lastTargets: HoverTarget[] = [];
/** The open action menu + the teammate it belongs to (for click-toggle). */
let mateMenu: HTMLElement | null = null;
let mateMenuFor = '';
let mateMenuStyleInstalled = false;

function closeMateMenu(): void {
    try { if (mateMenu && mateMenu.parentNode) mateMenu.parentNode.removeChild(mateMenu); } catch (_) { /* ignore */ }
    mateMenu = null;
    mateMenuFor = '';
}

function ensureMateMenuStyle(): void {
    if (mateMenuStyleInstalled) return;
    mateMenuStyleInstalled = true;
    const style = document.createElement('style');
    style.id = 'mpMateMenuStyle';
    style.textContent = [
        '.mpMateMenu { position: fixed; z-index: 9100; min-width: 168px; max-width: 240px;',
        '  padding: 5px; background: rgba(6, 18, 30, 0.97);',
        '  border: 1px solid #6fc7ff; border-radius: 6px;',
        '  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55), 0 0 14px rgba(111, 199, 255, 0.25);',
        "  font-family: 'Noto Sans SC', 'Segoe UI', sans-serif; }",
        '.mpMateMenu .mpMateMenuName { padding: 5px 8px 7px 8px; font-size: 13px; color: #dff3ff;',
        '  border-bottom: 1px solid rgba(111, 199, 255, 0.3); margin-bottom: 4px;',
        '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.mpMateMenu button { display: block; width: 100%; box-sizing: border-box;',
        '  margin: 2px 0; padding: 7px 9px; background: rgba(18, 50, 72, 0.9); color: #dff3ff;',
        '  border: 1px solid rgba(111, 199, 255, 0.4); border-radius: 4px;',
        '  font-size: 12.5px; font-family: inherit; text-align: left; cursor: pointer; }',
        '.mpMateMenu button:hover { background: rgba(46, 104, 142, 0.95); }',
        '.mpMateMenu button.mpMateDanger { background: rgba(96, 34, 34, 0.9);',
        '  border-color: rgba(255, 125, 125, 0.55); color: #ffeaea; }',
        '.mpMateMenu button.mpMateDanger:hover { background: rgba(140, 48, 48, 0.95); }',
    ].join('\n');
    try { if (document.head) document.head.appendChild(style); } catch (_) { /* ignore */ }
}

/** DOM client px -> engine gui coords (inverse of showTooltip's conversion:
 * the canvas CSS box scales the internal pixel buffer independently of
 * ig.system.scale on HiDPI / resized windows). */
function cssToGui(clientX: number, clientY: number): { x: number, y: number } | null {
    try {
        const sys: any = (ig as any).system;
        const canvas: any = sys && sys.canvas;
        if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return null;
        const rect = canvas.getBoundingClientRect();
        if (!(rect.width > 0) || !(sys.width > 0)) return null;
        return {
            x: (clientX - rect.left) * (sys.width / rect.width),
            y: (clientY - rect.top) * (sys.height / rect.height),
        };
    } catch (_) { return null; }
}

/** Open the teammate action list at the click point: teleport-to-mate, kick
 * (leader) / leave (member), and add-friend — or 私聊 once already friends. */
function openMateMenu(name: string, clientX: number, clientY: number): void {
    try {
        closeMateMenu();
        const main: any = mpGetMain && mpGetMain();
        const conn: any = main && main.connection;
        if (!main || !conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return;
        ensureMateMenuStyle();
        const menu = document.createElement('div');
        menu.className = 'mpMateMenu';

        const head = document.createElement('div');
        head.className = 'mpMateMenuName';
        head.textContent = name;
        menu.appendChild(head);

        const addBtn = (label: string, cls: string, onClick: () => void): void => {
            const b = document.createElement('button');
            if (cls) b.className = cls;
            b.textContent = label;
            b.addEventListener('click', (ev) => {
                try { ev.stopPropagation(); } catch (_) { /* ignore */ }
                closeMateMenu();
                try { onClick(); } catch (_) { /* an action must never break the HUD */ }
            });
            menu.appendChild(b);
        };

        // 传送到队友身边 — requestRegroup carries the full gating (party check,
        // cutscene stash, cross-map area unlock on the reply).
        addBtn(t('teleportToMate'), '', () => {
            if (typeof main.requestRegroup === 'function') main.requestRegroup(name);
        });

        // 踢出队伍 (I lead) / 退出队伍 (I follow) — same rule as the quick menu.
        const isLeader = !!(main.partyLeader && main.name && main.partyLeader === main.name);
        if (isLeader) {
            addBtn(t('kickParty'), 'mpMateDanger', () => {
                if (typeof conn.partyKick === 'function') conn.partyKick(name);
            });
        } else {
            addBtn(t('leaveParty'), 'mpMateDanger', () => {
                if (typeof conn.partyLeave === 'function') conn.partyLeave();
            });
        }

        // 加好友 — becomes 私聊 once the target is already a friend.
        let friend = false;
        try {
            const party: any = (sc as any).party;
            friend = !!(party && typeof party.isFriend === 'function' && party.isFriend(name));
        } catch (_) { /* ignore */ }
        if (friend) {
            addBtn(t('chatPrivate'), '', () => openPrivateChannel(name, true));
        } else {
            addBtn(t('addFriend'), '', () => {
                if (typeof conn.friendAdd === 'function') {
                    try { conn.friendAdd(name); } catch (_) { /* ignore */ }
                    showMpToast({ title: t('friendRequestSentToast') });
                }
            });
        }

        document.body.appendChild(menu);
        mateMenu = menu;
        mateMenuFor = name;
        // Zoom-aware placement (same math as the chat name menu: authored
        // offsets are pre-zoom, getBoundingClientRect/innerWidth post-zoom).
        const ui = getMpUiScale();
        const mw = (menu.offsetWidth || 180) * ui;
        const mh = (menu.offsetHeight || 130) * ui;
        const pad = 8 * ui;
        const left = Math.max(pad, Math.min(clientX + 6 * ui, window.innerWidth - mw - pad));
        let top = clientY + 6 * ui;
        if (top + mh > window.innerHeight - pad) top = Math.max(pad, clientY - mh - 6 * ui);
        menu.style.left = left / ui + 'px';
        menu.style.top = top / ui + 'px';
    } catch (_) { /* ignore */ }
}

/** ONE capture-phase mousedown listener handles both sides of the menu: a
 * click on a teammate plate opens (or re-opens / toggles) the action list;
 * a click anywhere else closes it; a click INSIDE the menu passes through to
 * the buttons. Registered once from installNetBadge. */
function onHudMouseDown(e: MouseEvent): void {
    try {
        if (e.button !== 0) return;
        if (mateMenu && e.target instanceof Node && mateMenu.contains(e.target)) return;
        let hitName = '';
        if (netBadgeActive() && !anyMenuOpen() && lastTargets.length) {
            const p = cssToGui(e.clientX, e.clientY);
            if (p) {
                // Topmost wins — badges are pushed after portraits, scan in
                // reverse (same order the tooltip pump uses).
                for (let i = lastTargets.length - 1; i >= 0; i--) {
                    const tr = lastTargets[i];
                    if (!tr.name) continue;
                    if (p.x >= tr.x && p.x < tr.x + tr.w && p.y >= tr.y && p.y < tr.y + tr.h) {
                        hitName = tr.name;
                        break;
                    }
                }
            }
        }
        if (hitName) {
            const main: any = mpGetMain && mpGetMain();
            // Only real teammates: never self, never a stale plate after the
            // party broke up.
            if (!main || hitName === main.name
                || !Array.isArray(main.partyMembers) || main.partyMembers.indexOf(hitName) === -1) {
                if (mateMenu) closeMateMenu();
                return;
            }
            // Consume the click: the engine binds mousedown on the canvas in
            // the BUBBLE phase, so swallowing it here in document-capture keeps
            // a plate click from also swinging the melee attack / interacting.
            try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
            if (mateMenu && mateMenuFor === hitName) { closeMateMenu(); return; } // toggle
            openMateMenu(hitName, e.clientX, e.clientY);
            return;
        }
        if (mateMenu) closeMateMenu();
    } catch (_) { /* ignore */ }
}

// --------------------------------------------------------------- pump

/** One per-frame pass: refresh the cached quality and consume the hover targets
 * collected by this frame's (actually last frame's) gui draws. */
function pumpNetBadges(): void {
    let connected = false;
    try {
        const m = mpGetMain && mpGetMain();
        const conn: any = m && m.connection;
        connected = !!conn && typeof conn.isOpen === 'function' && conn.isOpen();
        if (connected && typeof conn.getNetQuality === 'function') {
            const got: INetQuality = conn.getNetQuality();
            mpQuality = got && got.known ? got : null;
        } else {
            mpQuality = null;
        }
    } catch (_) { mpQuality = null; }

    const targets = hoverTargets;
    hoverTargets = [];
    lastTargets = targets; // click hit-testing reads the latest frame's plates

    if (!connected || anyMenuOpen()) closeMateMenu(); // never linger over menus / after drops
    if (!connected || anyMenuOpen() || !targets.length) {
        hideTooltip();
        return;
    }

    const input: any = (ig as any).input;
    const mouse: any = input && input.mouse;
    if (!mouse || typeof mouse.x !== 'number' || typeof mouse.y !== 'number' || mouse.x < 0) {
        hideTooltip();
        return;
    }
    const mx: number = mouse.x;
    const my: number = mouse.y;

    // Topmost target wins; badges are pushed after portraits so they win overlaps.
    let hit: HoverTarget | null = null;
    for (let i = targets.length - 1; i >= 0; i--) {
        const tr = targets[i];
        if (mx >= tr.x && mx < tr.x + tr.w && my >= tr.y && my < tr.y + tr.h) { hit = tr; break; }
    }
    if (!hit) { hideTooltip(); return; }

    let text: string;
    if (hit.kind === 'badge') {
        // ROUND 30 (item 5): an off-map member's BADGE tooltip still explains why
        // the diamond is grey. The PORTRAIT tooltip (below) always shows name +
        // level — the user asked for that to never change to the room warning.
        if (hit.offMap) {
            text = t('notInSameRoom');
        } else if (hit.name) {
            // A MEMBER badge reports ONLY the teammate's own link to the server
            // (their ping, relayed ~1/s) plus the loss % — the same one-line
            // format as the self badge below. Peer report not arrived yet (or
            // our probe still unknown) -> a dash, mirroring the self tooltip.
            const peer = typeof hit.peerPing === 'number' ? Math.round(hit.peerPing) + 'ms' : '—';
            text = t('netPingLabel') + ': ' + peer + '  '
                + t('netLossLabel') + ': ' + (hit.lossPct != null ? hit.lossPct : 0) + '%';
        } else {
            // 1.75.x: the SELF badge reports the EFFECTIVE self link — host: own
            // server RTT; member: own RTT + the host's RTT (selfEffectivePing).
            const eff = selfEffectivePing();
            // 100% loss -> no answered probe -> ping unknown; show a dash instead of -1.
            const ping = eff && eff.ping >= 0 ? Math.round(eff.ping) + 'ms' : '—';
            text = t('netPingLabel') + ': ' + ping + '  '
                + t('netLossLabel') + ': ' + (eff ? eff.lossPct : 0) + '%';
        }
    } else {
        text = (hit.name || '') + '  ' + t('memberLevel') + ' ' + (hit.level != null ? hit.level : '?');
    }
    showTooltip(text, mx, my);
}

/** Start the per-frame pump (idempotent). */
function startPump(): void {
    const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
    if (!s || typeof s.registerUpdate !== 'function') return;
    if ((s as any)._mpNetBadgeLoop) return;
    (s as any)._mpNetBadgeLoop = true;
    s.registerUpdate(() => {
        try { pumpNetBadges(); } catch (_) { /* never break the update loop */ }
    });
}

/** Install the net badges + hover tooltips. Idempotent; safe to call from main.ts
 * next to the other installers. Canvas injects are permanent (they gate on the
 * connection state every frame), so there is no teardown to run. */
export function installNetBadge(getMain: () => Multiplayer | undefined): void {
    if (installed) return;
    if (typeof sc === 'undefined' || typeof ig === 'undefined') {
        console.warn('[multiplayer] net badges: game globals missing');
        return;
    }
    installed = true;
    mpGetMain = getMain;
    // Party-plate click -> teammate action menu (capture so it runs before the
    // canvas's own handlers; it never consumes the event — the game still sees
    // every click).
    try { document.addEventListener('mousedown', onHudMouseDown, true); } catch (_) { /* ignore */ }
    const scAny: any = sc as any;
    if (!scAny.MemberHudGui || !scAny.StatusElementModeGui) {
        console.warn('[multiplayer] net badges: HUD classes not found');
        return;
    }

    scAny.MemberHudGui.inject({
        updateDrawables(this: any, renderer: any) {
            this.parent(renderer);
            try { collectMemberHud(this, renderer); } catch (_) { /* never break the HUD draw */ }
            try { drawMemberOverloadOverlay(this, renderer); } catch (_) { /* never break the HUD draw */ }
        },
    });

    scAny.StatusElementModeGui.inject({
        updateDrawables(this: any, renderer: any) {
            this.parent(renderer);
            try { collectElementHud(this, renderer); } catch (_) { /* never break the HUD draw */ }
        },
    });

    // In DUNGEONS the engine hides the WHOLE party HUD
    // (sc.party.dungeonBlocked -> PartyHudGui HIDDEN) because natively only
    // follower bots sit in the party and bots never enter dungeons. Online the
    // same rule also swallowed REMOTE PLAYERS' HP plates — but remote teammates
    // DO come along. While dungeon-blocked with at least one roster member in
    // the party, keep the container visible and hide only the BOT plates
    // (models without a roster name). Solo / bot-only parties keep the native
    // hide-everything behaviour.
    if (scAny.PartyHudGui && typeof scAny.PartyHudGui.inject === 'function') {
        const applyDungeonPlateVisibility = (hud: any): boolean => {
            let anyOnline = false;
            try {
                const m: any = mpGetMain && mpGetMain();
                const roster: string[] = (m && Array.isArray(m.partyMembers)) ? m.partyMembers : [];
                const guis: any[] = (hud && hud.memberGuis) || [];
                for (const g of guis) {
                    const model: any = g && g.model;
                    const name: string = model ? String(model._mpName || model.name || '') : '';
                    const online = !!name && roster.indexOf(name) !== -1;
                    if (online) anyOnline = true;
                    try { g.doStateTransition(online ? 'DEFAULT' : 'HIDDEN'); } catch (_) { /* ignore */ }
                }
            } catch (_) { /* ignore */ }
            return anyOnline;
        };
        const dungeonOnlineVisible = (): boolean => {
            try {
                const m: any = mpGetMain && mpGetMain();
                const conn: any = m && m.connection;
                if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return false;
                const party: any = (sc as any).party;
                if (!party || typeof party.isDungeonBlocked !== 'function' || !party.isDungeonBlocked()) return false;
                const g: any = (ig as any).game;
                return !!(g && g.playerEntity);
            } catch (_) { return false; }
        };
        scAny.PartyHudGui.inject({
            updateVisibility(this: any) {
                try {
                    if (dungeonOnlineVisible() && applyDungeonPlateVisibility(this)) {
                        // Engine logic minus the dungeon-block clause (level-up
                        // still hides the HUD).
                        const model: any = (sc as any).model;
                        const lvl = !!(model && typeof model.isLevelUp === 'function' && model.isLevelUp());
                        this.doStateTransition(lvl ? 'HIDDEN' : 'DEFAULT');
                        return;
                    }
                    // NOT blocked (left the dungeon / went offline / bot-only):
                    // the engine only transitions the CONTAINER — a plate we hid
                    // would stay HIDDEN forever. Restore any hidden plate first.
                    const guis: any[] = this.memberGuis || [];
                    for (const g of guis) {
                        try { if (g && g.currentStateName === 'HIDDEN') g.doStateTransition('DEFAULT'); } catch (_) { /* ignore */ }
                    }
                } catch (_) { /* fall through to native */ }
                this.parent();
            },
            updatePartySubGui(this: any) {
                this.parent();
                // Roster changes rebuild the plates with default (visible)
                // transitions — re-apply the bot-only hiding while blocked.
                try {
                    if (dungeonOnlineVisible() && applyDungeonPlateVisibility(this)) {
                        const model: any = (sc as any).model;
                        const lvl = !!(model && typeof model.isLevelUp === 'function' && model.isLevelUp());
                        this.doStateTransition(lvl ? 'HIDDEN' : 'DEFAULT');
                    }
                } catch (_) { /* ignore */ }
            },
        });
    }

    // 1.72.0 (dungeon key-HUD overlap): the engine parks the dungeon key counter
    // (sc.KeyHudGui) at y=53 — directly on top of the FIRST party plate (partyGui
    // at y=39, 26px per plate) — because vanilla hides the whole party HUD inside
    // dungeons, so the collision could never happen. Our dungeon override above
    // keeps ONLINE teammates' plates visible in dungeons, so the plates and the
    // key counter overlap. While that override is active, slide the key HUD to
    // just below the lowest visible plate; native y=53 everywhere else.
    if (scAny.KeyHudGui && typeof scAny.KeyHudGui.inject === 'function') {
        // 1.75.x (key-HUD bugfix): what the VANILLA key HUD would show right now —
        // a key counter exists for the current area AND we are inside a dungeon.
        // Every custom hide/show decision below is gated on this, so the counter can
        // never appear outside a dungeon (the old backpack-fade re-showed it
        // unconditionally on menu close, which leaked it into field maps).
        const keyHudVanillaVisible = (keyHud: any): boolean => {
            try {
                const sm: any = (sc as any).map;
                if (!sm || typeof sm.isDungeon !== 'function' || !sm.isDungeon()) return false;
                const areaType = keyHud && keyHud.areaItemType;
                if (areaType == null || typeof sm.getAreaItemId !== 'function') return false;
                return sm.getAreaItemId(areaType) !== -1;
            } catch (_) { return false; }
        };
        const keyHudMenuOpen = (model: any): boolean => {
            try {
                if (!model) return false;
                if (typeof model.isMenu === 'function' && model.isMenu()) return true;
                if (typeof model.isQuickMenu === 'function' && model.isQuickMenu()) return true;
                return false;
            } catch (_) { return false; }
        };
        const repositionKeyHud = (keyHud: any): void => {
            try {
                // invisibleUpdate: our fade state machine lives in this update()
                // pump, which ig.gui SKIPS for HIDDEN hooks unless this flag is set —
                // without it the menu-hidden HUD's pump stopped, the fade never ran,
                // and the next close saw a stale timer and popped instantly (the
                // alternating gone/instant-appear cycle). One-time lazy write.
                try { if (keyHud.hook && !keyHud.hook.invisibleUpdate) keyHud.hook.invisibleUpdate = true; } catch (_) { /* ignore */ }
                const model: any = (sc as any).model;
                const vanillaVisible = keyHudVanillaVisible(keyHud);
                // Backpack / quick-menu fix: while the MAIN MENU (backpack) OR the
                // Shift quick menu is open, hide the key counter outright (user
                // request). Only when the vanilla HUD would show it inside a dungeon
                // do we remember that WE hid it, so closing the menu fades it back.
                // Outside a dungeon the native state stays HIDDEN and no stale
                // _mpMenuHidden latch is ever armed (bug 1).
                if (keyHudMenuOpen(model)) {
                    if (vanillaVisible && keyHud.currentStateName !== 'HIDDEN') {
                        keyHud._mpMenuHidden = true; // WE hid it -> fade back in on close
                        keyHud._mpFadeAt = 0;
                        keyHud.doStateTransition('HIDDEN');
                    } else if (!vanillaVisible) {
                        // Stale latch from an earlier dungeon visit: never re-show here.
                        keyHud._mpMenuHidden = false;
                        keyHud._mpFadeAt = 0;
                        if (keyHud.currentStateName !== 'HIDDEN') keyHud.doStateTransition('HIDDEN');
                    }
                    return;
                }
                if (!model || typeof model.isRunning !== 'function' || !model.isRunning()) {
                    return; // level-up / cutscene: engine owns the key HUD state
                }
                // Fade-back after the backpack / quick menu closes (user request): the
                // engine pops the HUD back INSTANTLY on SUB_STATE_CHANGED (time-0 DEFAULT
                // transition) while the menu's exit zoom is still playing. Undo the
                // pop in the same frame (time-0 HIDDEN, nothing was drawn yet), wait
                // out the exit animation (0.2s HIDDEN fade + 0.3s position restore),
                // then fade in from transparent by ramping hook.localAlpha (0 -> 0.8).
                // 1.75.x: only when the vanilla HUD would still be visible here — a
                // menu close outside a dungeon keeps the counter hidden.
                if (keyHud._mpMenuHidden) {
                    if (!vanillaVisible) {
                        keyHud._mpMenuHidden = false;
                        keyHud._mpFadeAt = 0;
                        if (keyHud.currentStateName !== 'HIDDEN') keyHud.doStateTransition('HIDDEN');
                        return;
                    }
                    const now = Date.now();
                    if (keyHud.currentStateName !== 'HIDDEN') keyHud.doStateTransition('HIDDEN');
                    if (!keyHud._mpFadeAt) keyHud._mpFadeAt = now + 300;
                    if (now < keyHud._mpFadeAt) return; // menu exit zoom still playing
                    keyHud.doStateTransition('DEFAULT'); // time-0; alpha rides localAlpha below
                    const fade = Math.min(1, (now - keyHud._mpFadeAt) / 300);
                    try { if (keyHud.hook) keyHud.hook.localAlpha = 0.8 * fade; } catch (_) { /* ignore */ }
                    if (fade >= 1) { keyHud._mpMenuHidden = false; keyHud._mpFadeAt = 0; }
                    // fall through: the dungeon party-plate offset below still applies
                }
                let y = 53; // native
                const hud: any = scAny.gui && scAny.gui.statusHud;
                const partyHud: any = hud && hud.partyGui;
                // Same condition as the PartyHudGui override below: online,
                // a player exists, and the engine is dungeon-blocking the HUD.
                let dungeonOverride = false;
                try {
                    const m: any = mpGetMain && mpGetMain();
                    const conn: any = m && m.connection;
                    const party: any = (sc as any).party;
                    dungeonOverride = !!(conn && typeof conn.isOpen === 'function' && conn.isOpen()
                        && party && typeof party.isDungeonBlocked === 'function' && party.isDungeonBlocked()
                        && (ig as any).game && (ig as any).game.playerEntity);
                } catch (_) { dungeonOverride = false; }
                if (partyHud && dungeonOverride) {
                    let maxBottom = -1;
                    const guis: any[] = partyHud.memberGuis || [];
                    for (const g of guis) {
                        if (g && g.currentStateName !== 'HIDDEN') {
                            const py = (g.hook && g.hook.pos && typeof g.hook.pos.y === 'number') ? g.hook.pos.y : 0;
                            const bottom = py + 25; // MemberHudGui height
                            if (bottom > maxBottom) maxBottom = bottom;
                        }
                    }
                    if (maxBottom >= 0) y = 39 + maxBottom + 2;
                }
                if (keyHud.hook && keyHud.hook.pos && keyHud.hook.pos.y !== y) keyHud.setPos(0, y);
            } catch (_) { /* never break the HUD */ }
        };
        scAny.KeyHudGui.inject({
            update(this: any) {
                this.parent();
                repositionKeyHud(this);
            },
            updateVisibility(this: any) {
                this.parent();
                repositionKeyHud(this);
            },
        });
    }

    // ROUND 30 (item 5): the off-map bar hide now lives in collectMemberHud (zero
    // the hpExpSpGui/hpBar/spBar hooks' localAlpha — the engine's draw gate skips
    // a hook's draw entirely at localAlpha 0, and unlike a single updateDrawables
    // skip it hides the CHILD bar guis too, which is what was still showing). The
    // old skip-in-updateDrawables approach only hid the background frame.
    startPump();
}
