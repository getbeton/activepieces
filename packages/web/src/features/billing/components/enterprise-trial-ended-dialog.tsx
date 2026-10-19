import { isNil } from '@activepieces/core-utils';
import { PlatformAdminSurface } from '@activepieces/shared';
import dayjs from 'dayjs';
import { t } from 'i18next';
import { Check, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { platformHooks } from '@/hooks/platform-hooks';
import { AdminControl, adminControl } from '@/lib/admin-control';
import { authenticationSession } from '@/lib/authentication-session';

import { billingDialogHooks } from '../hooks/billing-dialog-hooks';
import { billingQueries } from '../hooks/billing-hooks';
import { enterpriseTrialHooks } from '../hooks/enterprise-trial-hooks';
import { useUpgradeClick } from '../hooks/use-upgrade-click';
import { enterpriseTrialCopy } from '../utils/enterprise-trial-copy';
import { enterpriseTrialFeatures } from '../utils/enterprise-trial-features';
import { enterpriseTrialTime } from '../utils/enterprise-trial-time';
import { enterpriseTrialUi } from '../utils/enterprise-trial-ui';

import { EnterpriseTrialSalesLink } from './enterprise-trial-sales-link';
import { EnterpriseTrialSeatDialog } from './enterprise-trial-seat-dialog';

export function EnterpriseTrialEndedDialog() {
  const { platform } = platformHooks.useCurrentPlatform();
  const trial = enterpriseTrialHooks.useTrial();
  const grace = enterpriseTrialHooks.useSeatGrace();
  const { openDialog: openSeatDialog } =
    billingDialogHooks.useTrialSeatDialogStore();
  const upgradeClick = useUpgradeClick();
  const storageKey = `${SEEN_KEY_PREFIX}${enterpriseTrialUi.trialStorageId({
    platformId: platform.id,
    userId: authenticationSession.getCurrentUserId(),
    endsAt: trial.endsAt,
  })}`;
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const seen = seenKey === storageKey || enterpriseTrialUi.readFlag(storageKey);

  const recent =
    !isNil(trial.endsAt) &&
    enterpriseTrialTime.calendarDaysBetween({
      from: trial.endsAt,
      to: Date.now(),
    }) <= SHOW_FOR_DAYS;
  const open =
    trial.state === 'ended' && trial.isPlatformAdmin && recent && !seen;
  const { data: info } = billingQueries.usePlatformSubscription(
    platform.id,
    open && !isNil(grace),
  );
  const overSeats = info?.seatGrace?.userIds.length ?? 0;
  const close = () => {
    enterpriseTrialUi.writeFlag(storageKey);
    setSeenKey(storageKey);
  };
  const locked = enterpriseTrialFeatures.lockedAfterTrial(platform.plan.plan);
  const kept = [t('Flows, connections and data'), t('Your credits')];

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent
          onOpenAutoFocus={enterpriseTrialUi.focusDialogItself}
          className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-7 sm:max-w-lg sm:rounded-2xl"
        >
          <div className="flex flex-col gap-2 pr-6">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {t('Thanks for trying the Enterprise plan')}
            </DialogTitle>
            <DialogDescription className="text-base text-pretty">
              {isNil(trial.endsAt)
                ? t('You are back on the {plan} plan.', {
                    plan: trial.basePlanName,
                  })
                : t('It ended on {date}. You are back on the {plan} plan.', {
                    date: dayjs(trial.endsAt).format('MMM D'),
                    plan: trial.basePlanName,
                  })}
            </DialogDescription>
          </div>
          {!isNil(grace) && overSeats > 0 && (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-warning-7 bg-warning-3 p-3.5 text-sm text-warning-11">
              <p className="flex items-start gap-2.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {enterpriseTrialCopy.seatGraceNotice({
                  count: overSeats,
                  plan: trial.basePlanName,
                  endsAt: grace.endsAt,
                })}
              </p>
              <Button
                {...adminControl(AdminControl.TRIAL_SEATS_OPEN)}
                variant="outline"
                size="sm"
                onClick={() => {
                  close();
                  openSeatDialog();
                }}
              >
                {t('Manage seats')}
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium text-gray-12">
              {t('Everything you built is still here')}
            </span>
            <ul className="flex flex-col gap-2.5">
              {kept.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 text-sm text-gray-12"
                >
                  <Check className="size-4 shrink-0 text-success-11" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          {locked.length > 0 && (
            <div className="flex flex-col gap-3 border-t pt-5">
              <span className="text-sm text-gray-11">
                {t('Locked for changes')}
              </span>
              <ul className="flex flex-wrap gap-2">
                {locked.map((feature) => (
                  <li
                    key={feature.title}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-gray-11"
                  >
                    <feature.icon className="size-3.5 shrink-0 text-gray-9" />
                    {feature.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-gray-11">
            {t(
              'Our team can extend your trial or set you up on the Enterprise plan.',
            )}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              {...adminControl(AdminControl.TRIAL_PLANS_OPEN)}
              variant="outline"
              onClick={() => {
                close();
                upgradeClick({ surface: PlatformAdminSurface.DIALOG });
              }}
            >
              {t('Explore plans')}
            </Button>
            <EnterpriseTrialSalesLink
              surface="enterprise_trial_ended"
              variant="default"
            />
          </div>
        </DialogContent>
      </Dialog>
      {!open && <EnterpriseTrialSeatDialog />}
    </>
  );
}

const SEEN_KEY_PREFIX = 'ap-enterprise-trial-ended-seen-';
const SHOW_FOR_DAYS = 14;
