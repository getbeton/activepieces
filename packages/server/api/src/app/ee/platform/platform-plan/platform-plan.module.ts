import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { SystemJobName } from '../../../helper/system-jobs/common'
import { systemJobHandlers } from '../../../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../../../helper/system-jobs/system-job'
import { platformPlanController } from './platform-plan.controller'
import { trialSeatGrace } from './trial-seat-grace'

export const platformPlanModule: FastifyPluginAsyncZod = async (app) => {
    systemJobHandlers.registerJobHandler(SystemJobName.TRIAL_SEAT_GRACE_SWEEP, async () => {
        await trialSeatGrace(app.log).sweep()
    })
    await systemJobsSchedule(app.log).upsertJob({
        job: {
            name: SystemJobName.TRIAL_SEAT_GRACE_SWEEP,
            data: {},
            jobId: SystemJobName.TRIAL_SEAT_GRACE_SWEEP,
        },
        schedule: {
            type: 'repeated',
            cron: '25 * * * *',
        },
    })
    await app.register(platformPlanController, { prefix: '/v1/platform-billing' })
}
