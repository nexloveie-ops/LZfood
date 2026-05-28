import mongoose from 'mongoose';

/**
 * 库存流水（双向账，所有数值以追踪主体的 baseUnit 计）。
 *
 * 追踪主体 (subject) 两种二选一：
 *   - **menuItemId**：A 模式，整菜即库存单位（小笼包等），数量按菜品自身 baseUnit
 *   - **rawMaterialId**：B 模式，BoM 中的共享原料，数量按 RawMaterial.baseUnit
 *
 * type 分类：
 * - sale：销售扣减（负值），由结账流程自动写入；可附 `note: 'backfill'` 表示自动回填
 * - restock：到货增加（正值），由收银录入「按箱/按袋」换算到 baseUnit
 *   ↳ B 模式 restock 可附 `source` 区分中央厨房 / 第三方采购 / 自购，及自由文本 `supplierNote`
 * - waste：报损扣减（负值），必须 note
 * - init：初始盘点（覆盖式），上线第一次设置 currentQty
 * - adjust：人工微调（正/负）
 *
 * baseUnit / perServing / purchaseUnit 都做了快照，避免后期配置变化导致历史无法解读。
 */
export const InventoryTxnSchema = new mongoose.Schema(
  {
    /** A 模式：菜品 ID；B 模式留空 */
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', index: true },
    /** B 模式：原料 ID；A 模式留空 */
    rawMaterialId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterial', index: true },
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
    /** A 模式 sale 时保留每份对应几个 baseUnit；B 模式无意义 */
    perServingSnapshot: { type: Number, default: 1 },
    /** restock 时的进货单位快照（例如 case/bag），sale 时为空 */
    purchaseUnit: {
      code: { type: String, default: '' },
      label: { type: String, default: '' },
      factorToBase: { type: Number, default: 0 },
      qty: { type: Number, default: 0 },
    },
    /**
     * 仅 restock 类型有意义：进货来源。
     * - central_kitchen：中央厨房统配
     * - third_party：第三方供应商配送
     * - self_purchase：店主自购
     */
    source: {
      type: String,
      enum: ['central_kitchen', 'third_party', 'self_purchase'],
      required: false,
    },
    /** 供应商名 / 批次号 / 单据号等自由文本 */
    supplierNote: { type: String, default: '' },
    /** sale 关联订单与行 */
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    orderItemId: { type: String, default: '' },
    /** waste/adjust 时的备注；waste 必填；回填的 sale 流水固定为 'backfill' */
    note: { type: String, default: '' },
    operatorId: { type: mongoose.Schema.Types.ObjectId },
    operatorName: { type: String, default: '' },
  },
  { timestamps: true },
);

InventoryTxnSchema.index({ menuItemId: 1, createdAt: -1 });
InventoryTxnSchema.index({ rawMaterialId: 1, createdAt: -1 });
InventoryTxnSchema.index({ type: 1, createdAt: -1 });
