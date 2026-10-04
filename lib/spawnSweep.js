"use strict";

/**
 * Varredura de pontos de spawn de PLAYERS: cria uma batalha privada por (mapa, modo), entra,
 * lê o ponto de spawn que o servidor manda e sai — repetindo até ter amostras suficientes.
 *
 * Por que assim:
 *
 *  - O map.xml NÃO tem spawn point nenhum (só geometria). O único jeito de descobrir os
 *    pontos é o servidor te colocar num deles, uma entrada por vez.
 *
 *  - Capturamos no PrepareToSpawn, não no Spawn: os dois trazem exatamente a mesma
 *    posição/rotação, e o PrepareToSpawn chega ~5s antes — é a diferença entre um ciclo de
 *    ~3,5s e um de ~9s.
 *
 *  - O bot NUNCA manda pacote de movimento/tiro. Descobriu o ponto, sai.
 *
 *  - Uma batalha criada é reaproveitada para todos os ciclos daquele item. Criar batalha
 *    tem limite (3 a cada 5 min por conta, contando da primeira), entrar e sair não tem.
 *
 *  - Um item é (mapa, modo) — sem tema. O tema é a pintura do mapa; quem muda os pontos de
 *    spawn é o modo.
 *
 *  - Nada de rajada: cada EnterBattle só sai depois que o servidor confirmou a volta ao
 *    lobby. Rajada de EnterBattle derruba o socket sem aviso.
 *
 * O resultado vai para spawns/<map_id>.json (lib/spawnStore.js), um arquivo por mapa com
 * todos os modos juntos. Progresso retomável em state/spawn-sweep.json.
 */

const fs = require("node:fs");
const path = require("node:path");

const { BotClient, P, LAYOUT } = require("./BotClient");
const spawnStore = require("./spawnStore");
const { spawnKey, finite3 } = require("./spawnPoint");

// Ordinais confirmados no client decompilado (enum de tema) e no InitBattleCreateModel
// (battleLimits vem na ordem do enum de modo; DM=0 bate com a captura).
const MODES = { DM: 0, TDM: 1, CTF: 2, CP: 3, AS: 4 };
const THEMES = { SUMMER: 0, WINTER: 1, SPACE: 2, SUMMER_DAY: 3, SUMMER_NIGHT: 4, WINTER_DAY: 5, WINTER_NIGHT: 6, MATCHMAKING: 7 };
const TEAM = { RED: 0, BLUE: 1, NONE: 2 };
const TEAM_NAME = ["RED", "BLUE", "NONE"];
const TEAMS_FOR_MODE = {
	DM: ["NONE"],
	TDM: ["RED", "BLUE"],
	CTF: ["RED", "BLUE"],
	CP: ["RED", "BLUE"],
	AS: ["RED", "BLUE"],
};

const STATE_DIR = process.env.PT_STATE_DIR || path.join(__dirname, "..", "state");
const PROGRESS_FILE = process.env.PT_SPAWN_PROGRESS || path.join(STATE_DIR, "spawn-sweep.json");

const DEFAULTS = {
	modes: ["DM"],
	maps: null, // null = todos; array de mapId ou "/regex/"
	includeDisabled: false,
	redo: false,
	limit: 0, // 0 = sem limite de itens

	// Critério de parada por (mapa, modo, time)
	minEntries: 12, // piso de entradas, mesmo que tudo pareça pronto
	minPerPoint: 2, // piso de capturas por ponto

	// Janela DINÂMICA de "sem novidade": quanto mais pontos o mapa revela, mais entradas sem
	// ponto novo exigimos antes de dá-lo por completo (coupon-collector: com N pontos, o
	// intervalo esperado entre as últimas descobertas cresce com N).
	noNewFor: 10, // piso da janela estrita
	coverFactor: 1.5, // janela estrita = max(noNewFor, coverFactor × pontos descobertos)
	maxEntriesPerPoint: 8, // teto = N × pontos descobertos…
	maxEntries: 250, // …limitado por isto

	// Estabilidade: fecha o item MESMO com ponto raro abaixo de minPerPoint, desde que a janela
	// (mais longa) tenha passado sem novidade. O servidor sorteia alguns pontos raríssimo. 0 desliga.
	stableFor: 30,
	stableFactor: 3,

	// Confirmação de conjunto herdado (ver spawnStore.seedFrom): TDM e CTF compartilham pontos.
	confirmEntries: 40,
	confirmFraction: 0.6,

	// Fase 1 (opt-in, --observe): entrar em batalha que já existe e anotar o spawn dos outros.
	observe: false,
	observeMs: 90000,
	observeMaxBattles: 0,
	observeOnly: false,

	// Ritmo / limites do servidor
	createLimit: 3,
	createWindowMs: 5 * 60 * 1000,
	cycleDelayMs: 500,
	spawnTimeoutMs: 30000,
	teamBlockMs: 60000,
	loginStaggerMs: 4000,
	maxRetriesPerItem: 2,

	privateBattle: true, // só vale com passe na conta
	maxPeopleCount: 1, // POR TIME: 1 = ninguém mais entra

	// "prepare": lê o ponto no PrepareToSpawn e sai antes de encarnar. "spawn": manda
	// ReadyToPlace e lê o SpawnPacket (fallback automático se sair na preparação não for aceito).
	captureAt: "prepare",

	// Só metadados (bandeiras CTF, pontos CP): uma entrada por mapa, sem laço de spawn.
	metaOnly: false,

	server: null,
	verbose: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function atomicWrite(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

/** Espera todas as contas terminarem; a que estourar não cancela as outras. */
async function settle(promises) {
	const res = await Promise.allSettled(promises);
	for (const r of res) {
		if (r.status === "rejected") console.error(`[sweep] uma conta parou: ${r.reason?.message ?? r.reason}`);
	}
}

// ---------------------------------------------------------------------------
// Progresso (retomável)
// ---------------------------------------------------------------------------

function loadProgress() {
	try {
		const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
		if (data && typeof data === "object" && data.items) return data;
	} catch {}
	return { version: 2, items: {} };
}

let saveTimer = null;
function saveProgress(progress) {
	progress.updatedAt = new Date().toISOString();
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		try {
			atomicWrite(PROGRESS_FILE, JSON.stringify(progress, null, "\t") + "\n");
		} catch (e) {
			console.warn("[sweep] falha ao gravar progresso:", e.message);
		}
	}, 1000);
	if (saveTimer.unref) saveTimer.unref();
}

function flushProgress(progress) {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	try {
		progress.updatedAt = new Date().toISOString();
		atomicWrite(PROGRESS_FILE, JSON.stringify(progress, null, "\t") + "\n");
	} catch (e) {
		console.warn("[sweep] falha ao gravar progresso:", e.message);
	}
}

// ---------------------------------------------------------------------------
// Lista de trabalho
// ---------------------------------------------------------------------------

const itemKey = (mapId, mode) => `${mapId}|${mode}`;

/**
 * Monta a lista de (mapa, modo) a partir do catálogo do lobby (InitBattleCreateModel): já vem
 * com os modos suportados e a faixa de rank. `ranks` são os ranks das contas: o item entra se
 * PELO MENOS UMA alcança o mapa; cada conta filtra na hora de pegar.
 */
function buildWorklist(catalog, opts, progress, ranks) {
	const frota = (Array.isArray(ranks) ? ranks : [ranks]).filter((r) => r != null);
	const entries = Array.isArray(catalog?.maps) ? catalog.maps : [];
	const byMap = new Map();
	for (const m of entries) {
		if (!m || !m.mapId) continue;
		if (!opts.includeDisabled && m.enabled === false) continue;
		if (!byMap.has(m.mapId)) byMap.set(m.mapId, []);
		byMap.get(m.mapId).push(m);
	}

	const wantMap = mapFilter(opts.maps);
	const items = [];
	const skipped = [];

	for (const [mapId, variants] of byMap) {
		if (!wantMap(mapId)) continue;
		const v = variants.find((x) => THEMES[x.theme] !== undefined);
		if (!v) {
			skipped.push({ mapId, reason: "nenhum tema conhecido" });
			continue;
		}
		const modos = new Set();
		for (const x of variants) for (const m of x.supportedModes ?? []) modos.add(m);

		for (const mode of opts.modes) {
			if (MODES[mode] === undefined || !modos.has(mode)) continue;
			if (frota.length && !frota.some((r) => r >= v.minRank && r <= v.maxRank)) {
				skipped.push({ mapId, mode, reason: `nenhuma conta no rank ${v.minRank}-${v.maxRank}` });
				continue;
			}
			const key = itemKey(mapId, mode);
			if (!opts.redo && progress.items[key]?.done) continue;
			items.push({ key, mapId, mapName: v.mapName || mapId, theme: v.theme, mode, minRank: v.minRank, maxRank: v.maxRank, maxPeople: v.maxPeople });
		}
	}

	if (opts.limit > 0) items.length = Math.min(items.length, opts.limit);
	return { items, skipped };
}

function mapFilter(maps) {
	if (!maps || (Array.isArray(maps) && maps.length === 0)) return () => true;
	const list = Array.isArray(maps) ? maps : [maps];
	const exact = new Set(list.filter((m) => !m.startsWith("/")));
	const regexes = list.filter((m) => m.startsWith("/")).map((m) => new RegExp(m.slice(1).replace(/\/$/, ""), "i"));
	return (mapId) => exact.has(mapId) || regexes.some((r) => r.test(mapId));
}

// ---------------------------------------------------------------------------
// Contagem por (item, time)
// ---------------------------------------------------------------------------

class Tally {
	constructor(opts, seed = null) {
		this.opts = opts;
		this.points = new Map(); // "x,y,z,yaw" -> { x, y, z, yaw, count }
		this.conhecidos = new Set(); // tudo que já sabíamos ao carregar
		this.herdados = new Set(); // só o que veio de outro modo e ainda precisa aparecer
		for (const p of seed?.points ?? []) {
			const rec = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, count: p.count ?? 1 };
			if (p.seed) rec.seed = p.seed;
			this.points.set(keyOf(p), rec);
			this.conhecidos.add(keyOf(p));
			if (p.seed && !p.count) this.herdados.add(keyOf(p));
		}
		let seen = 0;
		for (const p of this.points.values()) seen += p.count;
		this.entries = seed?.entries ?? seen;
		this.inicial = this.entries;
		this.sinceNew = seed?.sinceNew ?? 0;
	}

	/** Registra uma captura; devolve true se o ponto era inédito. */
	add(point) {
		const k = keyOf(point);
		const prev = this.points.get(k);
		if (prev) prev.count++;
		else this.points.set(k, { ...point, count: 1 });
		this.entries++;
		const isNew = !prev;
		this.sinceNew = isNew ? 0 : this.sinceNew + 1;
		return isNew;
	}

	get minCount() {
		let min = Infinity;
		for (const p of this.points.values()) min = Math.min(min, p.count);
		return this.points.size ? min : 0;
	}

	get ceiling() {
		const { minEntries, maxEntries, maxEntriesPerPoint = 0 } = this.opts;
		if (!maxEntriesPerPoint) return maxEntries;
		return Math.min(maxEntries, Math.max(minEntries, maxEntriesPerPoint * this.points.size));
	}

	get novas() {
		return this.entries - this.inicial;
	}

	get confirmado() {
		const { confirmEntries, confirmFraction } = this.opts;
		if (!this.herdados.size || !confirmEntries) return false;
		if (this.novas < confirmEntries) return false;
		for (const [k, p] of this.points) if (p.count > 0 && !this.conhecidos.has(k)) return false;
		let confirmados = 0;
		for (const k of this.herdados) if (this.points.get(k).count > 0) confirmados++;
		return confirmados / this.herdados.size >= confirmFraction;
	}

	get janelaEstrita() {
		return Math.max(this.opts.noNewFor, Math.round((this.opts.coverFactor ?? 0) * this.points.size));
	}
	get janelaEstavel() {
		return Math.max(this.opts.stableFor, Math.round((this.opts.stableFactor ?? 0) * this.points.size));
	}
	get estavel() {
		const { minEntries, stableFor } = this.opts;
		if (!stableFor) return false;
		return this.entries >= minEntries && this.sinceNew >= this.janelaEstavel;
	}
	get estrito() {
		const { minEntries, minPerPoint } = this.opts;
		return this.entries >= minEntries && this.sinceNew >= this.janelaEstrita && this.minCount >= minPerPoint;
	}
	get raros() {
		let n = 0;
		for (const p of this.points.values()) if (p.count > 0 && p.count < this.opts.minPerPoint) n++;
		return n;
	}
	get done() {
		const { confirmEntries } = this.opts;
		if (this.confirmado) return true;
		const pendente = [...this.herdados].some((k) => !this.points.get(k).count);
		if (pendente && this.novas < confirmEntries) return false;
		if (this.entries >= this.ceiling) {
			const { stableFor } = this.opts;
			return !stableFor || this.estavel || this.novas >= this.janelaEstavel;
		}
		return this.estrito || this.estavel;
	}

	toJSON() {
		return { entries: this.entries, sinceNew: this.sinceNew, minCount: this.minCount, points: [...this.points.values()], herdados: this.herdados.size };
	}
}

const keyOf = (p) => `${p.x},${p.y},${p.z},${p.yaw}`;

function seedFromDisk(item, team) {
	const list = spawnStore.points(item.mapId, item.mode, team);
	return list.length ? { points: list } : null;
}

// ---------------------------------------------------------------------------
// Runner de uma conta
// ---------------------------------------------------------------------------

class AccountRunner {
	constructor(account, opts, progress) {
		this.account = account;
		this.opts = opts;
		this.progress = progress;
		this.tag = `[${account.label || account.username}]`;
		this.client = null;
		this.catalog = null;
		this.lobby = null;
		this.battleList = [];
		this.previewIndex = new Map(); // preview -> { mapId, theme } (do catálogo)
		this.createTimes = [];
		this.battle = null; // { battleId, item }
		this.needsSelect = false;
		this.captureAt = opts.captureAt;
		this.stats = { items: 0, cycles: 0, points: 0, errors: 0 };
	}

	log(...args) {
		console.log(new Date().toLocaleTimeString(), this.tag, ...args);
	}

	async start() {
		this.client = new BotClient({ tag: this.tag, verbose: this.opts.verbose, ...(this.opts.server ? { server: this.opts.server } : {}) });
		this.#wireLobby(this.client);
		try {
			await this.client.connect();
			const mark = this.client.seq;
			this.lobby = await this.client.login(this.account.username, this.account.password);

			// Quem cai no meio de uma batalha volta DENTRO dela no próximo login — e aí o lobby
			// (e o catálogo) nunca chega. Detectamos pelo InitMap e saímos primeiro.
			let info = await this.client.waitFor((p) => p.id === P.BattleInfo || p.id === P.InitMap, { since: mark, timeout: 30000, label: "catálogo de mapas" });
			if (info.id === P.InitMap) {
				this.log("logou dentro de uma batalha — saindo para o lobby");
				const saida = this.client.seq;
				await this.#leaveBattle();
				info = await this.client.waitFor(P.BattleInfo, { since: saida, timeout: 30000, label: "catálogo de mapas" });
			}
			this.catalog = JSON.parse(info.fields.jsonData);
			this.#indexCatalog(this.catalog);
			this.battle = null;
			await this.client.waitFor(P.BattleList, { since: mark, timeout: 15000, label: "lista de batalhas" }).catch(() => null);
		} catch (e) {
			this.client.close();
			throw e;
		}
		this.pro = (this.catalog.proBattleTimeLeftInSec ?? 0) > 0;
		this.tag = `[${this.account.label || this.account.username} ${this.lobby.nickname} r${this.lobby.rank}]`;
		this.log(`logado | passe ${this.pro ? "sim" : "NÃO"}`);
		if (this.opts.privateBattle && !this.pro) this.log("aviso: sem passe a batalha criada sai PÚBLICA (1 vaga por time protege em DM)");
		return this;
	}

	#indexCatalog(catalog) {
		for (const m of catalog.maps || []) if (m && m.preview != null && m.mapId) this.previewIndex.set(m.preview, { mapId: m.mapId, theme: m.theme || null });
	}

	async reconnect(tentativas = 5) {
		try { this.client?.close(); } catch {}
		let espera = 10000;
		for (let i = 1; i <= tentativas; i++) {
			await sleep(espera);
			try {
				const battle = this.battle; // a batalha sobrevive à queda da nossa conexão
				await this.start();
				this.battle = battle;
				this.needsSelect = true;
				return true;
			} catch (e) {
				this.log(`reconexão ${i}/${tentativas} falhou: ${e.message}`);
				espera = Math.min(espera * 2, 120000);
			}
		}
		return false;
	}

	#wireLobby(client) {
		client.on("packet", (pkt) => {
			try {
				switch (pkt.id) {
					case P.BattleInfo:
						this.#indexCatalog(JSON.parse(pkt.fields.jsonData));
						break;
					case P.BattleList: {
						const list = JSON.parse(pkt.fields.jsonData);
						if (Array.isArray(list?.battles)) this.battleList = list.battles;
						break;
					}
					case P.RemoveBattleFromList:
						if (this.battle && pkt.fields.battleId === this.battle.battleId) {
							this.log(`batalha ${this.battle.battleId} removida pelo servidor`);
							this.battle = null;
						}
						break;
					case P.SystemMessage:
					case P.ShowAlertMessage:
						this.log("aviso do servidor:", pkt.fields.text);
						break;
					default:
						break;
				}
			} catch (e) {
				console.warn(`${this.tag} ${pkt.name}: ${e.message}`);
			}
		});
	}

	// -- laço principal ------------------------------------------------------

	#takeItem(queue) {
		const rank = this.lobby.rank;
		const i = queue.findIndex((it) => rank >= it.minRank && rank <= it.maxRank);
		return i < 0 ? null : queue.splice(i, 1)[0];
	}

	async drain(queue) {
		while (queue.length) {
			const item = this.#takeItem(queue);
			if (!item) {
				this.log(`nada mais na fila para o rank ${this.lobby.rank} (${queue.length} item(ns) para outra conta)`);
				break;
			}
			let attempt = 0;
			for (;;) {
				try {
					await this.runItem(item);
					break;
				} catch (e) {
					this.stats.errors++;
					attempt++;
					this.log(`erro em ${item.key}: ${e.message}`);
					if (attempt > this.opts.maxRetriesPerItem) {
						this.#note(item, { error: e.message });
						break;
					}
					if (attempt >= 2) this.battle = null;
					if (this.client?.closed) {
						this.log("reconectando…");
						if (!(await this.reconnect())) {
							this.log("sem reconexão — encerrando esta conta (o item volta para a fila)");
							queue.unshift(item);
							return;
						}
					} else {
						await this.#backToLobby();
					}
				}
			}
		}
		this.client.close();
	}

	async #runMeta(item) {
		const team = (TEAMS_FOR_MODE[item.mode] || ["NONE"])[0];
		await this.#ensureBattle(item);
		this.stats.items++;
		try {
			await this.cycle(item, team);
			this.stats.cycles++;
			this.#note(item, { metaDone: true });
			this.log(`${item.key}: metadados capturados`);
		} catch (e) {
			this.stats.errors++;
			this.log(`${item.key}: meta falhou — ${e.message}`);
			if (this.client?.closed && !(await this.reconnect())) return;
			else await this.#backToLobby();
		}
	}

	async runItem(item) {
		if (this.opts.metaOnly) return this.#runMeta(item);

		const tallies = this.#tallies(item);
		if ([...tallies.values()].every((t) => t.done)) {
			this.#fecha(item, tallies, "já completo");
			return;
		}

		await this.#ensureBattle(item);
		this.stats.items++;

		const bloqueado = new Map(); // time -> instante em que volta a ser tentado
		const desviados = new Map(); // time pedido -> quantas vezes caímos em outro
		let seguidas = 0;
		const tetoCiclos = [...tallies.values()].reduce((a, t) => a + t.ceiling, 0) + 20;
		let ciclos = 0;

		while ([...tallies.values()].some((t) => !t.done)) {
			if (++ciclos > tetoCiclos) {
				this.log(`${item.key}: teto de ${tetoCiclos} entradas atingido`);
				break;
			}
			const team = this.#nextTeam(tallies, bloqueado);
			if (!team) {
				const espera = Math.min(...bloqueado.values()) - Date.now();
				if (espera > 0) await sleep(Math.min(espera, 30000));
				bloqueado.clear();
				continue;
			}

			let amostra;
			try {
				amostra = await this.cycle(item, team);
				seguidas = 0;
			} catch (e) {
				if (!/PrepareToSpawn/.test(e.message) || ++seguidas > 6) throw e;
				this.log(`${item.key}: sem spawn no lado ${team} (vaga ocupada?) — tentando o outro lado`);
				bloqueado.set(team, Date.now() + this.opts.teamBlockMs);
				this.stats.errors++;
				await this.#backToLobby();
				continue;
			}

			if (amostra.team !== team) {
				const n = (desviados.get(team) ?? 0) + 1;
				desviados.set(team, n);
				if (n >= 3) {
					bloqueado.set(team, Date.now() + this.opts.teamBlockMs);
					desviados.set(team, 0);
				}
			} else {
				desviados.set(team, 0);
			}

			const tally = tallies.get(amostra.team) ?? tallies.get(team);
			const isNew = tally.add(amostra.point);
			this.stats.cycles++;
			if (isNew) this.stats.points++;

			this.log(
				`${item.mapId} ${item.mode}${amostra.team === "NONE" ? "" : "/" + amostra.team} ` +
					`#${tally.entries}/${tally.ceiling} ${isNew ? "NOVO" : "repetido"} — ${tally.points.size} pontos, ` +
					`min ${tally.minCount}x, ${tally.sinceNew} sem novidade`
			);
			this.#note(item, { teams: dumpTeams(tallies) });
			await sleep(this.opts.cycleDelayMs);
		}

		this.#fecha(item, tallies, "concluído");
	}

	#fecha(item, tallies, motivo) {
		const confirmados = [...tallies.values()].filter((t) => t.confirmado).length;
		const faltando = [...tallies.entries()].filter(([, t]) => !t.confirmado && !t.estrito && !t.estavel);

		if (!faltando.length) {
			const raros = [...tallies.values()].reduce((a, t) => a + t.raros, 0);
			const porEstabilidade = [...tallies.values()].filter((t) => !t.estrito && !t.confirmado && t.estavel).length;
			this.#note(item, { done: true, parcial: false, teams: dumpTeams(tallies), ...(porEstabilidade ? { estavel: true, raros } : {}) });
			const como = [
				confirmados ? `${confirmados} lado(s) por conjunto herdado` : "",
				porEstabilidade ? `${porEstabilidade} lado(s) por estabilidade, ${raros} ponto(s) raro(s) registrados` : "",
			].filter(Boolean).join("; ");
			this.log(`${item.key}: ${motivo}${como ? ` (${como})` : ""}`);
			return;
		}
		const detalhe = faltando.map(([team, t]) => `${team} ${t.points.size} pontos, min ${t.minCount}x`).join(" | ");
		this.#note(item, { done: false, parcial: true, teams: dumpTeams(tallies) });
		this.log(`${item.key}: PARCIAL — teto de entradas atingido (${detalhe})`);
	}

	#nextTeam(tallies, bloqueado) {
		const agora = Date.now();
		const livres = [...tallies.entries()].filter(([team, t]) => !t.done && !(bloqueado.get(team) > agora)).sort((a, b) => a[1].entries - b[1].entries);
		return livres[0]?.[0] ?? null;
	}

	#tallies(item) {
		const teams = TEAMS_FOR_MODE[item.mode] || ["NONE"];
		const saved = this.progress.items[item.key]?.teams ?? {};
		const tallies = new Map();
		for (const t of teams) tallies.set(t, new Tally(this.opts, saved[t] ?? seedFromDisk(item, t)));
		return tallies;
	}

	#note(item, patch) {
		const prev = this.progress.items[item.key] ?? {};
		this.progress.items[item.key] = { ...prev, mapId: item.mapId, mode: item.mode, ...patch, updatedAt: new Date().toISOString() };
		saveProgress(this.progress);
	}

	// -- fase 1: observar batalhas que já existem ----------------------------

	async observe(pending, claimed) {
		let visited = 0;
		for (;;) {
			if (this.opts.observeMaxBattles && visited >= this.opts.observeMaxBattles) return;
			const target = this.#pickBattle(pending, claimed, visited === 0);
			if (!target) return;
			claimed.add(target.battleId);
			visited++;
			try {
				await this.observeBattle(target, pending.get(target.key));
			} catch (e) {
				this.stats.errors++;
				this.log(`observação de ${target.key} falhou: ${e.message}`);
				if (this.client?.closed) {
					if (!(await this.reconnect())) return;
				} else {
					await this.#backToLobby();
				}
			}
		}
	}

	#pickBattle(pending, claimed, explain = false) {
		const rank = this.lobby.rank;
		const options = [];
		const nao = { visitada: 0, privada: 0, rank: 0, tema: 0, item: 0, cheia: 0 };
		for (const b of this.battleList) {
			if (!b) continue;
			if (claimed.has(b.battleId)) { nao.visitada++; continue; }
			if (b.privateBattle) { nao.privada++; continue; }
			if (rank < b.minRank || rank > b.maxRank) { nao.rank++; continue; }
			const cls = this.previewIndex.get(b.preview);
			if (!cls?.mapId) { nao.tema++; continue; }
			const key = itemKey(cls.mapId, b.battleMode);
			const item = pending.get(key);
			if (!item || this.progress.items[key]?.done) { nao.item++; continue; }
			const users = usersOf(b);
			if (users.length >= b.maxPeople) { nao.cheia++; continue; }
			options.push({ battleId: b.battleId, key, users: users.length, battle: b });
		}
		if (explain) {
			this.log(`lista com ${this.battleList.length} batalhas: ${options.length} candidatas (descartadas: ${nao.item} item já coberto, ${nao.rank} rank, ${nao.privada} privadas, ${nao.cheia} cheias, ${nao.tema} sem mapa, ${nao.visitada} já visitadas)`);
		}
		options.sort((a, b) => b.users - a.users);
		return options[0] ?? null;
	}

	async observeBattle(target, item) {
		const tallies = this.#tallies(item);
		const b = target.battle;
		const team = item.mode === "DM" ? "NONE" : (b.usersRed?.length ?? 0) <= (b.usersBlue?.length ?? 0) ? "RED" : "BLUE";

		this.battle = null; // batalha alheia: nunca é candidata a reaproveitamento
		const entry = await this.#enter(team, target.battleId);
		const bf = JSON.parse(entry.initMap.fields.jsonData);
		if (bf.map_id && bf.map_id !== item.mapId) {
			await this.#leaveBattle();
			throw new Error(`entrei em ${bf.map_id}, esperava ${item.mapId}`);
		}
		const kick = Number(bf.kick_period_ms) || 300000;
		const budget = Math.min(this.opts.observeMs, kick - 30000);

		const before = countPoints(tallies);
		const seen = await this.#collectSpawns(item, tallies, budget);
		const novos = countPoints(tallies) - before;
		this.stats.cycles++;
		this.stats.points += novos;

		const done = [...tallies.values()].every((t) => t.done);
		this.#note(item, { teams: dumpTeams(tallies), ...(done ? { done: true } : {}) });
		this.log(`observou ${item.mapId} ${item.mode} em ${target.battleId} (${target.users} jogadores): ${seen} spawns, ${novos} pontos novos${done ? " — concluído" : ""}`);
		await this.#leaveBattle();
	}

	#collectSpawns(item, tallies, budget) {
		const c = this.client;
		const me = this.lobby.nickname;
		return new Promise((resolve) => {
			let seen = 0;
			const finish = () => {
				clearTimeout(timer);
				c.off("packet", onPacket);
				c.off("close", onClose);
				resolve(seen);
			};
			const timer = setTimeout(finish, Math.max(1000, budget));
			const onClose = () => finish();
			const onPacket = (p) => {
				if (p.id !== P.Spawn) return;
				if (p.fields.nickname === me) return;
				const point = spawnKey(p.fields);
				if (!point) return;
				const team = TEAM_NAME[p.fields.team] ?? "NONE";
				spawnStore.note({ mapId: item.mapId, mode: item.mode, team }, p.fields);
				seen++;
				const tally = tallies.get(team);
				if (!tally) return;
				tally.add(point);
				if ([...tallies.values()].every((t) => t.done)) finish();
			};
			c.on("packet", onPacket);
			c.on("close", onClose);
		});
	}

	async #leaveBattle() {
		const c = this.client;
		const mark = c.seq;
		c.send(P.DisablePause);
		c.send(P.ExitFromBattle, { layout: LAYOUT.LOBBY });
		await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.LOBBY, { since: mark, timeout: 30000, label: "volta ao lobby" });
	}

	// -- criação da batalha --------------------------------------------------

	async #ensureBattle(item, tentativa = 1) {
		if (this.battle?.item.key === item.key) return this.battle;
		await this.#rateGate();

		const c = this.client;
		const mark = c.seq;
		const req = this.#createRequest(item);
		c.send(P.CreateBattleRequest, req);

		// CreateBattleResponse é broadcast do lobby (um para cada batalha que QUALQUER jogador
		// cria). Identificamos a NOSSA pelo nome único que mandamos no pedido.
		let resp;
		try {
			resp = await c.waitFor((p) => p.id === P.CreateBattleResponse && battleJson(p)?.name === req.name, { since: mark, timeout: 30000, label: `criação de ${item.key}` });
		} catch (e) {
			if (c.closed) throw e;
			if (tentativa >= 3) throw new Error(`servidor não respondeu à criação em ${tentativa} janelas`);
			this.log(`sem resposta na criação (${tentativa}/3) — esperando a janela de ${this.opts.createWindowMs / 60000}min`);
			await sleep(this.opts.createWindowMs);
			this.createTimes = [];
			return this.#ensureBattle(item, tentativa + 1);
		}
		const battle = battleJson(resp);
		const battleId = battle.battleId ?? battle.itemId;
		if (!battleId) throw new Error("CreateBattleResponse sem battleId");
		if (battle.battleMode && battle.battleMode !== item.mode) throw new Error(`servidor criou modo ${battle.battleMode}, esperado ${item.mode}`);
		if (this.opts.privateBattle && battle.privateBattle === false) this.log(`aviso: batalha PÚBLICA (privada exige passe) — ${battleId}`);
		if (battle.maxPeople != null && battle.maxPeople !== this.opts.maxPeopleCount) this.log(`aviso: pedi ${this.opts.maxPeopleCount} vaga(s) por time, servidor deu ${battle.maxPeople}`);

		// o servidor seleciona a criada em seguida; se não vier, selecionamos nós
		const sel = await c.waitFor((p) => p.id === P.SelectBattle && p.fields.battleId === battleId, { since: mark, timeout: 10000 }).catch(() => null);
		if (!sel) this.needsSelect = true;

		this.battle = { battleId, item };
		this.log(`batalha criada: ${battleId} (${item.mapId} ${item.mode}, ${battle.privateBattle ? "privada" : "pública"}, ${battle.maxPeople ?? "?"} por time)`);
		return this.battle;
	}

	#createRequest(item) {
		const rank = Math.min(Math.max(this.lobby.rank, item.minRank), item.maxRank);
		const pro = this.pro;
		return {
			autoBalance: false,
			battleMode: MODES[item.mode],
			equipmentConstraintsMode: 0,
			friendlyFire: false,
			scoreLimit: 1,
			timeLimitInSec: 0,
			mapId: item.mapId,
			maxPeopleCount: this.opts.maxPeopleCount,
			name: uniqueName(`${item.mapName} ${item.mode}`),
			parkourMode: false,
			privateBattle: this.opts.privateBattle,
			proBattle: pro,
			maxRank: rank,
			minRank: rank,
			reArmorEnabled: false,
			mapTheme: THEMES[item.theme],
			// Flags "sem X" são de batalha pró; sem pró precisam ir todas falsas.
			withoutBonuses: pro,
			withoutCrystals: pro,
			withoutSupplies: pro,
			withoutUpgrades: false,
			reducedResistances: false,
			esportDropTiming: false,
			withoutGoldBoxes: pro,
			withoutGoldSiren: false,
			withoutGoldZone: pro,
			withoutMedkit: false,
			withoutMines: false,
			randomGold: true,
			dependentCooldownEnabled: false,
		};
	}

	async #rateGate() {
		const { createLimit, createWindowMs } = this.opts;
		for (;;) {
			const now = Date.now();
			this.createTimes = this.createTimes.filter((t) => now - t < createWindowMs);
			if (this.createTimes.length < createLimit) break;
			const wait = createWindowMs - (now - this.createTimes[0]) + 5000;
			this.log(`limite de criação (${createLimit}/${createWindowMs / 60000}min) — esperando ${Math.ceil(wait / 1000)}s`);
			await sleep(wait);
		}
		this.createTimes.push(Date.now());
	}

	// -- um ciclo: entra, lê o spawn, sai ------------------------------------

	async cycle(item, team) {
		const c = this.client;
		let entry;
		try {
			entry = await this.#enter(team);
		} catch (e) {
			this.log(`entrada falhou (${e.message}) — reselecionando ${this.battle.battleId}`);
			this.needsSelect = true;
			entry = await this.#enter(team);
		}

		const bf = JSON.parse(entry.initMap.fields.jsonData);
		if (bf.map_id && bf.map_id !== item.mapId) {
			await this.#leaveBattle().catch(() => {});
			this.battle = null;
			throw new Error(`entrei em ${bf.map_id}, esperava ${item.mapId}`);
		}

		// Bandeiras (CTF) e pontos de controle (CP) chegam UMA vez, no init — já estão no buffer.
		this.#captureMeta(item, entry.mark);

		const spawnMark = c.seq;
		c.send(P.ReadyToSpawn);
		const prep = await c.waitFor(P.PrepareToSpawn, { since: spawnMark, timeout: this.opts.spawnTimeoutMs, label: "PrepareToSpawn" });

		// O time que PEDIMOS não é necessariamente o que recebemos. Em modo por time o servidor
		// manda UpdateBattleUserTeam com o nosso nick; em DM é NONE mesmo.
		let real = this.#teamAtribuido(entry.mark);
		const porTime = (TEAMS_FOR_MODE[item.mode] || ["NONE"]).length > 1;
		if (!real && porTime) {
			try {
				const upd = await c.waitFor((p) => p.id === P.UpdateBattleUserTeam && p.fields.nickname === this.lobby.nickname, { since: entry.mark, timeout: 3000, label: "UpdateBattleUserTeam" });
				real = TEAM_NAME[upd.fields.team] ?? null;
			} catch {}
		}
		if (!real) real = team;
		if (real !== team) this.log(`${item.key}: pedi ${team}, servidor deu ${real}`);

		const observed = { team: TEAM[real], position: prep.fields.position, orientation: prep.fields.rotation };
		if (this.captureAt === "spawn") {
			c.send(P.ReadyToPlace);
			const sp = await c.waitFor(P.Spawn, { since: spawnMark, timeout: 30000, label: "Spawn" });
			observed.position = sp.fields.position;
			observed.orientation = sp.fields.orientation;
		}

		const point = spawnKey(observed);
		if (!point) throw new Error("spawn sem posição utilizável");
		spawnStore.note({ mapId: item.mapId, mode: item.mode, team: real }, observed);

		const exitMark = c.seq;
		c.send(P.DisablePause);
		c.send(P.ExitFromBattle, { layout: LAYOUT.LOBBY });
		try {
			await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.LOBBY, { since: exitMark, timeout: 30000, label: "volta ao lobby" });
		} catch (e) {
			if (this.captureAt === "prepare" && !c.closed) {
				this.captureAt = "spawn";
				this.log("saída na fase de preparação não confirmada — passando a encarnar antes de sair");
			}
			throw e;
		}
		return { point, team: real };
	}

	#captureMeta(item, since) {
		for (const p of this.client.recent) {
			if (p.seq <= since) continue;
			try {
				if (p.id === P.InitCtfFlags && p.fields.flagBasePositionRed) {
					const red = finite3(p.fields.flagBasePositionRed), blue = finite3(p.fields.flagBasePositionBlue);
					if (red && blue) spawnStore.noteFlags(item.mapId, red, blue);
				} else if (p.id === P.InitDomPoints && Array.isArray(p.fields.points)) {
					const pts = [];
					for (const pt of p.fields.points) {
						const pos = pt && finite3(pt.position);
						if (pos) pts.push({ id: pt.id ?? null, name: pt.name ?? null, ...pos });
					}
					spawnStore.noteDomPoints(item.mapId, p.fields, pts);
				}
			} catch (e) {
				this.log(`meta ${p.name}: ${e.message}`);
			}
		}
	}

	#teamAtribuido(since) {
		const eu = this.lobby.nickname;
		for (let i = this.client.recent.length - 1; i >= 0; i--) {
			const p = this.client.recent[i];
			if (p.seq <= since) break;
			if (p.id === P.UpdateBattleUserTeam && p.fields.nickname === eu) return TEAM_NAME[p.fields.team] ?? null;
		}
		return null;
	}

	async #enter(team, battleId = null) {
		const c = this.client;
		const mark = c.seq;
		const id = battleId ?? this.battle?.battleId;
		if ((this.needsSelect || battleId) && id) {
			c.send(P.SelectBattle, { battleId: id });
			this.needsSelect = false;
			await sleep(500);
		}
		c.send(P.EnterBattle, { battleTeam: TEAM[team] });
		const initMap = await c.waitFor(P.InitMap, { since: mark, timeout: 45000, label: "InitBattlefieldModel" });
		await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.BATTLE, { since: mark, timeout: 45000, label: "entrada na batalha" });
		return { initMap, mark };
	}

	async #backToLobby() {
		const c = this.client;
		if (!c || c.closed) return;
		const mark = c.seq;
		c.send(P.ExitFromBattle, { layout: LAYOUT.LOBBY });
		await c.waitFor((p) => p.id === P.ConfirmLayoutChange && p.fields.toLayout === LAYOUT.LOBBY, { since: mark, timeout: 15000 }).catch(() => null);
		this.needsSelect = true;
	}
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

function usersOf(b) {
	return [...(b.users ?? []), ...(b.usersRed ?? []), ...(b.usersBlue ?? [])];
}
function countPoints(tallies) {
	let n = 0;
	for (const t of tallies.values()) n += t.points.size;
	return n;
}
function dumpTeams(tallies) {
	const out = {};
	for (const [team, t] of tallies) out[team] = t.toJSON();
	return out;
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

function servidorAcessivel(alvo, timeout = 8000) {
	return new Promise((resolve) => {
		const s = require("node:net").connect({ host: alvo.host, port: alvo.port });
		const fim = (ok) => { s.destroy(); resolve(ok); };
		s.setTimeout(timeout);
		s.on("connect", () => fim(true));
		s.on("timeout", () => fim(false));
		s.on("error", () => fim(false));
	});
}

async function sweep(accounts, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	if (!accounts.length) throw new Error("nenhuma conta configurada");

	const alvo = opts.server ?? require("../config").gameServer;
	if (!(await servidorAcessivel(alvo))) {
		throw new Error(`${alvo.host}:${alvo.port} não responde (nem TCP). Servidor fora do ar ou IP bloqueado — espere antes de tentar de novo.`);
	}

	const progress = loadProgress();
	const runners = [];
	for (const acc of accounts) {
		const r = new AccountRunner(acc, opts, progress);
		let espera = opts.loginStaggerMs;
		for (let i = 1; i <= 3; i++) {
			try {
				await r.start();
				runners.push(r);
				break;
			} catch (e) {
				console.error(`[${acc.label || acc.username}] login ${i}/3 falhou: ${e.message}`);
				if (i < 3) await sleep(espera);
				espera = Math.min(espera * 3, 60000);
			}
		}
		if (accounts.length > 1) await sleep(opts.loginStaggerMs);
	}
	if (!runners.length) throw new Error("nenhuma conta conseguiu logar");

	const principal = runners.reduce((a, b) => (b.lobby.rank > a.lobby.rank ? b : a));
	const { items, skipped } = buildWorklist(principal.catalog, opts, progress, runners.map((r) => r.lobby.rank));
	for (const s of skipped) console.log(`[sweep] pulado ${s.mapId}${s.mode ? " " + s.mode : ""}: ${s.reason}`);
	console.log(`[sweep] ${items.length} itens na fila, ${runners.length} conta(s): ` + runners.map((r) => `${r.lobby.nickname} rank ${r.lobby.rank}`).join(", "));

	if (opts.dryRun) {
		for (const it of items) console.log(`  ${it.key}  (rank ${it.minRank}-${it.maxRank}, ${it.maxPeople}p)`);
		for (const r of runners) r.client.close();
		return { items, runners: [] };
	}

	if (opts.observe || opts.observeOnly) {
		const pending = new Map(items.map((i) => [i.key, i]));
		const claimed = new Set();
		console.log(`[sweep] fase 1: observando batalhas existentes (${pending.size} itens pendentes)`);
		await settle(runners.map((r) => r.observe(pending, claimed)));
		spawnStore.flush();
	}

	const queue = opts.redo ? items.slice() : items.filter((i) => !progress.items[i.key]?.done);
	if (opts.observeOnly) {
		console.log(`[sweep] fase 2 pulada (--observe-only): ${queue.length} item(s) continuam pendentes`);
	} else {
		console.log(`[sweep] fase 2: criando batalha para ${queue.length} item(s)`);
		await settle(runners.map((r) => r.drain(queue)));
	}

	spawnStore.flush();
	flushProgress(progress);
	for (const r of runners) r.client.close();
	return { items, stats: runners.map((r) => ({ conta: r.lobby?.nickname || r.account.label, ...r.stats })) };
}

module.exports = { sweep, buildWorklist, loadProgress, flushProgress, AccountRunner, Tally, MODES, THEMES, TEAM, TEAM_NAME, TEAMS_FOR_MODE, DEFAULTS, PROGRESS_FILE };
