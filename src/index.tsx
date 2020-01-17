import React from 'react'
import invariant from 'tiny-invariant'

type QueryKeySerialized = [string?, string?, string?, (any | false)?]

export interface QueryDefaultConfig {
  staleTime?: number
  initialData?: any
  cacheTime?: number
  retry?: boolean | number
  retryDelay?: number | ((attemptIndex: number) => number)
  refetchAllOnWindowFocus?: boolean
  refetchInterval?: false | number
  refetchIntervalInBackground?: boolean
  refetchOnWindowFocus?: Boolean
  suspense?: boolean
  getCanFetchMore?<PageData = any>(
    lastPage: PageData,
    allPages: PageData[]
  ): boolean
  queryKeySerializerFn?(queryKey: any): QueryKeySerialized
  manual?: boolean
}

export interface QueryConfig extends QueryDefaultConfig {
  prefetch?: boolean
  onError?: QueryInstance['onError']
  onSuccess?: QueryInstance['onSuccess']
  paginated?: boolean
  force?: boolean
}

export interface Query {
  queryHash: string
  queryGroup: string
  variablesHash?: string
  variables: any
  pageVariables: any[]
  instances: QueryInstance[]
  state: QueryState
  promise?: CancellablePromise<any>
  staleTimeout?: number
  cacheTimeout?: number
  refetchInterval?: number
  cancelled?: CancelledError
  config: QueryConfig
  setState(updater: (updater: QueryState) => QueryState): void
  subscribe(instance: QueryInstance): () => void
  cancelQueries(): void
  queryFn<QueryVariables = any>(
    variables: QueryVariables
  ): CancellablePromise<any>
  fetch(options?: {
    variables?: any | any[]
    force?: QueryConfig['force']
    isFetchMore?: boolean
  }): void
  setData<DataType = any>(data: DataType): void
}

export interface QueryOptions {
  queryHash: Query['queryHash']
  queryGroup: Query['queryGroup']
  variablesHash: Query['variablesHash']
  variables: Query['variables']
  config: Query['config']
  queryFn: Query['queryFn']
}

export interface QueryInstance {
  id: number
  onStateUpdate(state: QueryState): void
  onSuccess?<DataType = any>(data: DataType): void
  onError?<ErrorType = Error>(error: ErrorType): void
}

export interface CancellablePromise<T> extends Promise<T> {
  cancel?(): void
}

export interface QueryState {
  error: Error | null
  isFetching: boolean
  isFetchingMore: boolean
  canFetchMore: boolean
  failureCount: number
  isCached: boolean
  isStale: boolean
  data: any | any[]
}

export type CancelledError = object

export let queries: Query[] = []

const cancelledError: CancelledError = {}

export let globalStateListeners: Function[] = []

let uid = 0

const isServer = typeof window === 'undefined'

export let defaultConfig: QueryDefaultConfig = {
  retry: 3,
  retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
  staleTime: 0,
  cacheTime: 5 * 60 * 1000,
  refetchAllOnWindowFocus: true,
  refetchInterval: false,
  refetchIntervalInBackground: false,
  suspense: false,
  queryKeySerializerFn: defaultQueryKeySerializerFn,
  initialData: undefined,
  manual: false,
}

const configContext = React.createContext(defaultConfig)

const onWindowFocus = () => {
  const { refetchAllOnWindowFocus } = defaultConfig

  if (isDocumentVisible() && isOnline()) {
    refetchAllQueries({
      shouldRefetchQuery: query => {
        if (typeof query.config.refetchOnWindowFocus === 'undefined') {
          return !!refetchAllOnWindowFocus
        } else {
          return !!query.config.refetchOnWindowFocus
        }
      },
    }).catch(error => {
      console.error(error.message)
    })
  }
}

export type FocusHandlerRemover = void | (() => void)

export type FocusHandler = (event?: Event) => void

export type RegisterFocusHandler = (
  focusHandler: FocusHandler
) => FocusHandlerRemover

let removePreviousHandler: FocusHandlerRemover

export function setFocusHandler(registerFocusHandler: RegisterFocusHandler) {
  // Unsub the old watcher
  if (removePreviousHandler) {
    removePreviousHandler()
  }
  // Sub the new watcher
  removePreviousHandler = registerFocusHandler(onWindowFocus)
}

setFocusHandler(handleFocus => {
  // Listen to visibillitychange and focus
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('visibilitychange', handleFocus, false)
    window.addEventListener('focus', handleFocus, false)

    return () => {
      // Be sure to unsubscribe if a new handler is set
      window.removeEventListener('visibilitychange', handleFocus)
      window.removeEventListener('focus', handleFocus)
    }
  }

  return undefined
})

export function ReactQueryConfigProvider({
  config,
  children,
}: {
  config: QueryDefaultConfig
  children: React.ElementType
}) {
  let configContextValue = React.useContext(configContext)

  const newConfig = React.useMemo(
    () => ({
      ...(configContextValue || defaultConfig),
      ...config,
    }),
    [config, configContextValue]
  )

  if (!configContextValue) {
    defaultConfig = newConfig
  }

  return (
    <configContext.Provider value={newConfig}>
      {children}
    </configContext.Provider>
  )
}

function useConfigContext() {
  return React.useContext(configContext) || defaultConfig
}

function makeQuery<DataType = any>(options: QueryOptions) {
  let initialData = options.config.paginated ? [] : null

  if (typeof options.config.initialData !== 'undefined') {
    initialData = options.config.initialData
  }

  const setState: Query['setState'] = updater => {
    query.state = functionalUpdate(updater, query.state)
    query.instances.forEach(instance => {
      instance.onStateUpdate(query.state)
    })
    globalStateListeners.forEach((d: Function) => {
      d()
    })
  }

  const subscribe: Query['subscribe'] = instance => {
    let found = query.instances.find(d => d.id === instance.id)

    if (found) {
      Object.assign(found, instance)
    } else {
      found = instance
      query.instances.push(instance)
    }

    // Mark as active
    query.setState(old => {
      return {
        ...old,
        isInactive: false,
      }
    })

    // Cancel garbage collection
    clearTimeout(query.cacheTimeout)

    // Mark the query as not cancelled
    delete query.cancelled

    // Return the unsubscribe function
    return () => {
      query.instances = query.instances.filter(d => d.id !== instance.id)

      if (!query.instances.length) {
        // Cancel any side-effects
        query.cancelled = cancelledError

        if (query.cancelQueries) {
          query.cancelQueries()
        }

        // Mark as inactive
        query.setState(old => {
          return {
            ...old,
            isInactive: true,
          }
        })

        // Schedule garbage collection
        query.cacheTimeout = window.setTimeout(
          () => {
            queries.splice(
              queries.findIndex(d => d === query),
              1
            )
            globalStateListeners.forEach((d: Function) => d())
          },
          query.state.isCached ? query.config.cacheTime : 0
        )
      }
    }
  }

  // Set up the fetch function
  const tryFetchQueryPages = async (
    pageVariables: any[]
  ): Promise<DataType[]> => {
    try {
      // Perform the query
      const promises = pageVariables.map(variables => query.queryFn(variables))

      query.cancelQueries = () =>
        promises.map(({ cancel }) => cancel && cancel())

      const data = await Promise.all(promises)

      if (query.cancelled) throw query.cancelled

      return data
    } catch (error) {
      if (query.cancelled) throw query.cancelled

      // If we fail, increase the failureCount
      query.setState(old => {
        return {
          ...old,
          failureCount: old.failureCount + 1,
        }
      })

      // Do we need to retry the request?
      if (
        query.config.retry &&
        // Only retry if the document is visible
        (query.config.retry === true ||
          query.state.failureCount < query.config.retry)
      ) {
        if (!isDocumentVisible()) {
          return new Promise(r => {
            r
          })
        }

        // Determine the retryDelay
        const delay = functionalUpdate(
          query.config.retryDelay,
          query.state.failureCount
        )

        // Return a new promise with the retry
        return new Promise((resolve, reject) => {
          // Keep track of the retry timeout
          setTimeout(async () => {
            if (query.cancelled) return reject(query.cancelled)

            try {
              const data = await tryFetchQueryPages(pageVariables)
              if (query.cancelled) return reject(query.cancelled)
              resolve(data)
            } catch (error) {
              if (query.cancelled) return reject(query.cancelled)
              reject(error)
            }
          }, delay)
        })
      }

      throw error
    }
  }

  const fetch = async ({
    variables = query.config.paginated && query.state.isCached
      ? query.pageVariables
      : query.variables,
    force = false,
    isFetchMore = false,
  } = {}) => {
    // Don't refetch fresh queries without force
    if (!query.queryHash || (!query.state.isStale && !force)) {
      return
    }

    // Create a new promise for the query cache if necessary
    if (!query.promise) {
      query.promise = (async (): Promise<void | DataType[]> => {
        // If there are any retries pending for this query, kill them
        delete query.cancelled

        const cleanup = () => {
          delete query.promise

          // Schedule a fresh invalidation, always!
          clearTimeout(query.staleTimeout)

          query.staleTimeout = window.setTimeout(() => {
            if (query) {
              query.setState(old => {
                return {
                  ...old,
                  isStale: true,
                }
              })
            }
          }, query.config.staleTime)

          query.setState(old => {
            return {
              ...old,
              isFetching: false,
              isFetchingMore: false,
            }
          })
        }

        try {
          // Set up the query refreshing state
          query.setState(old => ({
            ...old,
            isFetching: true,
            isFetchingMore: isFetchMore,
            failureCount: 0,
          }))

          variables =
            query.config.paginated && query.state.isCached && !isFetchMore
              ? variables
              : [variables]

          // Try to fetch
          let data: DataType[] = await tryFetchQueryPages(variables)

          // If we are paginating, and this is the first query or a fetch more
          // query, then store the variables in the pageVariables
          if (
            query.config.paginated &&
            (isFetchMore || !query.state.isCached)
          ) {
            query.pageVariables.push(variables[0])
          }

          // Set data and mark it as cached
          query.setState(old => {
            data = query.config.paginated
              ? isFetchMore
                ? ([...old.data, data[0]] as DataType[])
                : data
              : data

            return {
              ...old,
              error: null,
              data,
              isCached: true,
              isStale: false,
              ...(query.config.paginated &&
                query.config.getCanFetchMore && {
                  canFetchMore: query.config.getCanFetchMore(
                    data[data.length - 1],
                    data
                  ),
                }),
            }
          })

          query.instances.forEach(
            instance =>
              instance.onSuccess && instance.onSuccess(query.state.data)
          )

          cleanup()

          return data
        } catch (error) {
          // As long as it's not a cancelled retry
          cleanup()

          if (error !== query.cancelled) {
            // Store the error
            query.setState(old => {
              return {
                ...old,
                error,
                isCached: false,
                isStale: true,
              }
            })

            query.instances.forEach(
              instance => instance.onError && instance.onError(error)
            )

            throw error
          }
        }
      })()
    }

    return query.promise
  }

  const setData: Query['setData'] = updater =>
    query.setState(old => ({
      ...old,
      data: functionalUpdate(updater, old.data),
    }))

  const cancelQueries = () => {}

  let query: Query = {
    ...options,
    pageVariables: [],
    instances: [],
    state: {
      error: null,
      isFetching: false,
      isFetchingMore: false,
      canFetchMore: false,
      failureCount: 0,
      isCached: false,
      isStale: true,
      data: initialData,
    },
    setState,
    subscribe,
    fetch,
    setData,
    cancelQueries,
  }

  return query
}

export function useQuery<QueryKeyType = any>(
  queryKey: QueryKeyType,
  queryFn: Query['queryFn'],
  config: QueryConfig
) {
  const isMountedRef = React.useRef(false)
  const wasSuspendedRef = React.useRef(false)
  const instanceIdRef = React.useRef(uid++)
  const instanceId = instanceIdRef.current

  config = {
    ...useConfigContext(),
    ...config,
  }

  const { manual } = config

  if (!config.queryKeySerializerFn) {
    invariant(
      config.queryKeySerializerFn,
      'Could not find a valid queryKeySerializerFn!'
    )
    return
  }

  const [
    queryHash,
    queryGroup,
    variablesHash,
    variables,
  ] = config.queryKeySerializerFn(queryKey)

  if (!queryHash || !queryGroup) {
    invariant(
      queryHash && queryGroup,
      'Query key must serialized to a valid [queryHash, queryGroup, variablesHash, variables] tuple!'
    )
    return
  }

  let query = queries.find(query => query.queryHash === queryHash)

  let wasPrefetched = false

  if (query) {
    wasPrefetched = !!query.config.prefetch
    query.config = config
    if (!isMountedRef.current) {
      query.config.prefetch = wasPrefetched
    }
    query.queryFn = queryFn
  } else {
    query = makeQuery({
      queryHash,
      queryGroup,
      variablesHash,
      variables,
      config,
      queryFn,
    })

    if (!isServer) {
      queries.push(query)
    }
  }

  React.useEffect(() => {
    if (query && config.refetchInterval && !query.refetchInterval) {
      query.refetchInterval = window.setInterval(() => {
        if (isDocumentVisible() || config.refetchIntervalInBackground) {
          if (query) query.fetch()
        }
      }, config.refetchInterval)
    }
    return () => {
      if (query) {
        clearInterval(query.refetchInterval)
        delete query.refetchInterval
      }
    }
  }, [config.refetchInterval, config.refetchIntervalInBackground, query])

  const [state, setState] = React.useState(query.state)

  const onStateUpdate = React.useCallback(newState => setState(newState), [])
  const getLatestOnError = useGetLatest(config.onError)
  const getLatestOnSuccess = useGetLatest(config.onSuccess)

  React.useEffect((): void | (() => void) => {
    if (query) {
      const unsubscribeFromQuery = query.subscribe({
        id: instanceId,
        onStateUpdate,
        onSuccess: data => {
          const onSuccess = getLatestOnSuccess()
          if (onSuccess) onSuccess(data)
        },
        onError: err => {
          const onError = getLatestOnError()
          if (onError) onError(err)
        },
      })
      return unsubscribeFromQuery
    }
  }, [getLatestOnError, getLatestOnSuccess, instanceId, onStateUpdate, query])

  const isLoading = !state.isCached && query.state.isFetching
  const refetch = query.fetch
  const setData = query.setData

  const fetchMore = React.useCallback(
    config.paginated
      ? paginationVariables => {
          return (
            query &&
            query.fetch({
              variables: paginationVariables,
              force: true,
              isFetchMore: true,
            })
          )
        }
      : () => {},
    [query]
  )

  const getLatestManual = useGetLatest(manual)

  React.useEffect(() => {
    if (getLatestManual()) {
      return
    }

    if (config.suspense) {
      if (wasSuspendedRef.current || wasPrefetched) {
        return
      }
    }

    const runRefetch = async () => {
      try {
        query && (await query.fetch())
      } catch (err) {
        console.error(err)
        // Swallow this error. Don't rethrow it into a render function
      }
    }

    runRefetch()
  }, [config.suspense, getLatestManual, query, wasPrefetched])

  React.useEffect(() => {
    isMountedRef.current = true
  }, [])

  if (config.suspense) {
    if (state.error) {
      throw state.error
    }
    if (!state.isCached) {
      wasSuspendedRef.current = true
      throw query.fetch()
    }
  }

  wasSuspendedRef.current = false

  return {
    ...state,
    isLoading,
    refetch,
    fetchMore,
    setData,
  }
}

export async function prefetchQuery<QueryKeyType = any>(
  queryKey: QueryKeyType,
  queryFn: Query['queryFn'],
  config: QueryConfig = {}
) {
  config = {
    ...defaultConfig,
    ...config,
    prefetch: true,
  }

  if (!defaultConfig.queryKeySerializerFn) {
    invariant(
      defaultConfig.queryKeySerializerFn,
      'Could not find a default queryKeySerializerFn!'
    )
    return
  }

  const [
    queryHash,
    queryGroup,
    variablesHash,
    variables,
  ] = defaultConfig.queryKeySerializerFn(queryKey)

  if (!queryHash || !queryGroup) {
    invariant(
      queryHash && queryGroup,
      'Query key must serialized to a valid [queryHash, queryGroup, variablesHash, variables] tuple!'
    )
    return
  }

  // If we're prefetching, use the queryFn to make the fetch call

  let query = queries.find(query => query.queryHash === queryHash)

  if (query) {
    if (!config.force) {
      return
    }
    query.config = config
    query.queryFn = queryFn
  } else {
    query = makeQuery({
      queryHash,
      queryGroup,
      variablesHash,
      variables,
      config,
      queryFn,
    })
    if (!isServer) {
      queries.push(query)
    }
  }

  // Trigger a query subscription with one-time unique id
  const unsubscribeFromQuery = query.subscribe({
    id: uid++,
    onStateUpdate: () => {},
  })

  // Trigger a fetch and return the promise
  try {
    return await query.fetch({ force: config.force })
  } finally {
    // Since this is not a hook, upsubscribe after we're done
    unsubscribeFromQuery()
  }
}

export async function refetchQuery<QueryKeyType = any>(
  queryKey: QueryKeyType,
  config: QueryConfig = {}
): Promise<void> {
  if (!defaultConfig.queryKeySerializerFn) {
    invariant(
      defaultConfig.queryKeySerializerFn,
      'Could not find a default queryKeySerializerFn!'
    )
    return
  }

  const [
    ,
    queryGroup,
    variablesHash,
    variables,
  ] = defaultConfig.queryKeySerializerFn(queryKey)

  // If we're simply refetching an existing query, then go find them
  // and call their fetch functions

  if (!queryGroup) {
    return
  }

  await Promise.all(
    queries.map(async query => {
      if (query.queryGroup !== queryGroup) {
        return
      }

      if (variables === false && query.variablesHash) {
        return
      }

      if (variablesHash && query.variablesHash !== variablesHash) {
        return
      }

      await query.fetch({ force: config.force })
    })
  )
}

export interface MutationOptions {
  refetchQueries?: any[]
  refetchQueriesOnFailure?: boolean
}

type MutationFn = <MutationVariablesType = any, MutationResponseType = any>(
  mutationVariables: MutationVariablesType
) => Promise<MutationResponseType>

export function useMutation(
  mutationFn: MutationFn,
  { refetchQueries, refetchQueriesOnFailure }: MutationOptions = {}
) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const mutationFnRef = React.useRef(mutationFn)
  mutationFnRef.current = mutationFn

  const mutate = React.useCallback(
    async (variables, { updateQuery, waitForRefetchQueries = false } = {}) => {
      setIsLoading(true)
      setError(null)

      const doRefetchQueries = async () => {
        if (refetchQueries) {
          const refetchPromises = refetchQueries.map(queryKey =>
            refetchQuery(queryKey, { force: true })
          )
          if (waitForRefetchQueries) {
            await Promise.all(refetchPromises)
          }
        }
      }

      try {
        const res =
          mutationFnRef.current && (await mutationFnRef.current(variables))

        setData(res)

        if (updateQuery) {
          setQueryData(updateQuery, res, { shouldRefetch: false })
        }

        try {
          await doRefetchQueries()
        } catch (err) {
          console.error(err)
          // Swallow this error since it is a side-effect
        }

        setIsLoading(false)

        return res
      } catch (error) {
        setError(error)

        if (refetchQueriesOnFailure) {
          await doRefetchQueries()
        }

        setIsLoading(false)
        throw error
      }
    },
    [refetchQueriesOnFailure, refetchQueries]
  )

  return [mutate, { data, isLoading, error }]
}

export function useIsFetching() {
  const [state, setState] = React.useState({})
  const ref = React.useRef<() => void>()

  if (!ref.current) {
    ref.current = () => {
      setState({})
    }
    globalStateListeners.push(ref.current)
  }

  React.useEffect(() => {
    return () => {
      globalStateListeners = globalStateListeners.filter(d => d !== ref.current)
    }
  }, [])

  return React.useMemo(
    () => state && queries.some(query => query.state.isFetching),
    [state]
  )
}

export function setQueryData(
  userQueryKey: any,
  updater: <T, U>(previousValue: T) => U,
  { shouldRefetch = true } = {}
): void | Promise<void> {
  if (!defaultConfig.queryKeySerializerFn) {
    invariant(
      defaultConfig.queryKeySerializerFn,
      'Could not find a default queryKeySerializerFn!'
    )
    return
  }

  const [queryHash] = defaultConfig.queryKeySerializerFn(userQueryKey)

  if (!queryHash) {
    return
  }

  const query = queries.find(d => d.queryHash === queryHash)

  if (!query) {
    return
  }

  query.setData(updater)

  if (shouldRefetch) {
    return refetchQuery(userQueryKey)
  }
}

interface RefetchAllQueriesOptions {
  includeInactive?: boolean
  force?: boolean
  shouldRefetchQuery?: boolean | ((query: Query) => boolean)
}

export async function refetchAllQueries({
  includeInactive = false,
  force = includeInactive,
  shouldRefetchQuery = false,
}: RefetchAllQueriesOptions = {}) {
  return Promise.all(
    queries.map(async query => {
      if (
        typeof shouldRefetchQuery === 'function' &&
        !shouldRefetchQuery(query)
      ) {
        return
      }
      if (query.instances.length || includeInactive) {
        return query.fetch({ force })
      }
    })
  )
}

export function clearQueryCache() {
  queries.length = 0
}

export function defaultQueryKeySerializerFn(queryKey: any): QueryKeySerialized {
  if (!queryKey) {
    return []
  }

  if (typeof queryKey === 'function') {
    try {
      return defaultQueryKeySerializerFn(queryKey())
    } catch {
      return []
    }
  }

  if (Array.isArray(queryKey)) {
    let [id, variables] = queryKey
    const variablesIsObject = isObject(variables)

    const invalid = typeof id !== 'string' || (variables && !variablesIsObject)

    invariant(
      !invalid,
      `Invalid query key tuple type: ${JSON.stringify(queryKey)}`
    )

    const variablesHash = variablesIsObject ? stableStringify(variables) : ''

    return [
      `${id}${variablesHash ? `_${variablesHash}}` : ''}`,
      id,
      variablesHash,
      variables,
    ]
  }

  return [queryKey, queryKey]
}

function stableStringifyReplacer(_: any, value: any) {
  return isObject(value)
    ? Object.assign(
        {},
        ...Object.keys(value)
          .sort()
          .map(key => ({
            [key]: value[key],
          }))
      )
    : Array.isArray(value)
    ? value
    : String(value)
}

export function stableStringify(obj: any) {
  return JSON.stringify(obj, stableStringifyReplacer)
}

function isObject(a: any) {
  return a && typeof a === 'object' && !Array.isArray(a)
}

function isDocumentVisible() {
  return (
    typeof document === 'undefined' ||
    document.visibilityState === undefined ||
    document.visibilityState !== 'hidden'
  )
}

function isOnline() {
  return navigator.onLine === undefined || navigator.onLine
}

function useGetLatest<T>(obj: T) {
  const ref = React.useRef(obj)
  ref.current = obj

  return React.useCallback(() => ref.current, [])
}

function functionalUpdate(
  updater:
    | any
    | (<PreviousStateType = any, NextStateType = PreviousStateType>(
        previousValue: PreviousStateType
      ) => NextStateType),
  old: any
) {
  return typeof updater === 'function' ? updater(old) : updater
}
