import mongoose from 'mongoose';

/**
 * 原材料 (BoM 模式)：与 `MenuItem.inventory` 子文档结构相似，但作为独立实体，可被多道菜或多个
 * 选项 (OptionChoice) 通过 `consumption[]` 引用，实现「共享原料」的库存追踪。
 *
 * - 与「菜品自身即库存单位」(A 模式：`MenuItem.inventoryTracked = true`) 互斥
 *   ↳ 互斥判定在菜品保存路径上做，保证同一份销售不会被双重扣减
 * - 数量单位约定：`currentQty` 始终以 `baseUnit` 计；`purchaseUnits` 提供 base 之上的常用整箱/整袋换算
 * - 阈值 = 历史日均消耗（来自 `InventoryTxn` 的 sale 流水累加）× `reorderFrequencyDays`，向上取整
 */
const PurchaseUnitTranslationSchema = new mongoose.Schema(
  {
    locale: { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false },
);

const PurchaseUnitSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    translations: { type: [PurchaseUnitTranslationSchema], default: [] },
    factorToBase: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const RawMaterialTranslationSchema = new mongoose.Schema(
  {
    locale: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false },
);

export const RawMaterialSchema = new mongoose.Schema(
  {
    /** 多语言名（zh-CN / en-US 共存，UI 按当前 locale 选取） */
    translations: { type: [RawMaterialTranslationSchema], default: [] },
    /** 库存最小单位（g / ml / 个 / 片 …），所有流水按此累计 */
    baseUnit: { type: String, required: true, trim: true },
    /** 到货时支持的整箱/整袋等单位定义 */
    purchaseUnits: { type: [PurchaseUnitSchema], default: [] },
    /** 当前库存（base 单位）。扣减由订单成交路径触发 */
    currentQty: { type: Number, default: 0, min: 0 },
    /** 补货周期（天），用于阈值计算 */
    reorderFrequencyDays: { type: Number, min: 1, default: 3 },
    /** 首次启用追踪的时间（用于「自动回填」hook 判定是否已回填过） */
    trackingEnabledAt: { type: Date },
    /** 历史回填是否完成（防止重复回填） */
    backfillCompletedAt: { type: Date },
    lastRestockAt: { type: Date },
    /** 是否启用（关闭后不再参与订单扣减与阈值告警；保留历史流水可读） */
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);
