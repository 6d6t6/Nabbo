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

const PRICES = {
  chair_basic: 10,
  table_basic: 25,
  plant_basic: 15
}

function getPrice(defId) {
  const p = PRICES[String(defId || "")]
  return typeof p === "number" && isFinite(p) && p >= 0 ? p : null
}

function startOfUtcDay(tsSeconds) {
  const ms = tsSeconds * 1000
  const d = new Date(ms)
  d.setUTCHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function getTag(ev, key) {
  if (!ev?.tags || !Array.isArray(ev.tags)) return null
  return ev.tags.find((t) => t?.[0] === key)?.[1] || null
}

async function computeBalance({ tools, relays, issuerPubkey, toPubkey, dailyAmount, now }) {
  const mkPool = () => new tools.SimplePool({ getTimeout: 1800, eoseSubTimeout: 1800 })

  const withTimeout = async (p, ms) => {
    let t
    try {
      return await Promise.race([
        p,
        new Promise((_, rej) => {
          t = setTimeout(() => rej(new Error("timeout")), ms)
        })
      ])
    } finally {
      if (t) clearTimeout(t)
    }
  }

  const since = 0
  const pool = mkPool()
  const [claims, mints] = await withTimeout(
    Promise.all([
      pool.list(relays, [
        {
          kinds: [30079],
          authors: [issuerPubkey],
          "#t": ["nabbo-claim"],
          "#p": [toPubkey],
          since,
          limit: 5000
        }
      ]),
      pool.list(relays, [
        {
          kinds: [1],
          authors: [issuerPubkey],
          "#t": ["nabbo-item"],
          "#p": [toPubkey],
          since,
          limit: 5000
        }
      ])
    ]),
    3200
  )

  const claimDays = new Set()
  for (const ev of claims || []) {
    const d = getTag(ev, "d")
    if (d && d.startsWith(`claim:${toPubkey}:`)) claimDays.add(d)
  }
  const earned = claimDays.size * dailyAmount

  let spent = 0
  for (const ev of mints || []) {
    if (getTag(ev, "op") !== "mint") continue
    const defId = getTag(ev, "def")
    const price = getPrice(defId)
    if (price != null) spent += price
  }

  const balance = Math.max(0, earned - spent)
  return {
    balance,
    earned,
    spent,
    claims: claimDays.size,
    asOf: typeof now === "number" ? now : Math.floor(Date.now() / 1000)
  }
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

  const relays = getRelays(env)
  const dailyAmount = 100
  let current
  try {
    current = await computeBalance({ tools, relays, issuerPubkey, toPubkey, dailyAmount, now: createdAt })
  } catch {
    return bad(503, "relays unavailable")
  }

  if (typeof current?.balance !== "number") return bad(503, "balance unavailable")
  if (current.balance < price) return bad(402, "insufficient coins")

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

  if (publishOk === 0) return bad(503, "failed to publish mint")

  let after
  try {
    after = await computeBalance({ tools, relays, issuerPubkey, toPubkey, dailyAmount, now: createdAt })
  } catch {
    after = null
  }

  return json(null, 200, {
    ok: true,
    event: signed,
    relays,
    publish: { ok: publishOk, fail: publishFail },
    balance: {
      before: current?.balance ?? null,
      after: after?.balance ?? null,
      price
    }
  })
}
