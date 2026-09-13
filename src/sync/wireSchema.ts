/**
 * 1.79.x (bandwidth): wire encodings for the hot streams
 * (playerState / updatePlayerStats / botState), extended in 1.80.x to the six
 * COMBAT streams (entityState / playerBall / throwBall / projectileState /
 * enemySound / enemySoundStop).
 *
 * Two encodings, negotiated PARTY-WIDE by the server (multiplayer.mpNetSchema):
 *  - 'c' 标准 (default): compact BINARY. The relay payload becomes
 *    { player|from, d: <Uint8Array> } — socket.io transports the array as a
 *    native binary attachment (no base64 inflation on websocket). Stateless
 *    decoding (a FIXED string dictionary + inline fallback), so mixed versions
 *    and per-sender streams can never desync.
 *  - 'd' 调试: short-key JSON with default-omission ({ player|from, k: {...} }).
 *    Human-readable in packet captures; ~45% smaller than legacy.
 *  - 'legacy': today's long-key JSON (old servers / old clients in the party).
 *
 * The server relays re-encode per RECEIVER (it decodes any inbound format into
 * the canonical long-key object first), so a 标准 player, a 调试 player and an
 * old client can share one instance.
 *
 * FIELD PRECISION (chosen below perception thresholds):
 *  - face/aim direction: 2 decimals (±0.01 on a unit vector).
 *  - throwBall dir (0.2.6): NORMALIZED to unit then i16×10000 (±0.0001). The old
 *    i8×100 clamped any |dir|>1.27 to ±1.27, collapsing free-aim throws to the
 *    four diagonals on receivers.
 *  - guard windows (gst/gws): centiseconds.  - ef/df: ×50 (0.02 steps).
 *  - element load: ×20 (matches the 0.05 quantization the sender already does).
 *  - hp/sp/exp: integers (the HUD/mirrors only ever display integers).
 *
 * BINARY LAYOUTS (identical implementation in protocol.js — keep in sync!):
 *  playerState:
 *    u8 flags1: b0 dead b1 cg b2 fl b3 cs b4 al b5 gd b6 hasXa b7 hasCl
 *    u8 flags2: b0 hasAnchor b1 hasEf b2 hasSt
 *    zigvar pos.x, pos.y, pos.z; i8 fx100, fy100; str anim;
 *    [str xa, str xf if hasXa]; var hp, maxHp, sp, maxSp; u8 em;
 *    [str cl if hasCl]; [i8 ax100, ay100 if al]; [zigvar cax, cay, caz if anchor];
 *    u8 gstCs, gwsCs; i8 gw100, gm100, ga100; var def, fc;
 *    [4×u8 ef50 if hasEf]; u8 df50; [5×u8 st if hasSt]; var ggt
 *  updatePlayerStats:
 *    u8 flags: b0 ov b1 hasEl b2 hasEm; var hp, maxHp, sp, maxSp;
 *    [u8 em if hasEm]; [u8 el20 if hasEl]
 *  botState:
 *    str map; u8 count; per bot: str n, zigvar x, y, u8 z, i8 fx100, fy100,
 *    str a, var hp, mh, lv, ex
 *
 * PRIMITIVES:
 *  var    = unsigned LEB128 varint
 *  zigvar = zigzag-encoded varint (signed)
 *  str    = u8 code: 0 = ""; 1..127 = STR_DICT[code-1]; 128 = inline
 *           (varint byte-length + UTF-8 bytes)
 */

/** Fixed string dictionary (wire code = index + 1; MUST match protocol.js). */
const STR_DICT = [
	'idle', 'walk', 'guard', 'dash', 'attack', 'throw', 'hit', 'special', 'charge', 'charged',
	'aim', 'dead', 'jump', 'fall', 'land', 'run', 'talk', 'sit', 'carry', 'push', 'pull',
	'climb', 'ladder', 'swim', 'dodge', 'counter', 'melee', 'ranged',
	'triblader', 'pentafist', 'spheromancer', 'hexacast', 'avenger', 'leatanks', 'player',
	'rookie-harbor', 'rhombus-sqr', 'basin-keep', 'copan', 'bridge', 'autumn-fall', 'arid-fond', 'offbeat',
	'heat-dng', 'cold-dng', 'shock-dng', 'wave-dng', 'tree-dng', 'jungle', 'sohn', 'cargo', 'ship', 'lab', 'math', 'rx',
	// 1.80.x (combat streams): enemy anim/AI-state strings + the entityState
	// target sentinel. Appended at the TAIL so the 1.79.x codes stay stable.
	'default', 'show', 'hide', 'earthIn', 'earthOut', 'walkAround', 'fly', 'spinShield',
	'hitStun', 'knockback', 'spawn', 'vanish', '__host__',
];
const STR_DICT_INDEX: { [s: string]: number } = {};
for (let i = 0; i < STR_DICT.length; i++) STR_DICT_INDEX[STR_DICT[i]] = i + 1;

// ------------------------------------------------------------------ byte writer

class ByteWriter {
	public bytes: number[] = [];
	public u8(v: number): void { this.bytes.push(v & 0xff); }
	public i8(v: number): void { this.bytes.push((v < -128 ? -128 : v > 127 ? 127 : v) & 0xff); }
	public i16(v: number): void {
		const n = (v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v));
		this.bytes.push(n & 0xff, (n >> 8) & 0xff);
	}
	public u8c(v: number, lo: number, hi: number): void { this.u8(v < lo ? lo : v > hi ? hi : Math.round(v)); }
	public var(n: number): void {
		let v = Math.max(0, Math.round(n));
		while (v >= 0x80) { this.bytes.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
		this.bytes.push(v);
	}
	public zig(n: number): void {
		const v = Math.round(n);
		this.var((v << 1) ^ (v >> 31));
	}
	public str(s: string): void {
		if (!s) { this.u8(0); return; }
		const code = STR_DICT_INDEX[s];
		if (code) { this.u8(code); return; }
		const utf8: number[] = [];
		for (let i = 0; i < s.length; i++) {
			let c = s.charCodeAt(i);
			if (c < 0x80) utf8.push(c);
			else if (c < 0x800) { utf8.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
			else { utf8.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
		}
		this.u8(128);
		this.var(utf8.length);
		for (let i = 0; i < utf8.length; i++) this.bytes.push(utf8[i] & 0xff);
	}
	public toUint8(): Uint8Array { return new Uint8Array(this.bytes); }
}

// ------------------------------------------------------------------ byte reader

class ByteReader {
	private p = 0;
	constructor(private b: Uint8Array) { }
	private get left(): number { return this.b.length - this.p; }
	public u8(): number { return this.p < this.b.length ? this.b[this.p++] & 0xff : 0; }
	public i8(): number { const v = this.u8(); return v >= 128 ? v - 256 : v; }
	public i16(): number {
		const lo = this.u8();
		const hi = this.u8();
		const v = lo | (hi << 8);
		return v >= 32768 ? v - 65536 : v;
	}
	public var(): number {
		let shift = 0, out = 0;
		while (this.left > 0) {
			const byte = this.u8();
			out |= (byte & 0x7f) << shift;
			if (!(byte & 0x80)) break;
			shift += 7;
			if (shift > 35) break; // hostile length guard
		}
		return out >>> 0;
	}
	public zig(): number { const v = this.var(); return (v >>> 1) ^ -(v & 1); }
	public str(): string {
		const code = this.u8();
		if (code === 0) return '';
		if (code < 128) return STR_DICT[code - 1] || '';
		if (code === 128) {
			const len = Math.min(this.var(), this.left);
			let s = '';
			for (let i = 0; i < len; i++) s += String.fromCharCode(this.u8());
			try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
		}
		return '';
	}
}

/** Normalize a received binary part (ArrayBuffer / Buffer / TypedArray). */
function asUint8(v: any): Uint8Array | null {
	try {
		if (v instanceof Uint8Array) return v;
		if (v instanceof ArrayBuffer) return new Uint8Array(v);
		if (v && typeof v.buffer === 'object' && v.buffer instanceof ArrayBuffer && typeof v.length === 'number') {
			return new Uint8Array(v.buffer, v.byteOffset || 0, v.length);
		}
	} catch (_) { /* not binary */ }
	return null;
}

// ------------------------------------------------------------ C (标准) encoder

function encCPlayerState(o: any): Uint8Array {
	const w = new ByteWriter();
	const flags1 = (o.dead ? 1 : 0) | (o.cg ? 2 : 0) | (o.fl ? 4 : 0) | (o.cs ? 8 : 0)
		| (o.al ? 16 : 0) | (o.gd ? 32 : 0)
		// hasXa is PRESENCE-based: an explicit empty string is the "extern anim
		// CLEARED" signal in the legacy format and must materialize on decode.
		| ((o.xa !== undefined || o.xf !== undefined) ? 64 : 0)
		// hasCl is presence-based too — cl:'' (unknown class) must materialize.
		| (o.cl !== undefined ? 128 : 0);
	w.u8(flags1);
	// Presence bits keep the decode EXACTLY as sparse as the legacy JSON (a
	// field absent on the wire stays absent after decoding — the receivers'
	// presence guards + caches must never see a default-0 overwrite, e.g. from
	// the town light packet that omits the whole stats/guard block).
	const hasStats = typeof o.hp === 'number';
	const hasGuard = o.gd !== undefined || o.gst !== undefined || o.gws !== undefined
		|| o.gw !== undefined || o.gm !== undefined || o.ga !== undefined
		|| o.def !== undefined || o.fc !== undefined;
	const ef = Array.isArray(o.ef) ? o.ef : null;
	const st = Array.isArray(o.st) ? o.st : null;
	const anchor = !!(o.cax || o.cay || o.caz);
	w.u8((anchor ? 1 : 0) | (st ? 2 : 0) | (hasStats ? 4 : 0) | (hasGuard ? 8 : 0)
		| (ef ? 16 : 0) | (typeof o.df === 'number' ? 32 : 0) | (typeof o.ggt === 'number' ? 64 : 0));
	const pos = o.pos || {};
	w.zig(pos.x || 0); w.zig(pos.y || 0); w.zig(pos.z || 0);
	const f = o.face || {};
	w.i8(Math.round((f.x || 0) * 100)); w.i8(Math.round((f.y || 0) * 100));
	w.str(o.anim || '');
	if (flags1 & 64) { w.str(o.xa || ''); w.str(o.xf || ''); }
	if (hasStats) {
		w.var(o.hp || 0); w.var(o.maxHp || 0); w.var(o.sp || 0); w.var(o.maxSp || 0);
		w.u8c(o.em || 0, 0, 4);
	}
	if (flags1 & 128) w.str(o.cl || '');
	if (flags1 & 16) {
		w.i8(Math.round((o.ax || 0) * 100)); w.i8(Math.round((o.ay || 0) * 100));
		if (anchor) { w.zig(Math.round(o.cax || 0)); w.zig(Math.round(o.cay || 0)); w.zig(Math.round(o.caz || 0)); }
	}
	if (hasGuard) {
		w.u8c((o.gst || 0) * 100, 0, 255);
		w.u8c((o.gws || 0) * 100, 0, 255);
		w.i8(Math.round((o.gw || 0) * 100)); w.i8(Math.round((o.gm || 0) * 100)); w.i8(Math.round((o.ga || 0) * 100));
		w.var(o.def || 0); w.var(o.fc || 0);
	}
	if (ef) for (let i = 0; i < 4; i++) w.u8c((ef[i] || 0) * 50, 0, 255);
	if (typeof o.df === 'number') w.u8c((o.df == null ? 1 : o.df) * 50, 0, 255);
	if (st) for (let i = 0; i < 5; i++) w.u8c(st[i] || 0, 0, 255);
	if (typeof o.ggt === 'number') w.var(o.ggt || 0);
	return w.toUint8();
}

function encCPlayerStats(o: any): Uint8Array {
	const w = new ByteWriter();
	// Presence-based bits: em:0 (neutral element) and el:0 (empty bar) are REAL
	// states and must materialize — only a truly absent field stays absent.
	w.u8((o.ov ? 1 : 0) | (o.el !== undefined ? 2 : 0) | (o.em !== undefined ? 4 : 0));
	w.var(o.hp || 0); w.var(o.maxHp || 0); w.var(o.sp || 0); w.var(o.maxSp || 0);
	if (o.em !== undefined) w.u8c(o.em, 0, 4);
	if (o.el !== undefined) w.u8c(o.el * 20, 0, 255);
	return w.toUint8();
}

function encCBotState(o: any): Uint8Array {
	const w = new ByteWriter();
	w.str(o.map || '');
	const bots = Array.isArray(o.bots) ? o.bots : [];
	w.u8(Math.min(255, bots.length));
	for (const b of bots) {
		w.str(b && b.n || '');
		w.zig(b.x || 0); w.zig(b.y || 0);
		w.u8c(b.z || 0, 0, 255);
		w.i8(Math.round((b.fx || 0) * 100)); w.i8(Math.round((b.fy || 0) * 100));
		w.str(b.a || '');
		w.var(b.hp || 0); w.var(b.mh || 0); w.var(b.lv || 0); w.var(b.ex || 0);
	}
	return w.toUint8();
}

// ------------------------------------------------------------ C (标准) decoder

function decCPlayerState(r: ByteReader): any {
	const flags1 = r.u8();
	const flags2 = r.u8();
	const out: any = {
		dead: (flags1 & 1) ? 1 : 0,
		cg: (flags1 & 2) ? 1 : 0,
		fl: (flags1 & 4) ? 1 : 0,
		cs: (flags1 & 8) ? 1 : 0,
		al: (flags1 & 16) ? 1 : 0,
		gd: (flags1 & 32) ? 1 : 0,
		pos: { x: r.zig(), y: r.zig(), z: r.zig() },
		face: { x: r.i8() / 100, y: r.i8() / 100 },
		anim: r.str(),
	};
	if (flags1 & 64) { out.xa = r.str(); out.xf = r.str(); }
	if (flags2 & 4) {
		out.hp = r.var(); out.maxHp = r.var(); out.sp = r.var(); out.maxSp = r.var();
		out.em = r.u8();
	}
	if (flags1 & 128) out.cl = r.str();
	if (flags1 & 16) {
		out.ax = r.i8() / 100; out.ay = r.i8() / 100;
		if ((flags2 & 1)) { out.cax = r.zig(); out.cay = r.zig(); out.caz = r.zig(); }
	}
	if (flags2 & 8) {
		out.gst = r.u8() / 100;
		out.gws = r.u8() / 100;
		out.gw = r.i8() / 100; out.gm = r.i8() / 100; out.ga = r.i8() / 100;
		out.def = r.var(); out.fc = r.var();
	}
	if (flags2 & 16) out.ef = [r.u8() / 50, r.u8() / 50, r.u8() / 50, r.u8() / 50];
	if (flags2 & 32) out.df = r.u8() / 50;
	if (flags2 & 2) out.st = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
	if (flags2 & 64) out.ggt = r.var();
	return out;
}

function decCPlayerStats(r: ByteReader): any {
	const flags = r.u8();
	const out: any = { hp: r.var(), maxHp: r.var(), sp: r.var(), maxSp: r.var() };
	if (flags & 4) out.em = r.u8();
	if (flags & 2) out.el = r.u8() / 20;
	// ov only materializes when SET (the legacy whitelist drops false), so a
	// receiver's overload cache never sees a spurious false overwrite.
	if (flags & 1) out.ov = true;
	return out;
}

function decCBotState(r: ByteReader): any {
	const map = r.str();
	const n = r.u8();
	const bots: any[] = [];
	for (let i = 0; i < n; i++) {
		bots.push({
			n: r.str(),
			x: r.zig(), y: r.zig(), z: r.u8(),
			fx: r.i8() / 100, fy: r.i8() / 100,
			a: r.str(),
			hp: r.var(), mh: r.var(), lv: r.var(), ex: r.var(),
		});
	}
	return { map, bots };
}

// --------------------------------------------------------- D (调试) key tables

const PS_KEYS: Array<[string, string]> = [
	['pos', 'p'], ['face', 'f'], ['anim', 'a'], ['xa', 'x'], ['xf', 'X'], ['dead', 'd'],
	['hp', 'h'], ['maxHp', 'H'], ['sp', 's'], ['maxSp', 'S'], ['cg', 'c'], ['em', 'e'],
	['cl', 'k'], ['fl', 'l'], ['cs', 'C'], ['al', 'A'], ['ax', 'i'], ['ay', 'j'],
	['cax', 'I'], ['cay', 'J'], ['caz', 'K'], ['gd', 'g'], ['gst', 't'], ['gws', 'T'],
	['gw', 'w'], ['gm', 'm'], ['ga', 'G'], ['def', 'D'], ['fc', 'F'], ['ef', 'E'],
	['df', 'b'], ['st', 'y'], ['ggt', 'q'],
];

// D-format omission rule: ONLY fields where 0/''/false is INDISTINGUISHABLE
// from absence for every consumer (cosmetic flags, aim fields only read while
// al=1, empty strings). The guard/damage/element/HUD blocks must NEVER be
// omitted on zero — a legit 0 (guard released, element switched to neutral,
// empty SP bar) would read as "keep the cached value" and resurrect stale
// state (the exact ROUND 79 cache bug class).
const PS_OMIT_D: { [k: string]: 1 } = {
	ax: 1, ay: 1, cax: 1, cay: 1, caz: 1,
	fl: 1, dead: 1, cs: 1, al: 1,
};

function encDPlayerState(o: any): any {
	const out: any = {};
	for (const [long, short] of PS_KEYS) {
		const v = o[long];
		if (v === undefined) continue;
		if (PS_OMIT_D[long] && (v === 0 || v === '' || v === false)) continue;
		out[short] = v;
	}
	return out;
}

function decDPlayerState(k: any): any {
	const out: any = {};
	for (const [long, short] of PS_KEYS) {
		if (k[short] !== undefined) out[long] = k[short];
	}
	return out;
}

const ST_KEYS: Array<[string, string]> = [
	['hp', 'h'], ['maxHp', 'H'], ['sp', 's'], ['maxSp', 'S'], ['em', 'e'], ['el', 'l'], ['ov', 'o'],
];

function encDPlayerStats(o: any): any {
	const out: any = {};
	for (const [long, short] of ST_KEYS) {
		const v = o[long];
		if (v === undefined) continue;
		// ov=false is the ONLY omission (the legacy whitelist drops false too);
		// em/el zeros are meaningful HUD states and must ride every packet.
		if (long === 'ov' && v === false) continue;
		out[short] = v;
	}
	return out;
}

function decDPlayerStats(k: any): any {
	const out: any = {};
	for (const [long, short] of ST_KEYS) {
		if (k[short] !== undefined) out[long] = k[short];
	}
	return out;
}

const BS_KEYS: Array<[string, string]> = [
	['n', 'n'], ['x', 'x'], ['y', 'y'], ['z', 'z'], ['fx', 'u'], ['fy', 'v'], ['a', 'a'],
	['hp', 'h'], ['mh', 'H'], ['lv', 'L'], ['ex', 'X'],
];

function encDBotState(o: any): any {
	const bots = Array.isArray(o.bots) ? o.bots : [];
	const outBots = bots.map((b: any) => {
		const nb: any = {};
		for (const [long, short] of BS_KEYS) {
			const v = b ? b[long] : undefined;
			// Only empty ANIM is omissible — z:0 / fy:0 / lv:0 are real values
			// the puppet appliers read positionally.
			if (v === undefined) continue;
			if (long === 'a' && v === '') continue;
			nb[short] = v;
		}
		return nb;
	});
	return { m: o.map || '', b: outBots };
}

function decDBotState(k: any): any {
	const bots = Array.isArray(k.b) ? k.b : [];
	return {
		map: typeof k.m === 'string' ? k.m : '',
		bots: bots.map((b: any) => {
			const nb: any = {};
			for (const [long, short] of BS_KEYS) {
				if (b && b[short] !== undefined) nb[long] = b[short];
			}
			return nb;
		}),
	};
}

// ------------------------------------------------- 1.80.x combat stream codecs
//
// Six more events ride the SAME negotiation/translation machinery. Two of them
// (entityState, playerBall) also use the SENDER-SIDE static/dynamic split: a
// dynamic-only entry simply omits the static keys (netSync strips them; the
// receiver merges its per-uid static cache; the SERVER merges its own cache
// back for legacy receivers). The codecs below are presence-faithful — an
// absent key stays absent after a round trip.
//
// entityState C layout (wrapper keeps map/cb/f/st as JSON):
//   var n; per entry: var uid; u8 eflags1 (b0 marker b1 hasStatic b2 hd b3 psv
//   b4 abs b5 vul b6 inv b7 tg); if marker -> next entry; u8 eflags2 (b0 brk
//   b1 af b2 hasSt b3 hasSh b4 hasShp); [static if hasStatic: var mi, str t,
//   var m, var msp, u8 tos, u8 sfl (b0 ats b1 nm b2 mk), [str ats/nm/mk]];
//   dynamic: zig x,y,z; i8 fx100, fy100; str a; str ss; var h; var sp;
//   u8 brpC (0..100, 255 = absent); str tn; [5x var st]; [str sh-json];
//   [var shp]
// playerBall C layout (wrapper keeps map/from as JSON):
//   var n; per entry: var uid; u8 fl (b0 dead b1 hasStatic b2 hasPn);
//   [u8 el, u8 chg, str pn if hasStatic]; zig x,y,z, vx, vy
// throwBall C layout (whole payload binary):
//   str ballInfo; u8 fl (b0 hasPos b1 hasBn b2 combatantStr); combatant
//   (str | var); u8 party; i16 dirx10000, diry10000 (unit-normalized);
//   [zig pos x,y,z]; [str bn]
// projectileState C layout (wrapper keeps map as JSON):
//   var n; per entry: var i; u8 kind (0 B, 1 S, 2 G); var src; str pn;
//   zig x,y,z, vx, vy; u8 d
// enemySound C layout (whole payload binary):
//   var uid; str path; u8 vol100; u8 var100; u8 fl (b0 loop b1 global
//   b2 hasRadius b3 hasSpeed); [u8 radius]; [u8 speed50]
// enemySoundStop C layout: var uid

function encCEntityState(o: any): Uint8Array {
	const w = new ByteWriter();
	const list = (Array.isArray(o.e) ? o.e : []).filter((e: any) => e && typeof e === 'object');
	w.var(Math.min(512, list.length));
	for (const en of list) {
		w.var(en.i || 0);
		// A liveness marker carries ONLY the uid (netSync sends {i} for unchanged
		// enemies). Real entries always carry a numeric x.
		if (typeof en.x !== 'number') { w.u8(1); continue; }
		const hasStatic = en.t !== undefined || en.mi !== undefined;
		const st = Array.isArray(en.st) ? en.st : null;
		const sh = (en.sh !== undefined && en.sh !== null) ? en.sh : null;
		w.u8((hasStatic ? 2 : 0) | (en.hd ? 4 : 0) | (en.psv ? 8 : 0) | (en.abs ? 16 : 0)
			| (en.vul ? 32 : 0) | (en.inv ? 64 : 0) | (en.tg ? 128 : 0));
		w.u8((en.brk ? 1 : 0) | (en.af ? 2 : 0) | (st ? 4 : 0) | (sh ? 8 : 0)
			| (en.shp !== undefined ? 16 : 0));
		if (hasStatic) {
			w.var(en.mi || 0);
			w.str(en.t || '');
			w.var(en.m || 0);
			w.var(en.msp || 0);
			w.u8(en.tos ? 1 : 0);
			const hasAts = en.ats !== undefined, hasNm = en.nm !== undefined, hasMk = en.mk !== undefined;
			w.u8((hasAts ? 1 : 0) | (hasNm ? 2 : 0) | (hasMk ? 4 : 0));
			if (hasAts) w.str(en.ats || '');
			if (hasNm) w.str(en.nm || '');
			if (hasMk) w.str(en.mk || '');
		}
		w.zig(en.x || 0); w.zig(en.y || 0); w.zig(en.z || 0);
		w.i8(Math.round((en.fx || 0) * 100)); w.i8(Math.round((en.fy || 0) * 100));
		w.str(en.a || '');
		w.str(en.ss || '');
		w.var(en.h || 0);
		w.var(en.sp || 0);
		if (en.brp === undefined || en.brp === null) w.u8(255);
		else w.u8c(en.brp * 100, 0, 254);
		w.str(en.tn || '');
		if (st) for (let i = 0; i < 5; i++) w.var(st[i] || 0);
		if (sh) w.str(JSON.stringify(sh));
		if (en.shp !== undefined) w.var(en.shp || 0);
	}
	return w.toUint8();
}

function decCEntityState(r: ByteReader): any {
	const n = r.var();
	const e: any[] = [];
	for (let k = 0; k < n; k++) {
		const i = r.var();
		const ef1 = r.u8();
		if (ef1 & 1) { e.push({ i }); continue; }
		const ef2 = r.u8();
		const out: any = {
			i,
			hd: (ef1 & 4) ? 1 : 0,
			psv: (ef1 & 8) ? 1 : 0,
			abs: (ef1 & 16) ? 1 : 0,
			vul: (ef1 & 32) ? 1 : 0,
			inv: (ef1 & 64) ? 1 : 0,
			tg: (ef1 & 128) ? 1 : 0,
			brk: (ef2 & 1) ? 1 : 0,
		};
		if (ef2 & 2) out.af = 1;
		if (ef1 & 2) {
			out.mi = r.var();
			out.t = r.str();
			out.m = r.var();
			out.msp = r.var();
			out.tos = r.u8();
			const sfl = r.u8();
			if (sfl & 1) out.ats = r.str();
			if (sfl & 2) out.nm = r.str();
			if (sfl & 4) out.mk = r.str();
		}
		out.x = r.zig(); out.y = r.zig(); out.z = r.zig();
		out.fx = r.i8() / 100; out.fy = r.i8() / 100;
		out.a = r.str();
		out.ss = r.str();
		out.h = r.var();
		out.sp = r.var();
		const brpC = r.u8();
		if (brpC !== 255) out.brp = brpC / 100;
		out.tn = r.str();
		if (ef2 & 4) out.st = [r.var(), r.var(), r.var(), r.var(), r.var()];
		if (ef2 & 8) { try { out.sh = JSON.parse(r.str()); } catch (_) { /* skip bad shields */ } }
		if (ef2 & 16) out.shp = r.var();
		e.push(out);
	}
	return { e };
}

function encCPlayerBall(o: any): Uint8Array {
	const w = new ByteWriter();
	const list = (Array.isArray(o.entries) ? o.entries : []).filter((e: any) => e && typeof e === 'object');
	w.var(Math.min(64, list.length));
	for (const en of list) {
		w.var(en.i || 0);
		const dead = en.dead === 1 || en.dead === true;
		const hasPn = typeof en.pn === 'string' && en.pn.length > 0;
		const hasStatic = !dead && (en.el !== undefined || en.chg !== undefined || hasPn);
		w.u8((dead ? 1 : 0) | (hasStatic ? 2 : 0) | (hasPn ? 4 : 0));
		if (dead) continue;
		if (hasStatic) {
			w.u8c(en.el || 0, 0, 4);
			w.u8(en.chg ? 1 : 0);
			if (hasPn) w.str(en.pn || '');
		}
		w.zig(en.x || 0); w.zig(en.y || 0); w.zig(en.z || 0);
		w.zig(en.vx || 0); w.zig(en.vy || 0);
	}
	return w.toUint8();
}

function decCPlayerBall(r: ByteReader): any {
	const n = r.var();
	const entries: any[] = [];
	for (let k = 0; k < n; k++) {
		const i = r.var();
		const fl = r.u8();
		if (fl & 1) { entries.push({ i, dead: 1 }); continue; }
		const out: any = { i };
		if (fl & 2) {
			out.el = r.u8();
			out.chg = r.u8();
		}
		if (fl & 4) out.pn = r.str();
		out.x = r.zig(); out.y = r.zig(); out.z = r.zig();
		out.vx = r.zig(); out.vy = r.zig();
		entries.push(out);
	}
	return { entries };
}

function encCThrowBall(o: any): Uint8Array {
	const w = new ByteWriter();
	const dir = o.dir || {};
	const pos = o.pos;
	const combatantStr = typeof o.combatant === 'string';
	// 0.2.6: normalize first — Ball.spawn treats dir as a unit direction and
	// scales it to speed. Encoding a raw velocity/magnitude through i8×100
	// clamped |dir|>1.27 to ±1.27, which collapsed free-aim angles to the
	// four diagonals on every receiver.
	const dx = Number(dir.x) || 0;
	const dy = Number(dir.y) || 0;
	const len = Math.hypot(dx, dy);
	const nx = len > 1e-6 ? dx / len : 0;
	const ny = len > 1e-6 ? dy / len : 0;
	w.str(o.ballInfo || '');
	w.u8((pos ? 1 : 0) | (o.bn ? 2 : 0) | (combatantStr ? 4 : 0));
	if (combatantStr) w.str(o.combatant || '');
	else w.var(typeof o.combatant === 'number' ? Math.max(0, Math.round(o.combatant)) : 0);
	w.u8c(o.party || 0, 0, 255);
	w.i16(Math.round(nx * 10000));
	w.i16(Math.round(ny * 10000));
	if (pos) { w.zig(pos.x || 0); w.zig(pos.y || 0); w.zig(pos.z || 0); }
	if (o.bn) w.str(o.bn || '');
	return w.toUint8();
}

function decCThrowBall(r: ByteReader): any {
	const out: any = { ballInfo: r.str() };
	const fl = r.u8();
	if (fl & 4) out.combatant = r.str();
	else out.combatant = r.var();
	out.party = r.u8();
	out.dir = { x: r.i16() / 10000, y: r.i16() / 10000 };
	if (fl & 1) out.pos = { x: r.zig(), y: r.zig(), z: r.zig() };
	if (fl & 2) out.bn = r.str();
	return out;
}

function encCProjectileState(o: any): Uint8Array {
	const w = new ByteWriter();
	const list = (Array.isArray(o.e) ? o.e : []).filter((e: any) => e && typeof e === 'object');
	w.var(Math.min(128, list.length));
	for (const en of list) {
		w.var(en.i || 0);
		w.u8(en.k === 'S' ? 1 : (en.k === 'G' ? 2 : 0));
		w.var(en.src || 0);
		w.str(en.pn || '');
		w.zig(en.x || 0); w.zig(en.y || 0); w.zig(en.z || 0);
		w.zig(en.vx || 0); w.zig(en.vy || 0);
		w.u8(en.d === 1 || en.d === true ? 1 : 0);
	}
	return w.toUint8();
}

function decCProjectileState(r: ByteReader): any {
	const n = r.var();
	const e: any[] = [];
	for (let k = 0; k < n; k++) {
		e.push({
			i: r.var(),
			k: ['B', 'S', 'G'][r.u8()] || 'B',
			src: r.var(),
			pn: r.str(),
			x: r.zig(), y: r.zig(), z: r.zig(),
			vx: r.zig(), vy: r.zig(),
			d: r.u8(),
		});
	}
	return { e };
}

function encCEnemySound(o: any): Uint8Array {
	const w = new ByteWriter();
	w.var(o.uid || 0);
	w.str(o.path || '');
	w.u8c((o.volume === undefined ? 1 : o.volume) * 100, 0, 100);
	w.u8c((o.variance || 0) * 100, 0, 100);
	const hasRadius = typeof o.radius === 'number';
	const hasSpeed = typeof o.speed === 'number';
	w.u8((o.loop ? 1 : 0) | (o.global ? 2 : 0) | (hasRadius ? 4 : 0) | (hasSpeed ? 8 : 0));
	if (hasRadius) w.u8c(o.radius, 0, 255);
	if (hasSpeed) w.u8c((o.speed === undefined ? 1 : o.speed) * 50, 0, 255);
	return w.toUint8();
}

function decCEnemySound(r: ByteReader): any {
	const out: any = {
		uid: r.var(),
		path: r.str(),
		volume: r.u8() / 100,
		variance: r.u8() / 100,
	};
	const fl = r.u8();
	out.loop = !!(fl & 1);
	out.global = !!(fl & 2);
	if (fl & 4) out.radius = r.u8();
	if (fl & 8) out.speed = r.u8() / 50;
	return out;
}

function encCEnemySoundStop(o: any): Uint8Array {
	const w = new ByteWriter();
	w.var(o.uid || 0);
	return w.toUint8();
}

function decCEnemySoundStop(r: ByteReader): any {
	return { uid: r.var() };
}

// ------------------------------------------------- combat D (调试) key tables
//
// Same sparse-presence semantics as the C codecs: only fields the sender put
// on the wire ride the short-key form; NO zero-omission (a legit 0 must never
// read as "keep the cached value" — the ROUND 79 bug class). The
// entityState/playerBall static/dynamic split is pure PRESENCE.

const ENT_KEYS: Array<[string, string]> = [
	['i', 'i'], ['mi', 'M'], ['t', 'T'], ['x', 'x'], ['y', 'y'], ['z', 'z'],
	['fx', 'f'], ['fy', 'F'], ['a', 'a'], ['ss', 'C'], ['h', 'h'], ['m', 'm'],
	['tg', 'g'], ['tn', 'n'], ['sp', 'p'], ['msp', 'P'], ['brk', 'b'], ['brp', 'B'],
	['hd', 'd'], ['psv', 'S'], ['abs', 'X'], ['vul', 'V'], ['inv', 'c'], ['tos', 'O'],
	['nm', 'q'], ['ats', 'R'], ['st', 'w'], ['sh', 'W'], ['shp', 'Y'], ['mk', 'K'], ['af', 'j'],
];

function encDEntityState(o: any): any {
	const list = (Array.isArray(o.e) ? o.e : []).filter((e: any) => e && typeof e === 'object');
	return {
		e: list.map((en: any) => {
			const out: any = {};
			for (const [long, short] of ENT_KEYS) {
				if (en[long] !== undefined) out[short] = en[long];
			}
			return out;
		}),
	};
}

function decDEntityState(k: any): any[] {
	const list = Array.isArray(k && k.e) ? k.e : [];
	return list.map((en: any) => {
		const out: any = {};
		for (const [long, short] of ENT_KEYS) {
			if (en && en[short] !== undefined) out[long] = en[short];
		}
		return out;
	});
}

const PB_KEYS: Array<[string, string]> = [
	['i', 'i'], ['el', 'e'], ['chg', 'c'], ['pn', 'p'], ['x', 'x'], ['y', 'y'], ['z', 'z'],
	['vx', 'X'], ['vy', 'Y'], ['dead', 'd'],
];

function encDPlayerBall(o: any): any {
	const list = (Array.isArray(o.entries) ? o.entries : []).filter((e: any) => e && typeof e === 'object');
	return {
		e: list.map((en: any) => {
			const out: any = {};
			for (const [long, short] of PB_KEYS) {
				if (en[long] !== undefined) out[short] = en[long];
			}
			return out;
		}),
	};
}

function decDPlayerBall(k: any): any[] {
	const list = Array.isArray(k && k.e) ? k.e : [];
	return list.map((en: any) => {
		const out: any = {};
		for (const [long, short] of PB_KEYS) {
			if (en && en[short] !== undefined) out[long] = en[short];
		}
		return out;
	});
}

const TB_KEYS: Array<[string, string]> = [
	['ballInfo', 'b'], ['combatant', 'c'], ['party', 'p'], ['pos', 'P'], ['bn', 'n'],
];

function encDThrowBall(o: any): any {
	const out: any = {};
	for (const [long, short] of TB_KEYS) {
		if (o[long] !== undefined) out[short] = o[long];
	}
	if (o.dir !== undefined) out.d = o.dir;
	return out;
}

function decDThrowBall(k: any): any {
	const out: any = {};
	for (const [long, short] of TB_KEYS) {
		if (k[short] !== undefined) out[long] = k[short];
	}
	if (k.d !== undefined) out.dir = k.d;
	return out;
}

const PRJ_KEYS: Array<[string, string]> = [
	['i', 'i'], ['k', 'k'], ['src', 's'], ['pn', 'p'], ['x', 'x'], ['y', 'y'], ['z', 'z'],
	['vx', 'X'], ['vy', 'Y'], ['d', 'd'],
];

function encDProjectileState(o: any): any {
	const list = (Array.isArray(o.e) ? o.e : []).filter((e: any) => e && typeof e === 'object');
	return {
		e: list.map((en: any) => {
			const out: any = {};
			for (const [long, short] of PRJ_KEYS) {
				if (en[long] !== undefined) out[short] = en[long];
			}
			return out;
		}),
	};
}

function decDProjectileState(k: any): any[] {
	const list = Array.isArray(k && k.e) ? k.e : [];
	return list.map((en: any) => {
		const out: any = {};
		for (const [long, short] of PRJ_KEYS) {
			if (en && en[short] !== undefined) out[long] = en[short];
		}
		return out;
	});
}

const ES_KEYS: Array<[string, string]> = [
	['uid', 'u'], ['path', 'p'], ['volume', 'v'], ['variance', 'x'], ['loop', 'l'],
	['global', 'g'], ['radius', 'r'], ['speed', 's'],
];

function encDEnemySound(o: any): any {
	const out: any = {};
	for (const [long, short] of ES_KEYS) {
		if (o[long] !== undefined) out[short] = o[long];
	}
	return out;
}

function decDEnemySound(k: any): any {
	const out: any = {};
	for (const [long, short] of ES_KEYS) {
		if (k[short] !== undefined) out[long] = k[short];
	}
	return out;
}

// ------------------------------------------------------------------ public API

export type HotEvent =
	| 'playerState' | 'updatePlayerStats' | 'botState'
	| 'entityState' | 'playerBall' | 'throwBall'
	| 'projectileState' | 'enemySound' | 'enemySoundStop';

/** Outbound: wrap the canonical payload in the requested wire schema.
 * 'legacy' returns the payload unchanged (today's format). The wrapper keeps
 * routing fields (player/from/map, and entityState's cb/f/st — the server's
 * per-stream relay throttle + the HUD tick counters read them) as JSON. */
export function encodeHotEvent(event: HotEvent, mode: string, payload: any): any {
	if (!payload || mode === 'legacy') return payload;
	try {
		const wrap: any = {};
		const bin = mode === 'c';
		if (event === 'entityState') {
			if (bin) {
				wrap.map = payload.map;
				if (payload.cb) wrap.cb = true;
				if (payload.f === 1) wrap.f = 1;
				if (payload.st === 'B' || payload.st === 'H') wrap.st = payload.st;
				wrap.d = encCEntityState(payload);
			} else {
				wrap.m = payload.map;
				if (payload.cb) wrap.c = 1;
				if (payload.f === 1) wrap.f = 1;
				if (payload.st === 'B' || payload.st === 'H') wrap.s = payload.st;
				wrap.k = encDEntityState(payload);
			}
		} else if (event === 'playerBall') {
			if (payload.player !== undefined) wrap.player = payload.player;
			if (payload.from !== undefined) wrap.from = payload.from;
			if (bin) { wrap.map = payload.map; wrap.d = encCPlayerBall(payload); }
			else { wrap.m = payload.map; wrap.k = encDPlayerBall(payload); }
		} else if (event === 'projectileState') {
			if (bin) { wrap.map = payload.map; wrap.d = encCProjectileState(payload); }
			else { wrap.m = payload.map; wrap.k = encDProjectileState(payload); }
		} else if (event === 'throwBall') {
			if (bin) wrap.d = encCThrowBall(payload);
			else wrap.k = encDThrowBall(payload);
		} else if (event === 'enemySound') {
			if (bin) wrap.d = encCEnemySound(payload);
			else wrap.k = encDEnemySound(payload);
		} else if (event === 'enemySoundStop') {
			if (bin) wrap.d = encCEnemySoundStop(payload);
			else wrap.k = { u: payload.uid || 0 };
		} else {
			if (payload.player !== undefined) wrap.player = payload.player;
			if (payload.from !== undefined) wrap.from = payload.from;
			if (event === 'botState' && payload.map !== undefined) wrap.map = payload.map;
			if (event === 'playerState') {
				if (bin) wrap.d = encCPlayerState(payload);
				else wrap.k = encDPlayerState(payload);
			} else if (event === 'updatePlayerStats') {
				if (bin) wrap.d = encCPlayerStats(payload);
				else wrap.k = encDPlayerStats(payload);
			} else {
				if (bin) wrap.d = encCBotState(payload);
				else wrap.k = encDBotState(payload);
			}
		}
		return wrap;
	} catch (e) {
		console.warn('[wire] encode failed, falling back to legacy', e);
	}
	return payload;
}

/** Inbound: decode ANY of the three formats back into the canonical long-key
 * payload (legacy objects pass through untouched). */
export function decodeHotEvent(event: HotEvent, data: any): any {
	if (!data || typeof data !== 'object') return data;
	try {
		const bin = asUint8(data.d);
		if (bin) {
			const r = new ByteReader(bin);
			let body: any;
			if (event === 'entityState') body = decCEntityState(r);
			else if (event === 'playerBall') body = decCPlayerBall(r);
			else if (event === 'projectileState') body = decCProjectileState(r);
			else if (event === 'throwBall') return decCThrowBall(r);
			else if (event === 'enemySound') return decCEnemySound(r);
			else if (event === 'enemySoundStop') return decCEnemySoundStop(r);
			else if (event === 'playerState') body = decCPlayerState(r);
			else if (event === 'updatePlayerStats') body = decCPlayerStats(r);
			else body = decCBotState(r);
			return Object.assign({}, data, body);
		}
		if (data.k && typeof data.k === 'object' && !Array.isArray(data.k)) {
			if (event === 'entityState') {
				return {
					map: typeof data.m === 'string' ? data.m : '',
					cb: data.c === 1,
					f: data.f === 1 ? 1 : undefined,
					st: (data.s === 'B' || data.s === 'H') ? data.s : undefined,
					e: decDEntityState(data.k),
				};
			}
			if (event === 'playerBall') {
				return {
					from: data.from,
					map: typeof data.m === 'string' ? data.m : '',
					entries: decDPlayerBall(data.k),
				};
			}
			if (event === 'projectileState') {
				return { map: typeof data.m === 'string' ? data.m : '', e: decDProjectileState(data.k) };
			}
			if (event === 'throwBall') return decDThrowBall(data.k);
			if (event === 'enemySound') return decDEnemySound(data.k);
			if (event === 'enemySoundStop') {
				const out: any = {};
				if (data.k.u !== undefined) out.uid = data.k.u;
				return out;
			}
			const body = event === 'playerState' ? decDPlayerState(data.k)
				: event === 'updatePlayerStats' ? decDPlayerStats(data.k)
					: decDBotState(data.k);
			return Object.assign({}, data, body);
		}
	} catch (e) {
		console.warn('[wire] decode failed, passing through raw', e);
	}
	return data;
}
