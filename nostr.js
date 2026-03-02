const {
  generatePrivateKey,
  getPublicKey,
  finishEvent,
  SimplePool
} = globalThis.NostrTools ?? {}

if (!generatePrivateKey || !getPublicKey || !finishEvent || !SimplePool) {
  throw new Error(
    "NostrTools bundle not found. Ensure lib/nostr.bundle.js is loaded before nostr.js/app.js."
  )
}

let sk
let pk
let usingExtension = false

const relays = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net"
]
const pool = new SimplePool()

export async function initNostr() {

  // EXTENSION MODE
  if (window.nostr) {
    usingExtension = true
    pk = await window.nostr.getPublicKey()
    console.log("Using extension:", pk)
    return
  }

  // LOCAL KEY MODE
  sk = localStorage.getItem("nostr_sk")

  if (!sk) {
    sk = generatePrivateKey()
    localStorage.setItem("nostr_sk", sk)
  }

  pk = getPublicKey(sk)

  console.log("Generated local key:", pk)
}

export async function publish(kind, content, tags = []) {

  const eventTemplate = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey: pk
  }

  let event

  if (usingExtension) {
    event = await window.nostr.signEvent(eventTemplate)
  } else {
    event = finishEvent(eventTemplate, sk)
  }

  const pubs = pool.publish(relays, event)
  await Promise.allSettled(pubs)
}

export function subscribe(filters, onEvent) {

  const sub = pool.sub(
    relays,
    [filters],
    {}
  )

  sub.on("event", (event) => {
    onEvent(event)
  })

  return sub
}

export function getPubkey() {
  return pk
}