"use strict";

/**
 * Chave canônica de um ponto de spawn. Mora sozinha aqui porque DOIS acervos gravam o
 * mesmo dado (classes/gameplayHarvest.js e classes/spawnStore.js) e qualquer diferença de
 * arredondamento entre eles faria o MESMO ponto virar dois — a contagem por ponto, que é o
 * critério de "já tenho esse mapa", deixaria de significar qualquer coisa.
 */

const TWO_PI = Math.PI * 2;

/** Normaliza yaw para (-π, π] (o servidor manda valores como -5π sem normalizar). */
function normYaw(z) {
	if (typeof z !== "number" || !isFinite(z)) return 0;
	let y = z % TWO_PI;
	if (y <= -Math.PI) y += TWO_PI;
	if (y > Math.PI) y -= TWO_PI;
	return Math.round(y * 1000) / 1000;
}

function r3(n) {
	return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Vetor com coordenadas FINITAS arredondadas, ou null. NaN é um float32 legal no wire e
 * NaN !== NaN quebraria o dedupe para sempre (a lista cresceria sem limite).
 */
function finite3(p, round = r3) {
	if (!p || typeof p !== "object") return null;
	const x = round(p.x), y = round(p.y), z = round(p.z);
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
	return { x, y, z };
}

/** { position, orientation|rotation } → { x, y, z, yaw } ou null. */
function spawnKey(fields) {
	const pos = finite3(fields && fields.position);
	if (!pos) return null;
	const ori = (fields && (fields.orientation || fields.rotation)) || {};
	return { x: pos.x, y: pos.y, z: pos.z, yaw: normYaw(ori.z) };
}

module.exports = { spawnKey, finite3, normYaw, r3 };
