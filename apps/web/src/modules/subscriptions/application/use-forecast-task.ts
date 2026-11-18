import { useEffect, useMemo, useState } from "react";

type ForecastTask<T> = () => Generator<void, T>;

function advance<T>(task: Generator<void, T>) {
  const deadline = performance.now() + 8;
  let result = task.next();
  while (!result.done && performance.now() < deadline) result = task.next();
  return result;
}

/** 首次渲染只做一片；实际算完的结果立即可用，剩余工作在提交后继续，避免按条数无条件增加加载轮次。 */
export function useForecastTask<T>(factory: ForecastTask<T>): T | undefined {
  const prepared = useMemo(() => {
    const task = factory();
    return { task, result: advance(task) };
  }, [factory]);
  const [completed, setCompleted] = useState<{ factory: ForecastTask<T>; value?: T; error?: unknown }>();

  useEffect(() => {
    if (prepared.result.done) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const task = prepared.task;
    const run = () => {
      if (cancelled) return;
      try {
        const result = advance(task);
        if (result.done) setCompleted({ factory, value: result.value });
        else timer = setTimeout(run, 0);
      } catch (error) {
        setCompleted({ factory, error });
      }
    };
    timer = setTimeout(run, 0);
    return () => {
      // 换月、编辑或换账号后取消剩余工作；旧任务既不能提交，也不能在卸载后继续消耗 CPU。
      cancelled = true;
      clearTimeout(timer);
    };
  }, [factory, prepared]);

  if (prepared.result.done) return prepared.result.value;
  if (completed?.factory !== factory) return undefined;
  if (completed.error !== undefined) throw completed.error;
  return completed.value;
}
