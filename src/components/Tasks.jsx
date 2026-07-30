import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, CheckCircle2 } from 'lucide-react'
import { supabase } from '../supabaseClient'

const tg = typeof window !== 'undefined' && window.Telegram?.WebApp

function Tasks() {
  const [user] = useState(() => tg?.initDataUnsafe?.user ?? null)
  const [tasks, setTasks] = useState([])
  const [completedIds, setCompletedIds] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback(async () => {
    if (!user) return

    let { data: tasksData, error: tasksErr } = await supabase
      .from('tasks')
      .select('*')
      .eq('is_active', true)

    if (tasksErr?.code === '42703') {
      // is_active column doesn't exist yet (pending migration) — fall back
      // to fetching every task instead of hard-failing the whole tab.
      ;({ data: tasksData, error: tasksErr } = await supabase.from('tasks').select('*'))
    }
    if (tasksErr) throw tasksErr

    const { data: userTasksData, error: userTasksErr } = await supabase
      .from('user_tasks')
      .select('task_id')
      .eq('user_id', user.id)
    if (userTasksErr) throw userTasksErr

    setTasks(tasksData ?? [])
    setCompletedIds(new Set((userTasksData ?? []).map((row) => row.task_id)))
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        await refresh()
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [refresh])

  async function handleCheck(task) {
    if (!user) return
    setBusyId(task.id)
    setError(null)
    setNotice(null)
    try {
      const { data: verifyData, error: verifyErr } = await supabase.functions.invoke(
        'verify-subscription',
        { body: { task_id: task.id } },
      )
      if (verifyErr) throw verifyErr
      if (!verifyData?.subscribed) {
        throw new Error(verifyData?.message ?? 'Вы не подписаны на канал')
      }

      const { data: reward, error: rpcErr } = await supabase.rpc('complete_task', {
        p_task_id: task.id,
      })
      if (rpcErr) throw rpcErr

      setNotice(`Задание выполнено: +${reward} GRAM`)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  if (!user) {
    return (
      <p className="text-sm text-theme-dark-text/70">
        Откройте приложение через Telegram, чтобы выполнять задания.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="text-sm text-red-700 bg-red-100 border border-red-300 rounded-2xl px-3 py-2">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-theme-accent bg-theme-accent/10 border border-theme-card-border rounded-2xl px-3 py-2">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-theme-dark-text/70">Загрузка заданий…</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-theme-dark-text/70">Заданий пока нет.</p>
      ) : (
        tasks.map((task) => {
          const isCompleted = completedIds.has(task.id)
          const isBusy = busyId === task.id

          return (
            <div
              key={task.id}
              className="bg-theme-card border border-theme-card-border rounded-2xl p-4 flex flex-col gap-3 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-base">{task.title}</h3>
                <span className="shrink-0 text-xs font-medium text-theme-accent bg-theme-accent/10 px-2.5 py-1 rounded-full">
                  +{task.reward_gram} GRAM
                </span>
              </div>

              <div className="flex gap-2">
                <a
                  href={task.link}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 flex items-center justify-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-dark-text text-theme-card"
                >
                  <ExternalLink size={16} />
                  Перейти в канал
                </a>
                <button
                  type="button"
                  disabled={isCompleted || isBusy}
                  onClick={() => handleCheck(task)}
                  className="flex-1 flex items-center justify-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold bg-theme-accent text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isCompleted ? (
                    <>
                      <CheckCircle2 size={16} />
                      Выполнено
                    </>
                  ) : isBusy ? (
                    'Проверка…'
                  ) : (
                    'Проверить'
                  )}
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

export default Tasks
