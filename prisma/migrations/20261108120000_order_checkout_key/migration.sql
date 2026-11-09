-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "checkoutKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_checkoutKey_key" ON "Order"("checkoutKey");

