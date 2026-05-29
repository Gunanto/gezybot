import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import type { ToolCatalogEntry } from '@/shared/types'

interface ToolCatalogResponse {
  tools: ToolCatalogEntry[]
}

/**
 * Loads the Kin-agnostic native tool catalog (GET /api/tools/catalog). This is
 * pure metadata — every native tool with its domain, label, description, and
 * `hardExcludedFromSubKin` flag — used to populate the toolbox editor and any
 * other surface that lets a user pick tools by name (not per-Kin enabled
 * state, which still comes from useKinTools).
 */
export function useToolCatalog() {
  const [tools, setTools] = useState<ToolCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await api.get<ToolCatalogResponse>('/tools/catalog')
      setTools(data.tools)
    } catch (err) {
      console.error('[useToolCatalog] error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { tools, isLoading, refetch }
}
