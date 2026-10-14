/**
 * @vitest-environment jsdom
 */
/* eslint-disable jest-dom/prefer-in-document -- @testing-library/jest-dom is not a dependency of packages/web */
import { fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EnterpriseTrialEndedDialog } from '@/features/billing/components/enterprise-trial-ended-dialog';

const state = vi.hoisted(() => ({ endsAt: new Date() }));

vi.mock('i18next', () => ({ t: (key: string) => key }));

vi.mock('@/hooks/platform-hooks', () => ({
  platformHooks: {
    useCurrentPlatform: () => ({
      platform: { id: 'platform-1', plan: { plan: 'free' } },
    }),
  },
}));

vi.mock('@/features/billing/hooks/enterprise-trial-hooks', () => ({
  ENTERPRISE_TRIAL_DAYS: 7,
  enterpriseTrialHooks: {
    useTrial: () => ({
      state: 'ended',
      endsAt: state.endsAt,
      isPlatformAdmin: true,
      basePlanName: 'Team',
    }),
  },
}));

vi.mock('@/features/billing/hooks/use-upgrade-click', () => ({
  useUpgradeClick: () => () => undefined,
}));

vi.mock('@/features/billing/components/enterprise-trial-sales-link', () => ({
  EnterpriseTrialSalesLink: () => null,
}));

vi.mock('@/features/billing/components/enterprise-trial-seat-dialog', () => ({
  EnterpriseTrialSeatDialog: () => <div>seat check</div>,
}));

beforeEach(() => {
  window.localStorage.clear();
});

describe('seat check after the trial', () => {
  it('runs only once the ended dialog is out of the way', () => {
    state.endsAt = dayjs().subtract(2, 'day').toDate();
    render(<EnterpriseTrialEndedDialog />);
    expect(screen.queryByText('seat check')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Explore plans' }));
    expect(screen.getByText('seat check')).toBeDefined();
  });

  it('still runs after the ended dialog stops showing', () => {
    state.endsAt = dayjs().subtract(20, 'day').toDate();
    render(<EnterpriseTrialEndedDialog />);
    expect(screen.getByText('seat check')).toBeDefined();
  });
});
