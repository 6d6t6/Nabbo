import "../../../lib/nostr.bundle.js"

function json(res, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  })
}

function bad(status, message) {
  return json(null, status, { ok: false, error: message })
}

function requireTools() {
  const tools = globalThis.NostrTools
  if (!tools) throw new Error("NostrTools not available")
  const { finishEvent, getPublicKey, SimplePool, nip98 } = tools
  if (!finishEvent || !getPublicKey || !SimplePool || !nip98) throw new Error("NostrTools missing finishEvent/getPublicKey/SimplePool/nip98")
  return tools
}

function getRelays(env) {
  const raw = String(env?.RELAYS || "").trim()
  if (raw) {
    const parsed = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parsed.length) return parsed
  }
  return [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net"
  ]
}

function hexFromEnv(env, key) {
  const v = (env?.[key] || "").trim()
  if (!/^[0-9a-f]{64}$/i.test(v)) return null
  return v.toLowerCase()
}

function randomHex(bytesLen) {
  const b = new Uint8Array(bytesLen)
  crypto.getRandomValues(b)
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}

async function requireAuthPubkey({ request, tools }) {
  const auth = request.headers.get("authorization") || request.headers.get("Authorization")
  if (!auth) return { ok: false, status: 401, error: "missing authorization" }

  try {
    const method = request.method
    const url = request.url
    await tools.nip98.validateToken(auth, url, method)
    const ev = await tools.nip98.unpackEventFromToken(auth)
    const pubkey = String(ev?.pubkey || "").trim()
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) return { ok: false, status: 401, error: "invalid authorization" }
    return { ok: true, pubkey }
  } catch {
    return { ok: false, status: 401, error: "invalid authorization" }
  }
}

export async function onRequestPost({ request, env }) {
  const tools = requireTools()

  const auth = await requireAuthPubkey({ request, tools })
  if (!auth.ok) return bad(auth.status, auth.error)

  let body
  try {
    body = await request.json()
  } catch {
    return bad(400, "invalid json")
  }

  const issuerSk = hexFromEnv(env, "ISSUER_SK")
  if (!issuerSk) return bad(500, "issuer key not configured")

  const trade = body?.trade
  if (!trade || typeof trade !== "object") return bad(400, "missing trade")

  const tradeIdRaw = String(trade.tradeId || "").trim()
  const tradeId = tradeIdRaw || randomHex(16)

  const createdAt = Math.floor(Date.now() / 1000)
  const issuerPubkey = tools.getPublicKey(issuerSk)

  const contentObj = {
    type: "nabbo_econ_finalize",
    tradeId,
    trade,
    ts: createdAt
  }

  const eventTemplate = {
    kind: 1,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["op", "finalize"],
      ["trade", tradeId],
      ["issuer", issuerPubkey]
    ],
    content: JSON.stringify(contentObj),
    pubkey: issuerPubkey
  }

  let signed
  try {
    signed = tools.finishEvent(eventTemplate, issuerSk)
  } catch {
    return bad(500, "failed to sign")
  }

  const relays = getRelays(env)
  let publishOk = 0
  let publishFail = 0
  try {
    const pool = new tools.SimplePool()
    const pubs = pool.publish(relays, signed)
    const results = await Promise.allSettled(pubs)
    for (const r of results) {
      if (r.status === "fulfilled") publishOk += 1
      else publishFail += 1
    }
  } catch {
    publishFail = relays.length
  }

  return json(null, 200, { ok: true, event: signed, relays, publish: { ok: publishOk, fail: publishFail } })
}
