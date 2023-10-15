/**
 * 1. stale while revalidate
 * 2. dedupe
 * 3. auto-cancel
 * 4. suspense
 * 5.
 */

// @ts-ignore
// import { useSyncExternalStore } from 'use-sync-external-store/shim';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { serialize } from "./serialize";
import { isVisible } from "./webPreset";
import {
  EMPTY_CACHE,
  readCache,
  Cache,
  subscribeCache,
  refreshCache,
} from "./cache";
import { assign, cloneDeep, get, isArray, set } from "lodash-es";

const CACHE_REVALIDATE_FUNCTION_POOL: Record<
  string,
  Record<string, () => void | Promise<void>>
> = {};

const CACHE_REVALIDATE_PROMISE_POOL: Record<string, Promise<unknown>> = {};
// (window as any)["debug_CACHE_REVALIDATE_FUNCTION_POOL"] = CACHE_REVALIDATE_FUNCTION_POOL;

export interface StateDependencies {
  data?: boolean;
  error?: boolean;
  loading?: boolean;
}

type UseFetchOption<T> = {
  autoRefresh?: boolean;
  debug?: boolean;
  /**
   * 如果你认为从API上无法分析实体对应的结构
   * 传入这个参数将会覆盖默认的行为
   */

  fineGrainedIter?: (
    data: T
  ) => Generator<{ cacheKey: string; path: string }, void, undefined>;
};
const DEFAULT_OPTIONS = {
  autoRefresh: false,
  debug: false,
};

/**
 * 1. cache
 * 2. revalidate
 * 3. dedupe
 * 4. heartbeat
 * 5. 更细粒度的缓存
 *
 *
 *
 * @desc 09/01/2022
 * 重新验证的时机:
 * 1. mount时重新验证
 * 2. key变化时重新验证
 * 3. 上述两者都没有变化， 但cache被删除时重新验证
 */
function useFetch<T>(
  key: string | Array<any> | Function,
  fetcher: (...args: any) => Promise<T>,
  options?: UseFetchOption<T>
) {
  const _options = { ...DEFAULT_OPTIONS, ...(options || {}) };

  // eslint-disable-next-line prefer-const
  let [cacheKey, fnArg] = serialize(key);
  fnArg = fnArg instanceof Array ? fnArg : [fnArg];
  const stateDependencies = useRef<StateDependencies>({});
  const unsubscribe = useRef<Function>();
  const mount = useRef(true);
  const firstOfThisMount = useRef(true);

  const log = useCallback(
    (...arg: any) => {
      if (_options.debug) {
        console.log(...arg);
      }
    },
    [_options.debug]
  );

  const subsrcibe = useCallback(
    (callback: () => void) => {
      unsubscribe.current?.();
      if (cacheKey) {
        unsubscribe.current = subscribeCache(cacheKey, {
          subscriber: "Component",
          excutor: () => {
            log(`${cacheKey} request an update`);
            callback();
          },
        });
      }
      const unsubscribeFn = unsubscribe.current ?? (() => void 0);

      return unsubscribeFn as () => void;
    },
    [cacheKey, log]
  );

  /**
   * cache 变化触发react更新
   */
  const cache = useSyncExternalStore(subsrcibe, () => {
    // key 为空代表暂时不需要写缓存
    if (!cacheKey) {
      return EMPTY_CACHE as Cache<T>;
    }

    const snapshot = readCache<T>(cacheKey);
    if (snapshot.data) {
      // when snapshot has data, we need check if cache has deps
      // cache has deps which need be fulfilled
      if (
        snapshot.__deps &&
        snapshot.__deps.size > 0 &&
        options?.fineGrainedIter
      ) {
        const _data = cloneDeep(snapshot.data);
        for (const { path, cacheKey } of options.fineGrainedIter(_data)) {
          const record = get(_data, path);
          const innerData = readCache(record["__cache_key__"]).data || {};

          assign(record, innerData);
        }
        snapshot.data = _data;
      }
    }
    return snapshot;
  });

  const revalidate = useCallback(() => {
    // 1. key 为空代表暂时不需要请求
    if (cacheKey) {
      log("revalidate", cacheKey);
      // dedup
      let revalidatePromise = CACHE_REVALIDATE_PROMISE_POOL[
        cacheKey
      ] as Promise<T>;
      if (!revalidatePromise) {
        CACHE_REVALIDATE_PROMISE_POOL[cacheKey] = revalidatePromise = fetcher(
          ...((isArray(fnArg) && fnArg) || [fnArg])
        );
      }

      return revalidatePromise
        .then((data) => {
          if (options?.fineGrainedIter) {
            for (const {
              path,
              cacheKey: fineGrainedCacheKey,
            } of options.fineGrainedIter(data)) {
              const fineGrainedData = get(data, path);

              // get, or create fine grained cache
              const innerCache = readCache<unknown>(fineGrainedCacheKey);
              // connect finegrained cache and current cache
              if (!cache.__deps) {
                cache.__deps = new Set();
              }
              cache.__deps?.add(fineGrainedCacheKey);

              if (!innerCache.__parents) {
                innerCache.__parents = new Set();
              }
              innerCache.__parents.add(cacheKey);

              console.log("refresh fine grained cache", fineGrainedData);
              // refresh fine grained cache
              refreshCache(fineGrainedCacheKey, {
                ...innerCache,
                loading: false,
                data: fineGrainedData,
              });

              set(data as any as object, path, {
                __cache_key__: fineGrainedCacheKey,
              });
            }

            // 主要是loading
            refreshCache(
              cacheKey,
              {
                ...cache,
                loading: false,
                data,
              },
              stateDependencies.current.data ||
                stateDependencies.current.loading
            );
          } else {
            // 异步之后, cache可能已经被删除
            refreshCache(
              cacheKey,
              {
                ...cache,
                loading: false,
                data,
              },
              stateDependencies.current.data ||
                stateDependencies.current.loading
            );
          }
        })
        .catch(({ error }: any) => {
          log(cacheKey, "revalidate error");

          refreshCache(
            cacheKey,
            {
              ...cache,
              loading: false,
              error,
            },
            stateDependencies.current.data || stateDependencies.current.loading
          );
        })
        .finally(() => {
          log(cacheKey, "revalidate done");
          // console.log(cache);
          // cache.revalidatePromise = undefined;
          delete CACHE_REVALIDATE_PROMISE_POOL[cacheKey];
        });
    }
  }, [cacheKey, cache, key, log]);

  // 1. 注册revalidate函数到全局事件池
  // 2. mount阶段重新验证
  // 3. cacheKey变化时重新验证
  useLayoutEffect(() => {
    if (cacheKey) {
      const revalidate_key = window.crypto.randomUUID();
      if (!CACHE_REVIDATE_POOL[cacheKey]) {
        CACHE_REVIDATE_POOL[cacheKey] = {};
      }
      CACHE_REVIDATE_POOL[cacheKey][revalidate_key] = revalidate;

      requestAnimationFrame(revalidate);

      return () => {
        if (CACHE_REVIDATE_POOL[cacheKey][revalidate_key]) {
          delete CACHE_REVIDATE_POOL[cacheKey][revalidate_key];
        }
      };
    }
  }, [cacheKey]);

  // cache被删除时重新验证
  useLayoutEffect(() => {
    // 无cache并且也不是mount阶段
    if (!cache && !firstOfThisMount.current) {
      requestAnimationFrame(revalidate);
    }
  }, [cache]);

  useEffect(() => {
    return () => {
      unsubscribe.current?.();
    };
  }, [cacheKey]);

  useEffect(() => {
    firstOfThisMount.current = false;
    return () => {
      mount.current = false;
    };
  }, []);

  // 心跳包
  useLayoutEffect(() => {
    let timer: any;
    function next() {
      // Use the passed interval
      // ...or invoke the function with the updated data to get the interval
      const interval = 5000;

      // We only start the next interval if `refreshInterval` is not 0, and:
      // - `force` is true, which is the start of polling
      // - or `timer` is not 0, which means the effect wasn't canceled
      if (interval && timer !== -1) {
        timer = setTimeout(execute, interval);
      }
    }

    function execute() {
      // Check if it's OK to execute:
      // Only revalidate when the page is visible, online, and not errored.
      if (isVisible() /*  && isOnline() */) {
        revalidate()?.then(next);
      } else {
        // Schedule the next interval to check again.
        next();
      }
    }

    if (_options.autoRefresh) {
      next();
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = -1;
      }
    };
  }, [revalidate]);

  return [
    {
      // 依赖收集
      get data() {
        stateDependencies.current.data = true;
        return cache?.data ?? null;
      },
      get error() {
        stateDependencies.current.error = true;
        return cache?.error ?? null;
      },
      get loading() {
        stateDependencies.current.loading = true;
        return cache?.loading ?? true;
      },
    },
  ];
}

/**
 *
 * @param cacheKey
 * @param partialCache
 * @param tryToTriggerUpdate 是否触发组件更新, 一般用于批量修改缓存的情况, 设置为false, 在修改完成后手动触发一次更新以提高性能
 * @param revalidate 是否对数据进行验证,
 *
 */
type MutateOption<T> = {
  optimisticData?: Cache<T>;
  revalidate?: boolean;
};
const DEFAULT_MUTATE_OPTIONS = {
  revalidate: true,
};
function mutateCache<T>(
  cacheKey: string,
  mutationFun?: () => Promise<Cache<T> | void>,
  options?: MutateOption<T>
) {
  if (cacheKey) {
    const cache = readCache(cacheKey);
    // if this cache dependent on other cache
    // we dit not support mutationFun/options
    if (cache.__deps && cache.__deps.size > 0) {
      // 通知所有mount状态的组件重新验证数据
      // broadcastCacheChange(cacheKey);
      if (CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]) {
        Object.keys(CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]).forEach((key) => {
          CACHE_REVALIDATE_FUNCTION_POOL[cacheKey][key]();
        });
      }

      return;
    }

    const _options = { ...DEFAULT_MUTATE_OPTIONS, ...(options || {}) };

    // 乐观更新， 直接改变本地数据
    if (_options.optimisticData) {
      refreshCache(cacheKey, _options.optimisticData);
    }

    if (mutationFun) {
      mutationFun().then((nextCache) => {
        // 1. 乐观更新时， 不需要返回值， 直接revalidate
        // 2. 有的修改就没有返回值， 也直接revalidate
        if (!_options.optimisticData && nextCache) {
          refreshCache(cacheKey, nextCache);
        }

        // 通知所有mount状态的组件重新验证数据
        if (CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]) {
          Object.keys(CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]).forEach(
            (key) => {
              CACHE_REVALIDATE_FUNCTION_POOL[cacheKey][key]();
            }
          );
        }

        // if cache has parent caches, they should also revalidate
        if (cache.__parents && cache.__parents.size > 0) {
          for (const pKey of cache.__parents) {
            if (CACHE_REVALIDATE_FUNCTION_POOL[pKey]) {
              Object.keys(CACHE_REVALIDATE_FUNCTION_POOL[pKey]).forEach(
                (key) => {
                  CACHE_REVALIDATE_FUNCTION_POOL[pKey][key]();
                }
              );
            }
          }
        }
      });
    } else if (_options.revalidate) {
      // 通知所有mount状态的组件重新验证数据
      if (CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]) {
        Object.keys(CACHE_REVALIDATE_FUNCTION_POOL[cacheKey]).forEach((key) => {
          CACHE_REVALIDATE_FUNCTION_POOL[cacheKey][key]();
        });
      }

      // if cache has parent caches, they should also revalidate
      if (cache.__parents && cache.__parents.size > 0) {
        for (const pKey of cache.__parents) {
          if (CACHE_REVALIDATE_FUNCTION_POOL[pKey]) {
            Object.keys(CACHE_REVALIDATE_FUNCTION_POOL[pKey]).forEach((key) => {
              CACHE_REVALIDATE_FUNCTION_POOL[pKey][key]();
            });
          }
        }
      }
    }
  }
}

export { mutateCache };
export default useFetch;
