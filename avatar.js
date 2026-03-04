import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'

function colorFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0xffffff
}

function normalizeAppearance(app) {
  const a = app && typeof app === "object" ? app : {}
  return {
    skin: String(a.skin || "peach"),
    hair: String(a.hair || "brown_short"),
    top: String(a.top || "tee_blue"),
    bottom: String(a.bottom || "pants_gray"),
    face: String(a.face || "smile")
  }
}

const faceTextureCache = new Map()

function makeFaceTexture(faceId) {
  const key = String(faceId || "smile")
  if (faceTextureCache.has(key)) return faceTextureCache.get(key)

  const c = document.createElement("canvas")
  c.width = 32
  c.height = 32
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, 32, 32)

  const ink = "#111"
  ctx.fillStyle = ink

  // whites of eyes
  ctx.fillStyle = "#f7f7f7"
  ctx.fillRect(8, 10, 7, 6)
  ctx.fillRect(17, 10, 7, 6)

  // pupils
  ctx.fillStyle = ink
  ctx.fillRect(11, 12, 2, 2)
  ctx.fillRect(20, 12, 2, 2)

  // brows
  ctx.fillRect(9, 9, 5, 1)
  ctx.fillRect(18, 9, 5, 1)

  // mouths
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.lineCap = "round"
  if (key === "neutral") {
    ctx.beginPath()
    ctx.moveTo(11, 21)
    ctx.lineTo(21, 21)
    ctx.stroke()
  } else if (key === "sad") {
    ctx.beginPath()
    ctx.arc(16, 25, 7, Math.PI * 1.15, Math.PI * 1.85)
    ctx.stroke()
  } else if (key === "surprised") {
    ctx.beginPath()
    ctx.arc(16, 22, 4, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    // smile
    ctx.beginPath()
    ctx.arc(16, 19, 8, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
  }

  // subtle blush
  ctx.globalAlpha = 0.25
  ctx.fillStyle = "#d86a7a"
  ctx.fillRect(6, 18, 4, 3)
  ctx.fillRect(22, 18, 4, 3)
  ctx.globalAlpha = 1

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  faceTextureCache.set(key, tex)
  return tex
}

export function quantizeYawTo8(yaw) {
  const step = (Math.PI * 2) / 8
  const n = Math.round(yaw / step)
  return n * step
}

function colorForAppearanceKey(key) {
  const map = {
    peach: 0xf2c6a0,
    tan: 0xd6a17a,
    brown: 0xa26c4a,
    dark: 0x6b3f2a,

    none: 0x000000,
    black: 0x1b1b1b,
    brown_short: 0x5a3a24,
    blonde_short: 0xcaa46a,
    red_short: 0x9b3b2e,

    tee_blue: 0x3f6fff,
    tee_red: 0xd94a4a,
    hoodie_green: 0x2f8f4e,
    jacket_black: 0x1f1f1f,

    pants_gray: 0x6e6e7a,
    pants_blue: 0x3b57b6,
    shorts_black: 0x262626,
    skirt_pink: 0xc95e8f
  }
  return map[String(key || "")] ?? 0xffffff
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

function adjustHex(hex, mul) {
  const c = new THREE.Color(hex)
  c.r = clamp01(c.r * mul)
  c.g = clamp01(c.g * mul)
  c.b = clamp01(c.b * mul)
  return c.getHex()
}

function shadedMaterials(color) {
  const top = adjustHex(color, 1.08)
  const front = adjustHex(color, 1.02)
  const sideA = adjustHex(color, 0.90)
  const sideB = adjustHex(color, 0.86)
  const bottom = adjustHex(color, 0.82)

  return [
    new THREE.MeshBasicMaterial({ color: sideB }),
    new THREE.MeshBasicMaterial({ color: sideA }),
    new THREE.MeshBasicMaterial({ color: top }),
    new THREE.MeshBasicMaterial({ color: bottom }),
    new THREE.MeshBasicMaterial({ color: front }),
    new THREE.MeshBasicMaterial({ color: sideA })
  ]
}

function createPart(geo, color) {
  const mat = shadedMaterials(color)
  return new THREE.Mesh(geo, mat)
}

export function createAvatar(scene, pubkey) {
  const group = new THREE.Group()

  group.userData.pubkey = String(pubkey || "")

  const baseColor = pubkey ? colorFromString(pubkey) : Math.random() * 0xffffff
  group.userData.baseColor = baseColor

  const head = createPart(new THREE.BoxGeometry(0.60, 0.62, 0.58), 0xf2c6a0)
  head.position.y = 1.66

  const faceMat = new THREE.MeshBasicMaterial({ map: makeFaceTexture("smile"), transparent: true })
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.30), faceMat)
  face.position.set(0, 1.66, 0.30)

  const hair = createPart(new THREE.BoxGeometry(0.64, 0.26, 0.62), 0x5a3a24)
  hair.position.y = 1.90

  const torso = createPart(new THREE.BoxGeometry(0.78, 0.70, 0.50), baseColor)
  torso.position.y = 1.10

  const armL = createPart(new THREE.BoxGeometry(0.18, 0.52, 0.22), baseColor)
  armL.position.set(-0.50, 1.12, 0)

  const armR = createPart(new THREE.BoxGeometry(0.18, 0.52, 0.22), baseColor)
  armR.position.set(0.50, 1.12, 0)

  const handL = createPart(new THREE.BoxGeometry(0.18, 0.18, 0.22), 0xf2c6a0)
  handL.position.set(-0.50, 0.80, 0)

  const handR = createPart(new THREE.BoxGeometry(0.18, 0.18, 0.22), 0xf2c6a0)
  handR.position.set(0.50, 0.80, 0)

  const hips = createPart(new THREE.BoxGeometry(0.74, 0.28, 0.48), 0x6e6e7a)
  hips.position.y = 0.68

  const legs = createPart(new THREE.BoxGeometry(0.70, 0.62, 0.50), 0x6e6e7a)
  legs.position.y = 0.30

  const footL = createPart(new THREE.BoxGeometry(0.30, 0.14, 0.32), 0x1b1b1b)
  footL.position.set(-0.18, 0.02, 0.10)

  const footR = createPart(new THREE.BoxGeometry(0.30, 0.14, 0.32), 0x1b1b1b)
  footR.position.set(0.18, 0.02, 0.10)

  group.add(head)
  group.add(face)
  group.add(hair)
  group.add(torso)
  group.add(armL)
  group.add(armR)
  group.add(handL)
  group.add(handR)
  group.add(hips)
  group.add(legs)
  group.add(footL)
  group.add(footR)

  group.traverse((o) => {
    if (!o || typeof o !== "object") return
    o.userData = o.userData || {}
    o.userData.pubkey = String(pubkey || "")
  })

  group.userData.parts = { head, face, hair, torso, armL, armR, handL, handR, hips, legs, footL, footR }
  group.userData.pose = "stand"
  group.userData.poseYOffset = 0
  group.userData.appearance = normalizeAppearance(null)

  group.userData.restPose = {
    head: { pos: head.position.clone(), rot: head.rotation.clone() },
    face: { pos: face.position.clone(), rot: face.rotation.clone() },
    hair: { pos: hair.position.clone(), rot: hair.rotation.clone() },
    torso: { pos: torso.position.clone(), rot: torso.rotation.clone() },
    armL: { pos: armL.position.clone(), rot: armL.rotation.clone() },
    armR: { pos: armR.position.clone(), rot: armR.rotation.clone() },
    handL: { pos: handL.position.clone(), rot: handL.rotation.clone() },
    handR: { pos: handR.position.clone(), rot: handR.rotation.clone() },
    hips: { pos: hips.position.clone(), rot: hips.rotation.clone() },
    legs: { pos: legs.position.clone(), rot: legs.rotation.clone() },
    footL: { pos: footL.position.clone(), rot: footL.rotation.clone() },
    footR: { pos: footR.position.clone(), rot: footR.rotation.clone() }
  }

  group.position.y = 0
  scene.add(group)

  setAvatarAppearance(group, group.userData.appearance)

  return group
}

export function setAvatarPose(avatar, pose) {
  if (!avatar) return
  const p = pose === "sit" ? "sit" : "stand"
  avatar.userData.pose = p
  avatar.userData.poseYOffset = 0

  const parts = avatar.userData?.parts
  const rest = avatar.userData?.restPose
  if (!parts || !rest) return

  const reset = () => {
    for (const k of ["head", "face", "hair", "torso", "armL", "armR", "handL", "handR", "hips", "legs", "footL", "footR"]) {
      const part = parts[k]
      const r = rest[k]
      if (!part || !r) continue
      part.position.copy(r.pos)
      part.rotation.copy(r.rot)
    }
  }

  reset()

  if (p === "sit") {
    parts.torso.position.y = 1.05
    parts.hips.position.y = 0.72

    parts.legs.rotation.x = -Math.PI / 2
    parts.legs.position.y = 0.55
    parts.legs.position.z = 0.36

    if (parts.armL) {
      parts.armL.rotation.x = 0.10
      parts.armL.rotation.z = 0.12
      parts.armL.position.y = 1.02
      parts.armL.position.z = 0.06
    }
    if (parts.armR) {
      parts.armR.rotation.x = 0.10
      parts.armR.rotation.z = -0.12
      parts.armR.position.y = 1.02
      parts.armR.position.z = 0.06
    }
    if (parts.handL) {
      parts.handL.position.y = 0.74
      parts.handL.position.z = 0.08
    }
    if (parts.handR) {
      parts.handR.position.y = 0.74
      parts.handR.position.z = 0.08
    }
  }
}

export function setAvatarAppearance(avatar, appearance) {
  if (!avatar) return
  const app = normalizeAppearance(appearance)
  avatar.userData.appearance = app

  const parts = avatar.userData?.parts
  if (!parts) return

  const skinColor = colorForAppearanceKey(app.skin)
  if (parts.head?.material) {
    const mats = shadedMaterials(skinColor)
    parts.head.material = mats
  }
  if (parts.handL?.material) parts.handL.material = shadedMaterials(skinColor)
  if (parts.handR?.material) parts.handR.material = shadedMaterials(skinColor)

  if (parts.face?.material) {
    const t = makeFaceTexture(app.face)
    parts.face.material.map = t
    parts.face.material.needsUpdate = true
  }

  const hairKey = app.hair === "none" ? "none" : app.hair
  const hairColor = colorForAppearanceKey(hairKey)
  if (parts.hair?.material) {
    parts.hair.visible = hairKey !== "none"
    parts.hair.material = shadedMaterials(hairColor)
  }

  const topColor = colorForAppearanceKey(app.top)
  if (parts.torso?.material) parts.torso.material = shadedMaterials(topColor)
  if (parts.armL?.material) parts.armL.material = shadedMaterials(topColor)
  if (parts.armR?.material) parts.armR.material = shadedMaterials(topColor)

  const bottomColor = colorForAppearanceKey(app.bottom)
  if (parts.hips?.material) parts.hips.material = shadedMaterials(bottomColor)
  if (parts.legs?.material) parts.legs.material = shadedMaterials(bottomColor)

  const shoeColor = adjustHex(bottomColor, 0.45)
  if (parts.footL?.material) parts.footL.material = shadedMaterials(shoeColor)
  if (parts.footR?.material) parts.footR.material = shadedMaterials(shoeColor)
}

export function updateAvatarPosition(avatar, pos) {
  if (!avatar || !pos) return
  const baseY = typeof avatar?.userData?.poseYOffset === "number" ? avatar.userData.poseYOffset : 0
  const y = typeof pos.y === "number" && Number.isFinite(pos.y) ? pos.y + baseY : baseY
  avatar.position.set(pos.x, y, pos.z)
}
