-- CreateTable
CREATE TABLE "ImageSignature" (
    "mediaId" TEXT NOT NULL,
    "dhash" TEXT NOT NULL,
    "histogram" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageSignature_pkey" PRIMARY KEY ("mediaId")
);

-- CreateTable
CREATE TABLE "ImageQuery" (
    "id" TEXT NOT NULL,
    "dhash" TEXT NOT NULL,
    "histogram" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImageQuery_createdAt_idx" ON "ImageQuery"("createdAt");

-- AddForeignKey
ALTER TABLE "ImageSignature" ADD CONSTRAINT "ImageSignature_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
