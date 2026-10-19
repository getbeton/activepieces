import { PlatformRole, PrincipalType, User, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { getBillingEnforcedKey, getBillingOverviewKey } from '../../../../src/app/database/redis/keys'
import { distributedStore } from '../../../../src/app/database/redis-connections'
import { autumnUtils } from '../../../../src/app/ee/platform/platform-plan/billing-providers/autumn-utils'
import { platformPlanRepo } from '../../../../src/app/ee/platform/platform-plan/platform-plan.service'
import { trialSeatGrace } from '../../../../src/app/ee/platform/platform-plan/trial-seat-grace'
import { BillingOverview } from '../../../../src/app/platform/billing-provider'
import { userRepo } from '../../../../src/app/user/user-service'
import { generateMockToken } from '../../../helpers/auth'
import { mockAndSaveBasicSetup, mockBasicUser } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let log: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    log = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(() => {
    vi.restoreAllMocks()
})

const TRIAL_STARTED_AT = dayjs().subtract(10, 'day').toISOString()

describe('Seat grace after the Enterprise trial', () => {
    it('starts when the trial ends with users added during it beyond the plan seats', async () => {
        const { platformId, trialUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3 })

        await endTrial({ platformId, billingEnforced: true })

        const plan = await platformPlanRepo().findOneByOrFail({ platformId })
        expect(dayjs(plan.seatGraceEndsAt).diff(dayjs().add(7, 'day'), 'minute')).toBe(0)
        expect(dayjs(plan.seatGraceTrialStartedAt).toISOString()).toBe(TRIAL_STARTED_AT)
        expect(await trialSeatGrace(log).get({ plan, billingEnforced: true })).toEqual({
            usedSeats: 5,
            userIds: [trialUsers[2].id, trialUsers[1].id],
        })
    })

    it('does not start when the platform fits its plan', async () => {
        const { platformId } = await setupPlatform({ usersLimit: 5, preTrialUsers: 1, trialUsers: 3 })

        await endTrial({ platformId, billingEnforced: true })

        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).toBeNull()
    })

    it('does not start when billing is not enforced', async () => {
        const { platformId } = await setupPlatform({ usersLimit: 1, trialUsers: 2 })

        await endTrial({ platformId, billingEnforced: false })

        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).toBeNull()
    })

    it('leaves embedded users out of the count and never picks them', async () => {
        const { platformId, trialUsers } = await setupPlatform({ usersLimit: 2, trialUsers: 2, embeddedTrialUsers: 3 })

        await endTrial({ platformId, billingEnforced: true })

        const plan = await platformPlanRepo().findOneByOrFail({ platformId })
        expect(await trialSeatGrace(log).get({ plan, billingEnforced: true })).toEqual({
            usedSeats: 3,
            userIds: [trialUsers[1].id],
        })
    })

    it('stays while the platform is over its seats and clears on the refresh after it fits', async () => {
        const { platformId, trialUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3 })
        await endTrial({ platformId, billingEnforced: true })

        await refreshWithoutTrialChange({ platformId })
        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).not.toBeNull()

        await deactivate([trialUsers[0], trialUsers[1]])
        await refreshWithoutTrialChange({ platformId })
        const plan = await platformPlanRepo().findOneByOrFail({ platformId })
        expect(plan.seatGraceEndsAt).toBeNull()
        expect(plan.seatGraceTrialStartedAt).toBeNull()
    })

    it('deactivates the users added during the trial beyond the plan seats when the grace ends', async () => {
        const { platformId, owner, preTrialUsers, trialUsers, embeddedUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3, embeddedTrialUsers: 1 })
        await endTrial({ platformId, billingEnforced: true })
        await endGraceNow(platformId)

        await trialSeatGrace(log).sweep()

        expect(await statusOf(trialUsers[2])).toBe(UserStatus.INACTIVE)
        expect(await statusOf(trialUsers[1])).toBe(UserStatus.INACTIVE)
        for (const kept of [owner, preTrialUsers[0], trialUsers[0], embeddedUsers[0]]) {
            expect(await statusOf(kept)).toBe(UserStatus.ACTIVE)
        }
        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).toBeNull()
    })

    it('deactivates nobody when the plan gained seats before the grace ended', async () => {
        const { platformId, trialUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3 })
        await endTrial({ platformId, billingEnforced: true })
        await platformPlanRepo().update({ platformId }, { usersLimit: 10 })
        await endGraceNow(platformId)

        await trialSeatGrace(log).sweep()

        for (const user of trialUsers) {
            expect(await statusOf(user)).toBe(UserStatus.ACTIVE)
        }
        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).toBeNull()
    })

    it('leaves a grace that has not ended yet alone', async () => {
        const { platformId, trialUsers } = await setupPlatform({ usersLimit: 1, trialUsers: 2 })
        await endTrial({ platformId, billingEnforced: true })
        stubRefresh()

        await trialSeatGrace(log).sweep()

        for (const user of trialUsers) {
            expect(await statusOf(user)).toBe(UserStatus.ACTIVE)
        }
        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).not.toBeNull()
    })

    it('lists the users who would be deactivated to a platform admin in the billing info', async () => {
        const { platformId, owner, trialUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3 })
        await endTrial({ platformId, billingEnforced: true })
        await distributedStore.put(getBillingOverviewKey(platformId), FREE_OVERVIEW, 300)
        const token = await generateMockToken({ id: owner.id, type: PrincipalType.USER, platform: { id: platformId } })

        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/platform-billing/info',
            headers: { authorization: `Bearer ${token}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().seatGrace).toEqual({ usedSeats: 5, userIds: [trialUsers[2].id, trialUsers[1].id] })
    })

    it('clears the grace when the billing info finds the platform fits again', async () => {
        const { platformId, owner, trialUsers } = await setupPlatform({ usersLimit: 3, preTrialUsers: 1, trialUsers: 3 })
        await endTrial({ platformId, billingEnforced: true })
        await deactivate([trialUsers[2], trialUsers[1]])
        await distributedStore.put(getBillingOverviewKey(platformId), FREE_OVERVIEW, 300)
        const token = await generateMockToken({ id: owner.id, type: PrincipalType.USER, platform: { id: platformId } })

        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/platform-billing/info',
            headers: { authorization: `Bearer ${token}` },
        })

        expect(response.json().seatGrace).toBeNull()
        expect((await platformPlanRepo().findOneByOrFail({ platformId })).seatGraceEndsAt).toBeNull()
    })
})

async function setupPlatform({ usersLimit, preTrialUsers = 0, trialUsers = 0, embeddedTrialUsers = 0 }: SetupPlatformParams): Promise<SetupPlatformResult> {
    const { mockOwner, mockPlatform } = await mockAndSaveBasicSetup({ plan: { usersLimit, scheduledUsersLimit: null } })
    await distributedStore.put(getBillingEnforcedKey(mockPlatform.id), true, 300)
    return {
        platformId: mockPlatform.id,
        owner: mockOwner,
        preTrialUsers: await addUsers({ platformId: mockPlatform.id, count: preTrialUsers, firstDaysAgo: 30 }),
        trialUsers: await addUsers({ platformId: mockPlatform.id, count: trialUsers, firstDaysAgo: 5 }),
        embeddedUsers: await addUsers({ platformId: mockPlatform.id, count: embeddedTrialUsers, firstDaysAgo: 2, provider: UserIdentityProvider.JWT }),
    }
}

async function addUsers({ platformId, count, firstDaysAgo, provider = UserIdentityProvider.EMAIL }: AddUsersParams): Promise<User[]> {
    return Promise.all(Array.from({ length: count }, async (_, index) => {
        const { mockUser } = await mockBasicUser({
            userIdentity: { provider },
            user: {
                platformId,
                platformRole: PlatformRole.MEMBER,
                status: UserStatus.ACTIVE,
                created: dayjs().subtract(firstDaysAgo, 'day').add(index, 'hour').toISOString(),
            },
        })
        return mockUser
    }))
}

async function endTrial({ platformId, billingEnforced }: EndTrialParams): Promise<void> {
    const plan = await platformPlanRepo().findOneByOrFail({ platformId })
    await trialSeatGrace(log).onEntitlementsRefreshed({
        platformId,
        previousPlan: { ...plan, enterpriseTrialStartedAt: TRIAL_STARTED_AT },
        trialEnded: true,
        billingEnforced,
    })
}

async function refreshWithoutTrialChange({ platformId }: { platformId: string }): Promise<void> {
    const plan = await platformPlanRepo().findOneByOrFail({ platformId })
    await trialSeatGrace(log).onEntitlementsRefreshed({ platformId, previousPlan: plan, trialEnded: false, billingEnforced: true })
}

async function endGraceNow(platformId: string): Promise<void> {
    await platformPlanRepo().update({ platformId }, { seatGraceEndsAt: dayjs().subtract(1, 'minute').toISOString() })
    stubRefresh()
}

function stubRefresh(): void {
    vi.spyOn(autumnUtils, 'refreshEntitlements').mockResolvedValue(undefined)
}

async function deactivate(users: User[]): Promise<void> {
    for (const user of users) {
        await userRepo().update({ id: user.id }, { status: UserStatus.INACTIVE })
    }
}

async function statusOf(user: User): Promise<UserStatus> {
    return (await userRepo().findOneByOrFail({ id: user.id })).status
}

const FREE_OVERVIEW: BillingOverview = {
    startDate: dayjs().toISOString(),
    endDate: dayjs().add(1, 'month').toISOString(),
    nextBillingAmount: 0,
    cancelAt: null,
    trialEndsAt: null,
    planName: 'Free',
    scheduledPlanName: null,
    billingPortalAvailable: false,
    creditsResetInterval: null,
    planInterval: null,
    creditsFeature: null,
    appSumoCreditsFeature: null,
    seatsFeature: null,
    includedSeats: null,
    additionalSeats: null,
    unavailable: false,
}

type SetupPlatformParams = {
    usersLimit: number
    preTrialUsers?: number
    trialUsers?: number
    embeddedTrialUsers?: number
}

type SetupPlatformResult = {
    platformId: string
    owner: User
    preTrialUsers: User[]
    trialUsers: User[]
    embeddedUsers: User[]
}

type AddUsersParams = {
    platformId: string
    count: number
    firstDaysAgo: number
    provider?: UserIdentityProvider
}

type EndTrialParams = {
    platformId: string
    billingEnforced: boolean
}
