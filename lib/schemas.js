"use strict";

// Esquemas vêm SEMPRE do protanki-protocol (defs do ProTanki oficial). Este módulo só adapta
// o decode da lib para "campos ou null", sem nunca lançar — um parse é só leitura.
const proto = require("protanki-protocol");

/** Decodifica o corpo de um pacote pelo esquema da lib. null se não há esquema. */
function parse(packetId, body) {
	const def = proto.defById(Number(packetId));
	if (!def || !def.schema || def.schema.length === 0) return null;
	const out = {};
	try {
		const { result, bytesRead } = proto.decodeSchema(def.schema, body);
		Object.assign(out, result);
		out.__remaining = body.length - bytesRead;
	} catch (e) {
		out.__parseError = e.message;
	}
	return out;
}

module.exports = { parse };
