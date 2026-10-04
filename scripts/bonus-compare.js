#!/usr/bin/env node
"use strict";

/**
 * Compara a captura de suprimentos de dois acervos, mapa a mapa: contagem por tipo, quantos
 * pontos coincidem exatamente, distância do ponto mais próximo para os que não coincidem, e a
 * linha do tempo. Serve para validar uma recaptura (ex.: 120 s fixos vs parada por teto).
 *
 *   node scripts/bonus-compare.js <dirA> <dirB> [map_x,map_y]     (padrão: todos em comum)
 *
 * Um ponto de A "bate" com um de B se a mesma coordenada (x,y,z inteiros) existe em B para o
 * mesmo tipo; cada ponto de B é consumido uma vez (dois pontos iguais em A exigem dois em B).
 */

const fs = require("node:fs");
const path = require("node:path");

const [dirA, dirB, only] = process.argv.slice(2);
if (!dirA || !dirB) {
	console.error("uso: node scripts/bonus-compare.js <dirA> <dirB> [map_a,map_b]");
	process.exit(1);
}
const filtro = only ? new Set(only.split(",").map((s) => s.trim())) : null;

function load(dir) {
	const out = new Map();
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			if (d.bonus?.capture?.finishedAt) out.set(d.mapId, d.bonus);
		} catch {}
	}
	return out;
}
const A = load(dirA), B = load(dirB);
const mapas = [...A.keys()].filter((m) => B.has(m) && (!filtro || filtro.has(m))).sort();
if (!mapas.length) {
	console.log("nenhum mapa em comum");
	process.exit(0);
}

const key = (p) => `${p.x},${p.y},${p.z}`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

for (const m of mapas) {
	const a = A.get(m), b = B.get(m);
	const pa = a.points || {}, pb = b.points || {};
	const tipos = new Set([...Object.keys(pa), ...Object.keys(pb)]);
	console.log(`\n== ${m}`);
	console.log(`   A: ${a.capture.drops} pontos, ${a.capture.stopReason}, escuta ${Math.round(a.capture.elapsedMs / 1000)}s, último drop ${a.capture.timeline?.at(-1)}s`);
	console.log(`   B: ${b.capture.drops} pontos, ${b.capture.stopReason}, escuta ${Math.round(b.capture.elapsedMs / 1000)}s, último drop ${b.capture.timeline?.at(-1)}s`);
	let iguais = 0, soA = [], soB = [];
	for (const t of tipos) {
		const la = pa[t] || [], lb = [...(pb[t] || [])];
		for (const p of la) {
			const i = lb.findIndex((q) => key(q) === key(p));
			if (i >= 0) {
				iguais++;
				lb.splice(i, 1);
			} else soA.push({ t, p });
		}
		for (const q of lb) soB.push({ t, q });
	}
	const nA = Object.values(pa).reduce((s, l) => s + l.length, 0), nB = Object.values(pb).reduce((s, l) => s + l.length, 0);
	console.log(`   coincidem exatamente: ${iguais} | só em A: ${soA.length} | só em B: ${soB.length}`);
	console.log(`   por tipo A→B: ${[...tipos].map((t) => `${t} ${(pa[t] || []).length}→${(pb[t] || []).length}`).join(", ")}`);
	// para os que não bateram, o mais próximo do mesmo tipo no outro acervo
	for (const { t, p } of soA) {
		const cand = (pb[t] || []).map((q) => dist(p, q));
		const d = cand.length ? Math.min(...cand) : null;
		console.log(`   só em A: ${t} (${p.x}, ${p.y}, ${p.z})${d != null ? ` — mais próximo em B a ${Math.round(d)} un.` : " — tipo ausente em B"}`);
	}
	for (const { t, q } of soB) {
		const cand = (pa[t] || []).map((p) => dist(p, q));
		const d = cand.length ? Math.min(...cand) : null;
		console.log(`   só em B: ${t} (${q.x}, ${q.y}, ${q.z})${d != null ? ` — mais próximo em A a ${Math.round(d)} un.` : " — tipo ausente em A"}`);
	}
	if (iguais === nA && nA === nB) console.log("   → idênticos");
}
