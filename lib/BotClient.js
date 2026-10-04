"use strict";

/**
 * Cliente headless do ProTanki: conecta DIRETO no servidor de jogo, sem o client Flash
 * no meio. É o mesmo protocolo do bridge (classes/ProTankiClient.js) — handshake de
 * chaves, XOR posicional, framing por prefixo de tamanho, deflate opcional — só que
 * sem um segundo socket para repassar nada.
 *
 * Duas decisões que valem explicação:
 *
 *  1. Respostas de manutenção (Ping→Pong, TimeChecker→Response, LoadDependencies→
 *     ResourceCallback) são automáticas aqui dentro. O servidor BLOQUEIA o progresso
 *     enquanto espera o callback de dependências, e derruba quem não responde ping —
 *     nenhuma máquina de estado acima deveria precisar lembrar disso.
 *
 *  2. `waitFor` aceita um marcador `since`. Vários pacotes chegam no MESMO segmento TCP
 *     e são emitidos no mesmo tick síncrono; um `await` só volta a rodar no microtask
 *     seguinte, quando o pacote esperado JÁ passou. Sem o buffer `recent` + `since`,
 *     a máquina de estado trava esperando algo que já aconteceu.
 */

const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const { encodeBody, BufferWriter, defById } = require("protanki-protocol");

const config = require("../config");
const { connect } = require("./proxyConnect");
const { parse } = require("./schemas");
const { PACKETS } = require("./packets");

const FLAG_DEFLATE = 0x40000000;
const RECENT_MAX = 512; // janela de replay do waitFor — folgada para uma entrada em batalha inteira

/** Ids usados pelo cliente headless (nome curado → id). */
const P = {
	// handshake / manutenção
	Protection: 2001736388,
	Ping: -555602629,
	Pong: 1484572481,
	TimeChecker: 34068208,
	TimeCheckerResponse: 2074243318,
	LoadDependencies: -1797047325,
	ResourceCallback: -82304134,
	HideLoader: -1282173466,

	// login
	Language: -1864333717,
	Login: -739684591,
	IncorrectPassword: 103812952,
	Captcha: -1670408519,
	Punishment: 1200280053,
	LobbyData: 907073245,

	// lobby
	BattleInfo: -838186985, // InitBattleCreateModel: catálogo de mapas/temas
	BattleList: 552006706,
	CreateBattleRequest: -2135234426,
	CreateBattleResponse: 802300608,
	SelectBattle: 2092412133,
	ShowBattleInfo: 546722394,
	RemoveBattleFromList: -1848001147,
	UnloadBattleList: -324155151,

	// batalha
	EnterBattle: -1284211503,
	SetLayout: 1118835050,
	ConfirmLayoutChange: -593368100,
	InitMap: -152638117, // InitBattlefieldModel
	InitCtfFlags: 789790814, // bases das bandeiras (CTF)
	InitDomPoints: -1337059439, // pontos de controle + letras (CP)
	SpawnBonus: 1831462385, // queda de caixa/bônus
	SpawnBonusRegion: -915079427, // zona de gold box
	InitBonuses: 870278784, // bônus já no mapa ao entrar (jsonData array)
	ReadyToSpawn: 268832557,
	PrepareToSpawn: -157204477,
	ReadyToPlace: -1378839846,
	Spawn: 875259457,
	DisablePause: 1156768699,
	UpdateBattleUserTeam: -497293992, // nick + time REAL atribuído pelo servidor
	ExitFromBattle: 377959142,
	UnloadSpaceBattle: -985579124,

	// avisos do servidor
	SystemMessage: -600078553,
	ShowAlertMessage: -322235316,
	HaltServer: -1712113407,
};

const LAYOUT = { LOBBY: 0, GARAGE: 1, BATTLE: 3 };

/** Nome do pacote sem efeito colateral (packetName() grava em unknown-packets.json). */
function nameOf(id) {
	return PACKETS[id] || defById(Number(id))?.name || `UNKNOWN(${id})`;
}

class BotClient extends EventEmitter {
	constructor({ tag = "[bot]", server = config.gameServer, proxy = config.proxy, verbose = false } = {}) {
		super();
		this.tag = tag;
		this.server = server;
		this.proxy = proxy;
		this.verbose = verbose;

		this.socket = null;
		this.closed = false;
		this.recvBuffer = Buffer.alloc(0);

		this.seq = 0; // pacotes recebidos até agora — marcador do waitFor
		this.recent = []; // últimos RECENT_MAX pacotes, para o replay do waitFor

		this.encryptionLenght = 8;
		this.decrypt_keys = new Array(8);
		this.encrypt_keys = new Array(8);
		this.decrypt_position = 0;
		this.encrypt_position = 0;
		this.keysReady = false;

		this.startedAt = Date.now(); // base do clientTime (getTimer() do client Flash)

		// Um 'close' sem ouvinte vira exceção não tratada no EventEmitter só para 'error',
		// mas mantemos um ouvinte-base para nunca depender de quem instanciou.
		this.on("close", () => {});
	}

	// -------------------------------------------------------------------------
	// Conexão
	// -------------------------------------------------------------------------

	/** Conecta e resolve quando as chaves de cripto chegam (o servidor manda primeiro). */
	connect({ timeout = 20000 } = {}) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.close();
				reject(new Error("timeout no handshake de chaves"));
			}, timeout);

			const done = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				err ? reject(err) : resolve(this);
			};

			connect(this.server, this.proxy, (err, socket) => {
				if (err) return done(new Error(`conexão falhou: ${err.message}`));

				this.socket = socket;
				socket.on("data", (data) => this.#onData(data));
				socket.on("close", () => this.#onClose(new Error("socket fechado pelo servidor")));
				socket.on("error", (e) => this.#onClose(e));
				this.once("keys", () => done(null));
			});
		});
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.socket?.destroy();
		this.emit("close", new Error("fechado localmente"));
	}

	#onClose(err) {
		if (this.closed) return;
		this.closed = true;
		this.socket?.destroy();
		this.emit("close", err);
	}

	// -------------------------------------------------------------------------
	// Cripto — idêntica ao lado cliente de classes/ProTankiClient.js
	// -------------------------------------------------------------------------

	#setCryptKeys(keys) {
		let base = 0;
		for (const k of keys) base ^= k;
		for (let i = 0; i < this.encryptionLenght; i++) {
			this.encrypt_keys[i] = base ^ (i << 3) ^ 87;
			this.decrypt_keys[i] = base ^ (i << 3);
		}
		this.keysReady = true;
	}

	#decryptBody(body) {
		for (let i = 0; i < body.length; i++) {
			const b = body.readInt8(i);
			this.decrypt_keys[this.decrypt_position] = b ^ this.decrypt_keys[this.decrypt_position];
			body[i] = this.decrypt_keys[this.decrypt_position];
			this.decrypt_position ^= this.decrypt_keys[this.decrypt_position] & 7;
		}
	}

	#encryptBody(body) {
		for (let i = 0; i < body.length; i++) {
			const b = body.readInt8(i);
			body[i] = b ^ this.encrypt_keys[this.encrypt_position];
			this.encrypt_keys[this.encrypt_position] = b;
			this.encrypt_position ^= b & 7;
		}
	}

	// -------------------------------------------------------------------------
	// Framing
	// -------------------------------------------------------------------------

	#onData(data) {
		this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

		while (this.recvBuffer.length >= 4) {
			const rawLen = this.recvBuffer.readInt32BE(0);
			const lenFlags = rawLen & 0xc0000000;
			const bodyLen = (rawLen & 0x3fffffff) - 4;

			if (bodyLen < 0) {
				this.#onClose(new Error(`quadro inválido (len ${rawLen})`));
				return;
			}
			if (this.recvBuffer.length - 4 < bodyLen) break; // pacote partido entre segmentos

			const frame = Buffer.from(this.recvBuffer.subarray(4, 4 + bodyLen));
			this.recvBuffer = this.recvBuffer.subarray(4 + bodyLen);
			try {
				this.#handleFrame(frame, lenFlags);
			} catch (e) {
				console.warn(`${this.tag} erro tratando pacote: ${e.message}`);
			}
		}
	}

	#handleFrame(frame, lenFlags) {
		const id = frame.readInt32BE(0);
		let body = Buffer.from(frame.subarray(4));

		// O pacote de chaves é o único que chega em claro — ele É a troca de chaves.
		if (id === P.Protection) {
			const keys = [];
			let off = 0;
			let len = body.readInt32BE(off);
			off += 4;
			while (len-- > 0) keys.push(body.readInt8(off++));
			this.#setCryptKeys(keys);
			this.emit("keys", keys);
			return;
		}

		this.#decryptBody(body);
		if (lenFlags & FLAG_DEFLATE) body = zlib.inflateRawSync(body);

		const name = nameOf(id);
		const fields = parse(id, body) ?? {};
		const pkt = { seq: ++this.seq, id, name, fields, body };

		this.recent.push(pkt);
		if (this.recent.length > RECENT_MAX) this.recent.shift();

		this.#autoReply(pkt);

		if (this.verbose) console.log(`${this.tag} ← ${name}`);
		this.emit("packet", pkt);
	}

	/** Respostas obrigatórias de manutenção — ver nota (1) no topo do arquivo. */
	#autoReply({ id, fields }) {
		switch (id) {
			case P.Ping:
				this.send(P.Pong);
				break;
			case P.TimeChecker:
				this.send(P.TimeCheckerResponse, {
					clientTime: (Date.now() - this.startedAt) | 0,
					serverTime: fields.value1 | 0,
				});
				break;
			case P.LoadDependencies:
				// Nada é baixado: o bot não renderiza nada, só precisa destravar o servidor.
				this.send(P.ResourceCallback, { callbackId: fields.callbackId });
				break;
			default:
				break;
		}
	}

	// -------------------------------------------------------------------------
	// Envio
	// -------------------------------------------------------------------------

	/** Monta o corpo pelo schema da lib, cifra e enquadra. */
	send(id, fields = null) {
		if (this.closed || !this.socket) return false;

		// Corpo novo a cada envio: a cifra é in-place, reaproveitar Buffer manda lixo.
		const body = fields === null ? Buffer.alloc(0) : encodeBody(id, fields);
		this.#encryptBody(body);

		const out = new BufferWriter()
			.writeInt32BE(body.length + 8)
			.writeInt32BE(id)
			.writeBuffer(body)
			.getBuffer();

		this.socket.write(out);
		if (this.verbose) console.log(`${this.tag} → ${nameOf(id)}`);
		return true;
	}

	// -------------------------------------------------------------------------
	// Espera
	// -------------------------------------------------------------------------

	/**
	 * Espera um pacote. `match` é um id ou um predicado (pkt) => bool.
	 * `since`: marcador de `client.seq` obtido ANTES da ação que dispara a resposta —
	 * pacotes já recebidos depois dele contam (ver nota (2) no topo).
	 */
	waitFor(match, { timeout = 20000, since = null, label = null } = {}) {
		const test = typeof match === "function" ? match : (p) => p.id === match;
		const what = label || (typeof match === "function" ? "pacote" : nameOf(match));

		if (since !== null) {
			const hit = this.recent.find((p) => p.seq > since && test(p));
			if (hit) return Promise.resolve(hit);
		}
		if (this.closed) {
			return Promise.reject(new Error(`desconectado esperando ${what}`));
		}

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.off("packet", onPacket);
				this.off("close", onClose);
			};
			const onPacket = (p) => {
				if (!test(p)) return;
				cleanup();
				resolve(p);
			};
			const onClose = (err) => {
				cleanup();
				reject(new Error(`desconectado esperando ${what}: ${err?.message ?? "?"}`));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`timeout (${timeout}ms) esperando ${what}`));
			}, timeout);

			this.on("packet", onPacket);
			this.on("close", onClose);
		});
	}

	// -------------------------------------------------------------------------
	// Login
	// -------------------------------------------------------------------------

	/**
	 * Faz login por usuário/senha e resolve com os dados do lobby (LobbyData).
	 * O client Flash só mostra o formulário depois do HideLoader — esperamos o mesmo
	 * sinal para não mandar Login antes de o servidor estar pronto para recebê-lo.
	 */
	async login(username, password, { timeout = 45000 } = {}) {
		this.send(P.Language, { lang: "pt_BR" });

		// `since: 0` (e não o seq atual): o HideLoader é um evento único da conexão e pode
		// já ter chegado antes daqui — esperar "a partir de agora" trava até o timeout.
		await this.waitFor(P.HideLoader, { since: 0, timeout, label: "HideLoader" }).catch(() => null);

		const loginMark = this.seq;
		this.send(P.Login, { username, password, rememberMe: false });

		const res = await this.waitFor(
			(p) =>
				p.id === P.LobbyData ||
				p.id === P.IncorrectPassword ||
				p.id === P.Captcha ||
				p.id === P.Punishment,
			{ since: loginMark, timeout, label: "resposta do login" }
		);

		if (res.id === P.IncorrectPassword) throw new Error(`login recusado (usuário/senha) para "${username}"`);
		if (res.id === P.Captcha) throw new Error(`servidor pediu captcha no login de "${username}"`);
		if (res.id === P.Punishment) throw new Error(`conta "${username}" punida: ${res.fields.reason ?? "?"}`);

		return res.fields; // { nickname, rank, crystals, ... }
	}
}

module.exports = { BotClient, P, LAYOUT, nameOf };
