#!/usr/bin/env node
"use strict";

/**
 * Fechamento da captura de suprimentos. Idempotente. Duas passagens:
 *
 *  1. Capacidade. Escuta >= 90 s cobriu a janela inteira de quedas (10–80 s), então
 *     capacity = drops. Para sessões antigas com parada adaptativa, reclassifica "tempo" como
 *     "teto" quando o silêncio final passou do dobro do maior intervalo (mínimo 20 s).
 *
 *  2. Migra o formato antigo (`drops` com count + `zones`/`region` agrupados) para `points`:
 *     cada queda vira um ponto, sem fundir. No sport cada ponto solta uma caixa e ela fica no
 *     chão, então duas quedas perto são dois pontos — o agrupamento por 500 unidades fundia
 *     pontos reais (cologne, esplanade, industrial_zone, montecarlo).
 *
 *   node scripts/bonus-finalize.js            aplica e imprime o resumo
 *   node scripts/bonus-finalize.js --dry-run  só imprime o que mudaria
 */

const fs = require("node:fs");
const path = require("node:path");
const { SPAWNS_DIR } = require("../lib/spawnStore");

const dry = process.argv.includes("--dry-run");
const IDLE_MARGIN = 1.0;
const IDLE_FLOOR_MS = 20000;
const WINDOW_COVERED_MS = 90000; // quedas acontecem entre 10 e 80 s; escuta >= 90 s viu tudo

let files = [];
try {
	files = fs.readdirSync(SPAWNS_DIR).filter((f) => f.endsWith(".json")).sort();
} catch {}

const rows = [];
let mudados = 0;
for (const f of files) {
	const file = path.join(SPAWNS_DIR, f);
	let d;
	try {
		d = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		continue;
	}
	const b = d.bonus;
	const c = b?.capture;
	if (!c || !c.finishedAt || !c.stopReason) continue; // sessão ainda em andamento

	const notas = [];
	let mudou = false;

	// 1. capacidade / razão de parada
	if ((c.elapsedMs || 0) >= WINDOW_COVERED_MS) {
		// escuta cobriu a janela inteira de quedas (10–80 s): tudo que existe caiu
		if (c.capacity !== c.drops) {
			notas.push(`janela coberta (${Math.round(c.elapsedMs / 1000)}s): capacity = ${c.drops}`);
			if (!dry) c.capacity = c.drops;
			mudou = true;
		}
	} else if (c.stopReason === "tempo" && c.drops > 0 && c.idleMs != null) {
		// sessões antigas com parada adaptativa
		const exigido = Math.max((c.maxGapMs || 0) * (1 + IDLE_MARGIN), IDLE_FLOOR_MS);
		if (c.idleMs > exigido) {
			notas.push(`tempo→teto: ${Math.round(c.idleMs / 1000)}s de silêncio > ${Math.round(exigido / 1000)}s exigidos`);
			if (!dry) Object.assign(c, { stopReason: "teto", capacity: c.drops });
			mudou = true;
		}
	}

	// 2. formato: drops/zones/region → points
	if (b.drops || b.zones || b.region) {
		const points = {};
		let n = 0;
		for (const [tipo, lista] of Object.entries(b.drops || {})) {
			points[tipo] = [];
			for (const p of lista) for (let i = 0; i < (p.count || 1); i++) points[tipo].push({ x: p.x, y: p.y, z: p.z });
			n += points[tipo].length;
		}
		notas.push(`drops/zones/region → points (${n} pontos)`);
		if (!dry) {
			const { capture, types, goldRegions } = b;
			d.bonus = { capture, types: types || {}, points, goldRegions: goldRegions || [] };
		}
		mudou = true;
	}

	if (mudou) {
		mudados++;
		if (!dry) {
			d.updatedAt = new Date().toISOString();
			fs.writeFileSync(file, JSON.stringify(d, null, "\t") + "\n");
		}
	}
	const bb = d.bonus;
	const pontos = Object.values(bb.points || bb.drops || {}).reduce((a, l) => a + l.length, 0);
	rows.push({ mapId: d.mapId, drops: c.drops, pontos, stopReason: c.stopReason, capacity: c.capacity, gold: (bb.goldRegions || []).length, listen: Math.round((c.elapsedMs || 0) / 1000), types: Object.keys(bb.types || {}).length, account: c.account, note: notas.join("; ") });
}

console.log(`${rows.length} mapas com captura de suprimentos; ${mudados} reclassificado(s)${dry ? " (dry-run, nada gravado)" : ""}`);
const por = rows.reduce((a, r) => ((a[r.stopReason] = (a[r.stopReason] || 0) + 1), a), {});
console.log("por razão de parada:", JSON.stringify(por));
const caps = rows.filter((r) => r.capacity != null).map((r) => r.capacity);
if (caps.length) console.log(`capacidade: min ${Math.min(...caps)}, max ${Math.max(...caps)}, média ${(caps.reduce((a, b) => a + b, 0) / caps.length).toFixed(1)}`);
const semGold = rows.filter((r) => !r.gold).length;
console.log(`mapas sem zona de gold vista: ${semGold} de ${rows.length}`);
console.log("");
const divergentes = rows.filter((r) => r.pontos !== r.drops);
if (divergentes.length) console.log(`ATENÇÃO: pontos != quedas em ${divergentes.map((r) => r.mapId).join(", ")}`);
console.log("");
console.log("mapa                      pontos cap  razão  tipos gold escuta conta");
for (const r of rows) {
	console.log(`${r.mapId.padEnd(25)} ${String(r.pontos).padStart(6)} ${String(r.capacity ?? "-").padStart(4)}  ${r.stopReason.padEnd(6)} ${String(r.types).padStart(5)} ${String(r.gold).padStart(4)} ${String(r.listen + "s").padStart(6)} ${r.account || ""}${r.note ? "  ← " + r.note : ""}`);
}
