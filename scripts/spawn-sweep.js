#!/usr/bin/env node
"use strict";

/**
 * Varredura de pontos de spawn de players — CLI.
 *
 *   ./ProTanki.exe scripts/spawn-sweep.js --dry-run
 *   ./ProTanki.exe scripts/spawn-sweep.js --modes DM
 *   ./ProTanki.exe scripts/spawn-sweep.js --modes DM --maps map_abyss,map_sandbox
 *   ./ProTanki.exe scripts/spawn-sweep.js --accounts c2,c3 --modes TDM,CTF
 *   ./ProTanki.exe scripts/spawn-sweep.js --observe-only       só entra em batalha que já existe
 *
 * Contas em accounts.json (fora do git): [{ "label": "c1", "username": "...", "password": "..." }]
 * Cada conta roda em paralelo e puxa itens da mesma fila. Resultado em spawns/<mapa>.json;
 * progresso em state/spawn-sweep.json — dá para parar e retomar.
 */

const fs = require("node:fs");
const path = require("node:path");
const { sweep, DEFAULTS, PROGRESS_FILE } = require("../lib/spawnSweep");

const ROOT = path.join(__dirname, "..");
const DEFAULT_ACCOUNTS = path.join(ROOT, "accounts.json");

function parseArgs(argv) {
	const out = { accountsFile: DEFAULT_ACCOUNTS, labels: null, options: {} };
	const o = out.options;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case "--accounts-file": out.accountsFile = next(); break;
			case "--accounts": out.labels = next().split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--modes": o.modes = next().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean); break;
			case "--maps": o.maps = next().split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--min-entries": o.minEntries = Number(next()); break;
			case "--max-entries": o.maxEntries = Number(next()); break;
			case "--max-per-point": o.maxEntriesPerPoint = Number(next()); break;
			case "--stable-for": o.stableFor = Number(next()); break;
			case "--meta": o.metaOnly = true; o.redo = true; break;
			case "--min-per-point": o.minPerPoint = Number(next()); break;
			case "--no-new-for": o.noNewFor = Number(next()); break;
			case "--limit": o.limit = Number(next()); break;
			case "--create-limit": o.createLimit = Number(next()); break;
			case "--create-window": o.createWindowMs = Number(next()) * 60 * 1000; break;
			case "--cycle-delay": o.cycleDelayMs = Number(next()); break;
			case "--capture-at": o.captureAt = next(); break;
			case "--public": o.privateBattle = false; break;
			case "--max-people": o.maxPeopleCount = Number(next()); break;
			case "--observe": o.observe = true; break;
			case "--observe-only": o.observeOnly = true; break;
			case "--observe-ms": o.observeMs = Number(next()); break;
			case "--observe-max": o.observeMaxBattles = Number(next()); break;
			case "--include-disabled": o.includeDisabled = true; break;
			case "--redo": o.redo = true; break;
			case "--dry-run": o.dryRun = true; break;
			case "--verbose": o.verbose = true; break;
			case "-h": case "--help": out.help = true; break;
			default:
				console.error(`argumento desconhecido: ${arg}`);
				out.help = true;
		}
	}
	return out;
}

function usage() {
	console.log(`
uso: ./ProTanki.exe scripts/spawn-sweep.js [opções]

  --accounts-file <arq>   arquivo de contas (padrão: accounts.json)
  --accounts c2,c3        só essas contas (por label); padrão: todas do arquivo
  --modes DM,TDM          modos a varrer (padrão: ${DEFAULTS.modes.join(",")})
  --maps a,b,/regex/      só esses mapas (padrão: todos)
  --min-entries N         piso de entradas por item (padrão: ${DEFAULTS.minEntries})
  --min-per-point N       capturas mínimas de cada ponto (padrão: ${DEFAULTS.minPerPoint})
  --no-new-for N          entradas sem ponto novo para encerrar (padrão: ${DEFAULTS.noNewFor})
  --max-per-point N       teto = N x pontos descobertos (padrão: ${DEFAULTS.maxEntriesPerPoint})
  --max-entries N         teto absoluto por item (padrão: ${DEFAULTS.maxEntries})
  --stable-for N          fecha sem ponto novo há N entradas mesmo com ponto raro (padrão: ${DEFAULTS.stableFor}; 0 = estrito)
  --meta                  só bandeiras (CTF) e pontos de controle (CP): uma entrada por mapa (implica --redo)
  --limit N               varre no máximo N itens
  --create-limit N        criações de batalha por janela (padrão: ${DEFAULTS.createLimit})
  --create-window MIN     janela do limite, em minutos (padrão: ${DEFAULTS.createWindowMs / 60000})
  --cycle-delay MS        respiro entre ciclos (padrão: ${DEFAULTS.cycleDelayMs})
  --capture-at prepare|spawn
                          onde ler o ponto: PrepareToSpawn (rápido, padrão) ou SpawnPacket
  --observe               fase 1: entra em batalha alheia e anota o spawn dos outros
  --observe-only          só a fase 1, nunca cria batalha
  --observe-ms MS         tempo máximo em cada batalha alheia (padrão: ${DEFAULTS.observeMs})
  --observe-max N         no máximo N batalhas observadas por conta (0 = sem limite)
  --max-people N          vagas POR TIME na batalha criada (padrão: ${DEFAULTS.maxPeopleCount})
  --public                cria a batalha na lista pública
  --include-disabled      inclui mapas desabilitados
  --redo                  refaz itens já concluídos
  --dry-run               só imprime a fila
  --verbose               loga cada pacote

progresso: ${path.relative(ROOT, PROGRESS_FILE)}
`);
}

function loadAccounts(file, labels) {
	if (!fs.existsSync(file)) throw new Error(`arquivo de contas não encontrado: ${file}\ncrie a partir do exemplo: cp accounts.example.json accounts.json`);
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
	const { accountsFile, labels, options, help } = parseArgs(process.argv.slice(2));
	if (help) return usage();
	let accounts;
	try {
		accounts = loadAccounts(accountsFile, labels);
	} catch (e) {
		console.error(e.message);
		process.exitCode = 1;
		return;
	}
	const t0 = Date.now();
	try {
		const res = await sweep(accounts, options);
		if (res.stats) {
			console.log("\n=== resumo ===");
			for (const s of res.stats) console.log(`  ${s.conta}: ${s.items} itens, ${s.cycles} entradas, ${s.points} pontos novos, ${s.errors} erros`);
		}
		console.log(`[sweep] fim em ${((Date.now() - t0) / 60000).toFixed(1)} min`);
	} catch (e) {
		console.error("[sweep] abortado:", e.message);
		process.exitCode = 1;
	}
})();
