"use strict";

// Servidor de jogo e proxy opcional. O proxy vem da variável PROXY, por exemplo:
//   PROXY=socks5://127.0.0.1:1080
//   PROXY=http://user:pass@1.2.3.4:8080
//
// IMPORTANTE: rode os scripts com ./ProTanki.exe (node.exe renomeado), não com `node`.
// O NoPing faz o túnel pelo NOME do executável; sem ele o servidor aceita o TCP e fecha a
// conexão sem mandar o pacote de chaves ("timeout no handshake de chaves").

function parseProxyUrl(url) {
	if (!url) return null;
	try {
		const u = new URL(url);
		let type = u.protocol.replace(":", "").toLowerCase();
		if (type === "socks" || type === "socks5h") type = "socks5";
		return {
			type,
			host: u.hostname,
			port: Number(u.port) || (type === "http" ? 8080 : 1080),
			username: u.username ? decodeURIComponent(u.username) : undefined,
			password: u.password ? decodeURIComponent(u.password) : undefined,
		};
	} catch (e) {
		console.error(`[config] PROXY inválido "${url}": ${e.message}`);
		return null;
	}
}

module.exports = {
	gameServer: { host: process.env.GAME_HOST || "194.67.196.216", port: Number(process.env.GAME_PORT) || 25565 },
	proxy: parseProxyUrl(process.env.PROXY) || null,
};
