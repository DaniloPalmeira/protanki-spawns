#!/usr/bin/env node
"use strict";

/**
 * Fechamento da captura de suprimentos: reclassifica a razão de parada com a MESMA regra de
 * silêncio da varredura, mas sem o piso de 3 quedas.
 *
 * Por quê: a varredura só declara teto depois de 3 quedas (para não fechar cedo). Um mapa com
 * capacidade 1 ou 2 fica então até o tempo esgotar, marcado como "tempo" — mas se o silêncio
 * final for maior que o dobro do maior intervalo entre quedas (mínimo 20 s), as caixas pararam
 * de cair e isso É o teto. map_island: quedas aos 15,9 s e 56,9 s, depois 233 s de silêncio.
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
	const c = d.bonus?.capture;
	if (!c) continue;

	let novo = null;
	if (c.stopReason === "tempo" && c.drops > 0 && c.idleMs != null) {
		const exigido = Math.max((c.maxGapMs || 0) * (1 + IDLE_MARGIN), IDLE_FLOOR_MS);
		if (c.idleMs > exigido) novo = { stopReason: "teto", capacity: c.drops, reclassified: `tempo→teto: ${Math.round(c.idleMs / 1000)}s de silêncio > ${Math.round(exigido / 1000)}s exigidos` };
	}
	if (novo) {
		mudados++;
		if (!dry) {
			Object.assign(c, novo);
			d.updatedAt = new Date().toISOString();
			fs.writeFileSync(file, JSON.stringify(d, null, "\t") + "\n");
		}
	}
	rows.push({ mapId: d.mapId, drops: c.drops, stopReason: novo?.stopReason ?? c.stopReason, capacity: novo?.capacity ?? c.capacity, gold: (d.bonus.goldRegions || []).length, listen: Math.round((c.elapsedMs || 0) / 1000), types: Object.keys(d.bonus.types || {}).length, account: c.account, note: novo?.reclassified || "" });
}

console.log(`${rows.length} mapas com captura de suprimentos; ${mudados} reclassificado(s)${dry ? " (dry-run, nada gravado)" : ""}`);
const por = rows.reduce((a, r) => ((a[r.stopReason] = (a[r.stopReason] || 0) + 1), a), {});
console.log("por razão de parada:", JSON.stringify(por));
const caps = rows.filter((r) => r.capacity != null).map((r) => r.capacity);
if (caps.length) console.log(`capacidade: min ${Math.min(...caps)}, max ${Math.max(...caps)}, média ${(caps.reduce((a, b) => a + b, 0) / caps.length).toFixed(1)}`);
const semGold = rows.filter((r) => !r.gold).length;
console.log(`mapas sem zona de gold vista: ${semGold} de ${rows.length}`);
console.log("");
console.log("mapa                      quedas cap  razão  tipos gold escuta conta");
for (const r of rows) {
	console.log(`${r.mapId.padEnd(25)} ${String(r.drops).padStart(6)} ${String(r.capacity ?? "-").padStart(4)}  ${r.stopReason.padEnd(6)} ${String(r.types).padStart(5)} ${String(r.gold).padStart(4)} ${String(r.listen + "s").padStart(6)} ${r.account || ""}${r.note ? "  ← " + r.note : ""}`);
}
