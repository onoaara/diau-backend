-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "draft" JSONB,
ADD COLUMN     "draftUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "draftUpdatedBy" TEXT;

