import { isNil, tryCatch } from '@activepieces/core-utils'
import { apDayjs } from '@activepieces/server-utils'
import { PlatformPlan, TrialSeatGrace, UserStatus } from '@activepieces/shared'
import dayjs, { Dayjs } from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In, LessThanOrEqual, SelectQueryBuilder } from 'typeorm'
import { transaction } from '../../../core/db/transaction'
import { rejectedPromiseHandler } from '../../../helper/promise-handler'
import { billingProvider } from '../../../platform/billing-provider'
import { UserSchema } from '../../../user/user-entity'
import { excludeEmbeddedUsers, userRepo } from '../../../user/user-service'
import { userInvitationsService } from '../../../user-invitations/user-invitation.service'
import { platformPlanTelemetry } from './platform-plan-telemetry'
import { platformPlanRepo } from './platform-plan.service'

const SEAT_GRACE_DAYS = 7
const SWEEP_BATCH_SIZE = 100
const SWEEP_HOUR_UTC = 15
const SWEEP_MINUTE_UTC = 30

export const trialSeatGrace = (log: FastifyBaseLogger) => ({
    async startOnTrialEnd({ platformId, seatLimit, trialStartedAt, billingEnforced }: StartOnTrialEndParams): Promise<SeatGraceColumns> {
        if (isNil(trialStartedAt)) {
            return {}
        }
        const addedSince = dayjs(trialStartedAt).toISOString()
        const grace = await findSeatsOverPlan({ platformId, seatLimit, addedSince, billingEnforced, log })
        if (isNil(grace)) {
            return {}
        }
        const seatGraceEndsAt = firstSweepFrom(apDayjs().add(SEAT_GRACE_DAYS, 'day')).toISOString()
        log.info({ platform: { id: platformId }, seatGrace: { endsAt: seatGraceEndsAt, usersCount: grace.userIds.length } }, 'Enterprise trial ended over the plan seats, seat grace starts')
        return { seatGraceEndsAt, seatGraceTrialStartedAt: addedSince }
    },
    async settle({ platformId, billingEnforced }: SettleParams): Promise<void> {
        const { error } = await tryCatch(async () => settleSeatGrace({ plan: await platformPlanRepo().findOneByOrFail({ platformId }), billingEnforced, log }))
        if (!isNil(error)) {
            log.error({ error, platform: { id: platformId } }, 'Failed to settle the seat grace after an entitlements refresh')
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

async function settleSeatGrace({ plan, billingEnforced, log }: SettleSeatGraceParams): Promise<TrialSeatGrace | null> {
    if (isNil(plan.seatGraceEndsAt)) {
        return null
    }
    const grace = await findSeatsOverPlan({
        platformId: plan.platformId,
        seatLimit: plan.usersLimit,
        addedSince: plan.seatGraceTrialStartedAt,
        billingEnforced,
        log,
    })
    if (isNil(grace)) {
        await platformPlanRepo().update({ platformId: plan.platformId }, CLEARED_SEAT_GRACE)
    }
    return grace
}

async function deactivateUsersOverPlan({ platformId, log }: PlatformLogParams): Promise<void> {
    await billingProvider.get(log).refreshEntitlements(platformId)
    const billingEnforced = await billingProvider.get(log).isBillingEnforced(platformId)
    const deactivated = await transaction(async (entityManager) => {
        const plan = await platformPlanRepo(entityManager)
            .createQueryBuilder('platform_plan')
            .setLock('pessimistic_write')
            .where('platform_plan.platformId = :platformId', { platformId })
            .getOneOrFail()
        await activeUsers({ platformId, entityManager }).setLock('pessimistic_write').select('user.id').getMany()
        const grace = await findSeatsOverPlan({
            platformId,
            seatLimit: plan.usersLimit,
            addedSince: plan.seatGraceTrialStartedAt,
            billingEnforced,
            log,
            entityManager,
        })
        const userIds = grace?.userIds ?? []
        if (userIds.length > 0) {
            await userRepo(entityManager).update({ id: In(userIds), platformId }, { status: UserStatus.INACTIVE })
        }
        await platformPlanRepo(entityManager).update({ platformId }, CLEARED_SEAT_GRACE)
        return userIds.length
    })
    if (deactivated > 0) {
        rejectedPromiseHandler(platformPlanTelemetry(log).onTrialSeatsDeactivated({ platformId, deactivatedUsers: deactivated }), log)
    }
    log.info({ platform: { id: platformId }, seatGrace: { deactivatedCount: deactivated } }, 'Seat grace ended')
}

async function findSeatsOverPlan({ platformId, seatLimit, addedSince, billingEnforced, log, entityManager }: FindSeatsOverPlanParams): Promise<TrialSeatGrace | null> {
    if (!billingEnforced || isNil(seatLimit) || isNil(addedSince)) {
        return null
    }
    const [activeUserCount, invitedSeats] = await Promise.all([
        excludeEmbeddedUsers(activeUsers({ platformId, entityManager })).getCount(),
        userInvitationsService(log).countReservedSeats({ platformId, entityManager }),
    ])
    const usedSeats = activeUserCount + invitedSeats
    const seatsOver = usedSeats - seatLimit
    if (seatsOver <= 0) {
        return null
    }
    const newestAdded = await excludeEmbeddedUsers(activeUsers({ platformId, entityManager }))
        .andWhere('user.created >= :addedSince', { addedSince: dayjs(addedSince).toISOString() })
        .andWhere(USER_IS_NOT_THE_PLATFORM_OWNER)
        .orderBy('user.created', 'DESC')
        .limit(seatsOver)
        .getMany()
    if (newestAdded.length === 0) {
        return null
    }
    return { usedSeats, seatLimit, userIds: newestAdded.map((user) => user.id) }
}

function firstSweepFrom(moment: Dayjs): Dayjs {
    const sameDaySweep = moment.utc().hour(SWEEP_HOUR_UTC).minute(SWEEP_MINUTE_UTC).second(0).millisecond(0)
    return sameDaySweep.isBefore(moment) ? sameDaySweep.add(1, 'day') : sameDaySweep
}

function activeUsers({ platformId, entityManager }: ActiveUsersParams): SelectQueryBuilder<UserSchema> {
    return userRepo(entityManager)
        .createQueryBuilder('user')
        .where('user.platformId = :platformId', { platformId })
        .andWhere('user.status = :status', { status: UserStatus.ACTIVE })
}

const CLEARED_SEAT_GRACE = { seatGraceEndsAt: null, seatGraceTrialStartedAt: null }

const USER_IS_NOT_THE_PLATFORM_OWNER = `NOT EXISTS (
    SELECT 1
    FROM platform
    WHERE platform.id = "user"."platformId"
    AND platform."ownerId" = "user".id
)`

type SeatGraceColumns = Partial<Pick<PlatformPlan, 'seatGraceEndsAt' | 'seatGraceTrialStartedAt'>>

type StartOnTrialEndParams = {
    platformId: string
    seatLimit: number | null
    trialStartedAt: string | Date | null
    billingEnforced: boolean
}

type SettleParams = {
    platformId: string
    billingEnforced: boolean
}

type GetParams = {
    plan: PlatformPlan
    billingEnforced: boolean
}

type SettleSeatGraceParams = {
    plan: PlatformPlan
    billingEnforced: boolean
    log: FastifyBaseLogger
}

type PlatformLogParams = {
    platformId: string
    log: FastifyBaseLogger
}

type FindSeatsOverPlanParams = {
    platformId: string
    seatLimit: number | null | undefined
    addedSince: string | Date | null | undefined
    billingEnforced: boolean
    log: FastifyBaseLogger
    entityManager?: EntityManager
}

type ActiveUsersParams = {
    platformId: string
    entityManager?: EntityManager
}

export const TRIAL_SEAT_GRACE_SWEEP_CRON = `${SWEEP_MINUTE_UTC} ${SWEEP_HOUR_UTC} * * *`
