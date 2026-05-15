import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// Page-scoped mutual exclusion for backend-job kick-off buttons. While any
// task owns the lock, other task triggers can read `lockedByOther('myId')`
// and disable themselves. Consumers call `acquire(id)` on start and
// `release()` on every termination path (success / error / cancel / SSE
// onerror); the hook also auto-releases on unmount so an unmounted-mid-job
// component doesn't strand the lock.

type Ctx = {
  current: string | null
  currentRef: { current: string | null }
  setCurrent: (o: string | null) => void
}

const BusyContext = createContext<Ctx | null>(null)

export function BusyProvider({ children }: { children: ReactNode }) {
  const [current, setCurrentState] = useState<string | null>(null)
  const currentRef = useRef<string | null>(null)
  const setCurrent = useCallback((o: string | null) => {
    currentRef.current = o
    setCurrentState(o)
  }, [])
  return createElement(
    BusyContext.Provider,
    { value: { current, currentRef, setCurrent } },
    children,
  )
}

export function useExclusiveTask() {
  const ctx = useContext(BusyContext)
  // Tracks whether THIS consumer instance owns the lock. Without per-consumer
  // ownership two components that happen to pass the same id could trample
  // each other's lock.
  const ownedRef = useRef<string | null>(null)
  // Mirror ctx through a ref so the unmount cleanup can reach setCurrent
  // without listing ctx as an effect dep — listing it would run cleanup on
  // every Provider re-render (because the context VALUE object is recreated
  // on each state change) and release the lock the instant acquire fires.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  useEffect(() => {
    return () => {
      if (ownedRef.current && ctxRef.current) {
        ctxRef.current.setCurrent(null)
        ownedRef.current = null
      }
    }
  }, [])

  const acquire = useCallback((id: string): boolean => {
    const c = ctxRef.current
    if (!c) return true
    const cur = c.currentRef.current
    if (cur && !ownedRef.current) return false
    c.setCurrent(id)
    ownedRef.current = id
    return true
  }, [])

  const release = useCallback(() => {
    const c = ctxRef.current
    if (!c) return
    if (ownedRef.current) {
      c.setCurrent(null)
      ownedRef.current = null
    }
  }, [])

  const owner = ctx?.current ?? null
  const lockedByOther = useCallback((id: string) => !!owner && owner !== id, [owner])

  return { acquire, release, owner, lockedByOther }
}
