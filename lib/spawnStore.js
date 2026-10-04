"use strict";

/**
 * Acervo por mapa em spawns/<map_id>.json:
 *
 *   {
 *     "mapId": "map_gravity",
 *     "modes": { "DM": { "NONE": [ {x,y,z,yaw,count} ] } },        // spawn de players
 *     "bonus": {                                                    // suprimentos
 *       "capture": { account, battleId, startedAt, listenMs, ... }, // a sessão que gerou
 *       "types": { medkit: 12, nitro: 9 },                          // quantas quedas por tipo
 *       "region": { <tipo>: bbox },                                 // bbox de todas as quedas do tipo
 *       "zones":  { <tipo>: [ {minX..maxZ,cx,cy,cz,samples} ] },    // regiões de queda (bbox agrupada)
 *       "drops":  { <tipo>: [ {x,y,z,count} ] },                    // amostra bruta (limitada)
 *       "goldRegions": [ {x,y,z,yaw,bonusType,count} ]              // zonas fixas de gold box
 *     },
 *     "ctf": { variants: [{ red, blue, count }] },
 *     "cp":  { keypointTriggerRadius, keypointVisorHeight, minesRestrictionRadius, points: [] }
 *   }
 *
 * Sem dimensão de tema: o tema é a pintura do mapa, spawn e bônus não mudam com ele.
 * Regras: merge em memória, gravação debounced e atômica, dedupe pela mesma chave
 * (spawnPoint.spawnKey) em todo lugar que grava spawn.
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
// Suprimentos (caixas)
// ---------------------------------------------------------------------------
//
// A caixa NÃO cai num ponto fixo: cai em posição aleatória dentro de uma região desenhada no
// editor de mapa. O que é finito e útil é o TIPO e a REGIÃO. Guardamos uma amostra limitada
// das posições, a bbox por tipo e as zonas (bbox agrupadas por proximidade).

const BONUS_SAMPLE_CAP = 300;
const ZONE_GAP = 500; // duas quedas a <= isto no plano XY pertencem à mesma zona

function emptyBonus() {
	return { types: {}, region: {}, zones: {}, drops: {}, goldRegions: [] };
}

/** Apaga tudo de bônus do mapa — captura limpa, uma sessão por mapa. */
function resetBonus(mapId) {
	const s = store(mapId);
	s.data.bonus = emptyBonus();
	marcar(s);
}

/** Metadados da sessão que gerou o bônus do mapa (conta, batalha, tempo de escuta…). */
function setBonusMeta(mapId, meta) {
	const s = store(mapId);
	const bonus = (s.data.bonus ??= emptyBonus());
	bonus.capture = { ...(bonus.capture || {}), ...meta };
	marcar(s);
}

function noteBonusDrop(mapId, tipo, pos) {
	if (!mapId || !tipo || !pos) return false;
	const s = store(mapId);
	const bonus = (s.data.bonus ??= emptyBonus());
	bonus.types ??= {};
	bonus.types[tipo] = (bonus.types[tipo] || 0) + 1;

	const box = (bonus.region ??= {});
	const b = (box[tipo] ??= { minX: pos.x, maxX: pos.x, minY: pos.y, maxY: pos.y, minZ: pos.z, maxZ: pos.z });
	growBox(b, pos);

	bonus.zones ??= {};
	addToZones((bonus.zones[tipo] ??= []), pos);

	bonus.drops ??= {};
	const lista = (bonus.drops[tipo] ??= []);
	let p = lista.find((e) => e.x === pos.x && e.y === pos.y && e.z === pos.z);
	const novo = !p;
	if (!p) {
		if (lista.length >= BONUS_SAMPLE_CAP) {
			marcar(s);
			return false;
		}
		lista.push((p = { x: pos.x, y: pos.y, z: pos.z, count: 0 }));
	}
	p.count += 1;
	marcar(s);
	return novo;
}

function distToBox(z, p) {
	const dx = Math.max(z.minX - p.x, 0, p.x - z.maxX);
	const dy = Math.max(z.minY - p.y, 0, p.y - z.maxY);
	return Math.hypot(dx, dy);
}
function growBox(z, p) {
	z.minX = Math.min(z.minX, p.x); z.maxX = Math.max(z.maxX, p.x);
	z.minY = Math.min(z.minY, p.y); z.maxY = Math.max(z.maxY, p.y);
	z.minZ = Math.min(z.minZ, p.z); z.maxZ = Math.max(z.maxZ, p.z);
}
function boxesTouch(a, b) {
	return a.minX - ZONE_GAP <= b.maxX && b.minX - ZONE_GAP <= a.maxX && a.minY - ZONE_GAP <= b.maxY && b.minY - ZONE_GAP <= a.maxY;
}
function finishZone(z) {
	z.cx = Math.round((z.minX + z.maxX) / 2);
	z.cy = Math.round((z.minY + z.maxY) / 2);
	z.cz = Math.round((z.minZ + z.maxZ) / 2);
}

/** Incorpora uma queda nas zonas do tipo, fundindo zonas que passaram a se tocar. */
function addToZones(zones, pos) {
	let z = zones.find((e) => distToBox(e, pos) <= ZONE_GAP);
	if (!z) zones.push((z = { minX: pos.x, maxX: pos.x, minY: pos.y, maxY: pos.y, minZ: pos.z, maxZ: pos.z, samples: 0 }));
	growBox(z, pos);
	z.samples += 1;
	for (let i = zones.length - 1; i >= 0; i--) {
		const o = zones[i];
		if (o === z || !boxesTouch(z, o)) continue;
		growBox(z, { x: o.minX, y: o.minY, z: o.minZ });
		growBox(z, { x: o.maxX, y: o.maxY, z: o.maxZ });
		z.samples += o.samples;
		zones.splice(i, 1);
	}
	finishZone(z);
	return z;
}

/** Recalcula `bonus.zones` do mapa a partir das amostras em `bonus.drops`. */
function rebuildBonusZones(mapId) {
	const s = store(mapId);
	const bonus = s.data.bonus;
	if (!bonus?.drops) return 0;
	bonus.zones = {};
	let n = 0;
	for (const [tipo, lista] of Object.entries(bonus.drops)) {
		const zones = (bonus.zones[tipo] = []);
		for (const p of lista) for (let i = 0; i < (p.count || 1); i++) addToZones(zones, p);
		n += zones.length;
	}
	marcar(s);
	return n;
}

/** Zona de gold box (SpawnBonusRegion) — essas são fixas. */
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
	resetBonus, setBonusMeta, noteBonusDrop, noteGoldRegion, rebuildBonusZones, bonusOf,
};
