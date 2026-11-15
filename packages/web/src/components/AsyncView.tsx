import type { ReactNode } from "react";
import { t } from "../i18n/en.ts";
import type { ApiState } from "../lib/hooks.ts";
import { Button } from "./ui/button.tsx";

export function Loading({ label }: { label?: string }) {
  return <div className="px-3 py-6 text-center text-body-sm text-slate-500">{label ?? t("common.loading")}</div>;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-body-sm text-rose-700">
      <span>
        {t("common.error")}: {error}
      </span>
      {onRetry && (
        <Button size="sm" variant="destructive" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <div className="px-3 py-6 text-center text-body-sm text-slate-500">{children ?? t("common.empty")}</div>;
}

/** Loading / error / empty / content for one useApi result. Keeps showing stale data while refetching. */
export function AsyncView<T>({
  state,
  isEmpty,
  empty,
  children,
}: {
  state: ApiState<T>;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
}) {
  if (state.data === undefined) {
    if (state.error) return <ErrorBox error={state.error.message} onRetry={state.reload} />;
    return <Loading />;
  }
  if (isEmpty?.(state.data)) return <Empty>{empty}</Empty>;
  return <>{children(state.data)}</>;
}
