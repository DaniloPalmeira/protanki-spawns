"use strict";

/**
 * Captura de suprimentos (caixas): UMA sessão por mapa, só DM, batalha privada.
 *
 *  - Cada conta COM PASSE cria uma batalha privada (1 vaga) no mapa, DM, com todos os bônus
 *    ligados e "Caixa de bônus em cronômetro preciso" (esportDropTiming), entra SEM spawnar e
 *    ouve as caixas caindo por `listenMs`. Depois sai e marca o mapa como feito.
 *
 *  - Privada porque outro jogador na batalha pegaria caixa e mudaria o ritmo; privada só
 *    existe com passe (proBattle). Conta sem passe é recusada na partida.
 *
 *  - O servidor expulsa quem não spawnou em kick_period_ms (5 min). A escuta é limitada a
 *    kick - kickMarginMs; com 4m50s de escuta sobra o tempo de sair por conta própria.
 *
 *  - Várias contas em paralelo puxam da MESMA fila. Cada uma só pega mapa dentro do seu rank
 *    e prefere o de maior minRank que alcança: a conta de rank alto gasta seu tempo nos mapas
 *    que só ela alcança, a de rank baixo fica com os livres.
 *
 *  - O battleId vem do CreateBattleResponse, NÃO do primeiro SelectPacket: logo após o login
 *    o lobby auto-seleciona uma batalha da lista, e o primeiro Select pode ser essa.
 *
 *  - Nada de rajada: cada EnterBattle só sai depois que o servidor confirmou a volta ao lobby
 *    anterior. Criar batalha tem limite (3 a cada 5 min por conta); 1 criação a cada ~6 min
 *    nunca encosta nele, mas o portão fica.
 *
 * Resultado em spawns/<map_id>.json (campo `bonus`); progresso em state/bonus-sweep.json.
 */

const fs = require("node:fs");
const path = require("node:path");

const { BotClient, P, LAYOUT } = require("./BotClient");
const spawnStore = require("./spawnStore");

const THEMES = { SUMMER: 0, WINTER: 1, SPACE: 2, SUMMER_DAY: 3, SUMMER_NIGHT: 4, WINTER_DAY: 5, WINTER_NIGHT: 6, MATCHMAKING: 7 };
const MODES = { DM: 0, TDM: 1, CTF: 2, CP: 3, AS: 4 };
const STATE_DIR = process.env.PT_STATE_DIR || path.join(__dirname, "..", "state");
const PROGRESS_FILE = process.env.PT_BONUS_PROGRESS || path.join(STATE_DIR, "bonus-sweep.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
	maps: null, // null = todos habilitados; array de mapId ou "/regex/"
	redo: false,
	limit: 0,
	mode: "DM",

	listenMs: 290000, // 4m50s de escuta por mapa
	kickMarginMs: 10000, // nunca ouvir além de kick_period_ms - isto

	createLimit: 3,
	createWindowMs: 5 * 60 * 1000,
	loginTimeout: 45000,

	server: null,
	verbose: false,
	dryRun: false,
};

function atomicWrite(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function loadProgress() {
	try {
		const d = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
		if (d && d.maps) return d;
	} catch {}
	return { version: 2, maps: {} };
}
function saveProgress(p) {
	p.updatedAt = new Date().toISOString();
	atomicWrite(PROGRESS_FILE, JSON.stringify(p, null, "\t") + "\n");
}

function mapFilter(maps) {
	if (!maps || !maps.length) return () => true;
	const list = Array.isArray(maps) ? maps : [maps];
	const exact = new Set(list.filter((m) => !m.startsWith("/")));
	const rx = list.filter((m) => m.startsWith("/")).map((m) => new RegExp(m.slice(1).replace(/\/$/, ""), "i"));
	return (id) => exact.has(id) || rx.some((r) => r.test(id));
}

/** Um item por mapa habilitado que suporta o modo; tema = o primeiro do catálogo. */
function buildWorklist(catalog, opts, progress) {
	const want = mapFilter(opts.maps);
	const byMap = new Map();
	for (const m of catalog.maps || []) {
		if (!m || m.enabled === false || !want(m.mapId)) continue;
		if (!(m.supportedModes || []).includes(opts.mode)) continue;
		if (THEMES[m.theme] === undefined) continue;
		if (!byMap.has(m.mapId)) byMap.set(m.mapId, m);
	}
	const items = [];
	for (const [mapId, m] of byMap) {
		if (!opts.redo && progress.maps[mapId]?.done) continue;
		items.push({ mapId, theme: m.theme, mode: opts.mode, minRank: m.minRank ?? 1, maxRank: m.maxRank ?? 30 });
	}
	// maior minRank primeiro: é o que a conta de rank alto deve pegar antes
	items.sort((a, b) => b.minRank - a.minRank || a.mapId.localeCompare(b.mapId));
	if (opts.limit > 0) items.length = Math.min(items.length, opts.limit);
	return items;
}

/** JSON do CreateBattleResponse (ou null se não parsear). */
function battleJson(p) {
	try {
		return JSON.parse(p.fields.jsonData);
	} catch {
		return null;
	}
}

/** Nome de batalha único (<= 40 chars): é por ele que achamos a NOSSA resposta no broadcast. */
function uniqueName(base) {
	const sufixo = " " + Math.random().toString(36).slice(2, 6);
	return base.slice(0, 40 - sufixo.length) + sufixo;
}

function normYaw(z) {
	if (typeof z !== "number" || !isFinite(z)) return 0;
	const TWO_PI = Math.PI * 2;
	let y = z % TWO_PI;
	if (y <= -Math.PI) y += TWO_PI;
	if (y > Math.PI) y -= TWO_PI;
	return Math.round(y * 1000) / 1000;
}
function r0(q) {
	if (!q) return null;
	const p = { x: Math.round(q.x), y: Math.round(q.y), z: Math.round(q.z) };
	return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
}

class BonusRunner {
	constructor(account, opts, shared) {
		this.account = account;
		this.opts = opts;
		this.shared = shared; // { progress, queue }
		this.tag = `[${account.label || account.username}]`;
		this.createTimes = [];
		this.stats = { maps: 0, drops: 0, gold: 0, errors: 0 };
		this.client = null;
		this.lobby = null;
		this.catalog = null;
	}
	log(...a) {
		console.log(new Date().toLocaleTimeString(), this.tag, ...a);
	}

	async start() {
		this.client = new BotClient({ tag: this.tag, verbose: this.opts.verbose, ...(this.opts.server ? { server: this.opts.server } : {}) });
		try {
			await this.client.connect();
			const mark = this.client.seq;
			this.lobby = await this.client.login(this.account.username, this.account.password, { timeout: this.opts.loginTimeout });
			const info = await this.client.waitFor(P.BattleInfo, { since: mark, timeout: 30000, label: "catálogo" });
			this.catalog = JSON.parse(info.fields.jsonData);
		} catch (e) {
			this.client.close();
			throw e;
		}
		this.pro = (this.catalog.proBattleTimeLeftInSec ?? 0) > 0;
		this.tag = `[${this.account.label || this.account.username} ${this.lobby.nickname} r${this.lobby.rank}]`;
		this.log(`logado | passe ${this.pro ? `${(this.catalog.proBattleTimeLeftInSec / 86400).toFixed(1)} dias` : "NÃO"}`);
		if (!this.pro) {
			this.client.close();
			throw new Error(`conta ${this.lobby.nickname} sem passe — batalha privada exige passe`);
		}
	}

	reaches(item) {
		return this.lobby.rank >= item.minRank && this.lobby.rank <= item.maxRank;
	}

	/** Tira da fila compartilhada o item de maior minRank que esta conta alcança. */
	pick() {
		const q = this.shared.queue;
		for (let i = 0; i < q.length; i++) {
			if (this.reaches(q[i])) return q.splice(i, 1)[0];
		}
		return null;
	}

	async #rateGate() {
		const { createLimit, createWindowMs } = this.opts;
		for (;;) {
			const now = Date.now();
			this.createTimes = this.createTimes.filter((t) => now - t < createWindowMs);
			if (this.createTimes.length < createLimit) break;
			const wait = createWindowMs - (now - this.createTimes[0]) + 5000;
			this.log(`limite de criação — esperando ${Math.ceil(wait / 1000)}s`);
			await sleep(wait);
		}
		this.createTimes.push(Date.now());
	}

	async #createBattle(item) {
		await this.#rateGate();
		const c = this.client;
		const rank = Math.min(Math.max(this.lobby.rank, item.minRank), item.maxRank);
		const name = uniqueName(`spawns ${item.mapId}`);
		const mark = c.seq;
		c.send(P.CreateBattleRequest, {
			autoBalance: false, battleMode: MODES[item.mode] ?? 0, equipmentConstraintsMode: 0, friendlyFire: false,
			scoreLimit: 999, timeLimitInSec: 0, mapId: item.mapId, maxPeopleCount: 1,
			name, parkourMode: false, privateBattle: true, proBattle: true,
			maxRank: rank, minRank: rank, reArmorEnabled: false, mapTheme: THEMES[item.theme],
			// todos os bônus ligados + cronômetro preciso (esportDropTiming)
			withoutBonuses: false, withoutCrystals: false, withoutSupplies: false, withoutUpgrades: false,
			reducedResistances: false, esportDropTiming: true, withoutGoldBoxes: false,
			withoutGoldSiren: false, withoutGoldZone: false, withoutMedkit: false, withoutMines: false,
			randomGold: true, dependentCooldownEnabled: false,
		});
		// CreateBattleResponse é broadcast do lobby (um para cada batalha que QUALQUER jogador
		// cria): a NOSSA é a que traz o nome único que mandamos no pedido.
		let resp;
		try {
			resp = await c.waitFor((p) => p.id === P.CreateBattleResponse && battleJson(p)?.name === name, { since: mark, timeout: 30000, label: "CreateBattleResponse" });
		} catch (e) {
			const aviso = c.recent.find((p) => p.seq > mark && (p.id === P.ShowAlertMessage || p.id === P.SystemMessage));
			throw new Error(`criação sem resposta${aviso ? ` (servidor disse: ${JSON.stringify(aviso.fields).slice(0, 200)})` : ""}: ${e.message}`);
		}
		const info = battleJson(resp);
		const battleId = info.battleId ?? info.itemId;
		if (!battleId) throw new Error("CreateBattleResponse sem battleId");
		if (info.privateBattle === false) throw new Error(`servidor criou batalha PÚBLICA (${battleId}) — captura exige privada`);
		if (info.battleMode && info.battleMode !== item.mode) throw new Error(`servidor criou modo ${info.battleMode}, esperado ${item.mode}`);
		// o lobby seleciona a criada em seguida; se não vier, selecionamos nós
		const sel = await c.waitFor((p) => p.id === P.SelectBattle && p.fields.battleId === battleId, { since: mark, timeout: 10000 }).catch(() => null);
		if (!sel) {
			c.send(P.SelectBattle, { battleId });
			await sleep(500);
		}
		return { battleId, info };
	}

	/**
	 * Entra na batalha selecionada (sem confirmar spawn). Confere pelo InitMap que o mapa é o
	 * esperado — entrar em outra batalha gravaria as quedas no mapa errado. Devolve kick_period_ms.
	 */
	async #enter(item) {
		const c = this.client;
		const mark = c.seq;
		c.send(P.EnterBattle, { battleTeam: 2 });
		const im = await c.waitFor(P.InitMap, { since: mark, timeout: 45000, label: "InitBattlefieldModel" });
		await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.BATTLE, { since: mark, timeout: 45000, label: "entrada na batalha" });
		let bf = {};
		try {
			bf = JSON.parse(im.fields.jsonData);
		} catch {}
		if (bf.map_id && bf.map_id !== item.mapId) {
			await this.#leave();
			throw new Error(`entrei em ${bf.map_id}, esperava ${item.mapId}`);
		}
		return Number(bf.kick_period_ms) || 300000;
	}

	async #leave() {
		const c = this.client;
		if (c.closed) return;
		const mark = c.seq;
		c.send(P.DisablePause);
		c.send(P.ExitFromBattle, { layout: LAYOUT.LOBBY });
		await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.LOBBY, { since: mark, timeout: 20000, label: "volta ao lobby" }).catch(() => {});
	}

	/** Ouve caixas por `budget` ms. Termina antes se o servidor nos devolver ao lobby (kick). */
	#listen(mapId, budget) {
		const c = this.client;
		return new Promise((resolve) => {
			const t0 = Date.now();
			let drops = 0, gold = 0, kicked = false;
			const finish = () => {
				clearTimeout(timer);
				c.off("packet", onPacket);
				c.off("close", onClose);
				resolve({ drops, gold, kicked, elapsedMs: Date.now() - t0, closed: c.closed });
			};
			const timer = setTimeout(finish, Math.max(1000, budget));
			const onClose = () => finish();
			const onPacket = (p) => {
				if (p.id === P.SpawnBonus) {
					const pos = r0(p.fields.position);
					if (pos) {
						spawnStore.noteBonusDrop(mapId, String(p.fields.id).split("#")[0], pos);
						drops++;
					}
				} else if (p.id === P.SpawnBonusRegion) {
					const pos = r0(p.fields.position);
					if (pos) {
						spawnStore.noteGoldRegion(mapId, pos, normYaw(p.fields.rotation?.z), p.fields.bonusType);
						gold++;
					}
				} else if (p.id === P.InitBonuses) {
					try {
						for (const b of JSON.parse(p.fields.jsonData).slice(0, 200)) {
							const pos = r0(b?.position);
							if (pos) {
								spawnStore.noteBonusDrop(mapId, String(b.id).split("#")[0], pos);
								drops++;
							}
						}
					} catch {}
				} else if (p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.LOBBY) {
					kicked = true;
					finish();
				}
			};
			c.on("packet", onPacket);
			c.on("close", onClose);
		});
	}

	async runMap(item) {
		const startedAt = new Date().toISOString();
		// captura limpa: uma sessão por mapa, nada do que havia antes sobra
		spawnStore.resetBonus(item.mapId);
		this.#note(item, { done: false, account: this.lobby.nickname, startedAt, error: null });

		const { battleId } = await this.#createBattle(item);
		this.log(`${item.mapId}: batalha ${battleId} criada (${item.theme}, ${item.mode})`);
		const kick = await this.#enter(item);
		const budget = Math.min(this.opts.listenMs, kick - this.opts.kickMarginMs);
		spawnStore.setBonusMeta(item.mapId, { account: this.lobby.nickname, battleId, mode: item.mode, theme: item.theme, startedAt, listenMs: budget, kickPeriodMs: kick, esportDropTiming: true, privateBattle: true });
		this.log(`${item.mapId}: dentro, ouvindo ${Math.round(budget / 1000)}s (kick ${kick}ms)`);

		const r = await this.#listen(item.mapId, budget);
		if (r.closed) throw new Error(`conexão caiu durante a escuta de ${item.mapId} (${r.drops} quedas em ${Math.round(r.elapsedMs / 1000)}s)`);
		await this.#leave();

		const bonus = spawnStore.bonusOf(item.mapId) || {};
		const tipos = Object.keys(bonus.types || {});
		const zonas = Object.values(bonus.zones || {}).reduce((a, z) => a + z.length, 0);
		spawnStore.setBonusMeta(item.mapId, { finishedAt: new Date().toISOString(), drops: r.drops, goldRegions: r.gold, kicked: r.kicked, elapsedMs: r.elapsedMs });
		spawnStore.flush();
		this.stats.maps++;
		this.stats.drops += r.drops;
		this.stats.gold += r.gold;
		this.#note(item, { done: true, battleId, finishedAt: new Date().toISOString(), drops: r.drops, gold: r.gold, types: tipos, zones: zonas, kicked: r.kicked, elapsedMs: r.elapsedMs });
		this.log(`${item.mapId}: concluído — ${r.drops} quedas, ${r.gold} gold, tipos [${tipos.join(",")}], ${zonas} zonas${r.kicked ? " (KICK antes do fim)" : ""}`);
	}

	#note(item, patch) {
		const p = this.shared.progress;
		p.maps[item.mapId] = { ...(p.maps[item.mapId] || {}), mapId: item.mapId, ...patch, updatedAt: new Date().toISOString() };
		saveProgress(p);
	}

	/** Reconecta com backoff; false só depois de esgotar as tentativas. */
	async reconnect(tentativas = 6) {
		try { this.client?.close(); } catch {}
		let espera = 10000;
		for (let i = 1; i <= tentativas; i++) {
			await sleep(espera);
			try {
				await this.start();
				return true;
			} catch (e) {
				this.log(`reconexão ${i}/${tentativas} falhou: ${e.message}`);
				espera = Math.min(espera * 2, 120000);
			}
		}
		return false;
	}

	async drain() {
		for (;;) {
			const item = this.pick();
			if (!item) break;
			try {
				await this.runMap(item);
			} catch (e) {
				this.stats.errors++;
				this.log(`${item.mapId}: ${e.message}`);
				this.#note(item, { done: false, error: e.message });
				if (this.client.closed) {
					// queda de conexão: devolve o mapa à fila e reconecta; só desiste no fim do backoff
					this.shared.queue.unshift(item);
					if (!(await this.reconnect())) {
						this.log("sem reconexão — encerrando esta conta");
						return;
					}
				} else {
					await this.#leave().catch(() => {});
					this.shared.queue.push(item); // tenta de novo no fim da fila
					await sleep(5000);
				}
			}
		}
		this.client.close();
		this.log(`fila vazia para esta conta — ${this.stats.maps} mapas, ${this.stats.drops} quedas, ${this.stats.errors} erros`);
	}
}

async function bonusSweep(accounts, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	if (!accounts.length) throw new Error("nenhuma conta configurada");

	const shared = { progress: loadProgress(), queue: [] };
	const runners = [];
	// Logins em sequência (sem rajada) e com tentativas: logo depois de uma queda (ou de matar
	// o processo) o servidor recusa a reconexão por um tempo — descartar a conta na primeira
	// falha deixaria metade da fila sem ninguém. Só "sem passe" descarta de imediato.
	for (const a of accounts) {
		const r = new BonusRunner(a, opts, shared);
		let espera = 15000;
		for (let i = 1; i <= 4; i++) {
			try {
				await r.start();
				runners.push(r);
				break;
			} catch (e) {
				const fatal = /sem passe/.test(e.message);
				console.log(`[${a.label || a.username}] login ${i}/4 falhou: ${e.message}${fatal ? " — descartada" : ""}`);
				if (fatal || i === 4) break;
				await sleep(espera);
				espera = Math.min(espera * 2, 90000);
			}
		}
		await sleep(3000);
	}
	if (!runners.length) throw new Error("nenhuma conta com passe conseguiu logar");

	shared.queue = buildWorklist(runners[0].catalog, opts, shared.progress);
	const inalcancaveis = shared.queue.filter((it) => !runners.some((r) => r.reaches(it)));
	console.log(`[bonus] ${shared.queue.length} mapas na fila, contas: ${runners.map((r) => `${r.lobby.nickname} (rank ${r.lobby.rank})`).join(", ")}`);
	if (inalcancaveis.length) console.log(`[bonus] fora do rank de todas as contas (${inalcancaveis.length}): ${inalcancaveis.map((i) => i.mapId).join(", ")}`);

	if (opts.dryRun) {
		for (const it of shared.queue) {
			const quem = runners.filter((r) => r.reaches(it)).map((r) => r.lobby.nickname).join("/") || "ninguém";
			console.log(`  ${it.mapId.padEnd(24)} ${it.theme.padEnd(12)} rank ${it.minRank}-${it.maxRank}  ← ${quem}`);
		}
		for (const r of runners) r.client.close();
		return { items: shared.queue, stats: null };
	}

	await Promise.all(runners.map((r) => r.drain()));
	spawnStore.flush();
	const restantes = shared.queue.slice();
	return { items: restantes, stats: runners.map((r) => ({ conta: r.lobby.nickname, ...r.stats })), inalcancaveis };
}

module.exports = { bonusSweep, buildWorklist, BonusRunner, DEFAULTS, PROGRESS_FILE, STATE_DIR };
