const net = require("node:net");

// Opens a TCP connection to `target` {host, port}, optionally tunneled through
// `proxy` {type, host, port, username?, password?} (type "socks5" or "http").
// Calls cb(err, socket). On success the socket is a clean tunnel to `target`:
// any bytes the destination already sent during the handshake are re-emitted via
// a 'data' event right after cb runs, so the caller can attach its own 'data'
// handler synchronously inside cb without losing the first packet.
function connect(target, proxy, cb) {
	if (!proxy) {
		const socket = net.createConnection({ host: target.host, port: target.port });
		const onErr = (e) => { socket.removeListener("connect", onConn); cb(e); };
		const onConn = () => { socket.removeListener("error", onErr); cb(null, socket); };
		socket.once("error", onErr);
		socket.once("connect", onConn);
		return socket;
	}

	const type = (proxy.type || "socks5").toLowerCase();
	const socket = net.createConnection({ host: proxy.host, port: proxy.port });
	const earlyErr = (e) => cb(new Error(`proxy connect (${proxy.host}:${proxy.port}): ${e.message}`));
	socket.once("error", earlyErr);
	socket.once("connect", () => {
		socket.removeListener("error", earlyErr);
		if (type === "http" || type === "connect") httpHandshake(socket, target, proxy, cb);
		else socks5Handshake(socket, target, proxy, cb);
	});
	return socket;
}

// Shared settle/leftover plumbing for a handshake.
function finisher(socket, onData, cb) {
	let settled = false;
	return {
		done(leftover) {
			if (settled) return;
			settled = true;
			socket.removeListener("data", onData);
			cb(null, socket);
			if (leftover && leftover.length) socket.emit("data", leftover);
		},
		fail(msg) {
			if (settled) return;
			settled = true;
			socket.removeListener("data", onData);
			socket.destroy();
			cb(new Error(msg));
		},
	};
}

function socks5Handshake(socket, target, proxy, cb) {
	const useAuth = !!proxy.username;
	let stage = "greeting";
	let buf = Buffer.alloc(0);

	const onData = (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (stage === "greeting") {
				if (buf.length < 2) return;
				const method = buf[1];
				buf = buf.subarray(2);
				if (method === 0x00) {
					sendConnect();
					stage = "reply";
				} else if (method === 0x02) {
					if (!useAuth) return fail("SOCKS5: proxy wants auth but no credentials configured");
					const u = Buffer.from(proxy.username);
					const p = Buffer.from(proxy.password || "");
					socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
					stage = "auth";
				} else {
					return fail(`SOCKS5: proxy rejected auth methods (0x${method.toString(16)})`);
				}
			} else if (stage === "auth") {
				if (buf.length < 2) return;
				const status = buf[1];
				buf = buf.subarray(2);
				if (status !== 0x00) return fail("SOCKS5: authentication failed");
				sendConnect();
				stage = "reply";
			} else if (stage === "reply") {
				if (buf.length < 4) return;
				const rep = buf[1];
				const atyp = buf[3];
				let addrLen;
				if (atyp === 0x01) addrLen = 4;
				else if (atyp === 0x04) addrLen = 16;
				else if (atyp === 0x03) {
					if (buf.length < 5) return;
					addrLen = 1 + buf[4];
				} else return fail(`SOCKS5: unknown address type 0x${atyp.toString(16)}`);

				const total = 4 + addrLen + 2;
				if (buf.length < total) return;
				if (rep !== 0x00) return fail(`SOCKS5: connect failed (reply 0x${rep.toString(16)})`);
				return done(buf.subarray(total));
			}
		}
	};

	function sendConnect() {
		const host = target.host;
		const portBuf = Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]);
		let req;
		if (net.isIPv4(host)) {
			const octets = host.split(".").map(Number);
			req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets]), portBuf]);
		} else {
			const h = Buffer.from(host);
			req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, portBuf]);
		}
		socket.write(req);
	}

	const { done, fail } = finisher(socket, onData, cb);
	socket.on("data", onData);
	// send the greeting last, after handlers are wired
	socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
}

function httpHandshake(socket, target, proxy, cb) {
	let buf = Buffer.alloc(0);

	const onData = (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		const idx = buf.indexOf("\r\n\r\n");
		if (idx === -1) return;
		const statusLine = buf.subarray(0, idx).toString("utf8").split("\r\n")[0];
		const code = parseInt(statusLine.split(/\s+/)[1], 10);
		if (code !== 200) return fail(`HTTP proxy CONNECT failed: ${statusLine}`);
		return done(buf.subarray(idx + 4));
	};

	const { done, fail } = finisher(socket, onData, cb);
	socket.on("data", onData);

	let head =
		`CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
		`Host: ${target.host}:${target.port}\r\n`;
	if (proxy.username) {
		const auth = Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64");
		head += `Proxy-Authorization: Basic ${auth}\r\n`;
	}
	head += "\r\n";
	socket.write(head);
}

module.exports = { connect };
