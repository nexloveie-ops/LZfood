import mongoose from 'mongoose';

/**
 * 库存流水（双向账，所有数值统一以 menuItem.inventory.baseUnit 计）。
 * - sale：销售扣减（负值），由结账流程自动写入
 * - restock：到货增加（正值），由收银录入「按箱/按袋」时换算成 baseUnit
 * - waste：报损扣减（负值），由收银操作时必须写明 reason
 * - init：初始化盘点（覆盖式），用于上线后第一次设置 currentQty
 * - adjust：人工微调（正/负），保留人工修正能力
 *
 * baseUnit / perServing / purchaseUnit 都做了快照，避免后期菜品配置变化导致历史无法解读。
 */
export const InventoryTxnSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true, index: true },
    type: {
      type: String,
      enum: ['sale', 'restock', 'waste', 'init', 'adjust'],
      required: true,
      index: true,
    },
    /** 该笔变动对应的 baseUnit 数量（正：增加；负：扣减） */
    qty: { type: Number, required: true },
    /** 操作前后的 currentQty 快照，仅用于审计与排查 */
    qtyBefore: { type: Number },
    qtyAfter: { type: Number },
    baseUnitSnapshot: { type: String, default: '' },
    perServingSnapshot: { type: Number, default: 1 },
    /** restock 时的进货单位快照（例如 case/bag），sale 时为空 */
    purchaseUnit: {
      code: { type: String, default: '' },
      label: { type: String, default: '' },
      factorToBase: { type: Number, default: 0 },
      qty: { type: Number, default: 0 },
    },
    /** sale 关联订单与行 */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    orderItemId: { type: String, default: '' },
    /** waste/adjust 时的备注；waste 必填 */
    note: { type: String, default: '' },
    operatorId: { type: mongoose.Schema.Types.ObjectId },
    operatorName: { type: String, default: '' },
  },
  { timestamps: true },
);

InventoryTxnSchema.index({ menuItemId: 1, createdAt: -1 });
InventoryTxnSchema.index({ type: 1, createdAt: -1 });
