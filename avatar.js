import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'

function colorFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0xffffff
}

export function createAvatar(scene, pubkey) {
  const geometry = new THREE.BoxGeometry(1, 2, 1)
  const color = pubkey ? colorFromString(pubkey) : Math.random() * 0xffffff
  const material = new THREE.MeshBasicMaterial({ color })
  const avatar = new THREE.Mesh(geometry, material)

  avatar.position.y = 1
  scene.add(avatar)

  return avatar
}

export function updateAvatarPosition(avatar, pos) {
  avatar.position.set(pos.x, 1, pos.z)
}
