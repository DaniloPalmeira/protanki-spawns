#!/usr/bin/env node
"use strict";

/**
 * Captura de suprimentos (caixas) — CLI. Precisa de conta(s) COM PASSE.
 *
 *   ./ProTanki.exe scripts/bonus-sweep.js --dry-run
 *   ./ProTanki.exe scripts/bonus-sweep.js
 *   ./ProTanki.exe scripts/bonus-sweep.js --accounts c2,c3 --maps map_sandbox,map_rio
 *
 * Uma sessão por mapa, só DM, batalha privada com cronômetro preciso. Todas as contas do
 * arquivo rodam em paralelo puxando da mesma fila; conta sem passe é descartada.
 * Resultado em spawns/<mapa>.json (campo `bonus`); progresso em state/bonus-sweep.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const { bonusSweep, DEFAULTS, PROGRESS_FILE } = require("../lib/bonusSweep");

const ROOT = path.join(__dirname, "..");
const DEFAULT_ACCOUNTS = path.join(ROOT, "accounts.json");

function parse(argv) {
	const out = { accountsFile: DEFAULT_ACCOUNTS, labels: null, options: {} };
	const o = out.options;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i], next = () => argv[++i];
		switch (a) {
			case "--accounts-file": out.accountsFile = next(); break;
			case "--accounts": out.labels = next().split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--maps": o.maps = next().split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--limit": o.limit = Number(next()); break;
			case "--listen-ms": o.listenMs = Number(next()); break;
			case "--no-adaptive": o.adaptiveStop = false; break;
			case "--idle-margin": o.idleMargin = Number(next()); break;
			case "--idle-floor-ms": o.idleFloorMs = Number(next()); break;
			case "--min-drops": o.minDrops = Number(next()); break;
			case "--mode": o.mode = next().toUpperCase(); break;
			case "--redo": o.redo = true; break;
			case "--dry-run": o.dryRun = true; break;
			case "--verbose": o.verbose = true; break;
			case "-h": case "--help": out.help = true; break;
			default: console.error(`argumento desconhecido: ${a}`); out.help = true;
		}
	}
	return out;
}

function usage() {
	console.log(`
uso: ./ProTanki.exe scripts/bonus-sweep.js [opções]   (contas com passe)

  --accounts-file <arq>   arquivo de contas (padrão: accounts.json)
  --accounts c2,c3        só essas contas (por label); padrão: todas do arquivo
  --maps a,b,/regex/      só esses mapas (padrão: todos habilitados com DM)
  --limit N               no máximo N mapas
  --listen-ms MS          teto duro de escuta por mapa (padrão: ${DEFAULTS.listenMs}; limitado ao kick de 5min)
  --no-adaptive           desliga a parada por teto (ouve sempre --listen-ms)
  --idle-margin F         silêncio exigido = maior intervalo entre quedas × (1+F) (padrão: ${DEFAULTS.idleMargin})
  --idle-floor-ms MS      silêncio mínimo para declarar teto (padrão: ${DEFAULTS.idleFloorMs})
  --min-drops N           só declara teto depois de N quedas (padrão: ${DEFAULTS.minDrops})
  --mode DM               modo da batalha (padrão: ${DEFAULTS.mode})
  --redo                  refaz mapas já concluídos (apaga o bônus anterior do mapa)
  --dry-run               só imprime a fila e quem alcança cada mapa
  --verbose               loga cada pacote

progresso: ${path.relative(ROOT, PROGRESS_FILE)}
`);
}

function loadAccounts(file, labels) {
	if (!fs.existsSync(file)) throw new Error(`arquivo de contas não encontrado: ${file} (copie accounts.example.json)`);
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	let list = Array.isArray(data) ? data : data.accounts;
	if (!Array.isArray(list) || !list.length) throw new Error(`${file}: esperava uma lista de contas`);
	for (const a of list) if (!a.username || !a.password) throw new Error(`${file}: conta sem username/password`);
	if (labels) {
		list = list.filter((a) => labels.includes(a.label) || labels.includes(a.username));
		if (!list.length) throw new Error(`nenhuma conta com label ${labels.join(",")}`);
	}
	return list;
}

(async () => {
	const { accountsFile, labels, options, help } = parse(process.argv.slice(2));
	if (help) return usage();
	let accounts;
	try { accounts = loadAccounts(accountsFile, labels); } catch (e) { console.error(e.message); process.exitCode = 1; return; }

	const t0 = Date.now();
	try {
		const res = await bonusSweep(accounts, options);
		if (res.stats) {
			console.log("\n=== resumo ===");
			for (const s of res.stats) console.log(`  ${s.conta}: ${s.maps} mapas, ${s.drops} quedas, ${s.gold} gold, ${s.errors} erros`);
			if (res.items.length) console.log(`  não feitos: ${res.items.map((i) => i.mapId).join(", ")}`);
		}
		console.log(`[bonus] fim em ${((Date.now() - t0) / 60000).toFixed(1)} min`);
	} catch (e) {
		console.error("[bonus] abortado:", e.message);
		process.exitCode = 1;
	}
})();
