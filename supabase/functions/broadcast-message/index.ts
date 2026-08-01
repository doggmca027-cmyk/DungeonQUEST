import { createClient } from 'npm:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const ADMIN_TELEGRAM_ID = 6288342755

// Telegram allows roughly 30 messages/sec globally. Batching at this size
// with a 1s pause between batches keeps us safely under that regardless of
// how many recipients there are, without waiting on each send one at a time.
const BATCH_SIZE = 25
const BATCH_DELAY_MS = 1000

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

function decodeJwtPayload(authHeader: string | null): Record<string, unknown> | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  const payloadPart = token?.split('.')[1]
  if (!payloadPart) return null
  const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  return JSON.parse(atob(padded))
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendOne(chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
    const data = await res.json()
    if (!data.ok) {
      // Expected for users who blocked the bot or deleted their account --
      // not a reason to abort the rest of the broadcast.
      console.error('sendMessage failed for', chatId, data.description)
    }
    return Boolean(data.ok)
  } catch (err) {
    console.error('sendMessage threw for', chatId, err)
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const payload = decodeJwtPayload(req.headers.get('Authorization'))
    const callerId = payload?.telegram_id
    if (!callerId || Number(callerId) !== ADMIN_TELEGRAM_ID) {
      return jsonResponse({ success: false, message: 'Unauthorized' }, 401)
    }

    const { text } = await req.json()
    if (typeof text !== 'string' || !text.trim()) {
      return jsonResponse({ success: false, message: 'Missing text' }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: users, error: usersErr } = await admin.from('users').select('id')
    if (usersErr) throw usersErr

    const recipients = users ?? []
    let sent = 0
    let failed = 0

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(batch.map((u) => sendOne(u.id, text)))
      for (const ok of results) {
        if (ok) sent++
        else failed++
      }
      if (i + BATCH_SIZE < recipients.length) await wait(BATCH_DELAY_MS)
    }

    return jsonResponse({ success: true, total: recipients.length, sent, failed })
  } catch (err) {
    console.error('broadcast-message failed:', err instanceof Error ? err.stack : err)
    return jsonResponse(
      { success: false, message: err instanceof Error ? err.message : 'Broadcast failed' },
      500,
    )
  }
})
