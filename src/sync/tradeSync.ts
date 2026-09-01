import type { Multiplayer } from '../multiplayer';

/**
 * 1.77.x (player trading): material/food exchange between players.
 *
 * Design (user spec):
 *  - The ITEMS (inventory) page top bar gets a 交易 button — a native
 *    sc.ButtonGui SMALL styled and hooked up EXACTLY like the vanilla
 *    帮助/排序/收藏 hotkey buttons (ButtonInteract global button + a
 *    sc.menu.addHotkey top-bar slot). Pressing it enters MERCHANT MODE: the
 *    NPC SHOPKEEPER BUBBLE (sc.MapInteractEntry + the NPC class's
 *    interactIcons.shop — map-icon.png @0,240) floats above the player's head on
 *    every screen (own + mirrors, via the presence broadcast): tiny AWAY marker
 *    from afar, small NEAR bubble in range, and the animated big FOCUS bubble
 *    when close — exactly like talking to a vanilla shop NPC (ROUND 152).
 *    Merchant mode ends on movement / combat / damage taken / map change /
 *    death / cutscene, or when a trade actually starts.
 *  - Anyone near a merchant-mode mirror can click it (or press the interact
 *    key) once the bubble has grown to the big FOCUS state — the native
 *    map-interact machine only fires onInteraction from FOCUS, so far-away
 *    clicks do nothing (要靠近等气泡变大才能交易). The SERVER opens the session
 *    immediately for BOTH sides (no invite/accept round-trip) and they exchange
 *    offers + ready flags through it. The merchant's OWN bubble is force-held
 *    in the big FOCUS state (自己看头顶默认为大气泡) and never fires.
 *  - The exchange has a LOSS ratio (config tradeRatio, default 2): what the
 *    RECEIVER gets = floor(given / ratio). The server computes the authoritative
 *    effective lists and sends each side its own {lose, gain} on tradeApply.
 *  - Tradeable: type TRADE (materials) with rarity < 3 (LEGENDARY = gold) and
 *    type CONS (food). Everything else (EQUIP/KEY/TOGGLE, gold materials) is
 *    rejected by the picker AND re-checked before applying.
 *  - "Obtained once" rule: A may only offer item X to B when B has obtained X at
 *    least once (their cumulative items stat). Each side publishes its known
 *    tradeable ids (tradeKnown) when the session opens; the picker filters by the
 *    PARTNER's list and the apply path re-validates every gained id locally.
 *  - Auto-cancel: either side enters combat / a cutscene / dies / disconnects,
 *    or the two players are no longer on the same map.
 *  - Anti-dupe: importing a save (admin API) or rolling back a save mirror
 *    locks trading for config.tradeLockHours (default 48h). Enforced
 *    server-side (merchant broadcast / invite / accept all refused), surfaced
 *    here through handshake tradeLockMs + the tradeRejected event; a completed
 *    trade auto-saves and uploads immediately so a later restore can't
 *    resurrect traded-away items.
 *
 * Engine facts used here (verified against game.compiled.js):
 *  - sc.ITEMS_TYPES = {CONS, EQUIP, TRADE, KEY, TOGGLE}; sc.ITEMS_RARITY =
 *    {LOW:0, NORMAL:1, RARE:2, LEGENDARY:3, ...}.
 *  - sc.inventory is the item DATABASE: getItem(id) -> entry (.type/.rarity),
 *    getItemName/getItemIcon for display. OWNED counts live on the player model:
 *    sc.model.player.getItemAmount(id) / addItem(id, n) / removeItem(id, n)
 *    (stack cap 99 inside addItem).
 *  - Cumulative "ever obtained": sc.stats.values.items[id] (addMap on addItem,
 *    never decremented by removeItem).
 *  - The trade button lives in the ITEMS page top bar (sc.ItemMenu): the
 *    vanilla hotkey mechanism — sc.menu.buttonInteract.addGlobalButton
 *    (clickable) + sc.menu.addHotkey (MainMenu lays the slots out top-right,
 *    ours lands left-most). ItemMenu instances are created lazily per menu
 *    session (MainMenu._createMenu) and dropped on menu close, so
 *    inject({init}) reliably covers every instance.
 *  - sc.control.interactPressed() is the native interact edge (aim/confirm) —
 *    left mouse click included, so clicking the focused big bubble trades.
 *  - sc.mapInteract (GameAddon, preUpdateOrder 0) owns the entry state machine:
 *    NEAR within 40+size.y/2 px (+z overlap + wall trace), FOCUS when the mouse
 *    cursor is near the entity (mouse mode) or the player faces it (gamepad);
 *    it auto-removes entries whose entity was killed, and hides all bubbles
 *    while control is blocked (cutscenes/menus).
 */

export interface ITradeSession {
	sid: number;
	partner: string;
	ratio: number;
	mySide: 'a' | 'b';
	myOffer: Array<{ id: string, n: number }>;
	theirOffer: Array<{ id: string, n: number }>;
	myReady: boolean;
	theirReady: boolean;
	partnerKnown: { [id: string]: boolean } | null;
	applying: boolean;
}

export class TradeSync {
	private main: Multiplayer;
	public enabled = true;
	public ratio = 2;

	/** Local player's merchant mode. */
	private merchant = false;
	/** Mirrors currently in merchant mode (name -> true). */
	private merchants: { [name: string]: boolean } = Object.create(null);
	/** Live trade session (client state mirrors the server's). */
	private session: ITradeSession | null = null;

	private inviteBox: HTMLDivElement | null = null;
	private inviteFrom = '';
	private inviteAt = 0;
	private panel: HTMLDivElement | null = null;

	/** Native shop-bubble entries (sc.mapInteract), '__self' + one per merchant
	 * mirror (ROUND 152). The native machine projects + animates them; we only
	 * add/remove entries and force-hold the self bubble in FOCUS. */
	private bubbles: { [name: string]: any } = Object.create(null);
	private lastMap = '';
	private lastHp = -1;

	constructor(main: Multiplayer) {
		this.main = main;
	}

	public install(): void {
		this.wireConnection();
		this.installGameHooks();
		(window as any).__mpTrade = this;
	}

	// ------------------------------------------------------------------ wiring

	private conn(): any {
		return this.main && (this.main as any).connection;
	}

	private wireConnection(): void {
		const conn = this.conn();
		if (!conn) return;
		try {
			if (typeof conn.onTradeMerchant === 'function') {
				conn.onTradeMerchant((d: any) => this.onMerchantPresence(d));
			}
			if (typeof conn.onTradeInvite === 'function') {
				conn.onTradeInvite((d: any) => this.onInvite(d));
			}
			if (typeof conn.onTradeOpen === 'function') {
				conn.onTradeOpen((d: any) => this.onOpen(d));
			}
			if (typeof conn.onTradeKnown === 'function') {
				conn.onTradeKnown((d: any) => this.onKnown(d));
			}
			if (typeof conn.onTradeState === 'function') {
				conn.onTradeState((d: any) => this.onState(d));
			}
			if (typeof conn.onTradeApply === 'function') {
				conn.onTradeApply((d: any) => this.onApply(d));
			}
			if (typeof conn.onTradeDone === 'function') {
				conn.onTradeDone((d: any) => this.onDone(d));
			}
			if (typeof conn.onTradeClosed === 'function') {
				conn.onTradeClosed((d: any) => this.onClosed(d));
			}
			if (typeof conn.onTradeRejected === 'function') {
				conn.onTradeRejected((d: any) => this.onRejected(d));
			}
		} catch (e) { console.warn('[trade] wiring failed', e); }
	}

	/** Engine-side hooks: the ESC-menu button + the per-frame pump. Once per process. */
	private installGameHooks(): void {
		if ((TradeSync as any)._hooked) return;
		(TradeSync as any)._hooked = true;
		try {
			(simplify as any).registerUpdate(() => {
				const t: any = (window as any).__mpTrade;
				if (t) t.pump();
			});
		} catch (e) { console.warn('[trade] pump install failed', e); }
		try {
			// ROUND 152: the merchant's OWN bubble must stay the big FOCUS bubble.
			// The native state machine recomputes states in onPreUpdate (it would
			// drop the self entry to NEAR unless the cursor is on our own head),
			// so re-force FOCUS right after it ran — ordering-guaranteed (the pump
			// call is only a fallback if this wrap never installs).
			const mi: any = (sc as any).mapInteract;
			if (mi && typeof mi.onPreUpdate === 'function' && !mi._mpTradeFocusWrapped) {
				mi._mpTradeFocusWrapped = true;
				const origPre = mi.onPreUpdate.bind(mi);
				mi.onPreUpdate = function () {
					origPre();
					try {
						const t: any = (window as any).__mpTrade;
						if (t) t.forceSelfBubbleFocus();
					} catch (_) { /* ignore */ }
				};
			}
		} catch (e) { console.warn('[trade] mapInteract wrap failed', e); }
		try {
			const IM: any = (sc as any).ItemMenu;
			if (IM && typeof IM.inject === 'function' && !IM.prototype._mpTradeBtn) {
				IM.prototype._mpTradeBtn = true;
				// Non-start submenus are created LAZILY (MainMenu._createMenu)
				// and destroyed again when the menu closes (_postCleanUp), so
				// every ItemMenu instance is new'd AFTER this install — the
				// init hook below reliably runs for each one.
				IM.inject({
					init(this: any) {
						this.parent();
						TradeSync.createItemMenuButton(this);
					},
					onAddHotkeys(this: any, b: any) {
						if (this.hotkeyTrade) {
							try {
								// Same mechanism as the vanilla 帮助/排序/收藏
								// top-bar buttons: a clickable GLOBAL button plus
								// a top-bar hotkey slot (MainMenu lays the slots
								// out top-right; ours lands left-most).
								(sc as any).menu.buttonInteract.addGlobalButton(
									this.hotkeyTrade,
									function () { return false; });
								(sc as any).menu.addHotkey(function (this: any) {
									return this.hotkeyTrade;
								}.bind(this));
							} catch (e) { console.warn('[trade] hotkey add failed', e); }
						}
						this.parent(b);
					},
					exitMenu(this: any) {
						this.parent();
						if (this.hotkeyTrade) {
							try { (sc as any).menu.buttonInteract.removeGlobalButton(this.hotkeyTrade); } catch (_) { /* ignore */ }
						}
					},
				});
			}
		} catch (e) { console.warn('[trade] ItemMenu inject failed', e); }
	}

	/** Create the 交易 top-bar button on ONE ItemMenu instance — same style and
	 * slide-down animation as the vanilla hotkey buttons beside it. The top bar
	 * itself positions it (sc.menu hotkey slots); clicking goes through
	 * ButtonInteract's global-button path, exactly like the vanilla ones. */
	private static createItemMenuButton(im: any): void {
		try {
			if (!im || im.hotkeyTrade) return;
			const btn = new (sc as any).ButtonGui('交易', void 0, true, (sc as any).BUTTON_TYPE.SMALL);
			btn.keepMouseFocus = true;
			// Top-bar slide-down transitions, curves copied from the live
			// hotkeyHelp button (KEY_SPLINES is not a global in the bundle).
			const tf = im.hotkeyHelp && im.hotkeyHelp.hook ? im.hotkeyHelp.hook.transitions : null;
			btn.hook.transitions = {
				DEFAULT: { state: {}, time: 0.2, timeFunction: tf && tf.DEFAULT ? tf.DEFAULT.timeFunction : undefined },
				HIDDEN: { state: { offsetY: -btn.hook.size.y }, time: 0.2, timeFunction: tf && tf.HIDDEN ? tf.HIDDEN.timeFunction : undefined },
			};
			btn.onButtonPress = function (this: any) {
				console.log('[trade] item-menu button pressed');
				let ok = false;
				try {
					const t2: any = (window as any).__mpTrade;
					if (t2) ok = !!t2.requestMerchant();
				} catch (_) { /* ignore */ }
				// Auto-close the WHOLE menu (the inventory) once the merchant
				// state changed. Walk the vanilla back-callback chain to the
				// ROOT entry (MainMenu._onBackButton -> sc.model.
				// enterPrevSubState) — that root callback is what actually
				// exits the menu; popping menuStack alone would leave it open.
				if (ok) {
					try {
						const mm: any = (sc as any).menu;
						let guard = 8;
						while (mm && typeof mm.currentBackCallback === 'function' && guard-- > 0) {
							mm.invokeTopBackButton();
						}
						// Edge fallback (no callback registered): resume the
						// vanilla way so the menu cannot stay stuck open.
						const mdl: any = (sc as any).model;
						if (mdl && typeof mdl.isMenu === 'function' && mdl.isMenu() && typeof mdl.enterRunning === 'function') {
							mdl.enterRunning();
						}
					} catch (_) { /* ignore */ }
				}
			};
			im.hotkeyTrade = btn;
			console.log('[trade] ItemMenu 交易 button installed');
		} catch (e) { console.warn('[trade] ItemMenu button failed', e); }
	}

	// --------------------------------------------------------- anti-dupe lock

	/** Remaining trade lockout in ms (0 = free). The deadline is maintained by
	 * the Multiplayer instance from the handshake / mirror-rollback result. */
	private lockRemainMs(): number {
		try {
			const until = (this.main as any).tradeLockedUntil || 0;
			return Math.max(0, until - Date.now());
		} catch (_) { return 0; }
	}

	/** Configured lockout duration text — from the server handshake
	 * (main.tradeLockHours, default 48). Older servers omit it -> 48. */
	private lockHoursTxt(): string {
		try {
			const h = Number((this.main as any).tradeLockHours);
			if (isFinite(h) && h >= 0) return String(h);
		} catch (_) { /* fall through */ }
		return '48';
	}

	/** '12 小时 30 分' style remaining-time text for lockout messages. */
	private fmtLockRemain(ms: number): string {
		const totalMin = Math.ceil(ms / 60000);
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		if (h <= 0) return m + ' 分钟';
		return m > 0 ? (h + ' 小时 ' + m + ' 分') : (h + ' 小时');
	}

	/** Server-side refusal of an invite/accept because one side is locked. */
	private onRejected(d: { reason: string, self?: boolean, name?: string, lockMs?: number }): void {
		try {
			if (!d || d.reason !== 'locked') return;
			const lm = (typeof d.lockMs === 'number' && d.lockMs > 0) ? d.lockMs : this.lockRemainMs();
			const who = d.self ? '你' : ('对方（' + (d.name || '?') + '）');
			this.toast('无法交易：' + who + '处于交易限制期（导入存档/镜像回溯后 ' + this.lockHoursTxt() + ' 小时），剩余约 ' + this.fmtLockRemain(lm));
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------ merchant mode

	/** Item-menu-button entry point: validate + enter merchant mode. Every early
	 * exit is LOUD (console + toast) so a dead click is diagnosable.
	 * @returns true when the merchant state CHANGED (entered or toggled off) —
	 * the caller uses this to decide whether to close the menu. */
	public requestMerchant(): boolean {
		const deny = (why: string): boolean => {
			console.log('[trade] merchant request ignored: ' + why);
			this.toast('无法开始交易：' + why);
			return false;
		};
		try {
			if (!this.enabled) return deny('服务器未开启交易');
			const c = this.conn();
			if (!c || (typeof c.isOpen === 'function' && !c.isOpen())) return deny('未连接服务器');
			if (this.session) return deny('正在进行交易');
			if (this.merchant) { this.exitMerchant('manual'); return true; }
			const lockMs = this.lockRemainMs();
			if (lockMs > 0) return deny('交易限制中（导入存档/镜像回溯后 ' + this.lockHoursTxt() + ' 小时），剩余约 ' + this.fmtLockRemain(lockMs));
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) return deny('过场动画中');
			if (mdl && mdl.combatMode) return deny('战斗中');
			const p: any = (ig as any).game && (ig as any).game.playerEntity;
			if (!p || !p.params || (p.params.currentHp || 0) <= 0) return deny('角色不可用');
			this.enterMerchant();
			return true;
		} catch (e) { console.warn('[trade] requestMerchant failed', e); return false; }
	}

	private enterMerchant(): void {
		try {
			this.merchant = true;
			this.lastHp = this.readHp();
			this.lastMap = this.readMap();
			const conn = this.conn();
			if (conn && typeof conn.tradeMerchant === 'function') conn.tradeMerchant(true);
			console.log('[trade] merchant mode ON');
			this.toast('已进入商人状态：头顶出现图标，其他玩家可点击你发起交易');
		} catch (_) { /* ignore */ }
	}

	public exitMerchant(reason: string): void {
		try {
			if (!this.merchant) return;
			this.merchant = false;
			const conn = this.conn();
			if (conn && typeof conn.tradeMerchant === 'function') conn.tradeMerchant(false);
			console.log('[trade] merchant mode OFF (' + reason + ')');
			this.toast('已退出商人状态' + (reason === 'manual' ? '' : '（' + reason + '）'));
		} catch (_) { /* ignore */ }
	}

	private onMerchantPresence(d: { pl: string, on: boolean }): void {
		try {
			if (!d || d.pl === this.main.name) return;
			if (d.on) this.merchants[d.pl] = true;
			else {
				delete this.merchants[d.pl];
				this.dropBubble(d.pl);
			}
		} catch (_) { /* ignore */ }
	}

	// -------------------------------------------------------------- invite flow

	private onInvite(d: { from: string }): void {
		try {
			if (!this.enabled || !d || !d.from || d.from === this.main.name) return;
			if (this.session) return; // already trading
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) return;
			this.showInviteBox(d.from);
		} catch (_) { /* ignore */ }
	}

	private showInviteBox(from: string): void {
		this.hideInviteBox();
		this.inviteFrom = from;
		this.inviteAt = Date.now();
		const box = document.createElement('div');
		box.id = 'mpTradeInvite';
		const style = document.createElement('style');
		style.textContent = [
			'#mpTradeInvite{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:99999;',
			'background:linear-gradient(180deg,rgba(15,28,48,0.97),rgba(8,16,30,0.97));border:2px solid #4a7ca8;',
			'border-radius:10px;padding:18px 28px;color:#dff3ff;min-width:320px;text-align:center;',
			'font-family:"Microsoft YaHei","Segoe UI",sans-serif;font-size:15px;',
			'box-shadow:0 10px 44px rgba(0,0,0,0.75),inset 0 0 0 1px rgba(127,212,255,0.10);}',
			'#mpTradeInvite .tiTitle{margin-bottom:14px;font-size:16px;color:#8fdcff;}',
			'#mpTradeInvite button{cursor:pointer;margin:0 8px;padding:7px 24px;border-radius:6px;font-size:14px;letter-spacing:1px;',
			'border:1px solid #3a6a94;background:linear-gradient(180deg,#1b4568,#123453);color:#dff3ff;}',
			'#mpTradeInvite button.tiYes{background:linear-gradient(180deg,#1f7a52,#14553a);border-color:#2f9c6c;}',
			'#mpTradeInvite button:hover{filter:brightness(1.25);}',
		].join('');
		document.head.appendChild(style);
		box.innerHTML = '<div class="tiTitle">【' + this.esc(from) + '】请求与你交易</div>'
			+ '<button class="tiYes">接受</button><button>拒绝</button>';
		const btns = box.querySelectorAll('button');
		btns[0].addEventListener('click', () => {
			const conn = this.conn();
			if (conn && typeof conn.tradeAccept === 'function') conn.tradeAccept(this.inviteFrom);
			this.hideInviteBox();
		});
		btns[1].addEventListener('click', () => this.hideInviteBox());
		document.body.appendChild(box);
		this.inviteBox = box;
	}

	private hideInviteBox(): void {
		this.inviteFrom = '';
		try { if (this.inviteBox && this.inviteBox.parentNode) this.inviteBox.parentNode.removeChild(this.inviteBox); } catch (_) { /* ignore */ }
		this.inviteBox = null;
	}

	// ------------------------------------------------------------ session flow

	private onOpen(d: { sid: number, a: string, b: string, ratio: number }): void {
		try {
			if (!this.enabled || !d || d.a !== this.main.name && d.b !== this.main.name) return;
			// Anti-dupe belt-and-braces: the server already refuses locked accounts,
			// but if a session ever opens while WE are locked, drop it immediately.
			if (this.lockRemainMs() > 0) {
				const conn0 = this.conn();
				if (conn0 && typeof conn0.tradeCancel === 'function') conn0.tradeCancel(d.sid, 'trade-locked');
				this.toast('交易已取消：你处于交易限制期');
				return;
			}
			// Starting a trade ends merchant mode for BOTH the icon and the rules.
			this.exitMerchant('trade-start');
			this.hideInviteBox();
			const mySide = d.a === this.main.name ? 'a' : 'b';
			this.session = {
				sid: d.sid,
				partner: mySide === 'a' ? d.b : d.a,
				ratio: (typeof d.ratio === 'number' && isFinite(d.ratio) && d.ratio >= 1) ? d.ratio : this.ratio,
				mySide,
				myOffer: [],
				theirOffer: [],
				myReady: false,
				theirReady: false,
				partnerKnown: null,
				applying: false,
			};
			this.lastMap = this.readMap();
			// Publish OUR obtained-once tradeable ids so the partner's picker can filter.
			try {
				const conn = this.conn();
				if (conn && typeof conn.tradeKnown === 'function') conn.tradeKnown(d.sid, this.knownTradeableIds());
			} catch (_) { /* ignore */ }
			this.buildPanel();
			this.setInputLock(true);
			console.log('[trade] session ' + d.sid + ' open with ' + this.session.partner);
		} catch (e) { console.warn('[trade] open failed', e); }
	}

	private onKnown(d: { sid: number, from: string, ids: string[] }): void {
		try {
			if (!this.session || this.session.sid !== d.sid || this.session.partner !== d.from) return;
			const map: any = Object.create(null);
			for (let i = 0; i < d.ids.length; i++) map[d.ids[i]] = true;
			this.session.partnerKnown = map;
			this.renderPanel();
		} catch (_) { /* ignore */ }
	}

	private onState(d: any): void {
		try {
			if (!this.session || this.session.sid !== d.sid) return;
			if (Array.isArray(d.items)) {
				// d.side is the SENDER's side ('a'|'b').
				if (d.side === this.session.mySide) this.session.myOffer = d.items.slice();
				else this.session.theirOffer = d.items.slice();
				this.session.myReady = false;
				this.session.theirReady = false;
			} else {
				this.session.myReady = this.session.mySide === 'a' ? d.readyA === 1 : d.readyB === 1;
				this.session.theirReady = this.session.mySide === 'a' ? d.readyB === 1 : d.readyA === 1;
			}
			this.renderPanel();
		} catch (_) { /* ignore */ }
	}

	private onApply(d: { sid: number, lose: Array<{ id: string, n: number }>, gain: Array<{ id: string, n: number }> }): void {
		try {
			if (!this.session || this.session.sid !== d.sid) return;
			const pl: any = (sc as any).model && (sc as any).model.player;
			if (!pl || typeof pl.addItem !== 'function' || typeof pl.removeItem !== 'function') { this.cancel('no-inventory'); return; }
			// Validate EVERYTHING before touching the inventory (all-or-nothing).
			for (const e of d.lose) {
				const have = this.itemCount(e.id);
				if (this.isTradeable(e.id) !== true) { this.cancel('bad-item'); return; }
				if (have < e.n) { this.cancel('missing-items'); return; }
			}
			for (const e of d.gain) {
				if (this.isTradeable(e.id) !== true) { this.cancel('bad-item'); return; }
				// The "obtained once" rule (receiver-side authority).
				if (!this.hasEverObtained(e.id)) { this.cancel('never-obtained:' + e.id); return; }
				const have = this.itemCount(e.id);
				if (have + e.n > 99) { this.cancel('overflow:' + e.id); return; }
			}
			// Apply in one synchronous pass: give first, then receive.
			for (const e of d.lose) {
				try { pl.removeItem(Number(e.id), e.n); } catch (_) { /* ignore */ }
			}
			for (const e of d.gain) {
				try { pl.addItem(Number(e.id), e.n); } catch (_) { /* ignore */ }
			}
			const conn = this.conn();
			if (conn && typeof conn.tradeApplied === 'function') conn.tradeApplied(d.sid);
			// Anti-dupe: persist the post-trade state IMMEDIATELY (local save + server
			// upload via the onStorageSave hook), so restoring an older save/mirror can
			// never resurrect the items just traded away.
			try { this.main.saveNow('trade'); } catch (_) { /* ignore */ }
			console.log('[trade] applied: -' + d.lose.length + ' +' + d.gain.length + ' lines (saved)');
		} catch (e) {
			console.warn('[trade] apply failed', e);
			this.cancel('apply-error');
		}
	}

	private onDone(d: { sid: number }): void {
		try {
			if (!this.session || this.session.sid !== d.sid) return;
			this.toast('交易完成，存档已自动保存并上传');
			this.closePanel('交易完成');
			this.session = null;
			this.setInputLock(false);
		} catch (_) { /* ignore */ }
	}

	private onClosed(d: { sid: number, reason: string }): void {
		try {
			if (!this.session || this.session.sid !== d.sid) return;
			const why: any = {
				cancel: '对方取消了交易',
				disconnect: '对方断开了连接',
				'missing-items': '物品数量不足',
				'never-obtained': '存在未获得过的物品',
				overflow: '物品数量将超过上限',
				'bad-item': '存在不可交易的物品',
			};
			const msg = '交易取消' + (why[d.reason] ? '：' + why[d.reason] : (d.reason ? '：' + d.reason : ''));
			this.closePanel(msg);
			this.session = null;
			this.setInputLock(false);
		} catch (_) { /* ignore */ }
	}

	private cancel(reason: string): void {
		try {
			const s = this.session;
			if (!s) return;
			const conn = this.conn();
			if (conn && typeof conn.tradeCancel === 'function') conn.tradeCancel(s.sid, reason);
			this.closePanel('交易取消');
			this.session = null;
			this.setInputLock(false);
		} catch (_) { /* ignore */ }
	}

	// -------------------------------------------------------------- item rules

	/** tradeable = TRADE-type material with rarity < LEGENDARY(3), or food (CONS). */
	public isTradeable(id: string): boolean {
		try {
			const inv: any = (sc as any).inventory;
			const data = inv && typeof inv.getItem === 'function' ? inv.getItem(id) : null;
			if (!data) return false;
			const T = (sc as any).ITEMS_TYPES || {};
			const R = (sc as any).ITEMS_RARITY || {};
			if (data.type === T.TRADE) return !(data.rarity >= (R.LEGENDARY !== undefined ? R.LEGENDARY : 3));
			if (data.type === T.CONS) return true;
			return false;
		} catch (_) { return false; }
	}

	/** Cumulative "ever obtained" (sc.stats.values.items[id], never decremented). */
	private hasEverObtained(id: string): boolean {
		try {
			const st: any = (sc as any).stats;
			const map = st && st.values && st.values.items;
			if (map && map[id] > 0) return true;
			// Fallback: currently owning at least one also counts as "obtained".
			return this.itemCount(id) > 0;
		} catch (_) { return false; }
	}

	/** The ids WE have ever obtained, restricted to tradeable categories. */
	private knownTradeableIds(): string[] {
		const out: string[] = [];
		try {
			const st: any = (sc as any).stats;
			const map = st && st.values && st.values.items;
			// Owned counts live on the PLAYER model; sc.inventory.items is the DB.
			const owned: any = (sc as any).model && (sc as any).model.player && (sc as any).model.player.items;
			const seen: any = Object.create(null);
			const push = (id: string) => {
				if (seen[id]) return;
				seen[id] = 1;
				if (this.isTradeable(id)) out.push(id);
			};
			if (map) for (const k in map) push(k);
			if (owned) for (let i = 0; i < owned.length; i++) {
				if (owned[i] > 0) push(String(i));
			}
			if (out.length > 512) out.length = 512;
		} catch (_) { /* ignore */ }
		return out;
	}

	/** My pickable inventory: tradeable, count > 0, and (when known) the partner
	 * has obtained the item at least once. */
	private pickableItems(): Array<{ id: string, n: number, name: string }> {
		const out: Array<{ id: string, n: number, name: string }> = [];
		try {
			// sc.inventory.items is the item DATABASE; owned counts are on the player.
			const pl: any = (sc as any).model && (sc as any).model.player;
			const owned: any = pl && pl.items;
			if (!owned) return out;
			const offered: any = Object.create(null);
			for (const e of (this.session ? this.session.myOffer : [])) offered[e.id] = true;
			for (let i = 0; i < owned.length; i++) {
				const n = owned[i] || 0;
				if (n <= 0) continue;
				const id = String(i);
				if (offered[id]) continue;
				if (!this.isTradeable(id)) continue;
				if (this.session && this.session.partnerKnown && !this.session.partnerKnown[id]) continue;
				out.push({ id, n, name: this.itemName(id) });
			}
			out.sort((a, b) => a.name.localeCompare(b.name));
		} catch (_) { /* ignore */ }
		return out;
	}

	private itemName(id: string): string {
		try {
			const inv: any = (sc as any).inventory;
			// The native helper resolves the LangLabel name in the CURRENT language.
			if (inv && typeof inv.getItemName === 'function') {
				const n = inv.getItemName(Number(id));
				if (n && typeof n === 'string') return n;
			}
			const data = inv && typeof inv.getItem === 'function' ? inv.getItem(Number(id)) : null;
			const name: any = data && data.name;
			if (name) {
				const LL: any = (ig as any).LangLabel;
				if (LL && typeof LL.getText === 'function') {
					const t = LL.getText(name);
					if (t && typeof t === 'string') return t;
				}
				if (typeof name.toString === 'function') {
					const s = name.toString();
					if (s && s !== '[object Object]') return s;
				}
			}
		} catch (_) { /* ignore */ }
		return id;
	}

	/** Renders the item's REAL game icon (the same glyph the inventory list uses)
	 * into a small canvas and caches the dataURL. Source: sc.inventory.getItemIcon
	 * -> "\\i[name]" escape -> sc.fontsystem.font.mapping[name] = [setIdx, glyph]
	 * -> iconSets[setIdx] font sheet cell (indicesX/indicesY/widthMap/charHeight).
	 * Returns null when anything is unavailable (row just shows no icon). */
	private itemIconUrl(id: string): string | null {
		if (id in this.iconUrlCache) return this.iconUrlCache[id];
		let url: string | null = null;
		try {
			const inv: any = (sc as any).inventory;
			const raw = inv && typeof inv.getItemIcon === 'function' ? inv.getItemIcon(Number(id)) : null;
			const mm = typeof raw === 'string' ? raw.match(/\\i\[([^\]]+)\]/) : null;
			let iconName: string | null = mm ? mm[1] : null;
			const fs: any = (sc as any).fontsystem;
			const font = fs && fs.font;
			let map: any = font && font.mapping && iconName ? font.mapping[iconName] : null;
			if (!map && font && font.mapping) { iconName = 'item-default'; map = font.mapping['item-default']; }
			const set = map && font.iconSets ? font.iconSets[map[0]] : null;
			const ci = map ? map[1] : -1;
			if (set && set.loaded && set.data && set.indicesX && ci >= 0 && ci < set.indicesX.length) {
				const w = (set.widthMap[ci] || 15) + 1;
				const h = set.charHeight || 16;
				const cv = document.createElement('canvas');
				cv.width = w * 2;
				cv.height = h * 2;
				const ctx = cv.getContext('2d');
				if (ctx) {
					ctx.imageSmoothingEnabled = false;
					ctx.drawImage(set.data, set.indicesX[ci], set.indicesY[ci], w, h, 0, 0, w * 2, h * 2);
					url = cv.toDataURL();
				}
			}
		} catch (_) { /* ignore */ }
		this.iconUrlCache[id] = url;
		return url;
	}
	private iconUrlCache: { [id: string]: string | null } = Object.create(null);

	private iconImg(id: string): string {
		const url = this.itemIconUrl(id);
		return url ? '<img class="tpIcon" src="' + url + '" alt="">' : '<span class="tpIcon tpNoIcon"></span>';
	}

	/** OWNED count of an item. NOTE: sc.inventory is the item DATABASE — the
	 * player's owned counts live on sc.model.player (getItemAmount/items[]). */
	private itemCount(id: string): number {
		try {
			const pl: any = (sc as any).model && (sc as any).model.player;
			if (pl && typeof pl.getItemAmount === 'function') return pl.getItemAmount(Number(id)) || 0;
			if (pl && pl.items) return pl.items[id] || 0;
		} catch (_) { /* ignore */ }
		return 0;
	}

	// ------------------------------------------------------------------- panel

	private esc(s: string): string {
		return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
	}

	private buildPanel(): void {
		this.closePanel(null);
		const s = this.session;
		if (!s) return;
		const panel = document.createElement('div');
		panel.id = 'mpTradePanel';
		// NW.js' bundled Chromium ignores CSS min()/vw here — size the panel
		// explicitly in px instead (wide landscape layout, width >> height).
		const pw = Math.round((window.innerWidth || 1280) * 0.9);
		const ph = Math.min(470, Math.round((window.innerHeight || 720) * 0.78));
		panel.style.width = pw + 'px';
		panel.style.height = ph + 'px';
		const style = document.createElement('style');
		const effNote = s.ratio > 1 ? ('兑换比例 1:' + s.ratio + '（对方实际收到 ⌊数量/' + s.ratio + '⌋）') : '兑换比例 1:1（无损耗）';
		style.textContent = [
			'#mpTradePanel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99998;',
			'display:flex;flex-direction:column;',
			'background:linear-gradient(180deg,rgba(15,28,48,0.98),rgba(8,16,30,0.98));',
			'border:2px solid #4a7ca8;border-radius:10px;color:#dff3ff;overflow:hidden;',
			'font-family:"Microsoft YaHei","Segoe UI",sans-serif;font-size:14px;',
			'box-shadow:0 10px 44px rgba(0,0,0,0.75),inset 0 0 0 1px rgba(127,212,255,0.10);}',
			'#mpTradePanel .tpHead{display:flex;align-items:center;gap:14px;padding:13px 22px 12px;',
			'background:linear-gradient(180deg,rgba(38,72,108,0.55),rgba(22,44,68,0.35));border-bottom:1px solid rgba(122,178,220,0.35);}',
			'#mpTradePanel .tpTitle{font-size:18px;font-weight:bold;color:#8fdcff;letter-spacing:2px;text-shadow:0 0 8px rgba(127,212,255,0.4);}',
			'#mpTradePanel .tpHeadSep{width:1px;height:20px;flex:none;background:rgba(122,178,220,0.4);}',
			'#mpTradePanel .tpPartner{display:inline-flex;align-items:baseline;gap:7px;font-size:12.5px;color:#9fc6d8;',
			'padding:4px 13px;border-radius:12px;background:rgba(255,226,168,0.08);border:1px solid rgba(255,210,130,0.45);}',
			'#mpTradePanel .tpPartner b{font-size:16px;font-weight:bold;color:#ffe2a8;letter-spacing:0.5px;}',
			'#mpTradePanel .tpRatio{margin-left:auto;font-size:12px;color:#9fc6d8;background:rgba(10,24,40,0.6);',
			'border:1px solid rgba(74,124,168,0.5);border-radius:10px;padding:2px 10px;}',
			'#mpTradePanel .tpNote{padding:8px 22px 10px;color:#8fb8cc;font-size:12.5px;border-bottom:1px solid rgba(122,178,220,0.18);letter-spacing:0.3px;}',
			'#mpTradePanel .tpCols{flex:1;display:flex;gap:26px;padding:14px 22px;min-height:0;}',
			'#mpTradePanel .tpCol{flex:1;display:flex;flex-direction:column;min-width:0;',
			'border:1px solid rgba(74,124,168,0.45);border-radius:8px;overflow:hidden;background:rgba(10,22,38,0.5);}',
			'#mpTradePanel .tpColHead{display:flex;align-items:center;gap:10px;padding:10px 14px;font-size:14px;font-weight:bold;',
			'color:#a9d9f2;background:rgba(30,58,88,0.65);border-bottom:1px solid rgba(122,178,220,0.25);}',
			'#mpTradePanel .tpColHead .tpHint{margin-left:auto;font-weight:normal;font-size:11px;color:#6f93a5;}',
			'#mpTradePanel .tpCol.tpColBag{border-color:rgba(96,168,128,0.55);background:rgba(12,26,22,0.55);}',
			'#mpTradePanel .tpCol.tpColBag .tpColHead{color:#b9ecd2;background:rgba(26,66,50,0.65);border-bottom-color:rgba(140,200,165,0.30);}',
			'#mpTradePanel .tpCol.tpColBag .tpColHead .tpHint{color:#7fa88f;}',
			'#mpTradePanel .tpCol.tpColBag .tpRow:hover{background:rgba(72,150,112,0.22);}',
			'#mpTradePanel .tpCol.tpColBag .tpList::-webkit-scrollbar-thumb{background:#2f5c44;}',
			'#mpTradePanel .tpBadge{font-weight:normal;font-size:11px;border-radius:8px;padding:1px 8px;}',
			'#mpTradePanel .tpBadge.tpOn{color:#8fd4a0;background:rgba(31,111,74,0.35);border:1px solid #2f9c6c;}',
			'#mpTradePanel .tpBadge.tpOff{color:#6f93a5;background:rgba(20,40,60,0.4);border:1px solid rgba(74,124,168,0.4);}',
			'#mpTradePanel .tpList{flex:1;overflow-y:auto;padding:6px;min-height:0;}',
			'#mpTradePanel .tpList::-webkit-scrollbar{width:10px;}',
			'#mpTradePanel .tpList::-webkit-scrollbar-thumb{background:#33597c;border-radius:4px;}',
			'#mpTradePanel .tpList::-webkit-scrollbar-track{background:rgba(8,18,32,0.5);}',
			'#mpTradePanel .tpRow{display:flex;align-items:center;gap:12px;padding:7px 10px;border-radius:6px;min-height:38px;box-sizing:border-box;}',
			'#mpTradePanel .tpRow:hover{background:rgba(64,130,180,0.22);}',
			'#mpTradePanel .tpRow.tpPick{cursor:pointer;}',
			'#mpTradePanel .tpIcon{width:24px;height:24px;flex:none;image-rendering:pixelated;display:inline-block;}',
			'#mpTradePanel .tpName{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e8f6ff;}',
			'#mpTradePanel .tpCnt{flex:none;min-width:24px;text-align:center;padding:2px 9px;border-radius:10px;',
			'font-size:13px;font-weight:bold;color:#ffd57f;font-variant-numeric:tabular-nums;letter-spacing:0.5px;',
			'background:rgba(255,213,127,0.09);border:1px solid rgba(255,213,127,0.40);margin:0 6px;}',
			'#mpTradePanel .tpEmpty{color:#5d8098;text-align:center;padding:28px 6px;font-size:13px;}',
			'#mpTradePanel .tpAdd{flex:none;display:flex;gap:5px;margin-left:6px;}',
			'#mpTradePanel .tpAdd button{cursor:pointer;width:26px;height:26px;padding:0;font-size:15px;line-height:1;border-radius:6px;',
			'border:1px solid #3a6a94;background:#15344e;color:#bfe6ff;}',
			'#mpTradePanel .tpAdd button:hover{background:#1d4a6e;}',
			'#mpTradePanel .tpStep{display:flex;align-items:center;gap:4px;flex:none;margin:0 4px;}',
			'#mpTradePanel .tpStep button{cursor:pointer;width:23px;height:23px;line-height:1;border-radius:5px;padding:0;',
			'border:1px solid #3a6a94;background:#15344e;color:#bfe6ff;font-size:14px;}',
			'#mpTradePanel .tpStep button:hover{background:#1d4a6e;}',
			'#mpTradePanel .tpQtyInput{width:44px;text-align:center;color:#ffd57f;font-size:13px;font-weight:bold;',
			'font-variant-numeric:tabular-nums;padding:2px 4px;border-radius:9px;margin:0 2px;outline:none;',
			'background:rgba(255,213,127,0.09);border:1px solid rgba(255,213,127,0.40);font-family:inherit;caret-color:#ffe9b8;}',
			'#mpTradePanel .tpQtyInput:hover{background:rgba(255,213,127,0.13);}',
			'#mpTradePanel .tpQtyInput:focus{border-color:#ffd57f;background:rgba(255,213,127,0.16);box-shadow:0 0 6px rgba(255,213,127,0.35);}',
			'#mpTradePanel .tpPill{flex:none;display:inline-flex;align-items:baseline;gap:6px;font-size:12px;',
			'border-radius:11px;padding:3px 11px;white-space:nowrap;letter-spacing:0.3px;margin:0 4px;}',
			'#mpTradePanel .tpPill b{font-size:15px;font-weight:bold;}',
			'#mpTradePanel .tpPill.tpGive{color:#ffd9a0;background:rgba(138,101,28,0.28);border:1px solid #a87f2e;}',
			'#mpTradePanel .tpPill.tpGive b{color:#ffcf6e;}',
			'#mpTradePanel .tpPill.tpGet{color:#a9f0c0;background:rgba(31,111,74,0.28);border:1px solid #2f9c6c;}',
			'#mpTradePanel .tpPill.tpGet b{color:#7fe6a8;}',
			'#mpTradePanel .tpLocked .tpRow{pointer-events:none;opacity:0.55;}',
			'#mpTradePanel .tpFoot{display:flex;align-items:center;gap:16px;padding:12px 20px;',
			'border-top:1px solid rgba(122,178,220,0.3);background:rgba(18,36,58,0.5);}',
			'#mpTradePanel .tpStatus{flex:1;text-align:center;color:#ffd57f;font-size:13px;}',
			'#mpTradePanel .tpBtn{cursor:pointer;padding:7px 22px;border-radius:6px;font-size:14px;letter-spacing:1px;',
			'border:1px solid #3a6a94;background:linear-gradient(180deg,#1b4568,#123453);color:#dff3ff;}',
			'#mpTradePanel .tpBtn:hover{filter:brightness(1.25);}',
			'#mpTradePanel .tpBtnGold{border-color:#d9a83c;background:linear-gradient(180deg,#8a651c,#6d4e12);color:#ffe9b8;}',
			'#mpTradePanel .tpBtnGray{border-color:#5a6a7a;background:linear-gradient(180deg,#37424e,#262e38);color:#c9d6de;}',
		].join('');
		document.head.appendChild(style);
		panel.innerHTML =
			'<div class="tpHead"><span class="tpTitle">玩家交易</span>'
			+ '<span class="tpHeadSep"></span>'
			+ '<span class="tpPartner">交易对象<b>' + this.esc(s.partner) + '</b></span>'
			+ '<span class="tpRatio">' + this.esc(effNote) + '</span></div>'
			+ '<div class="tpNote">仅可交易普通材料与食物 · 报价数量可直接输入（减到 0 自动移除）· Shift+点击 +/− 一次 ±10 · 进入战斗或离开房间将取消交易</div>'
			+ '<div class="tpCols">'
			+ '<div class="tpCol tpColBag"><div class="tpColHead"><span>我的背包</span><span class="tpHint">点击物品加入报价</span></div><div class="tpList" id="mpTradePick"></div></div>'
			+ '<div class="tpCol"><div class="tpColHead"><span>我的报价</span><span class="tpBadge tpOff" id="mpTradeMyBadge">未锁定</span><span class="tpHint">对方实收</span></div><div class="tpList" id="mpTradeMine"></div></div>'
			+ '<div class="tpCol"><div class="tpColHead"><span>对方报价</span><span class="tpBadge tpOff" id="mpTradeTheirBadge">未锁定</span><span class="tpHint">我的实收</span></div><div class="tpList" id="mpTradeTheirs"></div></div>'
			+ '</div>'
			+ '<div class="tpFoot"><button class="tpBtn tpBtnGray" id="mpTradeCancel">取消交易</button>'
			+ '<span class="tpStatus" id="mpTradeStatus"></span>'
			+ '<button class="tpBtn tpBtnGold" id="mpTradeLock">锁定报价</button></div>';
		document.body.appendChild(panel);
		this.panel = panel;
		panel.querySelector('#mpTradeCancel').addEventListener('click', () => this.cancel('cancel'));
		panel.querySelector('#mpTradeLock').addEventListener('click', () => this.toggleReady());
		this.renderPanel();
	}

	private toggleReady(): void {
		try {
			const s = this.session;
			if (!s || s.applying) return;
			const conn = this.conn();
			if (!conn || typeof conn.tradeReady !== 'function') return;
			conn.tradeReady(s.sid, !s.myReady);
		} catch (_) { /* ignore */ }
	}

	private renderPanel(): void {
		const s = this.session;
		const panel = this.panel;
		if (!s || !panel || !panel.parentNode) return;
		try {
			// Preserve scroll positions across the full rebuild.
			const keepScroll: { [id: string]: number } = {};
			for (const lid of ['mpTradePick', 'mpTradeMine', 'mpTradeTheirs']) {
				const el: any = panel.querySelector('#' + lid);
				if (el) keepScroll[lid] = el.scrollTop;
			}
			const locked = s.myReady || s.applying;

			// Preserve an in-progress quantity edit (focus + typed text) across
			// the full rebuild below (e.g. when a network update arrives mid-edit).
			const ae: any = document.activeElement;
			let editId: string | null = null;
			let editVal = '';
			if (ae && ae.classList && ae.classList.contains('tpQtyInput') && panel.contains(ae)) {
				editId = ae.getAttribute('data-id');
				editVal = String(ae.value);
			}

			// Picker column.
			const pick: any = panel.querySelector('#mpTradePick');
			if (pick) {
				pick.classList.toggle('tpLocked', locked);
				const items = this.pickableItems();
				pick.innerHTML = items.length ? '' : '<div class="tpEmpty">（没有可交易的物品' + (s.partnerKnown ? '' : '，等待对方数据…') + '）</div>';
				for (const it of items) {
					const row = document.createElement('div');
					row.className = 'tpRow tpPick';
					row.innerHTML = this.iconImg(it.id)
						+ '<span class="tpName" title="' + this.esc(it.name) + '">' + this.esc(it.name) + '</span>'
						+ '<span class="tpCnt">×' + it.n + '</span>'
						+ '<span class="tpAdd"><button title="点击 +1，Shift+点击 +10">+</button></span>';
					row.querySelectorAll('.tpAdd button').forEach((b: any) => {
						b.addEventListener('click', (ev: any) => {
							ev.stopPropagation();
							this.addToOffer(it.id, ev && ev.shiftKey ? 10 : 1);
						});
					});
					row.addEventListener('click', () => this.addToOffer(it.id, 1));
					pick.appendChild(row);
				}
			}
			// My offer column (qty steppers + effective receive preview).
			const mine: any = panel.querySelector('#mpTradeMine');
			if (mine) {
				mine.classList.toggle('tpLocked', locked);
				mine.innerHTML = s.myOffer.length ? '' : '<div class="tpEmpty">（点击左侧背包物品加入报价）</div>';
				for (const e of s.myOffer) {
					const eff = Math.floor(e.n / s.ratio);
					const row = document.createElement('div');
					row.className = 'tpRow';
					row.innerHTML = this.iconImg(e.id)
						+ '<span class="tpName" title="' + this.esc(this.itemName(e.id)) + '">' + this.esc(this.itemName(e.id)) + '</span>'
						+ (s.ratio > 1 ? '<span class="tpPill tpGive">对方实收 <b>' + eff + '</b></span>' : '')
						+ '<span class="tpStep"><button data-d="-1">−</button>'
						+ '<input class="tpQtyInput" type="text" inputmode="numeric" maxlength="2" data-id="' + this.esc(e.id) + '" value="' + e.n + '" title="直接输入数量；0 或更小将移除该项"/>'
						+ '<button data-d="1">+</button></span>';
					row.querySelectorAll('.tpStep button').forEach((b: any) => {
						b.addEventListener('click', (ev: any) => {
							ev.stopPropagation();
							const d = (parseInt(b.getAttribute('data-d') || '0', 10)) * (ev && ev.shiftKey ? 10 : 1);
							this.bumpOffer(e.id, d);
						});
					});
					const qty: any = row.querySelector('.tpQtyInput');
					if (qty) {
						// Editable quantity: commit on Enter/blur; 0 or less removes the row.
						qty.addEventListener('click', (ev: any) => ev.stopPropagation());
						qty.addEventListener('keydown', (ev: any) => {
							ev.stopPropagation();
							if (ev.key === 'Enter') qty.blur();
							else if (ev.key === 'Escape') { qty.value = String(e.n); qty.blur(); }
						});
						qty.addEventListener('keyup', (ev: any) => ev.stopPropagation());
						qty.addEventListener('change', () => {
							const raw = String(qty.value).trim();
							const v = Math.floor(Number(raw));
							if (raw === '' || !isFinite(v)) { this.renderPanel(); return; }
							if (v <= 0) { this.removeFromOffer(e.id); return; }
							this.setOfferQty(e.id, v);
						});
					}
					mine.appendChild(row);
				}
			}
			// Their offer column (my effective gain preview).
			const theirs: any = panel.querySelector('#mpTradeTheirs');
			if (theirs) {
				theirs.innerHTML = s.theirOffer.length ? '' : '<div class="tpEmpty">（对方还没有报价）</div>';
				for (const e of s.theirOffer) {
					const eff = Math.floor(e.n / s.ratio);
					const row = document.createElement('div');
					row.className = 'tpRow';
					row.innerHTML = this.iconImg(e.id)
						+ '<span class="tpName" title="' + this.esc(this.itemName(e.id)) + '">' + this.esc(this.itemName(e.id)) + '</span>'
						+ '<span class="tpCnt">×' + e.n + '</span>'
						+ (s.ratio > 1 ? '<span class="tpPill tpGet">我的实收 <b>' + eff + '</b></span>' : '');
					theirs.appendChild(row);
				}
			}
			// Lock badges in the column headers.
			const myBadge: any = panel.querySelector('#mpTradeMyBadge');
			if (myBadge) {
				myBadge.textContent = s.myReady ? '✓ 已锁定' : '未锁定';
				myBadge.className = 'tpBadge ' + (s.myReady ? 'tpOn' : 'tpOff');
			}
			const theirBadge: any = panel.querySelector('#mpTradeTheirBadge');
			if (theirBadge) {
				theirBadge.textContent = s.theirReady ? '✓ 已锁定' : '未锁定';
				theirBadge.className = 'tpBadge ' + (s.theirReady ? 'tpOn' : 'tpOff');
			}
			// Status + lock button.
			const status: any = panel.querySelector('#mpTradeStatus');
			if (status) {
				status.textContent = s.applying ? '交易执行中…'
					: (s.myReady ? (s.theirReady ? '双方已锁定，执行中…' : '你已锁定，等待对方…') : (s.theirReady ? '对方已锁定！改动报价将取消其锁定' : ''));
			}
			const lock: any = panel.querySelector('#mpTradeLock');
			if (lock) {
				lock.textContent = s.myReady ? '解锁报价' : '锁定报价';
				lock.className = 'tpBtn ' + (s.myReady ? 'tpBtnGray' : 'tpBtnGold');
				lock.style.display = s.applying ? 'none' : '';
			}
			// Restore scroll positions.
			for (const lid in keepScroll) {
				const el: any = panel.querySelector('#' + lid);
				if (el) el.scrollTop = keepScroll[lid];
			}
			// Restore the in-progress quantity edit, if any.
			if (editId !== null) {
				const inp: any = panel.querySelector('.tpQtyInput[data-id="' + editId + '"]');
				if (inp) {
					inp.focus();
					if (String(inp.value) !== editVal) inp.value = editVal;
					try { inp.setSelectionRange(editVal.length, editVal.length); } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
	}

	private addToOffer(id: string, qty: number): void {
		try {
			const s = this.session;
			if (!s || s.applying || s.myReady) return;
			const have = this.itemCount(id);
			if (have <= 0) return;
			const ex = s.myOffer.find((e) => e.id === id);
			if (ex) ex.n = Math.min(have, ex.n + qty);
			else s.myOffer.push({ id, n: Math.max(1, Math.min(have, qty)) });
			this.sendOffer();
		} catch (_) { /* ignore */ }
	}

	/** Stepper in the my-offer rows: adjust an offered quantity (clamped 1..have). */
	private bumpOffer(id: string, delta: number): void {
		try {
			const s = this.session;
			if (!s || s.applying || s.myReady) return;
			const e = s.myOffer.find((x) => x.id === id);
			if (!e) return;
			// Stepping down to 0 or below removes the row entirely.
			if (e.n + delta <= 0) { this.removeFromOffer(id); return; }
			const have = this.itemCount(id);
			const n = Math.min(have, e.n + delta);
			if (n === e.n) return;
			e.n = n;
			this.sendOffer();
		} catch (_) { /* ignore */ }
	}

	/** Direct quantity entry in the my-offer rows (clamped 1..owned). */
	private setOfferQty(id: string, qty: number): void {
		try {
			const s = this.session;
			if (!s || s.applying || s.myReady) return;
			const e = s.myOffer.find((x) => x.id === id);
			if (!e) return;
			const have = this.itemCount(id);
			const n = Math.max(1, Math.min(have, Math.floor(qty)));
			if (n === e.n) { this.renderPanel(); return; }
			e.n = n;
			this.sendOffer();
		} catch (_) { /* ignore */ }
	}

	private removeFromOffer(id: string): void {
		try {
			const s = this.session;
			if (!s || s.applying || s.myReady) return;
			s.myOffer = s.myOffer.filter((e) => e.id !== id);
			this.sendOffer();
		} catch (_) { /* ignore */ }
	}

	private sendOffer(): void {
		try {
			const s = this.session;
			if (!s) return;
			const conn = this.conn();
			if (!conn || typeof conn.tradeOffer !== 'function') return;
			conn.tradeOffer(s.sid, s.myOffer);
			this.renderPanel();
		} catch (_) { /* ignore */ }
	}

	private closePanel(msg: string | null): void {
		try {
			if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
		} catch (_) { /* ignore */ }
		this.panel = null;
		if (msg) console.log('[trade] ' + msg);
	}

	/** Blocks ALL gameplay + menu input while the trade panel is open, using the
	 * game's own auto-control addon (the mechanism cutscene auto-walk uses): once
	 * active, every sc.control query — move/attack/dash/guard/pause/menu/quickmenu/
	 * element switch/interact — routes to it and reports "not pressed". */
	private setInputLock(on: boolean): void {
		try {
			const ac: any = (sc as any).autoControl;
			if (!ac || typeof ac.setActive !== 'function') return;
			if (on) {
				ac.setActive(true);
				this._inputLocked = true;
			} else if (this._inputLocked) {
				this._inputLocked = false;
				if (typeof ac.isActive !== 'function' || ac.isActive()) ac.setActive(false);
			}
		} catch (_) { /* ignore */ }
	}
	private _inputLocked = false;

	// ------------------------------------------------------------- head icons

	private readMap(): string {
		try { return (ig as any).game ? String((ig as any).game.mapName || '') : ''; } catch (_) { return ''; }
	}

	private readHp(): number {
		try {
			const p: any = (ig as any).game && (ig as any).game.playerEntity;
			return p && p.params ? (p.params.currentHp || 0) : -1;
		} catch (_) { return -1; }
	}

	/** The NPC shopkeeper bubble icon (map-icon.png @0,240: animated big FOCUS
	 * bubble, small NEAR bubble, tiny AWAY marker). Shared read-only with the NPC
	 * class's own interactIcons.shop set. */
	private shopBubbleIcon(): any {
		try {
			const NPC: any = (ig.ENTITY as any).NPC;
			const shop = NPC && NPC.prototype && NPC.prototype.interactIcons && NPC.prototype.interactIcons.shop;
			if (shop) return shop;
			return new (sc as any).MapInteractIcon(new (ig as any).TileSheet('media/gui/map-icon.png', 24, 24, 0, 240), { FOCUS: [0, 0, 1, 2, 3, 0, 0, 0, 0], NEAR: [4], AWAY: [5] }, 0.1);
		} catch (_) { return null; }
	}

	/** Create (or keep) the native bubble entry for a merchant entity. The native
	 * machine drives AWAY/NEAR/FOCUS from player distance + cursor/facing. */
	private bubbleFor(name: string, ent: any): any {
		try {
			const mi: any = (sc as any).mapInteract;
			if (!mi || !(sc as any).MapInteractEntry || typeof mi.addEntry !== 'function') return null;
			let e = this.bubbles[name];
			// reuse only while the entry is still live on the SAME entity (the
			// native machine auto-removes entries whose entity was killed)
			if (e && e.entity === ent && mi.entries && mi.entries.indexOf(e) !== -1) return e;
			if (e) this.dropBubble(name);
			const icon = this.shopBubbleIcon();
			if (!icon) return null;
			const self = this;
			const handler = {
				onInteraction: function () { self.onBubbleInteract(name); return false; },
			};
			e = new (sc as any).MapInteractEntry(ent, handler, icon, (sc as any).INTERACT_Z_CONDITION.Z_RANGE_OVERLAP, false);
			e.blockedDuringCombat = true; // combat cancels trading anyway
			mi.addEntry(e);
			this.bubbles[name] = e;
			return e;
		} catch (_) { return null; }
	}

	private dropBubble(name: string): void {
		try {
			const e = this.bubbles[name];
			if (!e) return;
			delete this.bubbles[name];
			const mi: any = (sc as any).mapInteract;
			if (mi && mi.entries && mi.entries.indexOf(e) !== -1 && typeof mi.removeEntry === 'function') {
				mi.removeEntry(e);
			} else if (e.gui && typeof e.gui.remove === 'function') {
				e.gui.remove();
			}
		} catch (_) { /* ignore */ }
	}

	private dropAllBubbles(): void {
		try {
			for (const name in this.bubbles) this.dropBubble(name);
		} catch (_) { /* ignore */ }
	}

	/** Trade invite fired by the native bubble — FOCUS-only by construction (the
	 * map-interact machine only calls onInteraction for the focused entry, i.e.
	 * 靠近等气泡变大后点击/按互动键才会触发). */
	private onBubbleInteract(name: string): void {
		try {
			if (name === '__self') return; // merchants invite nobody (their own bubble is display-only)
			if (!this.enabled) return;
			if (Date.now() < this._inviteLockUntil) return;
			if (this.session) { this.toast('正在进行交易'); return; }
			if (this.inviteBox) return;
			const conn = this.conn();
			if (!conn || typeof conn.tradeInvite !== 'function') return;
			const lockMs = this.lockRemainMs();
			if (lockMs > 0) {
				this.toast('无法交易：你处于交易限制期，剩余约 ' + this.fmtLockRemain(lockMs));
				this._inviteLockUntil = Date.now() + 1200;
				return;
			}
			conn.tradeInvite(name);
			// Debounce: don't re-fire until the key/click is long released.
			this._inviteLockUntil = Date.now() + 1200;
		} catch (_) { /* ignore */ }
	}

	/** The merchant's OWN bubble always shows the big FOCUS state (自己看头顶默认
	 * 大气泡) — forced AFTER the native state machine ran (installed wrap), plus
	 * a pump fallback. Never forced while the native machine has hidden all
	 * bubbles (cutscene / menu) or while the game is paused. */
	private forceSelfBubbleFocus(): void {
		try {
			const e = this.bubbles['__self'];
			if (!e) return;
			const mi: any = (sc as any).mapInteract;
			if (!mi || mi.hidden) return;
			const g: any = (ig as any).game;
			if (!g || g.paused) return;
			const STATE = (sc as any).INTERACT_ENTRY_STATE;
			if (STATE && e.state !== STATE.FOCUS) e.setState(STATE.FOCUS);
		} catch (_) { /* ignore */ }
	}

	/** Small transient bottom-center DOM notice (same overlay approach as the
	 * invite box) — visible feedback for trade-state changes. */
	private toast(msg: string): void {
		try {
			const doc = window.document;
			let host = doc.getElementById('mpTradeToasts');
			if (!host) {
				host = doc.createElement('div');
				host.id = 'mpTradeToasts';
				host.setAttribute('style', 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);'
					+ 'z-index:99999;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;');
				const st = doc.createElement('style');
				st.textContent = '#mpTradeToasts div{background:linear-gradient(180deg,rgba(15,28,48,0.95),rgba(8,16,30,0.95));'
					+ 'border:1px solid #4a7ca8;border-radius:6px;padding:7px 16px;color:#dff3ff;font-size:13px;'
					+ 'font-family:"Microsoft YaHei","Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.6);}';
				doc.head.appendChild(st);
				doc.body.appendChild(host);
			}
			const el = doc.createElement('div');
			el.textContent = msg;
			host.appendChild(el);
			window.setTimeout(() => {
				try {
					el.remove();
					if (host && host.childElementCount === 0) host.remove();
				} catch (_) { /* ignore */ }
			}, 3000);
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------- pump

	private pump(): void {
		try {
			const m = this.main;
			if (!m || !m.connection || (typeof m.connection.isOpen === 'function' && !m.connection.isOpen())) {
				if (this.merchant) this.exitMerchant('disconnect');
				if (this.session) { this.session = null; this.setInputLock(false); this.closePanel('连接断开'); }
				if (this.inviteBox) this.hideInviteBox();
				this.merchants = Object.create(null);
				this.dropAllBubbles();
				return;
			}
			const game: any = (ig as any).game;
			const p: any = game && game.playerEntity;
			const mdl: any = (sc as any).model;
			const mapNow = this.readMap();

			// ---- merchant-mode exits: movement / combat / damage / map / death.
			if (this.merchant && p && p.coll) {
				let moving = false;
				try {
					const v = p.coll.vel;
					moving = Math.hypot(v.x || 0, v.y || 0) > 30;
				} catch (_) { moving = false; }
				const combat = !!(mdl && mdl.combatMode);
				const hp = this.readHp();
				const hurt = (this.lastHp >= 0 && hp >= 0 && hp < this.lastHp) || (p.damageTimer > 0);
				this.lastHp = hp;
				if (moving) this.exitMerchant('move');
				else if (combat) this.exitMerchant('combat');
				else if (hurt) this.exitMerchant('hurt');
				else if (mapNow !== this.lastMap) this.exitMerchant('map');
				else if ((p.params && p.params.currentHp <= 0) || (m as any).netSync && (m as any).netSync.isLocalDead && (m as any).netSync.isLocalDead()) this.exitMerchant('death');
			}
			this.lastMap = mapNow;

			// ---- head bubbles: own merchant + merchant mirrors (native shop bubble).
			if (this.merchant && p && p.coll && !p._killed) {
				this.bubbleFor('__self', p);
			} else {
				this.dropBubble('__self');
			}
			for (const name in this.merchants) {
				const ent = m.players && m.players[name] && (m.players[name] as any).entity;
				if (ent && !ent._killed && ent.coll) {
					this.bubbleFor(name, ent);
				} else {
					this.dropBubble(name);
				}
			}
			// sweep stale bubbles (merchant turned off / mirror replaced on map change)
			for (const name in this.bubbles) {
				if (name === '__self') { if (!this.merchant) this.dropBubble(name); }
				else if (!this.merchants[name]) this.dropBubble(name);
			}
			// fallback self-focus (the mapInteract.onPreUpdate wrap covers the ordering)
			this.forceSelfBubbleFocus();

			// ---- invite auto-expiry (60s).
			if (this.inviteBox && Date.now() - this.inviteAt > 60000) this.hideInviteBox();

			// (ROUND 152: interact/click invites now fire through the native
			// map-interact machine's onInteraction — FOCUS-only — no custom
			// proximity/click scan here any more.)

			// ---- session auto-cancel: combat / cutscene / death / not same map.
			const s = this.session;
			if (s) {
				let bad = '';
				if (mdl && mdl.combatMode) bad = 'combat';
				else if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) bad = 'cutscene';
				else if (p && p.params && p.params.currentHp <= 0) bad = 'death';
				else {
					const ent = m.players && m.players[s.partner] && (m.players[s.partner] as any).entity;
					if (!ent || ent._killed || !ent.coll) bad = 'not-same-room';
				}
				if (bad) this.cancel(bad);
			}
		} catch (_) { /* the pump must never throw */ }
	}

	// (ROUND 152: the old custom proximity/click scan was replaced by the native
	// map-interact machine — bubble entries fire onBubbleInteract from FOCUS.)
	private _inviteLockUntil = 0;
}
