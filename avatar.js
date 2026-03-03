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
    bottom: String(a.bottom || "pants_gray")
  }
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

function createPart(geo, color) {
  const mat = new THREE.MeshBasicMaterial({ color })
  return new THREE.Mesh(geo, mat)
}

export function createAvatar(scene, pubkey) {
  const group = new THREE.Group()

  const baseColor = pubkey ? colorFromString(pubkey) : Math.random() * 0xffffff
  group.userData.baseColor = baseColor

  const head = createPart(new THREE.BoxGeometry(0.62, 0.62, 0.62), 0xf2c6a0)
  head.position.y = 1.62

  const hair = createPart(new THREE.BoxGeometry(0.66, 0.28, 0.66), 0x5a3a24)
  hair.position.y = 1.86

  const torso = createPart(new THREE.BoxGeometry(0.78, 0.72, 0.48), baseColor)
  torso.position.y = 1.08

  const hips = createPart(new THREE.BoxGeometry(0.74, 0.28, 0.48), 0x6e6e7a)
  hips.position.y = 0.68

  const legs = createPart(new THREE.BoxGeometry(0.70, 0.62, 0.48), 0x6e6e7a)
  legs.position.y = 0.30

  group.add(head)
  group.add(hair)
  group.add(torso)
  group.add(hips)
  group.add(legs)

  group.userData.parts = { head, hair, torso, hips, legs }
  group.userData.pose = "stand"
  group.userData.poseYOffset = 1
  group.userData.appearance = normalizeAppearance(null)

  group.position.y = 0
  scene.add(group)

  setAvatarAppearance(group, group.userData.appearance)

  return group
}

export function setAvatarPose(avatar, pose) {
  if (!avatar) return
  const p = pose === "sit" ? "sit" : "stand"
  avatar.userData.pose = p
  avatar.userData.poseYOffset = p === "sit" ? -0.35 : 0
}

export function setAvatarAppearance(avatar, appearance) {
  if (!avatar) return
  const app = normalizeAppearance(appearance)
  avatar.userData.appearance = app

  const parts = avatar.userData?.parts
  if (!parts) return

  const skinColor = colorForAppearanceKey(app.skin)
  if (parts.head?.material) parts.head.material.color.setHex(skinColor)

  const hairKey = app.hair === "none" ? "none" : app.hair
  const hairColor = colorForAppearanceKey(hairKey)
  if (parts.hair?.material) {
    parts.hair.visible = hairKey !== "none"
    parts.hair.material.color.setHex(hairColor)
  }

  const topColor = colorForAppearanceKey(app.top)
  if (parts.torso?.material) parts.torso.material.color.setHex(topColor)

  const bottomColor = colorForAppearanceKey(app.bottom)
  if (parts.hips?.material) parts.hips.material.color.setHex(bottomColor)
  if (parts.legs?.material) parts.legs.material.color.setHex(bottomColor)
}

export function updateAvatarPosition(avatar, pos) {
  if (!avatar || !pos) return
  const y = typeof avatar?.userData?.poseYOffset === "number" ? avatar.userData.poseYOffset : 0
  avatar.position.set(pos.x, y, pos.z)
}
