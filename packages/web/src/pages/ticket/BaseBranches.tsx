import { GitBranch } from "lucide-react";
import { useState } from "react";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Select } from "../../components/ui/input.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { t } from "../../i18n/en.ts";
import { BRANCH_TYPES } from "@slackoff/shared";
import { api, paths, type BaseBranchRepo, type BranchTypeView } from "../../lib/api.ts";
import { useAction, useApi } from "../../lib/hooks.ts";

/**
 * The branch each repo of this ticket starts from: the repository's default (Settings), develop for a feature, a
 * release branch for a fix. Chosen until the ticket branch exists, then shown as what it was made from. Nothing is
 * shown when the project has no repository mapped (the blocked banner says so).
 */
export function BaseBranches({ ticketKey, finished, canReset = false }: { ticketKey: string; finished: boolean; canReset?: boolean }) {
  const list = useApi<{ repos: BaseBranchRepo[] }>(paths.baseBranches(ticketKey));
  const set = useAction(api.setBaseBranch);
  const branch = useApi<BranchTypeView>(paths.branchType(ticketKey));
  const setType = useAction(api.setBranchType);
  const reset = useAction(api.resetBranch);
  const [open, setOpen] = useState(false);
  const repos = list.data?.repos ?? [];
  if (repos.length === 0) return null;
  const editable = !finished && repos.some((r) => !r.locked);
  return (
    <div data-testid="base-branches" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body-sm text-slate-600">
      {repos.map((r) => {
        const label = repos.length > 1 ? t("ticket.baseNamed", { repo: r.name }) : t("ticket.base");
        const current = r.chosen ?? r.default;
        return (
          <label key={r.name} className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-4 shrink-0 text-slate-500" aria-hidden />
            <span className="shrink-0">{label}</span>
            {r.locked || finished ? (
              <span className="min-w-0 break-all font-mono text-code-sm text-slate-700">{t("ticket.baseLocked", { branch: r.used ?? current })}</span>
            ) : (
              <Select
                aria-label={label}
                className="min-h-11 max-w-[16rem] font-mono md:min-h-0"
                value={current}
                disabled={set.pending}
                onFocus={() => setOpen(true)}
                onChange={(e) => void set.run(ticketKey, r.name, e.target.value === r.default ? null : e.target.value)}
              >
                {r.options.map((o) => (
                  <option key={o} value={o}>
                    {o === r.default ? t("ticket.baseDefault", { branch: o }) : o}
                  </option>
                ))}
              </Select>
            )}
          </label>
        );
      })}
      {branch.data && (
        // the ticket branch: <type>/<KEY>-<title>; the type until the branch exists
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{t("ticket.branch")}</span>
          {branch.data.locked || finished ? (
            <>
              <span className="min-w-0 break-all font-mono text-code-sm text-slate-700" data-testid="branch-name">{branch.data.name}</span>
              {canReset && !finished && (
                <Tooltip content={`${t("common.thisWill")} ${t("ticket.resetBranchThisWill")}`}>
                  <Button
                    className="min-h-11 shrink-0 md:min-h-7"
                    disabled={reset.pending}
                    data-testid="reset-branch"
                    onClick={() => {
                      if (window.confirm(t("ticket.resetBranchConfirm", { branch: branch.data!.name }))) void reset.run(ticketKey);
                    }}
                  >
                    {t("ticket.resetBranch")}
                  </Button>
                </Tooltip>
              )}
            </>
          ) : (
            <>
              <Select
                aria-label={t("ticket.branchType")}
                className="min-h-11 w-auto font-mono md:min-h-0"
                value={branch.data.type}
                disabled={setType.pending}
                onChange={(e) => void setType.run(ticketKey, e.target.value)}
              >
                {BRANCH_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
              <span className="min-w-0 break-all font-mono text-code-sm text-slate-500" data-testid="branch-name">
                /{branch.data.name.slice(branch.data.type.length + 1)}
              </span>
            </>
          )}
        </span>
      )}
      {editable && (open || repos.some((r) => r.chosen !== null)) && <ThisWill>{t("ticket.baseThisWill")}</ThisWill>}
      {(set.error ?? setType.error ?? reset.error) && <span role="alert" className="text-rose-700">{set.error ?? setType.error ?? reset.error}</span>}
    </div>
  );
}
