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
  const { finishEvent, getPublicKey, SimplePool, nip98, verifySignature } = tools
  if (!finishEvent || !getPublicKey || !SimplePool || !nip98 || !verifySignature) throw new Error("NostrTools missing finishEvent/getPublicKey/SimplePool/nip98/verifySignature")
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

const PRICES = {
  chair_basic: 10,
  table_basic: 25,
  plant_basic: 15
}

function getPrice(defId) {
  const p = PRICES[String(defId || "")]
  return typeof p === "number" && isFinite(p) && p >= 0 ? p : null
}

function parseBalanceFromEvent(ev) {
  if (!ev || typeof ev !== "object") return null
  if (ev.kind !== 30078) return null
  if (!Array.isArray(ev.tags)) return null
  const d = ev.tags.find((t) => t?.[0] === "d")?.[1]
  if (d !== "coins") return null
  let obj
  try {
    obj = JSON.parse(ev.content || "{}")
  } catch {
    return null
  }
  if (obj?.type !== "nabbo_econ_balance") return null
  if (typeof obj.balance !== "number") return null
  if (!obj.pubkey || typeof obj.pubkey !== "string") return null
  return { pubkey: obj.pubkey, balance: obj.balance }
}

function makeBalanceEvent({ tools, issuerSk, issuerPubkey, toPubkey, balance, createdAt }) {
  const contentObj = {
    type: "nabbo_econ_balance",
    pubkey: toPubkey,
    balance,
    ts: createdAt
  }

  const eventTemplate = {
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["t", "nabbo-coins"],
      ["p", toPubkey],
      ["d", "coins"],
      ["issuer", issuerPubkey]
    ],
    content: JSON.stringify(contentObj),
    pubkey: issuerPubkey
  }

  return tools.finishEvent(eventTemplate, issuerSk)
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
  } catch (e) {
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

  const toPubkey = (body?.toPubkey || "").trim()
  const defId = (body?.defId || "").trim()
  const balanceEvent = body?.balanceEvent

  if (!/^[0-9a-f]{64}$/i.test(toPubkey)) return bad(400, "invalid toPubkey")
  if (!defId) return bad(400, "missing defId")

  const price = getPrice(defId)
  if (price === null) return bad(400, "unknown item")

  if (toPubkey.toLowerCase() !== auth.pubkey.toLowerCase()) {
    return bad(403, "toPubkey must match authenticated pubkey")
  }

  const issuerSk = hexFromEnv(env, "ISSUER_SK")
  if (!issuerSk) return bad(500, "issuer key not configured")

  const instanceId = randomHex(16)
  const createdAt = Math.floor(Date.now() / 1000)
  const issuerPubkey = tools.getPublicKey(issuerSk)

  if (!balanceEvent || typeof balanceEvent !== "object") {
    return bad(400, "missing balanceEvent")
  }

  const parsedBal = parseBalanceFromEvent(balanceEvent)
  if (!parsedBal) return bad(400, "invalid balanceEvent")
  if (parsedBal.pubkey.toLowerCase() !== toPubkey.toLowerCase()) return bad(400, "balanceEvent pubkey mismatch")
  if (String(balanceEvent.pubkey || "").toLowerCase() !== issuerPubkey.toLowerCase()) return bad(400, "balanceEvent issuer mismatch")
  if (!tools.verifySignature(balanceEvent)) return bad(400, "balanceEvent signature invalid")

  const currentBalance = parsedBal.balance
  if (!Number.isFinite(currentBalance) || currentBalance < 0) return bad(400, "invalid balance")
  if (currentBalance < price) return bad(402, "insufficient coins")
  const newBalance = currentBalance - price

  const contentObj = {
    type: "nabbo_econ_mint",
    instanceId,
    defId,
    toPubkey,
    price,
    ts: createdAt
  }

  const eventTemplate = {
    kind: 1,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["t", "nabbo-item"],
      ["op", "mint"],
      ["p", toPubkey],
      ["d", instanceId],
      ["def", defId],
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

  let balanceSigned
  try {
    balanceSigned = makeBalanceEvent({ tools, issuerSk, issuerPubkey, toPubkey, balance: newBalance, createdAt })
  } catch {
    return bad(500, "failed to sign balance")
  }

  const relays = getRelays(env)
  let publishOk = 0
  let publishFail = 0
  try {
    const pool = new tools.SimplePool()
    const pubs = [...pool.publish(relays, signed), ...pool.publish(relays, balanceSigned)]
    const results = await Promise.allSettled(pubs)
    for (const r of results) {
      if (r.status === "fulfilled") publishOk += 1
      else publishFail += 1
    }
  } catch {
    publishFail = relays.length
  }

  return json(null, 200, {
    ok: true,
    event: signed,
    balanceEvent: balanceSigned,
    relays,
    publish: { ok: publishOk, fail: publishFail },
    balance: { before: currentBalance, after: newBalance, price }
  })
}
