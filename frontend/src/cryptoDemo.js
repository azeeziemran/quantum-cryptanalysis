// The symmetric encryption flow is closer
// to modern E2EE design: ECDH-style secret -> SHA-256 -> AES-GCM.


// Here implemented the educational elliptic-curve arithmetic, ECDH, 
//and signature logic. For SHA-256 and AES-GCM used the browser’s Web Crypto 
// API, which is the standard secure implementation and mirrors how real-world 
// applications use trusted cryptographic primitives.

// The signature flow is a simple Schnorr-style scheme.
  
export const DEMO_CURVE = {
  name: 'EMRAN AZEEZI',
  p: 211, 
  a: 2,
  b: 3,
  generator: { x: 199, y: 192 },
  order: 204,
  privateKeyMax: 203,
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const SIGNATURE_PURPOSE = 'quantum-chat-demo-signature'

function mod(value, modulus = DEMO_CURVE.p) {
  return ((value % modulus) + modulus) % modulus
}

function inverseMod(value, modulus = DEMO_CURVE.p) {
  let oldR = mod(value, modulus)
  let r = modulus
  let oldS = 1
  let s = 0

  while (r !== 0) {
    const quotient = Math.floor(oldR / r)
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }

  return mod(oldS, modulus)
}

function pointAdd(pointA, pointB) {
  if (!pointA) return pointB
  if (!pointB) return pointA

  if (pointA.x === pointB.x && mod(pointA.y + pointB.y) === 0) {
    return null
  }

  const slope =
    pointA.x === pointB.x && pointA.y === pointB.y
      ? mod((3 * pointA.x * pointA.x + DEMO_CURVE.a) * inverseMod(2 * pointA.y))
      : mod((pointB.y - pointA.y) * inverseMod(pointB.x - pointA.x))

  const x = mod(slope * slope - pointA.x - pointB.x)
  const y = mod(slope * (pointA.x - x) - pointA.y)
  return { x, y }
}

function pointEqual(pointA, pointB) {
  if (!pointA || !pointB) return pointA === pointB
  return pointA.x === pointB.x && pointA.y === pointB.y
}

export function scalarMultiply(scalar, point = DEMO_CURVE.generator) {
  let result = null
  let addend = point
  let value = scalar

  while (value > 0) {
    if (value & 1) result = pointAdd(result, addend)
    addend = pointAdd(addend, addend)
    value >>= 1
  }

  return result
}

function randomScalar() {
  const random = window.crypto.getRandomValues(new Uint16Array(1))[0]
  return (random % DEMO_CURVE.privateKeyMax) + 1
}

export function generateDemoKeyPair() {
  // Step 1: Create a small demo private key and its matching public key.
  // The public key is the generator point multiplied by the private key.
  const privateKey = randomScalar()
  return {
    privateKey,
    publicKey: scalarMultiply(privateKey),
  }
}

export function computeSharedSecret(privateKey, publicKey) {
  // Step 2: Compute the ECDH-style shared secret.
  // Sender private key * recipient public key gives the same point as
  // recipient private key * sender public key.
  return scalarMultiply(privateKey, publicKey)
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

async function sha256Bytes(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value)
  const digest = await window.crypto.subtle.digest('SHA-256', textEncoder.encode(input))
  return new Uint8Array(digest)
}

async function hashToScalar(value) {
  const digest = await sha256Bytes(value)
  const integer = digest.reduce((total, byte) => (total * 256 + byte) % DEMO_CURVE.order, 0)
  return integer
}

export async function deriveAesKeyBytes(sharedSecret) {
  // Step 3: Turn the shared secret point into AES key bytes.
  // SHA-256 produces 32 bytes, which WebCrypto can use as an AES-GCM key.
  return sha256Bytes({
    purpose: 'quantum-chat-aes-gcm',
    curve: DEMO_CURVE.name,
    sharedSecret,
  })
}

async function importAesKey(keyBytes) {
  return window.crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

export async function signEnvelope(signingPrivateKey, envelope) {
  // Signature step 1: Pick a fresh random nonce for this envelope.
  const nonce = randomScalar()
  // Signature step 2: Publish the nonce as a curve point, not as the raw number.
  const noncePoint = scalarMultiply(nonce)
  // Signature step 3: Hash the nonce point and envelope into a challenge.
  const challenge = await hashToScalar({
    purpose: SIGNATURE_PURPOSE,
    noncePoint,
    envelope,
  })
  // Signature step 4: Combine nonce, challenge, and private key into a proof.
  const proof = mod(nonce + challenge * signingPrivateKey, DEMO_CURVE.order)

  return {
    algorithm: 'educational-schnorr',
    noncePoint,
    proof,
  }
}

export async function verifyEnvelopeSignature(signingPublicKey, envelope, signature) {
  // Verification step 1: Reject signatures that do not have the expected shape.
  if (!signingPublicKey || !signature?.noncePoint || typeof signature.proof !== 'number') {
    return false
  }

  // Verification step 2: Recreate the same challenge from the signed envelope.
  const challenge = await hashToScalar({
    purpose: SIGNATURE_PURPOSE,
    noncePoint: signature.noncePoint,
    envelope,
  })
  // Verification step 3: Check that proof * G matches noncePoint + challenge * publicKey.
  const left = scalarMultiply(signature.proof)
  const right = pointAdd(signature.noncePoint, scalarMultiply(challenge, signingPublicKey))
  return pointEqual(left, right)
}

export function buildSignatureEnvelope({
  senderId,
  senderName,
  senderPublicKey,
  senderSigningPublicKey,
  payloads,
}) {
  return {
    senderId,
    senderName,
    senderPublicKey,
    senderSigningPublicKey,
    payloads,
  }
}

export async function encryptForRecipient(plaintext, senderPrivateKey, recipient) {
  // Encryption step 1: Use sender private key and recipient public key
  // to compute the shared secret for this recipient.
  const sharedSecret = computeSharedSecret(senderPrivateKey, recipient.publicKey)
  // Encryption step 2: Derive AES-GCM key bytes from that shared secret.
  const keyBytes = await deriveAesKeyBytes(sharedSecret)
  // Encryption step 3: Import those bytes as a WebCrypto AES-GCM key.
  const key = await importAesKey(keyBytes)
  // Encryption step 4: Generate a fresh 12-byte IV for this encryption.
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  // Encryption step 5: Convert the message text into bytes.
  const plaintextBytes = textEncoder.encode(plaintext)
  // Encryption step 6: Encrypt the plaintext bytes with AES-GCM.
  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintextBytes,
  )
  const ciphertextBytes = new Uint8Array(ciphertextBuffer)

  // Encryption step 7: Return a transport-safe payload.
  // IV and ciphertext are base64 strings so the backend can store/send them as JSON.
  return {
    payload: {
      recipientId: recipient.id,
      recipientPublicKey: recipient.publicKey,
      algorithm: 'AES-GCM',
      kdf: 'SHA-256(sharedSecret)',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertextBytes),
    },
    debug: {
      recipientName: recipient.name,
      recipientPublicKey: recipient.publicKey,
      sharedSecret,
      aesKeyHex: bytesToHex(keyBytes),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertextBytes),
    },
  }
}

export async function decryptFromSender(payload, receiverPrivateKey, senderPublicKey) {
  // Decryption step 1: Recompute the same shared secret using
  // receiver private key and sender public key.
  const sharedSecret = computeSharedSecret(receiverPrivateKey, senderPublicKey)
  // Decryption step 2: Derive the same AES-GCM key bytes from the shared secret.
  const keyBytes = await deriveAesKeyBytes(sharedSecret)
  // Decryption step 3: Import the AES-GCM key for decryption.
  const key = await importAesKey(keyBytes)
  // Decryption step 4: Decode the IV and ciphertext from base64 back to bytes.
  const iv = base64ToBytes(payload.iv)
  const ciphertext = base64ToBytes(payload.ciphertext)
  // Decryption step 5: AES-GCM decrypts and verifies authenticity.
  // If the key, IV, or ciphertext is wrong, this throws an error.
  const plaintextBuffer = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  )

  // Decryption step 6: Convert decrypted bytes back into readable text.
  return {
    plaintext: textDecoder.decode(plaintextBuffer),
    debug: {
      sharedSecret,
      aesKeyHex: bytesToHex(keyBytes),
      iv: payload.iv,
      ciphertext: payload.ciphertext,
      algorithm: payload.algorithm,
      kdf: payload.kdf,
    },
  }
}
