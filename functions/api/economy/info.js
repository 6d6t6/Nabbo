import "../../../lib/nostr.bundle.js"

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  })
}

function bad(status, message) {
  return json(status, { ok: false, error: message })
}

function hexFromEnv(env, key) {
  const v = (env?.[key] || "").trim()
  if (!/^[0-9a-f]{64}$/i.test(v)) return null
  return v.toLowerCase()
}

export async function onRequestGet({ env }) {
  const tools = globalThis.NostrTools
  if (!tools?.getPublicKey) return bad(500, "NostrTools not available")

  const issuerSk = hexFromEnv(env, "ISSUER_SK")
  if (!issuerSk) return bad(500, "issuer key not configured")

  const issuerPubkey = tools.getPublicKey(issuerSk)
  return json(200, { ok: true, issuerPubkey })
}
