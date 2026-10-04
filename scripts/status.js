#!/usr/bin/env node
"use strict";

/**
 * Estado do acervo (spawns/<map>.json).
 *
 *   node scripts/status.js              resumo: spawns de players + suprimentos por mapa
 *   node scripts/status.js --bonus      só suprimentos, uma linha por mapa
 *   node scripts/status.js --spawns     só spawns de players (por modo/time)
 *   node scripts/status.js --faltando   só o que está incompleto
 *
 * Regra de completo para spawn: TODO ponto com pelo menos `--min` aparições (padrão 2).
 */

const fs = require("node:fs");
const path = require("node:path");
const { SPAWNS_DIR } = require("../lib/spawnStore");

const args = process.argv.slice(2);
const soBonus = args.includes("--bonus");
const soSpawns = args.includes("--spawns");
const soFaltando = args.includes("--faltando");
const min = Number(args[args.indexOf("--min") + 1]) || 2;

function loadAll() {
	let files;
	try {
		files = fs.readdirSync(SPAWNS_DIR).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out = [];
	for (const f of files) {
		try {
			out.push(JSON.parse(fs.readFileSync(path.join(SPAWNS_DIR, f), "utf8")));
		} catch {}
	}
	return out;
}

const maps = loadAll();
if (!maps.length) {
	console.log(`acervo vazio em ${path.relative(process.cwd(), SPAWNS_DIR) || "spawns/"}`);
	console.log("popule com:  ./ProTanki.exe scripts/bonus-sweep.js   (suprimentos)");
	console.log("         ou: ./ProTanki.exe scripts/spawn-sweep.js   (spawn de players)");
	process.exit(0);
}

// ---- suprimentos ----------------------------------------------------------
if (!soSpawns) {
	const comBonus = maps.filter((m) => m.bonus && m.bonus.capture);
	console.log(`=== suprimentos: ${comBonus.length} mapas capturados ===`);
	if (soBonus || !soFaltando) {
		console.log("mapa                      pontos  tipos                              razão  gold  escuta  conta");
		for (const m of comBonus) {
			const b = m.bonus;
			const tipos = Object.entries(b.types || {}).map(([t, n]) => `${t}:${n}`).join(" ");
			const pontos = Object.values(b.points || b.drops || {}).reduce((a, l) => a + l.length, 0);
			const escuta = b.capture.elapsedMs ? `${Math.round(b.capture.elapsedMs / 1000)}s` : "?";
			console.log(`${m.mapId.padEnd(25)} ${String(pontos).padStart(6)}  ${tipos.padEnd(34)} ${String(b.capture.stopReason || "?").padEnd(6)} ${String((b.goldRegions || []).length).padStart(4)}  ${escuta.padStart(6)}  ${b.capture.account || ""}`);
		}
	}
	const semQueda = comBonus.filter((m) => !(m.bonus.capture.drops > 0));
	if (semQueda.length) console.log(`sem nenhuma queda: ${semQueda.map((m) => m.mapId).join(", ")}`);
	console.log("");
}

// ---- spawns de players ----------------------------------------------------
if (!soBonus) {
	const rows = [];
	for (const data of maps) {
		for (const [mode, teams] of Object.entries(data.modes ?? {})) {
			for (const [team, list] of Object.entries(teams)) {
				if (!Array.isArray(list) || !list.length) continue;
				const herdados = list.filter((p) => p.seed && !p.count).length;
				const vistos = list.filter((p) => (p.count ?? 0) > 0);
				if (!vistos.length && !herdados) continue;
				const counts = vistos.map((p) => p.count);
				rows.push({
					mapId: data.mapId, mode, team,
					points: vistos.length, herdados,
					entries: counts.reduce((a, b) => a + b, 0),
					minCount: counts.length ? Math.min(...counts) : 0,
					raros: counts.filter((c) => c < min).length,
				});
			}
		}
	}
	console.log(`=== spawns de players: ${new Set(rows.map((r) => r.mapId)).size} mapas, ${rows.length} combinações (modo/time) ===`);
	if (rows.length) {
		const completos = rows.filter((r) => r.raros === 0 && !r.herdados);
		const faltando = rows.filter((r) => r.raros > 0);
		const mostrar = soFaltando ? faltando : rows;
		if (soSpawns || soFaltando) {
			console.log("mapa                          modo time  pontos entradas min  <" + min);
			for (const r of mostrar.sort((a, b) => a.mapId.localeCompare(b.mapId))) {
				console.log(`${r.mapId.padEnd(29)} ${r.mode.padEnd(4)} ${r.team.padEnd(5)} ${String(r.points).padStart(6)} ${String(r.entries).padStart(8)} ${String(r.minCount).padStart(3)} ${String(r.raros).padStart(4)}`);
			}
		}
		const pontos = rows.reduce((a, r) => a + r.points, 0);
		const entradas = rows.reduce((a, r) => a + r.entries, 0);
		console.log(`${pontos} pontos, ${entradas} observações | completos (todo ponto >= ${min}x): ${completos.length} | incompletos: ${faltando.length}`);
	}
}
