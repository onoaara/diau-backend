-- CreateEnum
CREATE TYPE "ProductEventType" AS ENUM ('VIEW', 'ADD_TO_CART', 'WATCH', 'SHARE', 'PURCHASE');

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" BIGSERIAL NOT NULL,
    "type" "ProductEventType" NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT,
    "visitorId" VARCHAR(64),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEvent_createdAt_type_idx" ON "ProductEvent"("createdAt", "type");

-- CreateIndex
CREATE INDEX "ProductEvent_productId_type_createdAt_idx" ON "ProductEvent"("productId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_visitorId_productId_createdAt_idx" ON "ProductEvent"("visitorId", "productId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
