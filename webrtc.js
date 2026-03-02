const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function createSessionId() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function createRoomId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function roomIdToCode(roomId) {
  return roomId.slice(0, 4).toUpperCase() + "-" + roomId.slice(4, 8).toUpperCase()
}

export class NabboNet {
  constructor({ publish, subscribe, myPubkey, roomId, ownerPubkey, isHost, onMessage, onPeerState }) {
    this.publish = publish
    this.subscribe = subscribe
    this.myPubkey = myPubkey
    this.roomId = roomId
    this.ownerPubkey = ownerPubkey
    this.isHost = isHost
    this.onMessage = onMessage
    this.onPeerState = onPeerState

    this.peers = new Map()
    this.dataChannels = new Map()
    this.signalSub = null

    this._seenSignalEventIds = new Set()

    this._signalSince = nowSec() - 5

    this.sessionId = createSessionId()
    this.peerSessions = new Map()
  }

  _cleanupPeer(peerPubkey, finalState) {
    const pc = this.peers.get(peerPubkey)
    if (pc) {
      try {
        pc.onicecandidate = null
        pc.onconnectionstatechange = null
        pc.ondatachannel = null
        pc.close()
      } catch {}
    }

    this.peers.delete(peerPubkey)
    this.dataChannels.delete(peerPubkey)
    this.onPeerState?.(peerPubkey, finalState)
  }

  _log(...args) {
    console.log("[NabboNet]", ...args)
  }

  async start() {
    this._log("start", { roomId: this.roomId, isHost: this.isHost, my: this.myPubkey.slice(0, 8), owner: this.ownerPubkey?.slice?.(0, 8) })

    const signalTag = `nabbo-signal:${this.roomId}`
    this.signalSub = this.subscribe(
      {
        kinds: [1],
        "#t": [signalTag],
        since: this._signalSince
      },
      (event) => this._onSignalEvent(event)
    )

    if (!this.isHost) {
      this._log("send join")
      await this._sendSignal({ type: "join", sessionId: this.sessionId })
    }
  }

  stop() {
    try {
      this.signalSub?.unsub?.()
    } catch {}

    for (const peerPubkey of Array.from(this.peers.keys())) {
      this._cleanupPeer(peerPubkey, "closed")
    }
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload)
    if (this.isHost) {
      for (const ch of this.dataChannels.values()) {
        if (ch.readyState === "open") ch.send(msg)
      }
    } else {
      const ch = this.dataChannels.get(this.ownerPubkey)
      if (ch?.readyState === "open") ch.send(msg)
    }
  }

  sendTo(peerPubkey, payload) {
    const msg = JSON.stringify(payload)
    if (this.isHost) {
      const ch = this.dataChannels.get(peerPubkey)
      if (ch?.readyState === "open") ch.send(msg)
      return
    }

    if (peerPubkey !== this.ownerPubkey) return
    const ch = this.dataChannels.get(this.ownerPubkey)
    if (ch?.readyState === "open") ch.send(msg)
  }

  async _sendSignal(payload, toPubkey) {
    const to = toPubkey ?? (this.isHost ? payload.to : this.ownerPubkey)

    if (payload.type === "offer" || payload.type === "answer") {
      const sdpLen = JSON.stringify(payload.sdp || {}).length
      this._log("signal send", payload.type, { to: to?.slice?.(0, 8), sdpLen })
    } else {
      this._log("signal send", payload.type, { to: to?.slice?.(0, 8) })
    }

    const content = JSON.stringify({
      ...payload,
      roomId: this.roomId,
      from: this.myPubkey,
      to,
      ts: nowSec()
    })

    const tags = [
      ["t", `nabbo-signal:${this.roomId}`]
    ]

    if (to) tags.push(["p", to])

    await this.publish(1, content, tags)
  }

  async _onSignalEvent(event) {
    if (event?.id) {
      if (this._seenSignalEventIds.has(event.id)) return
      this._seenSignalEventIds.add(event.id)
      if (this._seenSignalEventIds.size > 2000) {
        this._seenSignalEventIds.clear()
      }
    }

    const msg = safeJsonParse(event.content)
    if (!msg) return

    if (msg.roomId !== this.roomId) return

    if (msg.to && msg.to !== this.myPubkey) return

    if (msg.from === this.myPubkey) return

    this._log("signal recv", msg.type, { from: msg.from?.slice?.(0, 8), to: msg.to?.slice?.(0, 8) })

    if (!msg.sessionId || typeof msg.sessionId !== "string") {
      return
    }

    const msgTs = typeof msg.ts === "number" ? msg.ts : 0
    if (msgTs && msgTs < this._signalSince) {
      return
    }

    if (this.isHost) {
      if (msg.type === "join") {
        const prev = this.peerSessions.get(msg.from)
        if (prev?.sessionId === msg.sessionId && this.peers.has(msg.from)) {
          this._log("host ignore join (same session)", msg.from?.slice?.(0, 8))
          return
        }

        if (prev?.ts && msgTs && msgTs < prev.ts) {
          this._log("host ignore join (stale)", msg.from?.slice?.(0, 8))
          return
        }

        this.peerSessions.set(msg.from, { sessionId: msg.sessionId, ts: msgTs || nowSec() })
        await this._hostCreatePeer(msg.from, msg.sessionId)
      } else if (msg.type === "answer") {
        const expected = this.peerSessions.get(msg.from)
        if (expected?.sessionId !== msg.sessionId) return
        if (expected?.ts && msgTs && msgTs < expected.ts) return
        await this._hostOnAnswer(msg)
      } else if (msg.type === "ice") {
        const expected = this.peerSessions.get(msg.from)
        if (expected?.sessionId !== msg.sessionId) return
        if (expected?.ts && msgTs && msgTs < expected.ts) return
        await this._onIce(msg)
      }
    } else {
      if (msg.type === "offer") {
        if (msg.from !== this.ownerPubkey) return
        if (msg.to !== this.myPubkey) return
        if (msg.sessionId !== this.sessionId) {
          this._log("client ignore offer (session)", msg.sessionId)
          return
        }
        await this._clientOnOffer(msg)
      } else if (msg.type === "ice") {
        if (msg.from !== this.ownerPubkey) return
        if (msg.sessionId !== this.sessionId) return
        await this._onIce(msg)
      }
    }
  }

  async _hostCreatePeer(peerPubkey, sessionId) {
    const existing = this.peers.get(peerPubkey)
    if (existing) {
      this._cleanupPeer(peerPubkey, "closed")
    }

    this._log("host create peer", peerPubkey.slice(0, 8))

    const pc = new RTCPeerConnection(rtcConfig)
    this.peers.set(peerPubkey, pc)
    this.onPeerState?.(peerPubkey, "connecting")

    pc.onicecandidate = async (ev) => {
      if (!ev.candidate) return
      await this._sendSignal({ type: "ice", candidate: ev.candidate, to: peerPubkey, sessionId })
    }

    pc.onconnectionstatechange = () => {
      this._log("host pc state", peerPubkey.slice(0, 8), pc.connectionState)
      this.onPeerState?.(peerPubkey, pc.connectionState)

      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this._cleanupPeer(peerPubkey, pc.connectionState)
      }
    }

    const ch = pc.createDataChannel("nabbo")
    this._attachDataChannel(peerPubkey, ch)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    await this._sendSignal({ type: "offer", sdp: pc.localDescription, to: peerPubkey, sessionId })
  }

  async _hostOnAnswer(msg) {
    const pc = this.peers.get(msg.from)
    if (!pc) return

    if (!msg.sdp) return

    if (pc.signalingState !== "have-local-offer") {
      this._log("host ignore answer (state)", msg.from?.slice?.(0, 8), pc.signalingState)
      return
    }

    if (pc.currentRemoteDescription) {
      this._log("host ignore answer (already set)", msg.from?.slice?.(0, 8))
      return
    }

    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
  }

  async _clientOnOffer(msg) {
    if (msg.from !== this.ownerPubkey) return

    if (this.peers.has(this.ownerPubkey)) return

    const pc = new RTCPeerConnection(rtcConfig)
    this.peers.set(this.ownerPubkey, pc)
    this.onPeerState?.(this.ownerPubkey, "connecting")

    pc.onicecandidate = async (ev) => {
      if (!ev.candidate) return
      await this._sendSignal({ type: "ice", candidate: ev.candidate, sessionId: this.sessionId })
    }

    pc.onconnectionstatechange = () => {
      this._log("client pc state", pc.connectionState)
      this.onPeerState?.(this.ownerPubkey, pc.connectionState)

      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this._cleanupPeer(this.ownerPubkey, pc.connectionState)
      }
    }

    pc.ondatachannel = (ev) => {
      this._attachDataChannel(this.ownerPubkey, ev.channel)
    }

    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    await this._sendSignal({ type: "answer", sdp: pc.localDescription, sessionId: this.sessionId })
  }

  async _onIce(msg) {
    const peer = this.isHost ? msg.from : this.ownerPubkey
    const pc = this.peers.get(peer)
    if (!pc) return

    if (!msg.candidate) return

    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
    } catch {}
  }

  _attachDataChannel(peerPubkey, ch) {
    this.dataChannels.set(peerPubkey, ch)

    ch.onopen = () => {
      this.onPeerState?.(peerPubkey, "open")
    }

    ch.onclose = () => {
      this.onPeerState?.(peerPubkey, "closed")
      this.dataChannels.delete(peerPubkey)
    }

    ch.onmessage = (ev) => {
      const msg = safeJsonParse(ev.data)
      if (!msg) return
      this.onMessage?.(peerPubkey, msg)
    }
  }
}
