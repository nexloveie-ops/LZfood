import mongoose from 'mongoose';

/** 平台把飞鹅云打印机 SN 分配给店铺；UKEY 只在平台环境变量，不入库。 */
export const CloudPrinterSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Store',
      required: true,
      index: true,
    },
    sn: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    label: { type: String, default: '', trim: true },
  },
  { timestamps: true },
);

CloudPrinterSchema.index({ storeId: 1, createdAt: 1 });
