import mongoose from 'mongoose';

const ItemTranslationSchema = new mongoose.Schema({
  locale: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
}, { _id: false });

/**
 * BoM 消耗条目：选项 / 菜品销售一份时，需要扣减的「原材料 × 数量（按 RawMaterial.baseUnit）」。
 *
 * 例：双拼饭的「烧鸭」选项 → { rawMaterialId: <鸭子>, qty: 125 }（克）。
 * qty 不允许 ≤ 0；前端编辑时直接过滤掉空行。
 */
const ConsumptionSchema = new mongoose.Schema(
  {
    rawMaterialId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterial', required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const OptionChoiceSchema = new mongoose.Schema({
  extraPrice: { type: Number, default: 0 },
  originalPrice: { type: Number },
  translations: [{
    locale: { type: String, required: true },
    name: { type: String, required: true },
  }],
  /** 选中本选项时，每一份额外消耗的原材料明细（与 MenuItem.consumption 叠加） */
  consumption: { type: [ConsumptionSchema], default: [] },
}, { _id: true });

const OptionGroupSchema = new mongoose.Schema({
  required: { type: Boolean, default: false },
  /** 仅非必选组：最少选几项（≥0）。必选组仍为单选，保存时可忽略。 */
  minSelect: { type: Number, default: 0 },
  /** 仅非必选组：最多选几项；0 表示不限制。 */
  maxSelect: { type: Number, default: 0 },
  translations: [{
    locale: { type: String, required: true },
    name: { type: String, required: true },
  }],
  choices: [OptionChoiceSchema],
}, { _id: true });

/**
 * 进货单位换算：例如 1 箱 = 10 袋；1 袋 = 24 个（baseUnit）。
 * factorToBase 表示「该单位 → baseUnit」的换算系数（必须为正整数）。
 */
const PurchaseUnitSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    factorToBase: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

/**
 * 高级库存追踪子文档：仅当 `inventoryTracked = true` 时生效。
 * - baseUnit：库存最小单位（如「个」），currentQty 与所有流水按此累计
 * - perServing：单份销售对应几个 baseUnit（必须为正整数，份数不允许非整数）
 * - purchaseUnits：到货时支持的整箱/整袋等单位定义
 * - reorderFrequencyDays：补货周期（天），用于阈值计算
 * - estimatedDailySales：在没有足够历史销量样本时，作为日均销量的兜底值（份/天）
 */
const InventorySubdocSchema = new mongoose.Schema(
  {
    baseUnit: { type: String, trim: true, default: '' },
    perServing: { type: Number, min: 1, default: 1 },
    purchaseUnits: { type: [PurchaseUnitSchema], default: [] },
    currentQty: { type: Number, default: 0, min: 0 },
    reorderFrequencyDays: { type: Number, min: 1, default: 3 },
    estimatedDailySales: { type: Number, min: 0, default: 0 },
    trackingEnabledAt: { type: Date },
    lastRestockAt: { type: Date },
  },
  { _id: false },
);

const MenuItemSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory', required: true },
  price: { type: Number, required: true },
  calories: { type: Number },
  avgWaitMinutes: { type: Number },
  photoUrl: { type: String },
  arFileUrl: { type: String },
  isSoldOut: { type: Boolean, default: false },
  soldOutUntil: { type: Date },
  allergenIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Allergen' }],
  translations: [ItemTranslationSchema],
  optionGroups: [OptionGroupSchema],
  /**
   * A 模式：是否启用「菜品本身即库存单位」追踪。
   * 与 `consumption.length > 0`（B 模式）互斥，保存路径强制校验。
   */
  inventoryTracked: { type: Boolean, default: false, index: true },
  inventory: { type: InventorySubdocSchema, default: undefined },
  /**
   * B 模式：本菜品销售一份时，消耗的原材料明细（按 RawMaterial.baseUnit 计）。
   * 不区分选项；选项各自的 consumption 在 OptionChoice 子文档里。
   * 仅当 `inventoryTracked === false` 时允许非空。
   */
  consumption: { type: [ConsumptionSchema], default: [] },
}, { timestamps: true });

export { MenuItemSchema, ItemTranslationSchema };
