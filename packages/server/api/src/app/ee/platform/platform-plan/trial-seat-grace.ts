import { isNil, tryCatch } from '@activepieces/core-utils'
import { PlatformPlan, TrialSeatGrace, UserStatus } from '@activepieces/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { In, LessThanOrEqual, SelectQueryBuilder } from 'typeorm'
import { rejectedPromiseHandler } from '../../../helper/promise-handler'
import { billingProvider } from '../../../platform/billing-provider'
import { UserSchema } from '../../../user/user-entity'
import { excludeEmbeddedUsers, userRepo } from '../../../user/user-service'
import { userInvitationsService } from '../../../user-invitations/user-invitation.service'
import { platformPlanTelemetry } from './platform-plan-telemetry'
import { effectiveUsersLimit, platformPlanRepo } from './platform-plan.service'

const SEAT_GRACE_DAYS = 7
const SWEEP_BATCH_SIZE = 100

export const trialSeatGrace = (log: FastifyBaseLogger) => ({
    async onEntitlementsRefreshed({ platformId, previousPlan, trialEnded, billingEnforced }: OnEntitlementsRefreshedParams): Promise<void> {
        const { error } = await tryCatch(async () => {
            if (trialEnded) {
                await startIfOverSeats({ platformId, trialStartedAt: previousPlan?.enterpriseTrialStartedAt ?? null, billingEnforced, log })
                return
            }
            if (!isNil(previousPlan?.seatGraceEndsAt)) {
                await settleSeatGrace({ plan: await platformPlanRepo().findOneByOrFail({ platformId }), billingEnforced, log })
            }
        })
        if (!isNil(error)) {
            log.error({ error, platform: { id: platformId } }, 'Failed to update the seat grace after an entitlements refresh')
        }
    },
    async get({ plan, billingEnforced }: GetParams): Promise<TrialSeatGrace | null> {
        return settleSeatGrace({ plan, billingEnforced, log })
    },
    async sweep(): Promise<void> {
        const due = await platformPlanRepo().find({
            select: { platformId: true },
            where: { seatGraceEndsAt: LessThanOrEqual(dayjs().toISOString()) },
            take: SWEEP_BATCH_SIZE,
        })
        for (const { platformId } of due) {
            const { error } = await tryCatch(() => deactivateUsersOverPlan({ platformId, log }))
            if (!isNil(error)) {
                log.error({ error, platform: { id: platformId } }, 'Failed to end the seat grace')
            }
        }
    },
})

async function startIfOverSeats({ platformId, trialStartedAt, billingEnforced, log }: StartIfOverSeatsParams): Promise<void> {
    if (isNil(trialStartedAt)) {
        return
    }
    const seatGraceTrialStartedAt = dayjs(trialStartedAt).toISOString()
    const plan = await platformPlanRepo().findOneByOrFail({ platformId })
    const grace = await findSeatsOverPlan({ plan: { ...plan, seatGraceTrialStartedAt }, billingEnforced, log })
    if (isNil(grace)) {
        return
    }
    const seatGraceEndsAt = dayjs().add(SEAT_GRACE_DAYS, 'day').toISOString()
    await platformPlanRepo().update({ platformId }, { seatGraceEndsAt, seatGraceTrialStartedAt })
    log.info({ platform: { id: platformId }, seatGrace: { endsAt: seatGraceEndsAt, usersCount: grace.userIds.length } }, 'Enterprise trial ended over the plan seats, seat grace started')
}

async function settleSeatGrace({ plan, billingEnforced, log }: FindSeatsOverPlanParams): Promise<TrialSeatGrace | null> {
    if (isNil(plan.seatGraceEndsAt)) {
        return null
    }
    const grace = await findSeatsOverPlan({ plan, billingEnforced, log })
    if (isNil(grace)) {
        await clearSeatGrace(plan.platformId)
    }
    return grace
}

async function deactivateUsersOverPlan({ platformId, log }: PlatformLogParams): Promise<void> {
    await billingProvider.get(log).refreshEntitlements(platformId)
    const [plan, billingEnforced] = await Promise.all([
        platformPlanRepo().findOneByOrFail({ platformId }),
        billingProvider.get(log).isBillingEnforced(platformId),
    ])
    const grace = await findSeatsOverPlan({ plan, billingEnforced, log })
    const userIds = grace?.userIds ?? []
    if (userIds.length > 0) {
        await userRepo().update({ id: In(userIds), platformId }, { status: UserStatus.INACTIVE })
        rejectedPromiseHandler(platformPlanTelemetry(log).onTrialSeatsDeactivated({ platformId, deactivatedUsers: userIds.length }), log)
    }
    await clearSeatGrace(platformId)
    log.info({ platform: { id: platformId }, seatGrace: { deactivatedCount: userIds.length } }, 'Seat grace ended')
}

async function findSeatsOverPlan({ plan, billingEnforced, log }: FindSeatsOverPlanParams): Promise<TrialSeatGrace | null> {
    const seatLimit = effectiveUsersLimit(plan)
    const addedSince = plan.seatGraceTrialStartedAt
    if (!billingEnforced || isNil(seatLimit) || isNil(addedSince)) {
        return null
    }
    const [activeUsers, invitedSeats] = await Promise.all([
        activeUsersNotEmbedded(plan.platformId).getCount(),
        userInvitationsService(log).countReservedSeats({ platformId: plan.platformId }),
    ])
    const usedSeats = activeUsers + invitedSeats
    const seatsOver = usedSeats - seatLimit
    if (seatsOver <= 0) {
        return null
    }
    const newestAdded = await activeUsersNotEmbedded(plan.platformId)
        .andWhere('user.created >= :addedSince', { addedSince: dayjs(addedSince).toISOString() })
        .andWhere(USER_IS_NOT_THE_PLATFORM_OWNER)
        .orderBy('user.created', 'DESC')
        .limit(seatsOver)
        .getMany()
    if (newestAdded.length === 0) {
        return null
    }
    return { usedSeats, userIds: newestAdded.map((user) => user.id) }
}

function activeUsersNotEmbedded(platformId: string): SelectQueryBuilder<UserSchema> {
    return excludeEmbeddedUsers(userRepo()
        .createQueryBuilder('user')
        .where('user.platformId = :platformId', { platformId })
        .andWhere('user.status = :status', { status: UserStatus.ACTIVE }))
}

async function clearSeatGrace(platformId: string): Promise<void> {
    await platformPlanRepo().update({ platformId }, { seatGraceEndsAt: null, seatGraceTrialStartedAt: null })
}

const USER_IS_NOT_THE_PLATFORM_OWNER = `NOT EXISTS (
    SELECT 1
    FROM platform
    WHERE platform.id = "user"."platformId"
    AND platform."ownerId" = "user".id
)`

type OnEntitlementsRefreshedParams = {
    platformId: string
    previousPlan: PlatformPlan | null
    trialEnded: boolean
    billingEnforced: boolean
}

type GetParams = {
    plan: PlatformPlan
    billingEnforced: boolean
}

type StartIfOverSeatsParams = {
    platformId: string
    trialStartedAt: string | Date | null
    billingEnforced: boolean
    log: FastifyBaseLogger
}

type PlatformLogParams = {
    platformId: string
    log: FastifyBaseLogger
}

type FindSeatsOverPlanParams = {
    plan: PlatformPlan
    billingEnforced: boolean
    log: FastifyBaseLogger
}
