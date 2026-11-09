-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "restockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderEvent" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'status';

