"use strict";

/**
 * Acervo por mapa em spawns/<map_id>.json:
 *
 *   {
 *     "mapId": "map_gravity",
 *     "modes": { "DM": { "NONE": [ {x,y,z,yaw,count} ] } },        // spawn de players
 *     "bonus": {                                                    // suprimentos
 *       "capture": { account, battleId, startedAt, stopReason, capacity, timeline, ... },
 *       "types":  { medkit: 3, nitro: 2 },                          // pontos de spawn por tipo
 *       "points": { medkit: [ {x,y,z}, ... ] },                     // UM ponto por caixa que caiu
 *       "goldRegions": [ {x,y,z,yaw,bonusType,count} ]              // zonas fixas de gold box
 *     },
 *     "ctf": { variants: [{ red, blue, count }] },
 *     "cp":  { keypointTriggerRadius, keypointVisorHeight, minesRestrictionRadius, points: [] }
 *   }
 *
 * Suprimentos: a captura é UMA sessão por mapa em batalha com "cronômetro preciso" (sport) e
 * ninguém pegando caixa. Nesse modo cada ponto de spawn solta uma caixa, e a caixa fica no chão
 * até alguém pegar. Logo cada queda observada É um ponto de spawn distinto — duas caixas perto
 * uma da outra são dois pontos, não uma "zona". Por isso `points` guarda toda queda sem fundir
 * nem deduplicar (mesma coordenada duas vezes = dois pontos), e não existe agrupamento.
 *
 * Sem dimensão de tema: o tema é a pintura do mapa, spawn e bônus não mudam com ele.
 * Regras: merge em memória, gravação debounced e atômica, dedupe de spawn de player pela mesma
 * chave (spawnPoint.spawnKey) em todo lugar que grava.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnKey } = require("./spawnPoint");

const SPAWNS_DIR = process.env.PT_SPAWNS_DIR || path.join(__dirname, "..", "spawns");
const SAVE_DEBOUNCE_MS = 2000;

const stores = new Map(); // mapId -> { file, data, dirty }

function safeName(s) {
	return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function fileFor(mapId) {
	return path.join(SPAWNS_DIR, `${safeName(mapId)}.json`);
}
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
function atomicWrite(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function store(mapId) {
	let s = stores.get(mapId);
	if (s) return s;
	const file = fileFor(mapId);
	const data = readJson(file) ?? { mapId, modes: {} };
	data.modes ??= {};
	s = { file, data, dirty: false };
	stores.set(mapId, s);
	return s;
}

let saveTimer = null;
function scheduleSave() {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		try {
			flush();
		} catch (e) {
			console.warn("[spawns] falha ao gravar:", e.message);
		}
	}, SAVE_DEBOUNCE_MS);
	if (saveTimer.unref) saveTimer.unref();
}

function flush() {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	for (const s of stores.values()) {
		if (!s.dirty) continue;
		s.dirty = false;
		s.data.updatedAt = new Date().toISOString();
		atomicWrite(s.file, JSON.stringify(s.data, null, "\t") + "\n");
	}
}

function marcar(s) {
	s.dirty = true;
	scheduleSave();
}

// ---------------------------------------------------------------------------
// Spawn de players
// ---------------------------------------------------------------------------

/** Soma `n` observações de um ponto no balde (modo, time). Devolve true se o ponto era inédito. */
function merge(data, mode, team, point, n, extra = null) {
	const modeSlot = (data.modes[mode] ??= {});
	const list = (modeSlot[team] ??= []);
	const hit = list.find((p) => p.x === point.x && p.y === point.y && p.z === point.z && p.yaw === point.yaw);
	if (hit) {
		hit.count += n;
		return false;
	}
	list.push({ x: point.x, y: point.y, z: point.z, yaw: point.yaw, count: n, ...(extra || {}) });
	return true;
}

/** Lista já observada de (mapa, modo, time) — vazia se nunca vista. */
function points(mapId, mode, team) {
	if (!mapId) return [];
	const slot = store(mapId).data.modes?.[mode]?.[team];
	return Array.isArray(slot) ? slot : [];
}

/** Registra um spawn a partir dos campos do pacote ({ position, orientation|rotation }). */
function note(ctx, fields) {
	return notePoint(ctx, spawnKey(fields));
}

function notePoint({ mapId, mode, team }, point) {
	if (!mapId || !mode || !team || !point) return false;
	const s = store(mapId);
	const novo = merge(s.data, mode, team, point, 1);
	marcar(s);
	return novo;
}

/**
 * Copia os pontos de um modo para outro como EXPECTATIVA (count 0 + marca `seed`): TDM e CTF
 * compartilham o conjunto, então o segundo modo só precisa confirmar.
 */
function seedFrom(mapId, origem, destino) {
	const s = store(mapId);
	const de = s.data.modes?.[origem];
	if (!de) return 0;
	let novos = 0;
	for (const [team, lista] of Object.entries(de)) {
		for (const p of lista) {
			if (!p.count) continue;
			if (merge(s.data, destino, team, p, 0, { seed: origem })) novos++;
		}
	}
	if (novos) marcar(s);
	return novos;
}

// ---------------------------------------------------------------------------
// Bandeiras (CTF) e pontos de controle (CP)
// ---------------------------------------------------------------------------

function noteFlags(mapId, red, blue) {
	if (!mapId || !red || !blue) return false;
	const s = store(mapId);
	const ctf = (s.data.ctf ??= { variants: [] });
	const igual = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
	let v = ctf.variants.find((e) => igual(e.red, red) && igual(e.blue, blue));
	const novo = !v;
	if (!v) ctf.variants.push((v = { red: { ...red }, blue: { ...blue }, count: 0 }));
	v.count += 1;
	marcar(s);
	return novo;
}

function noteDomPoints(mapId, radii, pontos) {
	if (!mapId || !Array.isArray(pontos)) return 0;
	const s = store(mapId);
	const cp = (s.data.cp ??= { keypointTriggerRadius: null, keypointVisorHeight: null, minesRestrictionRadius: null, points: [] });
	for (const k of ["keypointTriggerRadius", "keypointVisorHeight", "minesRestrictionRadius"]) {
		if (typeof radii?.[k] === "number") cp[k] = radii[k];
	}
	let novos = 0;
	for (const pt of pontos) {
		let p = cp.points.find((e) => e.name === pt.name && e.x === pt.x && e.y === pt.y);
		if (!p) {
			cp.points.push((p = { id: pt.id ?? null, name: pt.name ?? null, x: pt.x, y: pt.y, z: pt.z, count: 0 }));
			novos++;
		}
		p.count += 1;
	}
	marcar(s);
	return novos;
}

// ---------------------------------------------------------------------------
// Suprimentos (caixas) — ver o cabeçalho: cada queda é um ponto de spawn, nada se funde.
// ---------------------------------------------------------------------------

function emptyBonus() {
	return { types: {}, points: {}, goldRegions: [] };
}

/** Apaga tudo de bônus do mapa — captura limpa, uma sessão por mapa. */
function resetBonus(mapId) {
	const s = store(mapId);
	s.data.bonus = emptyBonus();
	marcar(s);
}

/** Metadados da sessão que gerou o bônus do mapa (conta, batalha, razão de parada…). */
function setBonusMeta(mapId, meta) {
	const s = store(mapId);
	const bonus = (s.data.bonus ??= emptyBonus());
	bonus.capture = { ...(bonus.capture || {}), ...meta };
	marcar(s);
}

/** Uma caixa caiu: registra o ponto. `tipo` sem o sufixo de instância (medkit, nitro, armorup…). */
function noteBonusDrop(mapId, tipo, pos) {
	if (!mapId || !tipo || !pos) return false;
	const s = store(mapId);
	const bonus = (s.data.bonus ??= emptyBonus());
	bonus.types ??= {};
	bonus.types[tipo] = (bonus.types[tipo] || 0) + 1;
	bonus.points ??= {};
	(bonus.points[tipo] ??= []).push({ x: pos.x, y: pos.y, z: pos.z });
	marcar(s);
	return true;
}

/** Zona de gold box (SpawnBonusRegion) — só aparece em batalha com jogadores ativos. */
function noteGoldRegion(mapId, pos, yaw, bonusType) {
	if (!mapId || !pos) return false;
	const s = store(mapId);
	const bonus = (s.data.bonus ??= emptyBonus());
	bonus.goldRegions ??= [];
	let p = bonus.goldRegions.find((e) => e.x === pos.x && e.y === pos.y && e.z === pos.z && e.bonusType === bonusType);
	const novo = !p;
	if (!p) bonus.goldRegions.push((p = { x: pos.x, y: pos.y, z: pos.z, yaw, bonusType, count: 0 }));
	p.count += 1;
	marcar(s);
	return novo;
}

/** Leitura do bônus gravado (para relatórios). */
function bonusOf(mapId) {
	return store(mapId).data.bonus || null;
}

module.exports = {
	SPAWNS_DIR, fileFor, flush,
	note, notePoint, points, seedFrom,
	noteFlags, noteDomPoints,
	resetBonus, setBonusMeta, noteBonusDrop, noteGoldRegion, bonusOf,
};
