#!/usr/bin/env node
"use strict";

/**
 * Viewer local. Sobe um servidor que lê spawns/*.json NA HORA e desenha, num mapa de cima,
 * os spawns por time, bandeiras (CTF), pontos de controle (CP), zonas de suprimentos e gold.
 * Depois de uma coleta nova, é só clicar em "↻ atualizar" no navegador.
 *
 *   node scripts/viewer.js            http://localhost:8777
 *   node scripts/viewer.js --port 9000
 *
 * GET /            → o viewer (scripts/viewer.html)
 * GET /data.json   → payload montado do spawns/ neste instante
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const SPAWNS_DIR = path.join(ROOT, "spawns");
const HTML_FILE = path.join(__dirname, "viewer.html");

const argPort = process.argv.indexOf("--port");
const PORT = argPort > -1 ? Number(process.argv[argPort + 1]) : 8777;

const r2 = (n) => Math.round(n * 100) / 100;
const ri = (n) => Math.round(n);

/** spawns/<id>.json → forma compacta que o viewer espera. */
function toViz(d, id) {
	const out = { name: id.replace(/^map_/, ""), modes: {} };

	for (const [mode, teams] of Object.entries(d.modes || {})) {
		const mv = {};
		for (const [team, list] of Object.entries(teams)) {
			if (!Array.isArray(list) || !list.length) continue;
			mv[team] = list.map((p) => [ri(p.x), ri(p.y), r2(p.yaw ?? 0)]);
		}
		if (Object.keys(mv).length) out.modes[mode] = mv;
	}

	const v = d.ctf?.variants?.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0];
	if (v) out.ctf = { red: [ri(v.red.x), ri(v.red.y)], blue: [ri(v.blue.x), ri(v.blue.y)] };
	if (d.cp?.points?.length) out.cp = d.cp.points.map((p) => [ri(p.x), ri(p.y), p.name || "?"]);

	if (d.bonus) {
		// um ponto de spawn de suprimento por caixa que caiu (formato antigo `drops` aceito)
		const bonus = {};
		for (const [tipo, list] of Object.entries(d.bonus.points || d.bonus.drops || {})) {
			if (Array.isArray(list) && list.length) bonus[tipo] = list.map((p) => [ri(p.x), ri(p.y)]);
		}
		if (Object.keys(bonus).length) out.bonus = bonus;
		if (Array.isArray(d.bonus.goldRegions) && d.bonus.goldRegions.length) out.gold = d.bonus.goldRegions.map((p) => [ri(p.x), ri(p.y)]);
		if (d.bonus.capture) out.capture = { account: d.bonus.capture.account, drops: d.bonus.capture.drops, listenMs: d.bonus.capture.listenMs, finishedAt: d.bonus.capture.finishedAt };
	}
	return out;
}

function buildData() {
	const data = {};
	let files = [];
	try { files = fs.readdirSync(SPAWNS_DIR).filter((f) => f.endsWith(".json")); } catch {}
	for (const f of files) {
		let d;
		try { d = JSON.parse(fs.readFileSync(path.join(SPAWNS_DIR, f), "utf8")); } catch { continue; }
		const id = d.mapId || f.replace(/\.json$/, "");
		const temSpawn = d.modes && Object.keys(d.modes).length;
		const temBonus = d.bonus && (Object.keys(d.bonus.points || d.bonus.drops || {}).length || (d.bonus.goldRegions || []).length);
		if (!temSpawn && !temBonus) continue;
		data[id] = toViz(d, id);
	}
	return data;
}

const server = http.createServer((req, res) => {
	const url = (req.url || "/").split("?")[0];
	if (url === "/data.json") {
		let body;
		try {
			body = JSON.stringify(buildData());
		} catch (e) {
			res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end("erro ao montar data.json: " + e.message);
			return;
		}
		res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(body);
		return;
	}
	if (url === "/" || url === "/index.html") {
		fs.readFile(HTML_FILE, (err, buf) => {
			if (err) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("não achei viewer.html: " + err.message);
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(buf);
		});
		return;
	}
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("404");
});

server.listen(PORT, () => {
	const n = Object.keys(buildData()).length;
	console.log(`[viewer] ${n} mapas em  http://localhost:${PORT}`);
	console.log(`[viewer] "↻ atualizar" no navegador relê o spawns/ na hora. Ctrl+C encerra.`);
});
