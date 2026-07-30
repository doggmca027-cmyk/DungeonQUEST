import { createClient } from 'npm:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const JWT_SECRET = Deno.env.get('PROJECT_JWT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const JWT_TTL_SECONDS = 60 * 60 * 12 // 12h, matches a typical Mini App session
const MAX_AUTH_DATE_AGE_SECONDS = 60 * 60 * 24 // reject stale initData (replay protection)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

async function hmacSha256(key: BufferSource, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return new Uint8Array(signature)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encoder = new TextEncoder()
  const headerPart = base64url(encoder.encode(JSON.stringify(header)))
  const payloadPart = base64url(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${headerPart}.${payloadPart}`
  const signature = await hmacSha256(encoder.encode(JWT_SECRET), signingInput)
  return `${signingInput}.${base64url(signature)}`
}

async function verifyInitData(initData: string) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) throw new Error('Missing hash in initData')
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), BOT_TOKEN)
  const computedHash = toHex(await hmacSha256(secretKey, dataCheckString))

  if (computedHash !== hash) {
    throw new Error('Invalid initData signature')
  }

  const authDate = Number(params.get('auth_date'))
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_DATE_AGE_SECONDS) {
    throw new Error('initData expired')
  }

  const userRaw = params.get('user')
  if (!userRaw) throw new Error('Missing user in initData')
  const user = JSON.parse(userRaw)
  const startParam = params.get('start_param')

  return { user, startParam }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const { initData } = await req.json()
    if (typeof initData !== 'string' || !initData) {
      return jsonResponse({ error: 'Missing initData' }, 400)
    }

    const { user, startParam } = await verifyInitData(initData)

    const referredByMatch = startParam?.match(/^ref_(\d+)$/)
    const referredBy = referredByMatch ? Number(referredByMatch[1]) : null

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { error: upsertErr } = await admin.rpc('get_or_create_user', {
      p_user_id: user.id,
      p_first_name: user.first_name ?? null,
      p_username: user.username ?? null,
      p_referred_by: referredBy,
    })
    if (upsertErr) throw upsertErr

    const token = await signJwt({
      sub: String(user.id),
      role: 'authenticated',
      telegram_id: user.id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
    })

    return jsonResponse({
      token,
      user: { id: user.id, first_name: user.first_name ?? null, username: user.username ?? null },
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unauthorized' }, 401)
  }
})
