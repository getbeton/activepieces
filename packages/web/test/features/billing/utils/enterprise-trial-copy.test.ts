import { beforeAll, describe, expect, it } from 'vitest';

import type { SeatGrace } from '@/features/billing/hooks/enterprise-trial-hooks';
import { enterpriseTrialCopy } from '@/features/billing/utils/enterprise-trial-copy';

import { icuI18n } from '../../../i18n/icu-i18n';

const ENDS_AT = new Date(2026, 9, 26, 12, 0, 0);

function seatGrace(overrides: Partial<SeatGrace> = {}): SeatGrace {
  return {
    endsAt: ENDS_AT,
    daysLeft: 3,
    endsToday: false,
    ending: false,
    seats: 5,
    isPlatformAdmin: false,
    ...overrides,
  };
}

beforeAll(async () => {
  await icuI18n.init();
});

describe('seat grace tooltip', () => {
  it('tells a member who loses access and when', () => {
    expect(enterpriseTrialCopy.seatGraceTooltip(seatGrace())).toBe(
      "Your Enterprise trial has ended. Users added during it beyond the plan's 5 seats lose access on Oct 26 unless an admin upgrades.",
    );
  });

  it('says one seat for a single-seat plan', () => {
    expect(enterpriseTrialCopy.seatGraceTooltip(seatGrace({ seats: 1 }))).toBe(
      "Your Enterprise trial has ended. Users added during it beyond the plan's 1 seat lose access on Oct 26 unless an admin upgrades.",
    );
  });

  it('tells an admin what is deactivated and where to act', () => {
    expect(
      enterpriseTrialCopy.seatGraceTooltip(
        seatGrace({ isPlatformAdmin: true }),
      ),
    ).toBe(
      "Users added during the trial beyond the plan's 5 seats will be deactivated on Oct 26. Manage seats, or upgrade to keep them.",
    );
  });
});

describe('seat grace sidebar detail', () => {
  it('names the day extra users lose access', () => {
    expect(enterpriseTrialCopy.seatGraceSidebarDetail(seatGrace())).toBe(
      'Extra users lose access Oct 26',
    );
  });
});

describe('seat grace notice', () => {
  it('agrees with a single user', () => {
    expect(
      enterpriseTrialCopy.seatGraceNotice({
        count: 1,
        plan: 'Team',
        endsAt: ENDS_AT,
      }),
    ).toBe(
      "1 user added during the trial is over the Team plan's seats and will be deactivated on Oct 26.",
    );
  });

  it('agrees with several users', () => {
    expect(
      enterpriseTrialCopy.seatGraceNotice({
        count: 3,
        plan: 'Free',
        endsAt: ENDS_AT,
      }),
    ).toBe(
      "3 users added during the trial are over the Free plan's seats and will be deactivated on Oct 26.",
    );
  });
});

describe('seat grace countdown', () => {
  it.each([
    { name: 'days away', grace: { daysLeft: 3 }, expected: '3 days left' },
    {
      name: 'the day before',
      grace: { daysLeft: 1, ending: true },
      expected: '1 day left',
    },
    {
      name: 'the last day',
      grace: { daysLeft: 0, ending: true, endsToday: true },
      expected: 'last day',
    },
  ])('reads $expected when it is $name', ({ grace, expected }) => {
    expect(enterpriseTrialCopy.cardStatus(seatGrace(grace))).toBe(expected);
  });
});
