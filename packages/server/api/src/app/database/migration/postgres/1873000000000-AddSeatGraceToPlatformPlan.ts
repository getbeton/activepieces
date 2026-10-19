import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddSeatGraceToPlatformPlan1873000000000 implements Migration {
    name = 'AddSeatGraceToPlatformPlan1873000000000'
    breaking = false
    release = '0.93.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform_plan"
            ADD COLUMN IF NOT EXISTS "seatGraceEndsAt" TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS "seatGraceTrialStartedAt" TIMESTAMP WITH TIME ZONE
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform_plan"
            DROP COLUMN IF EXISTS "seatGraceEndsAt",
            DROP COLUMN IF EXISTS "seatGraceTrialStartedAt"
        `)
    }
}
