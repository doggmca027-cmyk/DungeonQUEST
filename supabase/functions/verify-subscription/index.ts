import { createClient } from 'npm:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

// Accepts "https://t.me/username", "t.me/username", or "@username" and
// returns the bare username -- same normalization used in AdminPanel.jsx
// when a task is created, so this just has to undo it.
function extractUsername(link: string | null | undefined): string | null {
  if (!link) return null
  const value = link
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@/, '')
    .split(/[/?]/)[0]
  return value || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const payload = decodeJwtPayload(req.headers.get('Authorization'))
    const telegramId = payload?.telegram_id
    if (!telegramId) {
      return jsonResponse({ subscribed: false, message: 'Unauthorized' }, 401)
    }

    const { task_id: taskId } = await req.json()
    if (!taskId) {
      return jsonResponse({ subscribed: false, message: 'Missing task_id' }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: task, error: taskErr } = await admin
      .from('tasks')
      .select('link')
      .eq('id', taskId)
      .single()
    if (taskErr || !task) {
      return jsonResponse({ subscribed: false, message: 'Задание не найдено' }, 404)
    }

    const username = extractUsername(task.link)
    if (!username) {
      return jsonResponse({ subscribed: false, message: 'Некорректная ссылка на канал' }, 400)
    }

    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent('@' + username)}&user_id=${telegramId}`,
    )
    const tgData = await tgRes.json()

    if (!tgData.ok) {
      return jsonResponse({
        subscribed: false,
        message: tgData.description ?? 'Не удалось проверить подписку',
      })
    }

    const status = tgData.result?.status
    const subscribed = ['member', 'administrator', 'creator'].includes(status)

    return jsonResponse({
      subscribed,
      message: subscribed ? null : 'Вы не подписаны на канал',
    })
  } catch (err) {
    return jsonResponse(
      { subscribed: false, message: err instanceof Error ? err.message : 'Ошибка проверки' },
      500,
    )
  }
})
